"""Impresoras 3D standalone que corren Marlin puro (sin Klipper/Moonraker).

Path paralelo al de klipper_service.py/printers.py: aquí NOPAL habla Marlin
directo, ya sea por serie USB o mediante el puente TCP de un módulo MKS WiFi.
Ambos transportes reutilizan marlin_driver.py y comparten el mismo spooler.
"""

import asyncio
import json
import logging
import os
import re
import threading
import time
from collections import deque
from typing import Any, Callable, Dict, List, Optional

from backend.services import marlin_driver, mks_wifi_transport

logger = logging.getLogger(__name__)

REGISTRY_PATH = "marlin_printer_registry.json"
_probe_firmware_info_cache: Dict[tuple, tuple] = {}
_probe_firmware_info_cache_lock = threading.Lock()


def _cache_probe_firmware_info(device: str, baud: int, info: Dict[str, str]) -> None:
    with _probe_firmware_info_cache_lock:
        _probe_firmware_info_cache[(device, baud)] = (time.monotonic(), dict(info))


def _take_cached_probe_firmware_info(device: str, baud: int) -> Optional[Dict[str, str]]:
    with _probe_firmware_info_cache_lock:
        cached = _probe_firmware_info_cache.pop((device, baud), None)
    if cached is None:
        return None
    saved_at, info = cached
    return info if time.monotonic() - saved_at <= 20 else None


# ── Registro de impresoras conocidas (persistido) ──

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


def get_registered_printers() -> List[Dict[str, Any]]:
    return _load_registry()


def _probe_marlin_sync(device: str, baud: int = 115200, timeout: float = 3.0) -> bool:
    """Handshake liviano y autocontenido, análogo a
    laser_service._probe_grbl_sync: abre su propia conexión (no la
    persistente de ensure_listener) y confirma una respuesta Marlin real.

    Por USB usa M115 (identificación oficial) porque algunos builds actuales,
    como Marlin 2.1.2.7 para ANET ET4 Pro, responden M115 correctamente pero
    no exponen M105 durante el alta. Exigir temperaturas rechazaba una placa
    válida. TCP conserva primero el probe M105 por compatibilidad con MKS.
    """
    if device.startswith("tcp://"):
        try:
            lines = mks_wifi_transport.query_lines(device, "M105", timeout)
        except (OSError, ValueError):
            return False
        return any(marlin_driver.TEMP_RE.search(line) for line in lines)

    try:
        import serial
    except ImportError:
        return False
    try:
        ser = serial.Serial(device, baud, timeout=0.5)
    except Exception:
        return False
    try:
        time.sleep(3)  # Varias placas resetean al abrir el puerto (DTR)
        try:
            ser.reset_input_buffer()
            # La línea vacía realinea parsers que dejaron un byte basura al
            # cambiar de baud; la ET4 observada hace exactamente eso.
            ser.write(b"\r\nM115\r\n")
        except Exception:
            return False
        end_time = time.monotonic() + timeout
        lines: List[str] = []
        while time.monotonic() < end_time:
            try:
                raw = ser.readline()
            except Exception:
                return False
            if not raw:
                continue
            text = raw.decode("utf-8", errors="ignore").strip()
            if not text:
                continue
            lines.append(text)
            if marlin_driver.TEMP_RE.search(text):
                return True
            firmware_info = marlin_driver.parse_firmware_info_lines(lines)
            if firmware_info:
                _cache_probe_firmware_info(device, baud, firmware_info)
                return True
        return False
    finally:
        try:
            ser.close()
        except Exception:
            pass


async def probe_marlin(device: str, baud: int = 115200, timeout: float = 3.0) -> bool:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _probe_marlin_sync, device, baud, timeout)


AUTOBAUD_CANDIDATES = (115200, 250000)


async def probe_marlin_autobaud(
    device: str, bauds: tuple = AUTOBAUD_CANDIDATES, timeout: float = 3.0
) -> Optional[int]:
    """Prueba cada baud de `bauds` en orden (mismo handshake que
    probe_marlin, un intento por baud) y devuelve el primero que responda
    como Marlin, o None si ninguno contestó. No prueba en paralelo a
    propósito -- abrir el mismo puerto serie dos veces a la vez es lo que
    _probe_marlin_sync evita adrede (ver su docstring)."""
    for baud in bauds:
        if await probe_marlin(device, baud, timeout):
            return baud
    return None


def _probe_marlin_firmware_info_sync(device: str, baud: int, timeout: float = 4.0) -> Optional[Dict[str, str]]:
    """M115, mismo criterio autocontenido que _probe_marlin_sync (conexión
    propia, no la persistente de ensure_listener) -- se llama justo después
    de un probe_marlin_autobaud exitoso, cuando todavía no existe ningún
    listener para esta impresora (recién se está por registrar)."""
    if device.startswith("tcp://"):
        try:
            lines = mks_wifi_transport.query_lines(device, "M115", timeout)
        except (OSError, ValueError):
            return None
        return marlin_driver.parse_firmware_info_lines(lines)

    try:
        import serial
    except ImportError:
        return None
    try:
        ser = serial.Serial(device, baud, timeout=0.5)
    except Exception:
        return None
    try:
        time.sleep(2)
        try:
            ser.reset_input_buffer()
            ser.write(b"M115\n")
        except Exception:
            return None
        lines: List[str] = []
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            try:
                raw = ser.readline()
            except Exception:
                break
            if not raw:
                continue
            text = raw.decode("utf-8", errors="ignore").strip()
            if not text:
                continue
            lines.append(text)
            if marlin_driver.OK_RE.match(text):
                break
        return marlin_driver.parse_firmware_info_lines(lines)
    finally:
        try:
            ser.close()
        except Exception:
            pass


async def probe_marlin_firmware_info(device: str, baud: int, timeout: float = 4.0) -> Optional[Dict[str, str]]:
    cached = _take_cached_probe_firmware_info(device, baud)
    if cached is not None:
        return cached
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _probe_marlin_firmware_info_sync, device, baud, timeout)


def _reconcile_usb_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Mismo patrón que laser_service._reconcile_usb_entries: autocorrige el
    `device` de cada impresora usando su ubicación física USB (estable) como
    ancla, confirmando con un handshake Marlin real antes de adoptar una
    ruta nueva. Si no confirma, marca 'conflict' en vez de tocar la ruta."""
    from backend.services.laser_service import _resolve_usb_location, _location_for_device

    changed = False
    result: List[Dict[str, Any]] = []

    for entry in entries:
        stored_device = entry.get("device", "")
        location = entry.get("location")

        if entry.get("transport") == "mks_wifi" or stored_device.startswith("tcp://"):
            result.append(entry)
            continue

        if not location:
            if os.path.exists(stored_device):
                found_location = _location_for_device(stored_device)
                if found_location:
                    entry = {**entry, "location": found_location}
                    changed = True
            result.append(entry)
            continue

        if entry.get("conflict"):
            resolved = _resolve_usb_location(location)
            if resolved == stored_device:
                entry = {**entry, "conflict": None}
                changed = True
            result.append(entry)
            continue

        resolved_device = _resolve_usb_location(location)
        if resolved_device is None or resolved_device == stored_device:
            result.append(entry)
            continue

        if _probe_marlin_sync(resolved_device, baud=entry.get("baud") or 115200):
            entry = {**entry, "device": resolved_device, "conflict": None}
            changed = True
            logger.info(f"Puerto USB renumerado, autocorregido: {stored_device} -> {resolved_device}")
        else:
            entry = {**entry, "conflict": "Puerto reasignado a otra placa — revisar cableado"}
            changed = True
            logger.warning(f"[{stored_device}] Conflicto: '{location}' ya no responde como Marlin (ahora en {resolved_device})")
        result.append(entry)

    if changed:
        _save_registry(result)
    return result


def get_registered_printers_with_status() -> List[Dict[str, Any]]:
    """Mismo criterio que laser_service para hosts USB: confirma que el
    puerto /dev/ttyUSBx sigue existiendo, y que la reconciliación (ver
    _reconcile_usb_entries) no la haya marcado en conflicto."""
    entries = _reconcile_usb_entries(_load_registry())
    result = []
    for entry in entries:
        device = entry.get("device", "")
        if entry.get("transport") == "mks_wifi" or device.startswith("tcp://"):
            # El firmware oficial admite un solo cliente y reemplaza el
            # anterior al aceptar otro. No hacer un probe paralelo si ya hay
            # listener: cortaría el canal usado por un trabajo en curso.
            online = device in _serial_connections or mks_wifi_transport.is_reachable(device)
        else:
            online = not entry.get("conflict") and os.path.exists(device)
        result.append({**entry, "online": online})
    return result


def register_printer(
    device: str,
    name: str,
    baud: int = 115200,
    verified_marlin: Optional[bool] = None,
    firmware_info: Optional[Dict[str, str]] = None,
    profile_id: Optional[str] = None,
    board_variant: Optional[str] = None,
    extruder_count: Optional[int] = None,
    transport: Optional[str] = None,
) -> Dict[str, Any]:
    from backend.services.laser_service import _location_for_device

    transport = transport or ("mks_wifi" if device.startswith("tcp://") else "usb_serial")
    if transport not in ("usb_serial", "mks_wifi"):
        raise ValueError("Transporte Marlin no soportado")
    if transport == "mks_wifi":
        host, port = mks_wifi_transport.parse_endpoint(device)
        device = mks_wifi_transport.make_endpoint(host, port)

    entries = [e for e in _load_registry() if e.get("device") != device]
    existing = next((e for e in _load_registry() if e.get("device") == device), None)
    entry = {
        "device": device,
        "name": name,
        "baud": baud,
        "registered_at": existing.get("registered_at") if existing else time.time(),
        "location": _location_for_device(device) if transport == "usb_serial" else None,
        "transport": transport,
        "verified_marlin": verified_marlin if verified_marlin is not None else (
            existing.get("verified_marlin") if existing else False
        ),
        # Lo que haya reportado M115 (FIRMWARE_NAME/MACHINE_TYPE/
        # EXTRUDER_COUNT/etc.), tal cual -- señal complementaria para
        # "Detectar automáticamente" en el alta con perfil de placa, nunca
        # obligatoria (no todo firmware reporta todos los campos). None si
        # el probe no llegó a correr o no devolvió nada.
        "firmware_info": firmware_info if firmware_info is not None else (
            existing.get("firmware_info") if existing else None
        ),
        # Perfil de placa (ver printer_profiles.py) -- los 3 quedan en None
        # para una impresora Marlin genérica sin perfil, exactamente el
        # comportamiento de antes de que esto existiera. La validación de
        # que board_variant/extruder_count tengan sentido para el
        # profile_id elegido vive en la capa de API (marlin_printers.py),
        # no acá -- este módulo solo persiste.
        "profile_id": profile_id if profile_id is not None else (
            existing.get("profile_id") if existing else None
        ),
        "board_variant": board_variant if board_variant is not None else (
            existing.get("board_variant") if existing else None
        ),
        "extruder_count": extruder_count if extruder_count is not None else (
            existing.get("extruder_count") if existing else None
        ),
    }
    entries.append(entry)
    _save_registry(entries)
    logger.info(f"Impresora Marlin registrada: {device} ({name}, {baud} baud)")
    return entry


def unregister_printer(device: str) -> bool:
    entries = _load_registry()
    filtered = [e for e in entries if e.get("device") != device]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        logger.info(f"Impresora Marlin eliminada: {device}")
    return changed


def _baud_for(device: str) -> int:
    entry = next((e for e in _load_registry() if e.get("device") == device), None)
    return (entry or {}).get("baud") or 115200


def _transport_kind_for(device: str) -> str:
    entry = next((e for e in _load_registry() if e.get("device") == device), None)
    if entry and entry.get("transport"):
        return entry["transport"]
    return "mks_wifi" if device.startswith("tcp://") else "usb_serial"


def list_usb_marlin_ports() -> List[Dict[str, Any]]:
    """Puertos USB candidatos para una impresora Marlin: misma whitelist de
    chips que las placas láser/CNC (CH340, CP2102, ESP32 — comunes también en
    mainboards Marlin de 32 bits como las SKR). Excluye lo ya registrado como
    láser/CNC o como impresora Marlin, para que el mismo puerto no aparezca
    ofertado en los dos flujos de alta."""
    from backend.services.laser_service import list_usb_laser_ports, get_registered_lasers

    laser_entries = [
        e for e in get_registered_lasers() if e.get("host", "").startswith("usb:")
    ]
    claimed_laser_locations = {e["location"] for e in laser_entries if e.get("location")}
    claimed_laser_devices = {
        e["host"][len("usb:"):] for e in laser_entries if not e.get("location")
    }

    printer_entries = _load_registry()
    claimed_printer_locations = {e["location"] for e in printer_entries if e.get("location")}
    claimed_printer_devices = {
        e.get("device") for e in printer_entries if not e.get("location") and e.get("device")
    }

    claimed_locations = claimed_laser_locations | claimed_printer_locations
    claimed_devices = claimed_laser_devices | claimed_printer_devices

    return [
        port for port in list_usb_laser_ports()
        if port["device"] not in claimed_devices
        and not (port.get("location") and port["location"] in claimed_locations)
    ]


# ── Conexión única y compartida por dispositivo (USB o TCP) ──

_console_buffers: Dict[str, deque] = {}
_subscribers: Dict[str, List[asyncio.Queue]] = {}
_listener_ready_events: Dict[str, asyncio.Event] = {}

_serial_connections: Dict[str, Any] = {}
_serial_reader_threads: Dict[str, threading.Thread] = {}
_serial_stop_flags: Dict[str, threading.Event] = {}
_serial_open_failed_logged: Dict[str, bool] = {}

_main_loop: Optional[asyncio.AbstractEventLoop] = None


def set_main_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Igual que laser_service.set_main_event_loop: el hilo lector de serie
    necesita el loop principal para reenviar datos de forma segura con
    call_soon_threadsafe."""
    global _main_loop
    _main_loop = loop


def _serial_reader_loop(device: str, baud: int, loop: asyncio.AbstractEventLoop):
    buffer = _console_buffers.setdefault(device, deque(maxlen=300))
    stop_flag = _serial_stop_flags[device]
    transport_kind = _transport_kind_for(device)

    try:
        if transport_kind == "mks_wifi":
            ser = mks_wifi_transport.TcpLineConnection(device, timeout=0.5)
        else:
            import serial
            ser = serial.Serial(device, baud, timeout=0.5)
        _serial_connections[device] = ser
        logger.info(f"[{device}] Transporte {transport_kind} abierto")
        _serial_open_failed_logged[device] = False
    except Exception as e:
        if not _serial_open_failed_logged.get(device):
            logger.warning(f"[{device}] No se pudo abrir: {e}")
            _serial_open_failed_logged[device] = True
        return

    # Igual que laser_service: los adaptadores USB-serie (CH340, etc.)
    # suelen resetear la placa al abrir el puerto (toggle de DTR) — se le da
    # margen antes de avisar que el listener está listo para recibir comandos.
    if transport_kind == "usb_serial":
        time.sleep(2)
    loop.call_soon_threadsafe(_listener_ready_events.setdefault(device, asyncio.Event()).set)

    while not stop_flag.is_set():
        try:
            raw = ser.readline()
        except Exception as e:
            logger.debug(f"[{device}] Puerto serie cerrado/desconectado: {e}")
            break
        if not raw:
            if getattr(ser, "closed", False):
                break
            continue
        text = raw.decode("utf-8", errors="ignore").strip()
        if not text:
            continue
        # Las respuestas de polling M114/M105 llegan varias veces por segundo
        # mientras se muestra el estado en vivo — son datos para los widgets,
        # no mensajes de consola (mismo criterio que laser_service para los
        # reportes de estado de GRBL).
        if not (marlin_driver.POSITION_RE.search(text) or marlin_driver.TEMP_RE.search(text)):
            buffer.append({"message": text, "time": time.time()})
        for queue in list(_subscribers.get(device, [])):
            loop.call_soon_threadsafe(queue.put_nowait, text)

    try:
        ser.close()
    except Exception:
        pass
    _serial_connections.pop(device, None)


def _ensure_serial_listener(device: str):
    thread = _serial_reader_threads.get(device)
    if thread is not None and thread.is_alive():
        return
    _listener_ready_events.setdefault(device, asyncio.Event()).clear()
    _subscribers.setdefault(device, [])
    _serial_stop_flags[device] = threading.Event()
    loop = _main_loop or asyncio.get_event_loop()
    thread = threading.Thread(
        target=_serial_reader_loop,
        args=(device, _baud_for(device), loop),
        daemon=True,
    )
    _serial_reader_threads[device] = thread
    thread.start()


def ensure_listener(device: str) -> None:
    _ensure_serial_listener(device)


async def ensure_listener_ready(device: str, timeout: float = 5.0) -> None:
    ensure_listener(device)
    event = _listener_ready_events.get(device)
    if event is None:
        return
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass


def _subscribe(device: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(device, []).append(queue)
    return queue


def _unsubscribe(device: str, queue: asyncio.Queue):
    subs = _subscribers.get(device)
    if subs and queue in subs:
        subs.remove(queue)


def get_console_buffer(device: str, count: int = 100) -> List[Dict[str, Any]]:
    messages = list(_console_buffers.get(device, []))
    return messages[-count:]


def _is_conflicted(device: str) -> bool:
    entry = next((e for e in _load_registry() if e.get("device") == device), None)
    return bool((entry or {}).get("conflict"))


def _send_raw(device: str, command: str) -> bool:
    if _is_conflicted(device):
        # La reconciliación (_reconcile_usb_entries) no pudo confirmar que
        # ahí sigue la misma impresora que se registró — no se le manda nada
        # hasta que el usuario re-vincule a mano desde Configuración.
        logger.warning(f"[{device}] Comando bloqueado: dispositivo en conflicto, requiere re-vincular")
        return False
    ser = _serial_connections.get(device)
    if ser is None:
        ensure_listener(device)
        ser = _serial_connections.get(device)
        if ser is None:
            return False
    try:
        ser.write((command + "\n").encode("utf-8"))
        logger.debug(f"[{device}] TX: {command!r}")
        return True
    except Exception as e:
        logger.warning(f"[{device}] Fallo al escribir '{command!r}': {e}")
        return False


async def send_console_command(device: str, command: str) -> bool:
    await ensure_listener_ready(device)
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _send_raw, device, command)


def _transport_for(device: str) -> marlin_driver.MarlinTransport:
    return marlin_driver.MarlinTransport(
        send=lambda command: _send_raw(device, command),
        ensure_ready=lambda: ensure_listener_ready(device),
        subscribe=lambda: _subscribe(device),
        unsubscribe=lambda queue: _unsubscribe(device, queue),
    )


async def _collect_device_command(
    device: str,
    command: str,
    stop_when: Callable[[str], bool],
    timeout: float = 8.0,
) -> List[str]:
    """Recolecta una respuesta Marlin hasta una marca propia del comando.

    Para SD no basta cortar en el primer ``ok``: el modal también consulta
    posición y temperatura, y un ``ok`` de ese polling podría llegar antes
    que ``End file list``/``File selected``. Las marcas específicas evitan
    truncar una lista M20 por una respuesta ajena.
    """
    transport = _transport_for(device)
    await transport.ensure_ready()
    queue = transport.subscribe()
    lines: List[str] = []
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, transport.send, command)
        if not sent:
            return lines
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                text = await asyncio.wait_for(queue.get(), timeout=max(deadline - time.monotonic(), 0.1))
            except asyncio.TimeoutError:
                break
            lines.append(text)
            if stop_when(text) or marlin_driver.ERROR_RE.match(text):
                break
        return lines
    finally:
        transport.unsubscribe(queue)


SD_FILE_RE = re.compile(r"^(?P<name>.+?)\s+(?P<size>\d+)$")
SD_PROGRESS_RE = re.compile(r"SD printing byte\s+(?P<current>\d+)\s*/\s*(?P<total>\d+)", re.IGNORECASE)
SD_GCODE_EXTENSIONS = (".g", ".gc", ".gco", ".gcode")


def parse_sd_file_list(lines: List[str]) -> List[Dict[str, Any]]:
    """Parsea la salida M20 real de Marlin (nombre 8.3 + tamaño).

    La ANET ET4 comprobada devuelve, por ejemplo, ``DONA.GC 9207543``.
    Se ignoran GIF u otros auxiliares para no ofrecerlos como imprimibles.
    """
    files: List[Dict[str, Any]] = []
    inside_list = False
    for raw_line in lines:
        line = raw_line.strip()
        if line.lower() == "begin file list":
            inside_list = True
            continue
        if line.lower() == "end file list":
            break
        if not inside_list:
            continue
        match = SD_FILE_RE.match(line)
        if not match:
            continue
        name = match.group("name").strip()
        if not name.lower().endswith(SD_GCODE_EXTENSIONS):
            continue
        files.append({"name": name, "size": int(match.group("size"))})
    return files


async def list_sd_files(device: str) -> List[Dict[str, Any]]:
    lines = await _collect_device_command(
        device,
        "M20",
        lambda text: text.strip().lower() == "end file list",
        timeout=10.0,
    )
    return parse_sd_file_list(lines)


# ── Estado / temperatura / movimiento ──

async def get_status(device: str, timeout: float = 4.0) -> Optional[Dict[str, Any]]:
    """Posición (M114) + temperaturas (M105). El estado se sintetiza desde el
    job propio — Marlin no tiene una máquina de estados como GRBL."""
    transport = _transport_for(device)
    position = await marlin_driver.get_position(transport, timeout=timeout)
    if position is None:
        return None

    job = _jobs.get(device)
    sd_job = _sd_jobs.get(device)
    if (job and job.state == "running") or (sd_job and sd_job.get("state") == "running"):
        state = "printing"
    elif (job and job.state == "paused") or (sd_job and sd_job.get("state") == "paused"):
        state = "paused"
    else:
        state = "idle"

    result: Dict[str, Any] = {"state": state, "x": position["x"], "y": position["y"], "z": position["z"]}
    temps = await marlin_driver.get_temperatures(transport, timeout=timeout)
    if temps:
        result.update(temps)
    return result


async def get_temperature_snapshot(device: str) -> Dict[str, Any]:
    """Mismo shape que klipper_service.get_temperature_snapshot (sensors +
    history.series) para que el widget de temperaturas no necesite un camino
    aparte — pero sin historial real: Klipper lo obtiene gratis del
    temperature_store de Moonraker, Marlin no tiene equivalente por serie
    (se difiere acumular muestras propias)."""
    transport = _transport_for(device)
    temps = await marlin_driver.get_temperatures(transport) or {}

    def _label(key: str) -> str:
        if key == "extruder":
            return "Extruder"
        if key.startswith("extruder"):
            return f"Extruder {key[len('extruder'):]}"
        return "Heater Bed"

    sensors = [
        {
            "key": key,
            "label": _label(key),
            "kind": "heater",
            "current": values.get("current"),
            "target": values.get("target"),
        }
        for key, values in temps.items()
    ]
    return {"sensors": sensors, "history": {"interval_seconds": None, "series": {}}}


def set_heater_target(device: str, heater: str, target: float) -> bool:
    """M104 (extrusor, con T<n> si hay más de un hotend) o M140 (cama) --
    equivalente fire-and-forget al SET_HEATER_TEMPERATURE de Klipper. Con
    doble extrusor, `heater` llega como "extruder0"/"extruder1" (ver
    get_temperature_snapshot) -- antes de esto solo existía "extruder" a
    secas, así que cualquier valor con número habría caído mal en la rama
    de cama (M140) por error; ahora selecciona el tool con M104 T<n>."""
    if heater == "heater_bed":
        command = f"M140 S{target}"
    elif heater == "extruder":
        command = f"M104 S{target}"
    elif heater.startswith("extruder") and heater[len("extruder"):].isdigit():
        command = f"M104 T{heater[len('extruder'):]} S{target}"
    else:
        return False
    return _send_raw(device, command)


async def jog(device: str, axis: str, distance: float, feed: float) -> bool:
    transport = _transport_for(device)
    for line in marlin_driver.build_jog_lines(axis, distance, feed):
        result = await marlin_driver.send_and_await_ok(transport, line)
        if not result["success"]:
            return False
    return True


async def home(device: str, axes: Optional[str] = None) -> bool:
    transport = _transport_for(device)
    result = await marlin_driver.send_and_await_ok(
        transport, marlin_driver.build_home_command(axes), timeout=60.0
    )
    return result["success"]


# ── Impresión (streaming ok-por-línea) ──

class PrintJob:
    """Mismo shape que laser_service.LaserJob (filename/source/state/
    current/total/error) — clase local propia en vez de importar LaserJob:
    una impresión no es un "LaserJob", y mantiene los dos features
    desacoplados."""

    def __init__(self, device: str, lines: List[str], filename: str = "", source: str = "stream"):
        self.device = device
        self.lines = lines
        self.filename = filename
        self.source = source
        self.total = len([line for line in lines if line.strip() and not line.strip().startswith((";", "("))])
        self.current = 0
        self.state = "running"
        self.error_message: Optional[str] = None
        self.cancel_requested = False
        self.pause_requested = False
        self.started_at = time.time()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filename": self.filename,
            "source": self.source,
            "state": self.state,
            "current": self.current,
            "total": self.total,
            "error": self.error_message,
        }


# Un trabajo activo por impresora — igual que laser_service._jobs.
_jobs: Dict[str, PrintJob] = {}
_sd_jobs: Dict[str, Dict[str, Any]] = {}


async def _run_print_job(job: PrintJob):
    transport = _transport_for(job.device)
    await marlin_driver.run_job(transport, job)
    if job.state == "completed":
        logger.info(f"[{job.device}] Impresión completada ({job.current}/{job.total} líneas)")
    elif job.state == "error":
        logger.warning(f"[{job.device}] Impresión terminó con error: {job.error_message}")


def start_print(device: str, gcode_text: str, filename: str = "") -> Dict[str, Any]:
    existing = _jobs.get(device)
    if existing is not None and existing.state in ("running", "paused"):
        logger.warning(f"[{device}] No se pudo iniciar '{filename}': ya hay una impresión en curso")
        raise RuntimeError("Ya hay una impresión en curso en esta impresora")
    sd_existing = _sd_jobs.get(device)
    if sd_existing is not None and sd_existing.get("state") in ("running", "paused"):
        raise RuntimeError("Ya hay una impresión desde la SD en curso en esta impresora")

    lines = gcode_text.splitlines()
    job = PrintJob(device, lines, filename, source="stream")
    _jobs[device] = job
    logger.info(f"[{device}] Impresión iniciada: {filename or '(stream)'} ({len(lines)} líneas)")
    asyncio.create_task(_run_print_job(job))
    return job.to_dict()


async def start_sd_print(device: str, filename: str) -> Dict[str, Any]:
    """Selecciona y arranca un archivo que permanece en la SD de Marlin.

    No descarga ni crea una copia en la biblioteca local de NOPAL.
    """
    host_job = _jobs.get(device)
    sd_job = _sd_jobs.get(device)
    if host_job is not None and host_job.state in ("running", "paused"):
        raise RuntimeError("Ya hay una impresión enviada por NOPAL en curso")
    if sd_job is not None and sd_job.get("state") in ("running", "paused"):
        raise RuntimeError("Ya hay una impresión desde la SD en curso")

    files = await list_sd_files(device)
    selected = next((entry for entry in files if entry["name"] == filename), None)
    if selected is None:
        raise RuntimeError("El archivo ya no está disponible en la tarjeta SD")

    lines = await _collect_device_command(
        device,
        f"M23 {filename}",
        lambda text: text.strip().lower() == "file selected",
        timeout=8.0,
    )
    if not any(line.strip().lower() == "file selected" for line in lines):
        error = next((line for line in lines if marlin_driver.ERROR_RE.match(line)), None)
        raise RuntimeError(error or "Marlin no pudo seleccionar el archivo de la SD")

    await ensure_listener_ready(device)
    loop = asyncio.get_event_loop()
    if not await loop.run_in_executor(None, _send_raw, device, "M24"):
        raise RuntimeError("No se pudo iniciar la impresión desde la SD")

    job = {
        "filename": filename,
        "source": "sd",
        "state": "running",
        "current": 0,
        "total": selected["size"],
        "error": None,
        "started_at": time.time(),
    }
    _sd_jobs[device] = job
    logger.info(f"[{device}] Impresión SD iniciada: {filename}")
    return dict(job)


async def _refresh_sd_job(device: str, job: Dict[str, Any]) -> Dict[str, Any]:
    if job.get("state") not in ("running", "paused"):
        return dict(job)
    lines = await _collect_device_command(
        device,
        "M27",
        lambda text: bool(SD_PROGRESS_RE.search(text))
        or "not sd printing" in text.lower()
        or "done printing file" in text.lower(),
        timeout=4.0,
    )
    for line in lines:
        progress = SD_PROGRESS_RE.search(line)
        if progress:
            job["current"] = int(progress.group("current"))
            job["total"] = int(progress.group("total"))
            return dict(job)
        lowered = line.lower()
        if "done printing file" in lowered or "not sd printing" in lowered:
            job["state"] = "completed"
            job["current"] = job.get("total", 0)
            return dict(job)
    return dict(job)


# ── Subir a la SD (M28/M29) + arrancar con precalentado ──

SD_PREHEAT_EXTRUDER_RE = re.compile(r"^M10[49]\b[^\n]*?\bS(-?\d+\.?\d*)", re.IGNORECASE | re.MULTILINE)
SD_PREHEAT_BED_RE = re.compile(r"^M1[49]0\b[^\n]*?\bS(-?\d+\.?\d*)", re.IGNORECASE | re.MULTILINE)


async def check_sd_available(device: str) -> bool:
    """M21 (inicializa la SD). No hay una marca de éxito uniforme entre
    versiones de Marlin (varía entre 'SD card ok', nada, etc.), así que se
    detecta por AUSENCIA de las marcas de error conocidas en vez de
    depender de un mensaje de éxito específico."""
    lines = await _collect_device_command(
        device, "M21", lambda text: marlin_driver.OK_RE.match(text.strip()) is not None, timeout=6.0,
    )
    if not lines:
        return False
    joined = " ".join(lines).lower()
    if "init fail" in joined or "no sd card" in joined or "volume.init failed" in joined:
        return False
    return True


def _extract_preheat_targets(gcode_text: str) -> Dict[str, float]:
    """Primeros M104/M109 (extrusor) y M140/M190 (cama) que aparezcan en el
    archivo -- es la temperatura que el propio slicer ya declaró para esta
    impresión, no un valor que NOPAL inventa."""
    targets: Dict[str, float] = {}
    extruder_match = SD_PREHEAT_EXTRUDER_RE.search(gcode_text)
    if extruder_match:
        targets["extruder"] = float(extruder_match.group(1))
    bed_match = SD_PREHEAT_BED_RE.search(gcode_text)
    if bed_match:
        targets["heater_bed"] = float(bed_match.group(1))
    return targets


async def _wait_for_preheat(device: str, targets: Dict[str, float], timeout: float = 900.0) -> bool:
    """Espera (sondeando M105 cada 3s) a que cama/extrusor lleguen a ±3°C
    del target -- así el M24 de más abajo arranca con la placa ya caliente
    en vez de que el propio M109/M190 del archivo recién ahí empiece a
    esperar. Timeout largo (15 min) a propósito: una cama grande puede
    tardar de verdad, y esto corre en background, no bloquea al usuario."""
    transport = _transport_for(device)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        temps = await marlin_driver.get_temperatures(transport, timeout=6.0)
        if temps:
            reached = True
            for heater, target in targets.items():
                current = (temps.get(heater) or {}).get("current")
                if current is None or current < target - 3:
                    reached = False
                    break
            if reached:
                return True
        await asyncio.sleep(3)
    return False


async def upload_gcode_to_sd(device: str, filename: str, gcode_text: str) -> Dict[str, Any]:
    """Sube gcode_text a la SD de la impresora como `filename`, vía M28
    (abre el archivo en modo captura) / M29 (lo cierra). Marlin trata cada
    línea entre ambos exactamente igual que en ejecución normal (numerada +
    checksum, reintentable con "Resend:"), así que se reutiliza el mismo
    streaming estricto ok-por-línea de marlin_driver.run_job en vez de
    reimplementarlo -- la única diferencia real es que las líneas quedan
    escritas en un archivo de la placa en vez de ejecutarse."""
    transport = _transport_for(device)

    open_result = await marlin_driver.send_and_await_ok(transport, f"M28 {filename}", timeout=10.0)
    if not open_result["success"]:
        return {"success": False, "error": open_result.get("error") or "No se pudo abrir el archivo en la SD"}

    lines = gcode_text.splitlines()
    job = PrintJob(device, lines, filename, source="sd-upload")
    await marlin_driver.run_job(transport, job)
    if job.state != "completed":
        # Best-effort: cierra igual el archivo para no dejar la placa en
        # modo captura si algo falló a mitad de la subida.
        await marlin_driver.send_and_await_ok(transport, "M29", timeout=10.0)
        return {"success": False, "error": job.error_message or "Fallo al escribir el archivo en la SD"}

    close_result = await marlin_driver.send_and_await_ok(transport, "M29", timeout=15.0)
    if not close_result["success"]:
        return {"success": False, "error": close_result.get("error") or "No se pudo cerrar el archivo en la SD"}

    return {"success": True}


async def upload_and_start_sd_print(
    device: str, filename: str, gcode_text: str, preheat: bool = True
) -> Dict[str, Any]:
    """Sube `gcode_text` a la SD como `filename` y arranca la impresión —
    equivalente a "Imprimir ahora" pero vía SD en vez de streaming directo.
    Con preheat=True, manda M104/M140 con la temperatura que el propio
    archivo declara y espera a alcanzarla ANTES de arrancar (M24), para que
    la impresión no empiece con la placa fría."""
    host_job = _jobs.get(device)
    sd_job = _sd_jobs.get(device)
    if host_job is not None and host_job.state in ("running", "paused"):
        raise RuntimeError("Ya hay una impresión enviada por NOPAL en curso")
    if sd_job is not None and sd_job.get("state") in ("running", "paused"):
        raise RuntimeError("Ya hay una impresión desde la SD en curso")

    if not await check_sd_available(device):
        raise RuntimeError("La impresora no reporta una tarjeta SD disponible")

    upload_result = await upload_gcode_to_sd(device, filename, gcode_text)
    if not upload_result["success"]:
        raise RuntimeError(upload_result.get("error") or "No se pudo subir el archivo a la SD")

    if preheat:
        targets = _extract_preheat_targets(gcode_text)
        for heater, target in targets.items():
            set_heater_target(device, heater, target)
        if targets:
            await _wait_for_preheat(device, targets)

    return await start_sd_print(device, filename)


async def get_job_status(device: str) -> Dict[str, Any]:
    job = _jobs.get(device)
    if job is not None and job.state in ("running", "paused"):
        return job.to_dict()
    sd_job = _sd_jobs.get(device)
    if sd_job is not None:
        return await _refresh_sd_job(device, sd_job)
    if job is not None:
        return job.to_dict()
    return {"filename": "", "source": "", "state": "idle", "current": 0, "total": 0, "error": None}


def get_active_job_devices() -> List[Dict[str, Any]]:
    host_jobs = [
        {**job.to_dict(), "device": device}
        for device, job in _jobs.items()
        if job.state in ("running", "paused")
    ]
    sd_jobs = [
        {**job, "device": device}
        for device, job in _sd_jobs.items()
        if job.get("state") in ("running", "paused")
    ]
    return host_jobs + sd_jobs


async def pause_job(device: str) -> bool:
    """Cooperativo: Marlin no tiene protocolo realtime, el propio loop de
    marlin_driver.run_job deja de mandar líneas al ver pause_requested."""
    job = _jobs.get(device)
    if job and job.state == "running":
        job.pause_requested = True
        job.state = "paused"
        logger.info(f"[{device}] Impresión pausada")
        return True
    sd_job = _sd_jobs.get(device)
    if sd_job and sd_job.get("state") == "running":
        await ensure_listener_ready(device)
        if _send_raw(device, "M25"):
            sd_job["state"] = "paused"
            logger.info(f"[{device}] Impresión SD pausada")
            return True
    return False


async def resume_job(device: str) -> bool:
    job = _jobs.get(device)
    if job and job.state == "paused":
        job.pause_requested = False
        job.state = "running"
        logger.info(f"[{device}] Impresión reanudada")
        return True
    sd_job = _sd_jobs.get(device)
    if sd_job and sd_job.get("state") == "paused":
        await ensure_listener_ready(device)
        if _send_raw(device, "M24"):
            sd_job["state"] = "running"
            logger.info(f"[{device}] Impresión SD reanudada")
            return True
    return False


async def cancel_job(device: str) -> bool:
    job = _jobs.get(device)
    if job and job.state in ("running", "paused"):
        job.cancel_requested = True
        job.pause_requested = False
        logger.info(f"[{device}] Cancelación de impresión solicitada")
        return True
    sd_job = _sd_jobs.get(device)
    if sd_job and sd_job.get("state") in ("running", "paused"):
        await ensure_listener_ready(device)
        if _send_raw(device, "M524"):
            sd_job["state"] = "cancelled"
            logger.info(f"[{device}] Impresión SD cancelada")
            return True
    return False
