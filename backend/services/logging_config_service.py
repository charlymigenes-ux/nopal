"""Configuración del registro (logs) de NOPAL: fuentes, repetidos y destino.

Antes, `main.py` configuraba el logging una sola vez con `basicConfig`: un nivel
global (INFO), un archivo rotativo y una copia a consola (que systemd guarda en
el journal). No había forma de bajarle el volumen a una fuente ruidosa: el 76 %
del log era un aviso de la librería de la Matriz LED (`pypixelcolor`) y miles
de líneas idénticas de láseres apagados ("Fallo al enviar '?'").

Persistencia: `logging_config.json` en la raíz (mismo patrón que
`ai_config.json`): lectura, validación, escritura atómica y valores por omisión
si falta o está dañado. Se aplica al arrancar (antes de crear la app) y en
caliente al guardarlo, sin reiniciar.

- **Fuentes:** una fuente es el nombre de un logger de Python (`__name__` del
  módulo). Se configura por prefijo con la jerarquía estándar: `pypixelcolor`
  cubre `pypixelcolor.commands.send_image`. Estados: normal (hereda el nivel
  general), solo avisos y errores, solo errores, silenciada. Uvicorn no entra:
  tiene sus propios handlers y su log no pasa por aquí.
- **Repetidos:** un filtro en los handlers de NOPAL (no en los loggers, para no
  afectar a otros handlers) deja pasar la primera aparición de cada mensaje y,
  dentro de la ventana, solo cuenta las repeticiones idénticas (clave: fuente +
  nivel + mensaje ya formateado). Al cerrar la ventana escribe un resumen con
  la misma fuente y nivel. ERROR/CRITICAL siguen la misma regla: la primera
  siempre queda y el resumen conserva todo el diagnóstico.
- **Destino:** carpeta (solo `logs/` o subcarpetas: la rotación renombra
  archivos `.1`…`.N` y no debe poder pisar archivos ajenos), tamaño por archivo,
  cantidad de archivos y la copia a consola/journal (solo el StreamHandler de
  NOPAL; el log de acceso de uvicorn sigue en el journal).
"""

import json
import logging
import os
import re
import tempfile
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.config import LOG_BACKUP_COUNT, LOG_DATE_FORMAT, LOG_DIR, LOG_FORMAT, LOG_MAX_BYTES

logger = logging.getLogger(__name__)

CONFIG_PATH = "logging_config.json"
LOG_FILENAME = "nopal.log"

STATE_LEVELS = {
    "normal": logging.NOTSET,          # hereda el nivel general
    "info": logging.INFO,              # información, avisos y errores (aunque el general sea más bajo)
    "warnings": logging.WARNING,       # solo avisos y errores
    "errors": logging.ERROR,           # solo errores
    "silenced": logging.CRITICAL + 10,  # nada
}
# Estados de la lista técnica (Configuración avanzada), sin cambios.
SOURCE_STATES = ["normal", "warnings", "errors", "silenced"]
GROUPS = ("nopal", "plugins", "libraries")

# ── Capa amigable (Configuración → Registro) ──
#
# Nivel general: lo único que la mayoría necesita elegir.
#   basic      → solo avisos y errores (WARNING)
#   normal     → información, avisos y errores (INFO); recomendado
#   detailed   → INFO en general y DEBUG solo para NOPAL y sus plugins
#   diagnostic → DEBUG en todo, librerías incluidas
GENERAL_LEVELS = {"basic": logging.WARNING, "normal": logging.INFO,
                  "detailed": logging.INFO, "diagnostic": logging.DEBUG}
_OWN_PREFIXES = ("backend", "nopal_plugins")  # lo que "detallado" sube a DEBUG

# Componentes: áreas funcionales reales de NOPAL → prefijos de sus loggers
# reales (módulos con `getLogger(__name__)`, paquetes de plugins, librerías).
# No existen en el almacenamiento: son una vista sobre `sources`. Láser y CNC
# van juntos porque los atiende el mismo módulo (laser_service). Lo que no está
# aquí queda bajo el nivel general (y en la lista técnica).
COMPONENTS: List[Tuple[str, Tuple[str, ...]]] = [
    ("system", ("backend.main", "backend.api.status", "backend.api.config_backup",
                "backend.services.system_service", "backend.services.maintenance_service",
                "backend.services.auth_service", "backend.services.config_backup_service",
                "backend.services.logging_config_service", "backend.services.machine_identity")),
    ("printers", ("backend.api.printers", "backend.api.console", "backend.services.klipper_service",
                  "backend.services.marlin_printer_service", "backend.services.marlin_driver",
                  "backend.services.bambu_service", "backend.services.elegoo_service",
                  "backend.services.flashforge_service")),
    ("laser", ("backend.services.laser_service", "backend.services.gcode_bounds")),
    ("led_matrix", ("pypixelcolor", "nopal_plugins.matriz_led")),
    ("ai", ("backend.api.ai", "backend.services.ai_actions", "backend.services.ai_agent",
            "backend.services.ai_config_service", "backend.services.ai_conversations_service",
            "backend.services.ai_provider", "backend.services.ai_router", "backend.services.ai_tools")),
    ("tunascreen", ("backend.api.tunascreen", "backend.services.tunascreen_service")),
    ("cameras", ("nopal_plugins.camera_viewer",)),
    ("accessories", ("nopal_plugins.arduino_accessories",)),
    ("materials", ("nopal_plugins.spoolman",)),
    ("plugins", ("backend.services.plugin_installer_service", "backend.services.plugin_loader_service")),
    ("network", ("httpx", "urllib3", "websockets", "paho")),
]
COMPONENT_STATES = ["inherit", "info", "warnings", "errors", "silenced"]
_COMPONENT_IDS = {cid for cid, _ in COMPONENTS}

MIN_MAX_BYTES, MAX_MAX_BYTES = 256 * 1024, 100 * 1024 * 1024
MIN_BACKUPS, MAX_BACKUPS = 0, 50
MIN_WINDOW_S, MAX_WINDOW_S = 60, 3600
MAX_TRACKED_MESSAGES = 1000
_SWEEP_EVERY_S = 30

DEFAULT_CONFIG: Dict[str, Any] = {
    "level": "normal",
    # Componente Matriz LED en "Solo errores": su librería avisa en cada
    # imagen que manda el plugin (le falta la info del dispositivo); los
    # errores sí se ven.
    "sources": {"pypixelcolor": "errors", "nopal_plugins.matriz_led": "errors"},
    "folder": LOG_DIR,
    "max_bytes": LOG_MAX_BYTES,
    "backup_count": LOG_BACKUP_COUNT,
    "console": True,
    "dedup": {"enabled": True, "window_s": 600},
}

_SOURCE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_\-]*(\.[A-Za-z0-9_\-]+)*$")
_UNMANAGED_PREFIXES = ("uvicorn",)


class LoggingConfigError(ValueError):
    """Configuración de logs inválida (el router la traduce a 400)."""


# ── Persistencia y validación ──

def _base_dir() -> Path:
    """Única carpeta base permitida: la de logs que ya usaba NOPAL (`logs/`,
    relativa al directorio de trabajo del servicio)."""
    return (Path.cwd() / LOG_DIR).resolve()


def _validate_folder(value: Any) -> str:
    """`logs` o una subcarpeta suya, como ruta relativa normalizada. Nada
    absoluto, nada con `..` y nada que, resuelto (enlaces incluidos), salga de
    `logs/`."""
    if not isinstance(value, str) or not value.strip():
        raise LoggingConfigError("La carpeta de logs es obligatoria")
    raw = value.strip().replace("\\", "/").rstrip("/")
    if raw.startswith("/") or ".." in raw.split("/"):
        raise LoggingConfigError(f"La carpeta de logs debe estar dentro de '{LOG_DIR}/'")
    base = _base_dir()
    resolved = (Path.cwd() / raw).resolve()
    if resolved != base and base not in resolved.parents:
        raise LoggingConfigError(f"La carpeta de logs debe estar dentro de '{LOG_DIR}/'")
    relative = resolved.relative_to(Path.cwd().resolve())
    return relative.as_posix()


def _int_in(value: Any, low: int, high: int, label: str) -> int:
    if isinstance(value, bool):
        raise LoggingConfigError(f"{label} inválido")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise LoggingConfigError(f"{label} inválido")
    if not low <= number <= high:
        raise LoggingConfigError(f"{label} debe estar entre {low} y {high}")
    return number


def _validate_source(name: Any) -> str:
    if not isinstance(name, str) or not _SOURCE_RE.match(name) or name == "root":
        raise LoggingConfigError(f"Fuente inválida: {name}")
    if any(name == p or name.startswith(p + ".") for p in _UNMANAGED_PREFIXES):
        raise LoggingConfigError(f"La fuente {name} no se administra desde aquí")
    return name


def validate_config(config: Any) -> Dict[str, Any]:
    """Valida y normaliza una configuración completa. Levanta
    LoggingConfigError ante cualquier campo inválido."""
    if not isinstance(config, dict):
        raise LoggingConfigError("La configuración debe ser un objeto")
    level = config.get("level", "normal")
    if level not in GENERAL_LEVELS:
        raise LoggingConfigError(f"Nivel de registro inválido: {level}")
    sources = config.get("sources", {})
    if not isinstance(sources, dict):
        raise LoggingConfigError("Las fuentes deben ser un objeto {fuente: estado}")
    sources = _apply_components(sources, config.get("components"))
    clean_sources = {}
    for name, state in sources.items():
        if state not in STATE_LEVELS:
            raise LoggingConfigError(f"Estado inválido para {name}: {state}")
        clean_sources[_validate_source(name)] = state
    dedup = config.get("dedup", DEFAULT_CONFIG["dedup"])
    if not isinstance(dedup, dict) or not isinstance(dedup.get("enabled", True), bool):
        raise LoggingConfigError("Configuración de repetidos inválida")
    console = config.get("console", True)
    if not isinstance(console, bool):
        raise LoggingConfigError("La copia a consola debe ser verdadero o falso")
    return {
        "level": level,
        "sources": dict(sorted(clean_sources.items())),
        "folder": _validate_folder(config.get("folder", LOG_DIR)),
        "max_bytes": _int_in(config.get("max_bytes", LOG_MAX_BYTES), MIN_MAX_BYTES, MAX_MAX_BYTES, "El tamaño por archivo"),
        "backup_count": _int_in(config.get("backup_count", LOG_BACKUP_COUNT), MIN_BACKUPS, MAX_BACKUPS, "La cantidad de archivos"),
        "console": console,
        "dedup": {
            "enabled": dedup.get("enabled", True),
            "window_s": _int_in(dedup.get("window_s", 600), MIN_WINDOW_S, MAX_WINDOW_S, "La ventana de repetidos"),
        },
    }


def _apply_components(sources: Dict[str, Any], components: Any) -> Dict[str, Any]:
    """Traduce los estados por componente (Configuración → Registro) a estados
    por fuente: `inherit` borra la entrada de cada logger del componente; los
    demás la fijan. `custom` (mezcla hecha en la lista técnica) no toca nada."""
    if components is None:
        return sources
    if not isinstance(components, dict):
        raise LoggingConfigError("Los componentes deben ser un objeto {componente: estado}")
    result = dict(sources)
    prefixes = dict(COMPONENTS)
    for component, state in components.items():
        if component not in _COMPONENT_IDS:
            raise LoggingConfigError(f"Componente desconocido: {component}")
        if state == "custom":
            continue
        if state not in COMPONENT_STATES:
            raise LoggingConfigError(f"Estado inválido para {component}: {state}")
        for prefix in prefixes[component]:
            if state == "inherit":
                result.pop(prefix, None)
            else:
                result[prefix] = state
    return result


def get_config() -> Dict[str, Any]:
    """La configuración guardada, validada. Si falta o está dañada, los
    valores por omisión (nunca un error que impida arrancar)."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        return validate_config({**DEFAULT_CONFIG, **stored})
    except FileNotFoundError:
        return validate_config(DEFAULT_CONFIG)
    except (OSError, ValueError):
        # ValueError incluye JSON dañado y LoggingConfigError.
        logger.warning(f"{CONFIG_PATH} ilegible o inválido; se usan los valores por omisión")
        return validate_config(DEFAULT_CONFIG)


def _write_config(config: Dict[str, Any]) -> None:
    directory = os.path.dirname(os.path.abspath(CONFIG_PATH))
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, prefix=".logging_config.",
                                     suffix=".tmp", delete=False) as handle:
        json.dump(config, handle, indent=2, ensure_ascii=False)
        temp = handle.name
    os.replace(temp, CONFIG_PATH)


def save_config(config: Any) -> Dict[str, Any]:
    """Valida, guarda (atómico) y aplica en caliente."""
    validated = validate_config(config)
    _write_config(validated)
    apply_config(validated)
    return validated


# ── Repetidos ──

class RepeatFilter(logging.Filter):
    """Agrupa mensajes idénticos (fuente + nivel + mensaje formateado) dentro
    de una ventana. La decisión se toma una vez por registro y se comparte
    entre los handlers de NOPAL (archivo y consola) para no contar doble."""

    _MARK = "_nopal_repeat"

    def __init__(self, window_s: int, enabled: bool = True):
        super().__init__()
        self.window_s = window_s
        self.enabled = enabled
        self._lock = threading.Lock()
        self._seen: Dict[Tuple[str, int, str], List[Any]] = {}  # clave → [inicio, repeticiones]
        self._last_sweep = time.monotonic()
        self.handlers: List[logging.Handler] = []

    def filter(self, record: logging.LogRecord) -> bool:
        decided = getattr(record, self._MARK, None)
        if decided is not None:
            return decided
        if not self.enabled:
            setattr(record, self._MARK, True)
            return True
        try:
            key = (record.name, record.levelno, record.getMessage())
        except Exception:
            setattr(record, self._MARK, True)
            return True
        now = time.monotonic()
        summaries = []
        with self._lock:
            entry = self._seen.get(key)
            if entry is not None and now - entry[0] < self.window_s:
                entry[1] += 1
                allow = False
            else:
                if entry is not None and entry[1]:
                    summaries.append((key, entry[1], now - entry[0]))
                self._seen[key] = [now, 0]
                allow = True
            if now - self._last_sweep >= _SWEEP_EVERY_S or len(self._seen) > MAX_TRACKED_MESSAGES:
                summaries.extend(self._sweep(now, force_oldest=len(self._seen) > MAX_TRACKED_MESSAGES))
        setattr(record, self._MARK, allow)
        self._emit(summaries)
        return allow

    def _sweep(self, now: float, force_oldest: bool = False) -> List[Tuple[Tuple[str, int, str], int, float]]:
        self._last_sweep = now
        out = []
        for key, (start, count) in list(self._seen.items()):
            if now - start >= self.window_s:
                if count:
                    out.append((key, count, now - start))
                del self._seen[key]
        if force_oldest:
            # Tope de memoria: una fuente con mensajes siempre distintos no
            # debe hacer crecer esto sin fin. Se cierra lo más viejo (con su
            # resumen si tenía repeticiones).
            for key, (start, count) in sorted(self._seen.items(), key=lambda item: item[1][0]):
                if len(self._seen) <= MAX_TRACKED_MESSAGES // 2:
                    break
                if count:
                    out.append((key, count, now - start))
                del self._seen[key]
        return out

    def flush(self) -> None:
        """Escribe los resúmenes pendientes (antes de reconfigurar o apagar)."""
        with self._lock:
            pending = [(key, count, time.monotonic() - start) for key, (start, count) in self._seen.items() if count]
            self._seen.clear()
        self._emit(pending)

    def _emit(self, summaries) -> None:
        for (name, levelno, message), count, elapsed in summaries:
            minutes = max(1, round(elapsed / 60))
            record = logging.LogRecord(
                name, levelno, __file__, 0,
                f"[repetido] {message} — se repitió {count} veces en {minutes} min", None, None,
            )
            setattr(record, self._MARK, True)
            for handler in list(self.handlers):
                try:
                    if record.levelno >= handler.level:
                        handler.handle(record)
                except Exception:
                    pass


# ── Aplicación ──

_state_lock = threading.RLock()
_file_handler: Optional[RotatingFileHandler] = None
_console_handler: Optional[logging.StreamHandler] = None
_repeat_filter: Optional[RepeatFilter] = None
_configured_sources: set = set()
_current: Dict[str, Any] = {}


def current_log_file() -> str:
    """Ruta vigente del archivo de log (la leen el visor y Eventos recientes)."""
    folder = (_current or get_config())["folder"]
    return os.path.join(folder, LOG_FILENAME)


def apply_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Aplica la configuración al logging del proceso, en caliente: niveles por
    fuente, handlers de archivo y consola (solo los de NOPAL; cualquier otro
    handler del logger raíz se respeta) y el filtro de repetidos."""
    global _file_handler, _console_handler, _repeat_filter, _current
    config = validate_config(config) if config is not None else get_config()
    with _state_lock:
        root = logging.getLogger()
        root.setLevel(GENERAL_LEVELS[config["level"]])

        # Niveles por fuente; las que salen de la configuración vuelven a heredar.
        for name in _configured_sources - set(config["sources"]):
            logging.getLogger(name).setLevel(logging.NOTSET)
        # "Detallado": DEBUG solo para NOPAL y sus plugins (salvo que la fuente
        # tenga su propio estado); en los demás niveles heredan el general.
        for prefix in _OWN_PREFIXES:
            if prefix not in config["sources"]:
                logging.getLogger(prefix).setLevel(
                    logging.DEBUG if config["level"] == "detailed" else logging.NOTSET)
        for name, state in config["sources"].items():
            logging.getLogger(name).setLevel(STATE_LEVELS[state])
        _configured_sources.clear()
        _configured_sources.update(config["sources"])

        if _repeat_filter is not None:
            _repeat_filter.flush()  # nada pendiente se pierde al reconfigurar
        _repeat_filter = RepeatFilter(config["dedup"]["window_s"], config["dedup"]["enabled"])
        formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT)

        file_path = os.path.join(config["folder"], LOG_FILENAME)
        os.makedirs(config["folder"], exist_ok=True)
        new_file = RotatingFileHandler(file_path, maxBytes=config["max_bytes"],
                                       backupCount=config["backup_count"], encoding="utf-8")
        new_file.setFormatter(formatter)
        new_file.addFilter(_repeat_filter)
        old_file, _file_handler = _file_handler, new_file
        root.addHandler(new_file)
        if old_file is not None:
            root.removeHandler(old_file)
            old_file.close()

        if _console_handler is not None:
            root.removeHandler(_console_handler)
            _console_handler = None
        if config["console"]:
            _console_handler = logging.StreamHandler()
            _console_handler.setFormatter(formatter)
            _console_handler.addFilter(_repeat_filter)
            root.addHandler(_console_handler)

        _repeat_filter.handlers = [h for h in (_file_handler, _console_handler) if h is not None]
        _current = config
    return config


def flush_repeats() -> None:
    """Resúmenes pendientes al apagar NOPAL."""
    with _state_lock:
        if _repeat_filter is not None:
            _repeat_filter.flush()


# ── Fuentes y lectura ──

def _group_of(name: str) -> str:
    if name == "backend" or name.startswith("backend."):
        return "nopal"
    if name.startswith("nopal_plugins."):
        return "plugins"
    return "libraries"


def _source_key(name: str) -> Optional[str]:
    """Nombre con el que se ofrece una fuente: NOPAL por módulo, un plugin por
    su paquete (`nopal_plugins.<id>`), una librería por su paquete raíz."""
    if any(name == p or name.startswith(p + ".") for p in _UNMANAGED_PREFIXES):
        return None
    group = _group_of(name)
    if group == "nopal":
        return name
    parts = name.split(".")
    if group == "plugins":
        return ".".join(parts[:2]) if len(parts) >= 2 else None
    return parts[0]


def list_sources() -> List[Dict[str, Any]]:
    """Fuentes reales del proceso (`logging.root.manager.loggerDict`) más las
    que ya tienen configuración guardada, con su grupo y estado."""
    config = _current or get_config()
    names = set(config["sources"])
    for name, item in list(logging.root.manager.loggerDict.items()):
        if isinstance(item, logging.Logger):
            key = _source_key(name)
            if key:
                names.add(key)
    return [
        {"name": name, "group": _group_of(name), "state": config["sources"].get(name, "normal"),
         "component": component_of(name)}
        for name in sorted(names, key=lambda n: (GROUPS.index(_group_of(n)), n))
    ]


def source_threshold(name: str) -> int:
    """Nivel mínimo vigente para una fuente según la configuración (prefijo
    más largo), SIN crear loggers. Para filtrar líneas ya escritas (p. ej.
    Eventos recientes) que hoy no se escribirían."""
    config = _current or get_config()
    base = GENERAL_LEVELS[config["level"]]
    if config["level"] == "detailed" and any(name == p or name.startswith(p + ".") for p in _OWN_PREFIXES):
        base = logging.DEBUG
    best, level = -1, base
    for prefix, state in config["sources"].items():
        if (name == prefix or name.startswith(prefix + ".")) and len(prefix) > best:
            best = len(prefix)
            level = STATE_LEVELS[state] if state != "normal" else base
    return level


def _existing_loggers() -> set:
    return {name for name, item in list(logging.root.manager.loggerDict.items()) if isinstance(item, logging.Logger)}


def component_of(name: str) -> Optional[str]:
    """Componente al que pertenece una fuente técnica (None si a ninguno)."""
    best, found = -1, None
    for component, prefixes in COMPONENTS:
        for prefix in prefixes:
            if (name == prefix or name.startswith(prefix + ".")) and len(prefix) > best:
                best, found = len(prefix), component
    return found


def list_components() -> List[Dict[str, Any]]:
    """Componentes con al menos un logger real en este proceso (o con estado
    guardado), con su estado: el común de sus fuentes, `inherit` si ninguna
    tiene estado propio, o `custom` si se mezclaron en la lista técnica."""
    config = _current or get_config()
    existing = _existing_loggers()
    result = []
    for component, prefixes in COMPONENTS:
        present = any(n == p or n.startswith(p + ".") for p in prefixes for n in existing)
        states = {("inherit" if config["sources"].get(p, "normal") == "normal" else config["sources"][p]) for p in prefixes}
        if not present and states == {"inherit"}:
            continue
        result.append({"id": component, "state": states.pop() if len(states) == 1 else "custom"})
    return result


def public_view() -> Dict[str, Any]:
    config = _current or get_config()
    return {
        "config": config,
        "sources": list_sources(),
        "states": SOURCE_STATES,
        "level": config["level"],
        "levels": list(GENERAL_LEVELS),
        "components": list_components(),
        "component_states": COMPONENT_STATES,
        "groups": list(GROUPS),
        "log_file": current_log_file(),
        "limits": {
            "folder_base": LOG_DIR,
            "max_bytes": [MIN_MAX_BYTES, MAX_MAX_BYTES],
            "backup_count": [MIN_BACKUPS, MAX_BACKUPS],
            "window_s": [MIN_WINDOW_S, MAX_WINDOW_S],
        },
    }
