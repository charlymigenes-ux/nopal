"""Clasificador de comandos de POST /api/laser/command (ADR-006).

Esa ruta es un transporte genérico: el panel manda por ella tanto operación
normal (jog, home, cero de trabajo, air assist…) como potencia del láser y
control del husillo (M3/M4). Para que cada parte pase por la Authorization
Policy correcta, el comando se descompone en las acciones semánticas que
contiene y la ruta autoriza TODAS antes de enviar nada: una operación normal
no puede esconder una acción de admin en la misma petición.

Cómo lee GRBL lo que se le manda (y por eso así se clasifica):
- Los bytes de tiempo real (`?`, `!`, `~`, `0x18` y cualquier byte >= 0x80) se
  ejecutan apenas llegan, en cualquier posición del flujo, incluso en medio
  de una línea. Se extraen y se clasifica cada uno.
- El resto se procesa por líneas (`\\n` o `\\r`): a una petición se le pueden
  colar varias. Cada línea se normaliza como lo hace el firmware: comentarios
  `(...)` y `; ...` fuera, espacios fuera, mayúsculas.
- Una línea `$…` es un comando de sistema; cualquier otra es un bloque G-code
  que puede llevar varias palabras (`G0 X10 M3 S1000`).

Lista blanca, fail-closed: lo que no se reconoce como una acción concreta se
clasifica como `send_console_command` (admin). `M3`/`M4`/`M5` y cualquier
palabra `S` son control de potencia/husillo; `$…=…` son settings.

Dos casos quedan como NOT COVERED (sin acción en la política, solo exigen la
autenticación que ya exigía la ruta): `$X` (desbloqueo de alarma) y los
overrides en tiempo real de husillo/potencia (0x99–0x9E). No corresponden con
certeza a ninguna acción decidida en ADR-006, así que no se les cambia el
permiso (ver SDD §18.8).
"""

import re
from dataclasses import dataclass, field
from typing import FrozenSet, List, Tuple

from backend.services.authorization_policy import Action, ResourceKind

# Bytes de tiempo real de GRBL/grblHAL/FluidNC.
_REALTIME_ACTIONS = {
    "?": Action.VIEW_STATUS,      # reporte de estado
    "!": Action.PAUSE,            # feed hold
    "~": Action.RESUME,           # cycle start / resume
    "\x18": Action.CANCEL,        # soft reset: aborta el trabajo
    "\x84": Action.PAUSE,         # safety door
    "\x85": Action.MOVE,          # jog cancel
    **{chr(b): Action.SET_SPEED_FACTOR for b in range(0x90, 0x98)},  # overrides de avance y rápidos
}
# Overrides de husillo/potencia y spindle stop: NOT COVERED (ver docstring).
_REALTIME_UNCOVERED = frozenset(chr(b) for b in range(0x99, 0x9F))
# Toggles de refrigerante en tiempo real (flood / mist).
_REALTIME_COOLANT = frozenset({"\xa0", "\xa1"})

_WORD_RE = re.compile(r"([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))")

# Códigos G de operación normal → acción.
_MOTION_G = {0.0, 1.0, 2.0, 3.0, 53.0, 38.2, 38.3, 38.4, 38.5}
_MODAL_G = {17.0, 18.0, 19.0, 20.0, 21.0, 40.0, 80.0, 90.0, 91.0, 90.1, 91.1, 93.0, 94.0}
_HOME_G = {28.0, 30.0}
_WORK_ZERO_G = {54.0, 55.0, 56.0, 57.0, 58.0, 59.0, 92.0, 92.1, 10.0}
# Parámetros que acompañan a esos códigos sin efecto propio.
_PARAM_WORDS = set("XYZABCIJKRFPLN")


@dataclass(frozen=True)
class Classification:
    """Acciones que contiene un comando. `uncovered` lista las partes NOT
    COVERED (solo autenticación, sin acción en la política)."""

    actions: FrozenSet[Action]
    uncovered: Tuple[str, ...] = field(default_factory=tuple)


def _power_action(kind: ResourceKind) -> Action:
    return Action.SET_SPINDLE if kind is ResourceKind.CNC else Action.SET_LASER_POWER


def _coolant_action(kind: ResourceKind) -> Action:
    return Action.SET_COOLANT if kind is ResourceKind.CNC else Action.SET_AIR_ASSIST


def _strip_comments(line: str) -> str:
    line = re.sub(r"\([^)]*\)", "", line)
    return line.split(";", 1)[0]


def _classify_system_line(line: str, kind: ResourceKind) -> Tuple[List[Action], List[str]]:
    body = line[1:]
    if body in ("H",) or re.fullmatch(r"H[XYZABC]+", body):
        return [Action.HOME], []
    if body == "X":
        return [], ["$X"]
    if body in ("$", "#", "G", "I", "N"):
        return [Action.VIEW_STATUS], []
    if body.startswith("J="):
        actions = _classify_gcode_words(body[2:], kind, jog=True)
        return actions, []
    if "=" in body:
        return [Action.GRBL_SETTINGS], []
    return [Action.SEND_CONSOLE_COMMAND], []


def _classify_gcode_words(line: str, kind: ResourceKind, jog: bool = False) -> List[Action]:
    words = _WORD_RE.findall(line)
    if not words or _WORD_RE.sub("", line):
        # Vacía tras la normalización o con restos que no son palabras G-code.
        return [Action.SEND_CONSOLE_COMMAND] if line else []
    actions: List[Action] = []
    for letter, raw in words:
        value = float(raw)
        if letter == "G":
            if value in _MOTION_G or value in _MODAL_G:
                actions.append(Action.MOVE)
            elif value in _HOME_G and not jog:
                actions.append(Action.HOME)
            elif value in _WORK_ZERO_G and not jog:
                actions.append(Action.SET_WORK_ZERO)
            else:
                actions.append(Action.SEND_CONSOLE_COMMAND)
        elif letter == "M" and not jog:
            if value in (3.0, 4.0, 5.0):
                actions.append(_power_action(kind))
            elif value in (7.0, 8.0, 9.0):
                actions.append(_coolant_action(kind))
            else:
                actions.append(Action.SEND_CONSOLE_COMMAND)
        elif letter == "S":
            actions.append(_power_action(kind))
        elif letter in _PARAM_WORDS:
            continue
        else:
            actions.append(Action.SEND_CONSOLE_COMMAND)
    if jog and not actions:
        actions.append(Action.MOVE)
    return actions


def classify_laser_command(command: str, kind: ResourceKind) -> Classification:
    """Descompone `command` en las acciones de la política que contiene."""
    actions: List[Action] = []
    uncovered: List[str] = []
    text_chars: List[str] = []

    for char in command:
        if char in _REALTIME_ACTIONS:
            actions.append(_REALTIME_ACTIONS[char])
        elif char in _REALTIME_UNCOVERED:
            uncovered.append(f"0x{ord(char):02X}")
        elif char in _REALTIME_COOLANT:
            actions.append(_coolant_action(kind))
        elif ord(char) >= 0x80:
            actions.append(Action.SEND_CONSOLE_COMMAND)  # byte realtime desconocido
        else:
            text_chars.append(char)

    for raw_line in re.split(r"[\r\n]", "".join(text_chars)):
        line = re.sub(r"\s+", "", _strip_comments(raw_line)).upper()
        if not line:
            continue
        if line.startswith("$"):
            line_actions, line_uncovered = _classify_system_line(line, kind)
            actions.extend(line_actions)
            uncovered.extend(line_uncovered)
        else:
            actions.extend(_classify_gcode_words(line, kind))

    if not actions and not uncovered:
        # Comando vacío (o solo comentarios): no hace nada en la máquina.
        actions.append(Action.VIEW_STATUS)
    return Classification(frozenset(actions), tuple(uncovered))
