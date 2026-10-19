"""Consola: macros y plantillas propias, historial de comandos y utilidades.

Todo es por instalación y vive en JSON plano en la raíz del repo, igual que
el resto del estado de NOPAL:

- `console_macros.json`  → macros y plantillas creadas por el usuario.
- `console_history.json` → últimos comandos enviados, por puerto de Klipper.

Una *macro* es una lista fija de líneas de G-code. Una *plantilla* es lo mismo
pero con parámetros: las líneas llevan marcadores `{{clave}}` que se llenan al
ejecutarla (con validación de rango, para que un número mal tecleado no llegue
a la impresora). Las plantillas `builtin` viven en el código y son de solo
lectura. Las macros propias NO sustituyen a los `[gcode_macro]` de Klipper:
esos siguen saliendo de `klipper_service.get_macros`.
"""

import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

MACROS_PATH = "console_macros.json"
HISTORY_PATH = "console_history.json"

HISTORY_LIMIT = 100
MAX_NAME = 60
MAX_DESCRIPTION = 120
MAX_COMMANDS = 50
MAX_COMMAND_LENGTH = 200
MAX_PARAMS = 8
MAX_FILE_BYTES = 256 * 1024
MAX_FILE_LINES = 500
SEND_CHUNK = 20

# Iconos que el frontend sabe dibujar (slug → SVG propio).
ICONS = (
    "flame", "home", "spool", "layers", "nozzle", "power",
    "wrench", "thermometer", "bolt", "folder", "play",
)
DEFAULT_ICON = "bolt"

PARAM_KEY_RE = re.compile(r"^[a-z_][a-z0-9_]{0,23}$")
PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}")
# Texto libre en parámetros: sin ';' ni saltos de línea, para que un valor no
# pueda convertirse en comentario ni inyectar una segunda línea de G-code.
SAFE_TEXT_RE = re.compile(r"^[\w .\-/+]{0,60}$")

_lock = threading.Lock()


class ConsoleError(ValueError):
    """Dato inválido; el mensaje (es-MX) se muestra tal cual al usuario."""


class NotFoundError(LookupError):
    pass


class ReadOnlyError(PermissionError):
    pass


# ── Plantillas incluidas ──

def _num(key: str, label: str, default: float, minimum: float, maximum: float, unit: str) -> Dict[str, Any]:
    return {"key": key, "label": label, "type": "number",
            "default": default, "min": minimum, "max": maximum, "unit": unit}


BUILTIN_TEMPLATES: List[Dict[str, Any]] = [
    {
        "id": "builtin-print-petg", "name": "Impresión PETG", "subtitle": "Calienta y hace home · 240/80",
        "description": "Precalienta para PETG y lleva los ejes a home.", "icon": "flame",
        "commands": ["M140 S{{bed}}", "M104 S{{hotend}}", "G28", "M190 S{{bed}}", "M109 S{{hotend}}"],
        "params": [_num("hotend", "Extrusor", 240, 150, 300, "°C"), _num("bed", "Cama", 80, 0, 120, "°C")],
    },
    {
        "id": "builtin-print-pla", "name": "Impresión PLA", "subtitle": "Calienta y hace home · 210/60",
        "description": "Precalienta para PLA y lleva los ejes a home.", "icon": "flame",
        "commands": ["M140 S{{bed}}", "M104 S{{hotend}}", "G28", "M190 S{{bed}}", "M109 S{{hotend}}"],
        "params": [_num("hotend", "Extrusor", 210, 150, 300, "°C"), _num("bed", "Cama", 60, 0, 120, "°C")],
    },
    {
        "id": "builtin-pid-extruder", "name": "Calibración PID", "subtitle": "Temperatura del extrusor",
        "description": "Calibra el PID del extrusor (Klipper). Al terminar falta SAVE_CONFIG.", "icon": "thermometer",
        "commands": ["PID_CALIBRATE HEATER=extruder TARGET={{target}}"],
        "params": [_num("target", "Temperatura objetivo", 210, 100, 300, "°C")],
    },
    {
        "id": "builtin-maintenance", "name": "Mantenimiento", "subtitle": "Sube el cabezal para limpieza",
        "description": "Hace home y sube el cabezal para limpiar o revisar.", "icon": "wrench",
        "commands": ["G28", "G90", "G1 Z{{lift}} F600"],
        "params": [_num("lift", "Altura Z", 100, 10, 300, "mm")],
    },
    {
        "id": "builtin-nozzle-change", "name": "Cambio de nozzle", "subtitle": "Calienta y sube el cabezal",
        "description": "Calienta el extrusor y sube el cabezal para cambiar la boquilla.", "icon": "nozzle",
        "commands": ["G28", "G90", "G1 Z{{lift}} F600", "M104 S{{hotend}}", "M109 S{{hotend}}"],
        "params": [_num("hotend", "Extrusor", 200, 150, 300, "°C"), _num("lift", "Altura Z", 100, 10, 300, "mm")],
    },
]


# ── Persistencia ──

def _empty_store() -> Dict[str, List[Dict[str, Any]]]:
    return {"macros": [], "templates": []}


def _read_json(path: str, fallback: Any) -> Any:
    if not os.path.exists(path):
        return fallback
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        # Un JSON dañado no debe tumbar la consola: se aparta y se arranca limpio.
        corrupt = f"{path}.corrupt-{int(time.time())}.bak"
        try:
            os.replace(path, corrupt)
            logger.warning("%s estaba dañado; se movió a %s", path, corrupt)
        except OSError:
            logger.warning("%s está dañado y no se pudo apartar", path)
        return fallback


def _write_json(path: str, data: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".console-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load_store() -> Dict[str, List[Dict[str, Any]]]:
    data = _read_json(MACROS_PATH, _empty_store())
    if not isinstance(data, dict):
        return _empty_store()
    return {
        "macros": [m for m in data.get("macros", []) if isinstance(m, dict)],
        "templates": [t for t in data.get("templates", []) if isinstance(t, dict)],
    }


# ── Validación ──

def _clean_command(raw: Any) -> str:
    if not isinstance(raw, str):
        raise ConsoleError("Cada comando debe ser texto.")
    if "\n" in raw or "\r" in raw:
        raise ConsoleError("Escribe un comando por línea, sin saltos de línea dentro del comando.")
    command = raw.strip()
    if len(command) > MAX_COMMAND_LENGTH:
        raise ConsoleError(f"Un comando no puede pasar de {MAX_COMMAND_LENGTH} caracteres.")
    return command


def _clean_params(raw: Any) -> List[Dict[str, Any]]:
    if raw in (None, []):
        return []
    if not isinstance(raw, list) or len(raw) > MAX_PARAMS:
        raise ConsoleError(f"Una plantilla admite hasta {MAX_PARAMS} parámetros.")
    params, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            raise ConsoleError("Parámetro inválido.")
        key = str(item.get("key", "")).strip()
        if not PARAM_KEY_RE.match(key):
            raise ConsoleError("La clave de un parámetro solo admite minúsculas, números y guion bajo.")
        if key in seen:
            raise ConsoleError(f"El parámetro «{key}» está repetido.")
        seen.add(key)
        label = str(item.get("label") or key).strip()[:MAX_NAME]
        kind = item.get("type", "number")
        if kind not in ("number", "text"):
            raise ConsoleError(f"Tipo de parámetro inválido en «{key}».")
        param: Dict[str, Any] = {"key": key, "label": label, "type": kind,
                                 "unit": str(item.get("unit", ""))[:8]}
        if kind == "number":
            try:
                minimum = float(item.get("min", 0))
                maximum = float(item.get("max", 1000))
                default = float(item.get("default", minimum))
            except (TypeError, ValueError):
                raise ConsoleError(f"Los valores numéricos de «{key}» no son válidos.")
            if minimum > maximum or not minimum <= default <= maximum:
                raise ConsoleError(f"El valor por defecto de «{key}» debe estar entre su mínimo y su máximo.")
            param.update(min=minimum, max=maximum, default=default)
        else:
            default = str(item.get("default", ""))
            if not SAFE_TEXT_RE.match(default):
                raise ConsoleError(f"El valor por defecto de «{key}» tiene caracteres no permitidos.")
            param["default"] = default
        params.append(param)
    return params


def _clean_item(payload: Dict[str, Any], *, template: bool) -> Dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > MAX_NAME:
        raise ConsoleError(f"El nombre es obligatorio y no puede pasar de {MAX_NAME} caracteres.")
    description = str(payload.get("description", "")).strip()
    if len(description) > MAX_DESCRIPTION:
        raise ConsoleError(f"La descripción no puede pasar de {MAX_DESCRIPTION} caracteres.")
    icon = payload.get("icon") or DEFAULT_ICON
    if icon not in ICONS:
        raise ConsoleError("Icono no disponible.")
    raw_commands = payload.get("commands")
    if not isinstance(raw_commands, list):
        raise ConsoleError("Los comandos deben ser una lista.")
    commands = [c for c in (_clean_command(c) for c in raw_commands) if c]
    if not commands:
        raise ConsoleError("Agrega al menos un comando.")
    if len(commands) > MAX_COMMANDS:
        raise ConsoleError(f"Máximo {MAX_COMMANDS} comandos por macro.")

    params = _clean_params(payload.get("params")) if template else []
    used = {key for command in commands for key in PLACEHOLDER_RE.findall(command)}
    defined = {p["key"] for p in params}
    if not template and used:
        raise ConsoleError("Los marcadores {{…}} solo se usan en plantillas.")
    if used - defined:
        missing = ", ".join(sorted(used - defined))
        raise ConsoleError(f"Falta definir el parámetro: {missing}.")
    if defined - used:
        extra = ", ".join(sorted(defined - used))
        raise ConsoleError(f"El parámetro no se usa en ningún comando: {extra}.")

    item = {"name": name, "description": description, "icon": icon, "commands": commands}
    if template:
        item["subtitle"] = str(payload.get("subtitle", "")).strip()[:MAX_DESCRIPTION]
        item["params"] = params
    return item


def _public(item: Dict[str, Any], *, builtin: bool) -> Dict[str, Any]:
    out = dict(item)
    out["builtin"] = builtin
    out.setdefault("params", [])
    return out


# ── Macros y plantillas propias (CRUD) ──

def _section(template: bool) -> str:
    return "templates" if template else "macros"


def list_macros() -> List[Dict[str, Any]]:
    with _lock:
        return [_public(m, builtin=False) for m in _load_store()["macros"]]


def list_templates() -> List[Dict[str, Any]]:
    with _lock:
        user = [_public(t, builtin=False) for t in _load_store()["templates"]]
    return [_public(t, builtin=True) for t in BUILTIN_TEMPLATES] + user


def get_item(item_id: str, *, template: bool) -> Dict[str, Any]:
    if template:
        for builtin in BUILTIN_TEMPLATES:
            if builtin["id"] == item_id:
                return _public(builtin, builtin=True)
    with _lock:
        for item in _load_store()[_section(template)]:
            if item.get("id") == item_id:
                return _public(item, builtin=False)
    raise NotFoundError("No se encontró.")


def create_item(payload: Dict[str, Any], *, template: bool) -> Dict[str, Any]:
    item = _clean_item(payload, template=template)
    item["id"] = uuid.uuid4().hex[:12]
    with _lock:
        store = _load_store()
        store[_section(template)].append(item)
        _write_json(MACROS_PATH, store)
    return _public(item, builtin=False)


def update_item(item_id: str, payload: Dict[str, Any], *, template: bool) -> Dict[str, Any]:
    if template and any(b["id"] == item_id for b in BUILTIN_TEMPLATES):
        raise ReadOnlyError("Las plantillas incluidas no se pueden modificar.")
    clean = _clean_item(payload, template=template)
    with _lock:
        store = _load_store()
        for index, existing in enumerate(store[_section(template)]):
            if existing.get("id") == item_id:
                clean["id"] = item_id
                store[_section(template)][index] = clean
                _write_json(MACROS_PATH, store)
                return _public(clean, builtin=False)
    raise NotFoundError("No se encontró.")


def delete_item(item_id: str, *, template: bool) -> None:
    if template and any(b["id"] == item_id for b in BUILTIN_TEMPLATES):
        raise ReadOnlyError("Las plantillas incluidas no se pueden eliminar.")
    with _lock:
        store = _load_store()
        section = store[_section(template)]
        remaining = [i for i in section if i.get("id") != item_id]
        if len(remaining) == len(section):
            raise NotFoundError("No se encontró.")
        store[_section(template)] = remaining
        _write_json(MACROS_PATH, store)


# ── Render de plantillas ──

def _format_number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def render_commands(item: Dict[str, Any], params: Optional[Dict[str, Any]] = None) -> List[str]:
    """Líneas de G-code listas para enviar, con los parámetros ya validados."""
    values: Dict[str, str] = {}
    supplied = params or {}
    for spec in item.get("params", []):
        key = spec["key"]
        raw = supplied.get(key, spec.get("default"))
        label = spec.get("label") or key
        if spec["type"] == "number":
            try:
                number = float(raw)
            except (TypeError, ValueError):
                raise ConsoleError(f"«{label}» debe ser un número.")
            if number != number or not spec["min"] <= number <= spec["max"]:
                raise ConsoleError(
                    f"«{label}» debe estar entre {_format_number(spec['min'])} y {_format_number(spec['max'])}."
                )
            values[key] = _format_number(number)
        else:
            text = str(raw if raw is not None else "")
            if not SAFE_TEXT_RE.match(text):
                raise ConsoleError(f"«{label}» tiene caracteres no permitidos.")
            values[key] = text
    return [PLACEHOLDER_RE.sub(lambda m: values[m.group(1)], command) for command in item["commands"]]


def chunked(lines: List[str], size: int = SEND_CHUNK) -> List[List[str]]:
    return [lines[i:i + size] for i in range(0, len(lines), size)]


# ── Archivo de G-code ──

def parse_gcode_upload(raw: bytes) -> Dict[str, Any]:
    """Convierte un archivo subido en líneas ejecutables (sin comentarios)."""
    if len(raw) > MAX_FILE_BYTES:
        raise ConsoleError(f"El archivo es muy grande (máximo {MAX_FILE_BYTES // 1024} KB).")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ConsoleError("El archivo no es texto UTF-8 válido.")
    lines, skipped = [], 0
    for original in text.splitlines():
        line = original.split(";", 1)[0].strip()
        if not line or line.startswith("("):
            skipped += 1
            continue
        if len(line) > MAX_COMMAND_LENGTH:
            raise ConsoleError(f"Hay una línea de más de {MAX_COMMAND_LENGTH} caracteres; no parece G-code.")
        lines.append(line)
    if not lines:
        raise ConsoleError("El archivo no tiene comandos para enviar.")
    if len(lines) > MAX_FILE_LINES:
        raise ConsoleError(
            f"El archivo tiene {len(lines)} comandos; el máximo para la consola es {MAX_FILE_LINES}. "
            "Para trabajos largos sube el archivo a la impresora e imprímelo."
        )
    return {"lines": lines, "skipped": skipped}


# ── Historial ──

def get_history(port: int, limit: int = 50) -> List[str]:
    with _lock:
        data = _read_json(HISTORY_PATH, {})
    entries = data.get(str(port), []) if isinstance(data, dict) else []
    return [e for e in entries if isinstance(e, str)][:max(1, min(limit, HISTORY_LIMIT))]


def record_command(port: int, command: str) -> None:
    """Guarda el comando como el más reciente. Nunca rompe el envío: si el
    historial falla se registra y se sigue."""
    command = command.strip()
    if not command:
        return
    try:
        with _lock:
            data = _read_json(HISTORY_PATH, {})
            if not isinstance(data, dict):
                data = {}
            entries = [e for e in data.get(str(port), []) if isinstance(e, str) and e != command]
            data[str(port)] = [command] + entries[:HISTORY_LIMIT - 1]
            _write_json(HISTORY_PATH, data)
    except OSError:
        logger.warning("No se pudo guardar el historial de la consola", exc_info=True)


def clear_history(port: int) -> None:
    with _lock:
        data = _read_json(HISTORY_PATH, {})
        if isinstance(data, dict) and str(port) in data:
            del data[str(port)]
            _write_json(HISTORY_PATH, data)


# ── Exportar log ──

def format_log(messages: List[Dict[str, Any]]) -> str:
    rows = []
    for msg in messages:
        stamp = ""
        if msg.get("time"):
            stamp = datetime.fromtimestamp(float(msg["time"])).strftime("%H:%M:%S")
        prefix = "> " if msg.get("type") == "command" else "  "
        rows.append(f"[{stamp}] {prefix}{msg.get('message', '')}")
    return "\n".join(rows) + ("\n" if rows else "")
