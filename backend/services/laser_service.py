import asyncio
import itertools
import json
import re
import socket
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import requests
import websockets

DEFAULT_LASER_HOST = "192.168.0.61"
HTTP_TIMEOUT = 4
WS_PORT = 81
REGISTRY_PATH = "laser_registry.json"

STATUS_RE = re.compile(
    r"<(?P<state>\w+)(?::\d+)?\|MPos:(?P<x>[-\d.]+),(?P<y>[-\d.]+),(?P<z>[-\d.]+)"
    r"(?:\|[^|>]*)*\|FS:(?P<feed>[-\d.]+),(?P<speed>[-\d.]+)"
)

_active_host = DEFAULT_LASER_HOST


def get_active_host() -> str:
    return _active_host


def set_active_host(host: str):
    global _active_host
    _active_host = host


def _is_usb_host(host: str) -> bool:
    return host.startswith("usb:")


def _usb_device(host: str) -> str:
    return host[len("usb:"):]


# ── Registro de placas conocidas (persistido) ──

def _load_registry() -> List[Dict[str, Any]]:
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _save_registry(entries: List[Dict[str, Any]]):
    try:
        with open(REGISTRY_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2)
    except OSError:
        pass


def get_registered_lasers() -> List[Dict[str, Any]]:
    return _load_registry()


def register_laser(host: str, name: str, transport: str) -> Dict[str, Any]:
    entries = [e for e in _load_registry() if e.get("host") != host]
    entry = {"host": host, "name": name, "transport": transport}
    entries.append(entry)
    _save_registry(entries)
    return entry


def unregister_laser(host: str) -> bool:
    entries = _load_registry()
    filtered = [e for e in entries if e.get("host") != host]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
    return changed


# ── Descubrimiento por red (ESP3D) ──

def _get_local_subnet() -> str:
    """Detecta el prefijo /24 de la red local del servidor (ej. '192.168.0')."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            local_ip = sock.getsockname()[0]
        return ".".join(local_ip.split(".")[:3])
    except Exception:
        return ".".join(DEFAULT_LASER_HOST.split(".")[:3])


def _probe_host(ip: str, timeout: float) -> Optional[Dict[str, Any]]:
    """Prueba si `ip` responde como una placa ESP3D (comando [ESP420])."""
    try:
        response = requests.get(
            f"http://{ip}/command",
            params={"commandText": "[ESP420]"},
            timeout=timeout,
        )
        if response.status_code != 200 or "Hostname" not in response.text:
            return None

        info: Dict[str, str] = {}
        for line in response.text.splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                info[key.strip()] = value.strip()

        return {
            "host": ip,
            "hostname": info.get("Hostname", ""),
            "firmware": info.get("Firmware") or info.get("FW version", ""),
        }
    except requests.exceptions.RequestException:
        return None


def _scan_network_sync(timeout: float = 0.4, max_workers: int = 60) -> List[Dict[str, Any]]:
    subnet = _get_local_subnet()
    candidates = [f"{subnet}.{i}" for i in range(1, 255)]
    found: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for result in executor.map(lambda ip: _probe_host(ip, timeout), candidates):
            if result:
                found.append(result)
    return found


async def scan_network() -> List[Dict[str, Any]]:
    """Escanea la red local (en un hilo aparte) buscando placas ESP3D/GRBL."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _scan_network_sync)


# ── Detección de placas por USB ──
# Chips USB-serial típicos de controladoras GRBL/ESP32 (Sculpfun, DLC32, etc.)
KNOWN_USB_CHIPS = [
    {"vid": 0x1A86, "pid": 0x7523, "label": "CH340"},
    {"vid": 0x1A86, "pid": 0x5523, "label": "CH340K"},
    {"vid": 0x10C4, "pid": 0xEA60, "label": "CP2102/CP2109"},
    {"vid": 0x303A, "pid": None, "label": "ESP32 (USB nativo)"},
]


def list_usb_laser_ports() -> List[Dict[str, Any]]:
    """Lista los puertos serie USB conectados que coinciden con chips
    típicos de controladoras láser (CH340, CP2102, ESP32)."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return []

    results = []
    for port in list_ports.comports():
        if port.vid is None:
            continue

        chip_label = None
        for chip in KNOWN_USB_CHIPS:
            if chip["vid"] == port.vid and (chip["pid"] is None or chip["pid"] == port.pid):
                chip_label = chip["label"]
                break

        if not chip_label:
            continue

        vid_pid = f"{port.vid:04X}:{port.pid:04X}" if port.pid is not None else f"{port.vid:04X}"
        results.append({
            "device": port.device,
            "description": port.description or "",
            "manufacturer": port.manufacturer or "",
            "chip": chip_label,
            "vid_pid": vid_pid,
        })

    return results


def _command_url(host: str) -> str:
    return f"http://{host}/command"


REALTIME_SERIAL_COMMANDS = {"?", "!", "~", "\x18"}


def _send_serial_command(host: str, command: str) -> bool:
    ser = _serial_connections.get(host)
    if ser is None:
        ensure_listener(host)
        ser = _serial_connections.get(host)
        if ser is None:
            return False
    try:
        payload = command if command in REALTIME_SERIAL_COMMANDS else command + "\n"
        ser.write(payload.encode("utf-8"))
        return True
    except Exception:
        return False


def send_raw_command(host: str, command: str) -> bool:
    """Envía un comando GRBL. Por red vía HTTP (ESP3D no responde el resultado en
    el cuerpo, la respuesta real llega por websocket); por USB, escribiendo
    directo al puerto serie."""
    if _is_usb_host(host):
        return _send_serial_command(host, command)
    try:
        response = requests.get(
            _command_url(host),
            params={"commandText": command},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        return True
    except requests.exceptions.RequestException:
        return False


def parse_status_line(line: str) -> Optional[Dict[str, Any]]:
    match = STATUS_RE.search(line)
    if not match:
        return None
    return {
        "state": match.group("state"),
        "x": float(match.group("x")),
        "y": float(match.group("y")),
        "z": float(match.group("z")),
        "feed": float(match.group("feed")),
        "speed": float(match.group("speed")),
    }


def get_board_info(host: str = DEFAULT_LASER_HOST) -> Dict[str, Any]:
    """Info de la placa: por red, comando [ESP420] (chip, firmware, red...);
    por USB, los datos del descriptor serie (chip, VID:PID, descripción)."""
    if _is_usb_host(host):
        device = _usb_device(host)
        for port in list_usb_laser_ports():
            if port["device"] == device:
                return {
                    "Device": port["device"],
                    "Chip": port["chip"],
                    "Description": port["description"],
                    "VID:PID": port["vid_pid"],
                }
        return {"Device": device}

    try:
        response = requests.get(
            _command_url(host),
            params={"commandText": "[ESP420]"},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        text = response.text
    except requests.exceptions.RequestException:
        return {}

    info: Dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        info[key.strip()] = value.strip()
    return info


# ── Tarjeta SD (ESP3D, solo placas de red) ──
#
# El endpoint real de ESP3D para la SD (descubierto inspeccionando su propio
# WebUI) es `/upload`, no `/files` (ese solo sirve la memoria interna SPIFFS
# y en esta placa siempre reporta vacío). `/upload?path=X` (GET) lista, y con
# `action=delete|deletedir|createdir&filename=Y` administra archivos/carpetas.
# La subida real es POST multipart con un campo `path`, un campo
# `<path><nombre>S` con el tamaño en bytes, y el archivo en `myfile[]`.

SD_HTTP_TIMEOUT = 30


def _normalize_sd_path(path: str) -> str:
    path = path or "/"
    if not path.startswith("/"):
        path = "/" + path
    if not path.endswith("/"):
        path += "/"
    return path


def sd_list_files(host: str, path: str = "/") -> Dict[str, Any]:
    if _is_usb_host(host):
        return {"status": "error", "message": "La tarjeta SD solo está disponible en placas de red (ESP3D)", "files": [], "path": path}
    try:
        response = requests.get(
            f"http://{host}/upload",
            params={"path": _normalize_sd_path(path)},
            timeout=SD_HTTP_TIMEOUT,
        )
        response.raise_for_status()
        return response.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"status": "error", "message": str(e), "files": [], "path": path}


def sd_create_folder(host: str, path: str, name: str) -> bool:
    try:
        response = requests.get(
            f"http://{host}/upload",
            params={"path": _normalize_sd_path(path), "action": "createdir", "filename": name},
            timeout=HTTP_TIMEOUT,
        )
        return response.ok
    except requests.exceptions.RequestException:
        return False


def sd_delete_entry(host: str, path: str, name: str, is_dir: bool) -> bool:
    action = "deletedir" if is_dir else "delete"
    try:
        response = requests.get(
            f"http://{host}/upload",
            params={"path": _normalize_sd_path(path), "action": action, "filename": name},
            timeout=HTTP_TIMEOUT,
        )
        return response.ok
    except requests.exceptions.RequestException:
        return False


def sd_upload_file(host: str, path: str, filename: str, file_bytes: bytes) -> bool:
    norm_path = _normalize_sd_path(path)
    full_name = f"{norm_path}{filename}"
    size_field = f"{full_name}S"
    try:
        response = requests.post(
            f"http://{host}/upload",
            data={"path": norm_path, size_field: str(len(file_bytes))},
            files={"myfile[]": (full_name, file_bytes)},
            timeout=120,
        )
        return response.ok
    except requests.exceptions.RequestException:
        return False


# ── Conexión (websocket o serie) única y compartida por host ──
#
# La placa (ESP32 con ESP3D) solo soporta UN cliente websocket a la vez: abrir
# varias conexiones concurrentes hace que deje de responder por completo
# (se comprobó en vivo). Por eso aquí se mantiene una sola conexión persistente
# de fondo por host (websocket para red, hilo de lectura para USB), y todo lo
# demás (status, consola, ajustes, trabajos) se suscribe a esa transmisión en
# vez de abrir su propia conexión.

_console_buffers: Dict[str, deque] = {}
_subscribers: Dict[str, List[asyncio.Queue]] = {}
_listener_ready_events: Dict[str, asyncio.Event] = {}

_listener_tasks: Dict[str, asyncio.Task] = {}  # red (websocket)

_serial_connections: Dict[str, Any] = {}  # usb (serial.Serial), keyed por host "usb:/dev/..."
_serial_reader_threads: Dict[str, threading.Thread] = {}
_serial_stop_flags: Dict[str, threading.Event] = {}


async def _ws_listener_loop(host: str):
    uri = f"ws://{host}:{WS_PORT}"
    buffer = _console_buffers.setdefault(host, deque(maxlen=300))
    ready_event = _listener_ready_events.setdefault(host, asyncio.Event())
    while True:
        try:
            async with websockets.connect(uri, open_timeout=HTTP_TIMEOUT) as ws:
                ready_event.set()
                async for message in ws:
                    if isinstance(message, bytes):
                        message = message.decode("utf-8", errors="ignore")
                    # Un solo frame puede traer varias líneas separadas por \r\n
                    # (por ejemplo, el volcado completo de "$$").
                    for line in message.splitlines():
                        text = line.strip()
                        if not text:
                            continue
                        buffer.append({"message": text, "time": time.time()})
                        for queue in list(_subscribers.get(host, [])):
                            queue.put_nowait(text)
        except Exception:
            pass
        ready_event.clear()
        await asyncio.sleep(3)


def _ensure_ws_listener(host: str):
    task = _listener_tasks.get(host)
    if task is None or task.done():
        _listener_ready_events.setdefault(host, asyncio.Event()).clear()
        _subscribers.setdefault(host, [])
        _listener_tasks[host] = asyncio.create_task(_ws_listener_loop(host))


def _serial_reader_loop(host: str, device: str, baud: int, loop: asyncio.AbstractEventLoop):
    import serial

    buffer = _console_buffers.setdefault(host, deque(maxlen=300))
    stop_flag = _serial_stop_flags[host]

    try:
        ser = serial.Serial(device, baud, timeout=0.5)
        _serial_connections[host] = ser
    except Exception:
        return

    loop.call_soon_threadsafe(_listener_ready_events.setdefault(host, asyncio.Event()).set)

    while not stop_flag.is_set():
        try:
            raw = ser.readline()
        except Exception:
            break
        if not raw:
            continue
        text = raw.decode("utf-8", errors="ignore").strip()
        if not text:
            continue
        buffer.append({"message": text, "time": time.time()})
        for queue in list(_subscribers.get(host, [])):
            loop.call_soon_threadsafe(queue.put_nowait, text)

    try:
        ser.close()
    except Exception:
        pass
    _serial_connections.pop(host, None)


def _ensure_serial_listener(host: str, baud: int = 115200):
    thread = _serial_reader_threads.get(host)
    if thread is not None and thread.is_alive():
        return
    _listener_ready_events.setdefault(host, asyncio.Event()).clear()
    _subscribers.setdefault(host, [])
    _serial_stop_flags[host] = threading.Event()
    loop = asyncio.get_event_loop()
    device = _usb_device(host)
    thread = threading.Thread(
        target=_serial_reader_loop,
        args=(host, device, baud, loop),
        daemon=True,
    )
    _serial_reader_threads[host] = thread
    thread.start()


def ensure_listener(host: str = DEFAULT_LASER_HOST):
    """Garantiza que exista una única conexión persistente hacia `host`
    (websocket para placas de red, hilo de lectura serie para USB)."""
    if _is_usb_host(host):
        _ensure_serial_listener(host)
    else:
        _ensure_ws_listener(host)


async def ensure_listener_ready(host: str = DEFAULT_LASER_HOST, timeout: float = 5.0):
    """Como `ensure_listener`, pero espera a que la conexión esté realmente
    establecida antes de continuar (evita perder las primeras líneas de la
    respuesta a un comando enviado justo después)."""
    ensure_listener(host)
    event = _listener_ready_events.get(host)
    if event is None:
        return
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass


def _subscribe(host: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(host, []).append(queue)
    return queue


def _unsubscribe(host: str, queue: asyncio.Queue):
    subs = _subscribers.get(host)
    if subs and queue in subs:
        subs.remove(queue)


def get_console_buffer(host: str = DEFAULT_LASER_HOST, count: int = 100) -> List[Dict[str, Any]]:
    messages = list(_console_buffers.get(host, []))
    return messages[-count:]


async def send_console_command(host: str, command: str) -> bool:
    await ensure_listener_ready(host)
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, send_raw_command, host, command)


async def get_status(host: str = DEFAULT_LASER_HOST, timeout: float = 3.0) -> Optional[Dict[str, Any]]:
    """Dispara '?' y espera la línea de estado de GRBL en la transmisión compartida."""
    await ensure_listener_ready(host)
    queue = _subscribe(host)
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, send_raw_command, host, "?")
        if not sent:
            return None
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            remaining = max(end_time - time.monotonic(), 0.1)
            try:
                text = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            parsed = parse_status_line(text)
            if parsed:
                return parsed
    finally:
        _unsubscribe(host, queue)
    return None


async def get_grbl_settings(host: str = DEFAULT_LASER_HOST, timeout: float = 5.0) -> List[Dict[str, str]]:
    """Obtiene los parámetros $$ actuales de la placa."""
    await ensure_listener_ready(host)
    queue = _subscribe(host)
    settings: List[Dict[str, str]] = []
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, send_raw_command, host, "$$")
        if not sent:
            return []
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            remaining = max(end_time - time.monotonic(), 0.1)
            try:
                text = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            if text.startswith("$") and "=" in text:
                key, _, value = text.partition("=")
                settings.append({"key": key.strip(), "value": value.strip()})
            elif text.lower() == "ok" and settings:
                break
    finally:
        _unsubscribe(host, queue)
    return settings


async def set_grbl_setting(host: str, key: str, value: str, timeout: float = 4.0) -> Dict[str, Any]:
    """Actualiza un parámetro $$ individual (ej. key='$0', value='10')."""
    await ensure_listener_ready(host)
    queue = _subscribe(host)
    command = f"{key}={value}"
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, send_raw_command, host, command)
        if not sent:
            return {"success": False, "message": "No se pudo enviar el comando"}
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            remaining = max(end_time - time.monotonic(), 0.1)
            try:
                text = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            normalized = text.lower()
            if normalized == "ok":
                return {"success": True}
            if normalized.startswith("error"):
                return {"success": False, "message": text}
    finally:
        _unsubscribe(host, queue)
    return {"success": False, "message": "Sin respuesta de la placa"}


class LaserJob:
    def __init__(self, host: str, lines: List[str], filename: str = "", source: str = "stream"):
        self.host = host
        self.lines = lines
        self.filename = filename
        self.source = source  # "stream" (línea por línea vía WiFi/USB) o "sd" (corre local desde la SD)
        self.total = len([line for line in lines if line.strip() and not line.strip().startswith((";", "("))])
        self.current = 0
        self.state = "running"
        self.error_message: Optional[str] = None
        self.cancel_requested = False
        self.pause_requested = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filename": self.filename,
            "source": self.source,
            "state": self.state,
            "current": self.current,
            "total": self.total,
            "error": self.error_message,
        }


# Un trabajo activo por placa (host) — así se puede correr un trabajo distinto
# en cada láser/impresora al mismo tiempo, sin que uno bloquee a los demás.
_jobs: Dict[str, LaserJob] = {}


async def _run_job(job: LaserJob):
    """Streaming línea por línea (WiFi/USB), esperando el 'ok' de cada línea."""
    await ensure_listener_ready(job.host)
    queue = _subscribe(job.host)
    loop = asyncio.get_event_loop()
    try:
        for line in job.lines:
            if job.cancel_requested:
                job.state = "cancelled"
                await loop.run_in_executor(None, send_raw_command, job.host, "\x18")
                return

            while job.pause_requested:
                await asyncio.sleep(0.3)
                if job.cancel_requested:
                    job.state = "cancelled"
                    await loop.run_in_executor(None, send_raw_command, job.host, "\x18")
                    return

            clean_line = line.strip()
            if not clean_line or clean_line.startswith((";", "(")):
                continue

            sent = await loop.run_in_executor(None, send_raw_command, job.host, clean_line)
            if not sent:
                job.state = "error"
                job.error_message = f"No se pudo enviar la línea {job.current + 1}"
                return

            acknowledged = False
            while not acknowledged:
                try:
                    text = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    job.state = "error"
                    job.error_message = f"Sin respuesta del láser en la línea {job.current + 1}"
                    return

                normalized = text.lower()
                if normalized == "ok":
                    acknowledged = True
                elif normalized.startswith("error") or normalized.startswith("alarm"):
                    job.state = "error"
                    job.error_message = f"{text} (línea {job.current + 1})"
                    return

            job.current += 1

        job.state = "completed"
    except Exception as e:
        job.state = "error"
        job.error_message = str(e)
    finally:
        _unsubscribe(job.host, queue)


async def _run_sd_job(job: LaserJob):
    """Corre un archivo ya subido a la SD directo en la placa ($F=archivo),
    sin transmitir línea por línea. El progreso se seduce del estado GRBL
    (Run -> Idle = terminado; Alarm = error)."""
    sd_filename = job.filename
    sent = await asyncio.get_event_loop().run_in_executor(
        None, send_raw_command, job.host, f"$F={sd_filename}"
    )
    if not sent:
        job.state = "error"
        job.error_message = "No se pudo iniciar el trabajo desde la SD"
        return

    await asyncio.sleep(2)  # da tiempo a que la placa deje Idle y entre a Run

    try:
        while True:
            if job.cancel_requested:
                await asyncio.get_event_loop().run_in_executor(None, send_raw_command, job.host, "\x18")
                job.state = "cancelled"
                return

            while job.pause_requested:
                await asyncio.sleep(0.5)
                if job.cancel_requested:
                    await asyncio.get_event_loop().run_in_executor(None, send_raw_command, job.host, "\x18")
                    job.state = "cancelled"
                    return

            status = await get_status(job.host, timeout=3)
            if status:
                state_value = (status.get("state") or "").lower()
                if state_value == "alarm":
                    job.state = "error"
                    job.error_message = "La placa reportó una alarma"
                    return
                if state_value == "idle":
                    job.state = "completed"
                    return

            await asyncio.sleep(2)
    except Exception as e:
        job.state = "error"
        job.error_message = str(e)


def start_job(host: str, gcode_text: str, filename: str = "") -> Dict[str, Any]:
    """Inicia streaming línea por línea (WiFi/USB) — para placas sin SD."""
    existing = _jobs.get(host)
    if existing is not None and existing.state in ("running", "paused"):
        raise RuntimeError("Ya hay un trabajo en curso en este láser")

    lines = gcode_text.splitlines()
    job = LaserJob(host, lines, filename, source="stream")
    _jobs[host] = job
    asyncio.create_task(_run_job(job))
    return job.to_dict()


def start_sd_job(host: str, sd_filename: str) -> Dict[str, Any]:
    """Inicia un trabajo ya subido a la SD, corriéndolo localmente en la placa."""
    existing = _jobs.get(host)
    if existing is not None and existing.state in ("running", "paused"):
        raise RuntimeError("Ya hay un trabajo en curso en este láser")

    job = LaserJob(host, [], sd_filename, source="sd")
    _jobs[host] = job
    asyncio.create_task(_run_sd_job(job))
    return job.to_dict()


def get_job_status(host: str) -> Dict[str, Any]:
    job = _jobs.get(host)
    if job is None:
        return {"filename": "", "source": "", "state": "idle", "current": 0, "total": 0, "error": None}
    return job.to_dict()


def pause_job(host: str) -> bool:
    job = _jobs.get(host)
    if job and job.state == "running":
        job.pause_requested = True
        job.state = "paused"
        send_raw_command(job.host, "!")
        return True
    return False


def resume_job(host: str) -> bool:
    job = _jobs.get(host)
    if job and job.state == "paused":
        job.pause_requested = False
        job.state = "running"
        send_raw_command(job.host, "~")
        return True
    return False


def cancel_job(host: str) -> bool:
    job = _jobs.get(host)
    if job and job.state in ("running", "paused"):
        job.cancel_requested = True
        job.pause_requested = False
        return True
    return False


def has_sd_card(host: str) -> bool:
    """Detecta si `host` tiene una tarjeta SD navegable (solo placas de red/ESP3D)."""
    if _is_usb_host(host):
        return False
    result = sd_list_files(host, "/")
    return result.get("status") == "Ok"


# ── Cola de trabajos ──

_queue_counter = itertools.count(1)
_laser_queue: List[Dict[str, Any]] = []


def add_to_queue(path: str, filename: str) -> Dict[str, Any]:
    entry = {
        "id": next(_queue_counter),
        "path": path,
        "filename": filename,
        "added_at": time.time(),
    }
    _laser_queue.append(entry)
    return entry


def get_queue() -> List[Dict[str, Any]]:
    return list(_laser_queue)


def remove_from_queue(entry_id: int) -> bool:
    global _laser_queue
    before = len(_laser_queue)
    _laser_queue = [item for item in _laser_queue if item["id"] != entry_id]
    return len(_laser_queue) < before


def pop_from_queue(entry_id: int) -> Optional[Dict[str, Any]]:
    global _laser_queue
    for index, item in enumerate(_laser_queue):
        if item["id"] == entry_id:
            return _laser_queue.pop(index)
    return None
