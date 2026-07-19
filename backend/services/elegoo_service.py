"""Impresoras Elegoo en red que hablan SDCP (Smart Device Control Protocol) sobre
WebSocket -- Centauri Carbon/Carbon 2, Neptune 4 series, OrangeStorm Giga.

No es el SDK oficial "Elegoo-Link" (ese es C++, no se puede importar desde este
backend) ni el transporte MQTT que usan las impresoras de resina viejas -- acá se
reimplementa directo en Python, con `websockets` (ya dependencia del proyecto), la
parte del protocolo que sí aplica a las impresoras FDM modernas.

Path paralelo a laser_service.py: también hay una sola conexión WS persistente por
impresora, pero en vez de líneas de texto GRBL se parsean sobres JSON de SDCP. A
diferencia de Klipper (poll REST) o Marlin (poll M105/M114), la placa empuja sola los
mensajes de Status/Attributes apenas cambian, así que una vez conectado no hace falta
encuestar nada -- alcanza con leer el último valor cacheado.

Los códigos de PrintInfo.Status usados acá (0 idle, 5 pausing, 8 preparing, 9
starting, 10 paused, 13 printing, 20 resuming) son los observados en vivo contra una
Centauri Carbon real (ver WalkerFrederick/sdcp-centauri-carbon), no los del enum
genérico de la spec base de SDCP (que describe pasos de impresoras de resina --
homing/dropping/exposing -- que no aplican acá). No hay hardware Elegoo disponible en
este entorno para confirmarlos al 100%; si una impresora real reporta un código no
mapeado, `normalize_elegoo_status` cae a "unknown" en vez de asumir un estado.
"""

import asyncio
import json
import logging
import os
import socket
import time
import uuid
from typing import Any, Dict, List, Optional

import requests
import websockets

from backend.utils import safe_section_path

logger = logging.getLogger(__name__)

DISCOVERY_PORT = 3000
WS_PORT = 3030
DISCOVERY_TIMEOUT = 2.0
REGISTRY_PATH = "elegoo_printer_registry.json"

_JOB_STATE_MAP = {
    0: "idle",
    5: "pausing",
    6: "paused",
    7: "stopping",
    8: "preparing",
    9: "printing",
    10: "paused",
    13: "printing",
    20: "resuming",
}


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


async def _verify_connection(ip: str, mainboard_id: str, timeout: float = 4.0) -> Dict[str, Any]:
    """Abre una conexión WS SDCP descartable solo para confirmar que hay una
    impresora real respondiendo en esa IP -- no se reusa como listener
    persistente (ver _ensure_listener). Éxito mínimo: llegó algún mensaje
    SDCP válido (Topic con /status/ o /attributes/) dentro del timeout, lo
    que ya confirma IP/puerto/protocolo correctos. Si además el topic
    referencia el mainboard_id esperado se marca "confirmed" -- si no, se
    acepta igual pero sin esa confirmación extra: el protocolo real (según
    la documentación comunitaria citada en el docstring del módulo) no
    garantiza de forma verificable el formato exacto del topic sin hardware
    real contra el que probarlo, así que no se convierte en un rechazo duro."""
    uri = _ws_url(ip)
    try:
        async with websockets.connect(uri, open_timeout=timeout, ping_interval=None) as ws:
            end_time = time.monotonic() + timeout
            while True:
                remaining = end_time - time.monotonic()
                if remaining <= 0:
                    return {"ok": False, "error": "La impresora respondió, pero no envió estado", "error_code": "PROTOCOL_INVALID"}
                try:
                    message = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    return {"ok": False, "error": "La impresora respondió, pero no envió estado", "error_code": "PROTOCOL_INVALID"}
                if isinstance(message, bytes):
                    message = message.decode("utf-8", errors="ignore")
                if message in ("ping", "pong"):
                    continue
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    continue
                topic = payload.get("Topic", "")
                if "/status/" in topic or "/attributes/" in topic:
                    confirmed = mainboard_id in topic
                    return {"ok": True, "confirmed_id": confirmed}
    except asyncio.TimeoutError:
        return {"ok": False, "error": "Tiempo de espera agotado conectando con la impresora", "error_code": "CONNECTION_FAILED"}
    except (OSError, websockets.InvalidURI, websockets.InvalidHandshake) as e:
        return {"ok": False, "error": f"No se pudo conectar a {ip}:{WS_PORT}: {e}", "error_code": "CONNECTION_FAILED"}


async def register_printer(ip: str, mainboard_id: str, name: str, model: str = "") -> Dict[str, Any]:
    """A diferencia del resto de bambu/flashforge_service.py, esto arrancó
    sin ninguna verificación real (guardaba directo) -- corregido para que
    también rechace el registro si la impresora no responde, en línea con
    el resto de las marcas."""
    check = await _verify_connection(ip, mainboard_id)
    if not check["ok"]:
        return {
            "success": False,
            "error": check.get("error") or "No se pudo conectar con la impresora",
            "error_code": check.get("error_code", "UNKNOWN"),
        }

    entries = [e for e in _load_registry() if e.get("mainboard_id") != mainboard_id]
    entry = {
        "mainboard_id": mainboard_id,
        "ip": ip,
        "name": name,
        "model": model,
        "registered_at": time.time(),
    }
    entries.append(entry)
    _save_registry(entries)
    logger.info(f"Impresora Elegoo registrada: {name} ({ip}, {mainboard_id})")
    return {"success": True, "printer": entry}


async def test_connection(mainboard_id: str) -> Dict[str, Any]:
    """Diagnóstico bajo demanda para una impresora ya registrada -- reusa
    _verify_connection en vez de reimplementar el chequeo."""
    entry = next((e for e in _load_registry() if e.get("mainboard_id") == mainboard_id), None)
    if entry is None:
        return {"success": False, "error": "Impresora no encontrada"}

    started = time.monotonic()
    check = await _verify_connection(entry["ip"], mainboard_id)
    latency_ms = round((time.monotonic() - started) * 1000)
    return {
        "success": check["ok"],
        "error": check.get("error"),
        "latency_ms": latency_ms if check["ok"] else None,
        "confirmed_id": check.get("confirmed_id", False),
        "listener_connected": _connected.get(mainboard_id, False),
    }


def unregister_printer(mainboard_id: str) -> bool:
    entries = _load_registry()
    filtered = [e for e in entries if e.get("mainboard_id") != mainboard_id]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        task = _listener_tasks.pop(mainboard_id, None)
        if task is not None and not task.done():
            task.cancel()
        _status_cache.pop(mainboard_id, None)
        _attributes_cache.pop(mainboard_id, None)
        _connected.pop(mainboard_id, None)
        logger.info(f"Impresora Elegoo eliminada: {mainboard_id}")
    return changed


# ── Descubrimiento (UDP broadcast) ──

def _discover_sync(timeout: float = DISCOVERY_TIMEOUT) -> List[Dict[str, Any]]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    found: Dict[str, Dict[str, Any]] = {}
    try:
        sock.sendto(b"M99999", ("255.255.255.255", DISCOVERY_PORT))
        end_time = time.monotonic() + timeout
        while True:
            remaining = end_time - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, addr = sock.recvfrom(8192)
            except socket.timeout:
                break
            try:
                payload = json.loads(data.decode("utf-8", errors="ignore"))
            except json.JSONDecodeError:
                continue
            info = payload.get("Data") or {}
            mainboard_id = info.get("MainboardID")
            if not mainboard_id:
                continue
            found[mainboard_id] = {
                "mainboard_id": mainboard_id,
                "ip": info.get("MainboardIP") or addr[0],
                "name": info.get("Name") or info.get("MachineName") or mainboard_id,
                "model": info.get("MachineName", ""),
                "firmware_version": info.get("FirmwareVersion", ""),
                "protocol_version": info.get("ProtocolVersion", ""),
            }
    finally:
        sock.close()
    return list(found.values())


async def scan_network(timeout: float = DISCOVERY_TIMEOUT) -> List[Dict[str, Any]]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _discover_sync, timeout)


# ── Conexión websocket persistente por impresora ──
#
# SDCP empuja solo los mensajes de Status/Attributes apenas cambian -- con UNA
# conexión persistente por impresora alcanza para tener el estado siempre al día.
# Mismo esqueleto que _ws_listener_loop de laser_service.py, pero acá se manda por
# la MISMA conexión (no hay un endpoint HTTP de comandos separado como en ESP3D),
# así que se guarda el objeto de conexión vivo para poder escribirle directo,
# igual que _serial_connections guarda el `Serial` abierto en laser_service.py.

_status_cache: Dict[str, Dict[str, Any]] = {}
_attributes_cache: Dict[str, Dict[str, Any]] = {}
_listener_tasks: Dict[str, asyncio.Task] = {}
_ws_connections: Dict[str, Any] = {}
_subscribers: Dict[str, List[asyncio.Queue]] = {}
_connected: Dict[str, bool] = {}
_ws_was_connected: Dict[str, bool] = {}


def _ws_url(ip: str) -> str:
    return f"ws://{ip}:{WS_PORT}/websocket"


def _handle_message(mainboard_id: str, payload: Dict[str, Any]):
    topic = payload.get("Topic", "")
    if "/status/" in topic:
        _status_cache[mainboard_id] = payload.get("Status", {})
    elif "/attributes/" in topic:
        _attributes_cache[mainboard_id] = payload.get("Attributes", {})


async def _listener_loop(mainboard_id: str, ip: str):
    uri = _ws_url(ip)
    while True:
        if _ws_was_connected.get(mainboard_id):
            # Se loguea una sola vez la transición, no en cada reintento de 3s
            # mientras sigue caído (mismo criterio que laser_service.py).
            logger.warning(f"[{mainboard_id}] WS Elegoo desconectado, reintentando...")
            _ws_was_connected[mainboard_id] = False
        try:
            async with websockets.connect(uri, open_timeout=4, ping_interval=None) as ws:
                logger.info(f"[{mainboard_id}] WS Elegoo conectado ({uri})")
                _ws_connections[mainboard_id] = ws
                _connected[mainboard_id] = True
                _ws_was_connected[mainboard_id] = True
                while True:
                    try:
                        message = await asyncio.wait_for(ws.recv(), timeout=45)
                    except asyncio.TimeoutError:
                        # La placa cierra la conexión a los 60s sin tráfico --
                        # un "ping" literal (no JSON) la mantiene viva.
                        await ws.send("ping")
                        continue
                    if isinstance(message, bytes):
                        message = message.decode("utf-8", errors="ignore")
                    if message in ("ping", "pong"):
                        continue
                    try:
                        payload = json.loads(message)
                    except json.JSONDecodeError:
                        continue
                    _handle_message(mainboard_id, payload)
                    for queue in list(_subscribers.get(mainboard_id, [])):
                        queue.put_nowait(payload)
        except Exception as e:
            logger.debug(f"[{mainboard_id}] WS Elegoo falló: {e}")
        finally:
            _ws_connections.pop(mainboard_id, None)
            _connected[mainboard_id] = False
        await asyncio.sleep(3)


def _ensure_listener(mainboard_id: str, ip: str):
    task = _listener_tasks.get(mainboard_id)
    if task is None or task.done():
        _subscribers.setdefault(mainboard_id, [])
        _listener_tasks[mainboard_id] = asyncio.create_task(_listener_loop(mainboard_id, ip))


# ── Comandos ──

def _envelope(cmd: int, data: Dict[str, Any]) -> Dict[str, Any]:
    """Sobre de request armado igual que el tráfico real capturado contra una
    Centauri Carbon (ver WalkerFrederick/sdcp-centauri-carbon): "Id" y el
    "MainboardID" interno van vacíos -- la conexión ya está scopeada a un socket
    por impresora, no hace falta repetirlo adentro del mensaje."""
    return {
        "Id": "",
        "Data": {
            "Cmd": cmd,
            "Data": data,
            "RequestID": uuid.uuid4().hex,
            "MainboardID": "",
            "TimeStamp": int(time.time() * 1000),
            "From": 1,
        },
    }


async def _send_command(mainboard_id: str, cmd: int, data: Optional[Dict[str, Any]] = None) -> bool:
    ws = _ws_connections.get(mainboard_id)
    if ws is None:
        return False
    try:
        await ws.send(json.dumps(_envelope(cmd, data or {})))
        return True
    except Exception as e:
        logger.warning(f"[{mainboard_id}] No se pudo mandar el comando {cmd}: {e}")
        return False


async def pause_printer(mainboard_id: str) -> bool:
    return await _send_command(mainboard_id, 129)


async def resume_printer(mainboard_id: str) -> bool:
    return await _send_command(mainboard_id, 131)


async def cancel_printer(mainboard_id: str) -> bool:
    return await _send_command(mainboard_id, 130)


async def start_print(mainboard_id: str, filename: str, start_layer: int = 0) -> bool:
    return await _send_command(mainboard_id, 128, {"Filename": filename, "StartLayer": start_layer})


async def get_camera_stream_url(mainboard_id: str) -> bool:
    """Pide a la placa que habilite la cámara -- la URL del stream MJPEG llega
    después por el mismo canal de status/attributes, no en la respuesta directa."""
    return await _send_command(mainboard_id, 386, {"Enable": 1})


# ── Subida de archivo (HTTP, no hay comando WS de upload en la Centauri Carbon) ──

def _upload_url(ip: str) -> str:
    return f"http://{ip}:{WS_PORT}/uploadFile/upload"


def _upload_file_sync(ip: str, abs_path: str) -> Dict[str, Any]:
    filename = os.path.basename(abs_path)
    with open(abs_path, "rb") as handle:
        content = handle.read()
    try:
        response = requests.post(
            _upload_url(ip),
            files={"file": (filename, content, "application/octet-stream")},
            timeout=30,
        )
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        logger.warning(f"No se pudo subir {filename} a {ip}: {e}")
        return {"success": False, "error": "No se pudo subir el archivo a la impresora"}
    return {"success": True, "filename": filename}


async def send_gcode_to_printer(mainboard_id: str, file_path: str, section: str = "model") -> Dict[str, Any]:
    """Sube un archivo de la biblioteca de NOPAL y arranca la impresión --
    mismo contrato que klipper_service.send_gcode_to_printer, pero acá la
    subida es HTTP y el arranque va por el comando 128 sobre el WS."""
    entry = next((e for e in _load_registry() if e["mainboard_id"] == mainboard_id), None)
    if entry is None:
        return {"success": False, "error": "Impresora no encontrada"}

    abs_path = safe_section_path(section, file_path)
    if not os.path.isfile(abs_path):
        return {"success": False, "error": "Archivo no encontrado"}

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _upload_file_sync, entry["ip"], abs_path)
    if not result.get("success"):
        return result

    if not await start_print(mainboard_id, result["filename"]):
        return {"success": False, "error": "Se subió el archivo pero no se pudo iniciar la impresión"}

    return result


# ── Normalización para el dashboard/tarjetas ──

def normalize_elegoo_status(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Adapta el status crudo de SDCP al mismo shape que ya usan las tarjetas
    Klipper/Marlin (ver klipper_service.normalize_printer_payload), para que
    dashboard_service.py y el frontend no necesiten un caso especial nuevo."""
    mainboard_id = entry["mainboard_id"]
    status = _status_cache.get(mainboard_id, {})
    print_info = status.get("PrintInfo", {})
    online = _connected.get(mainboard_id, False)

    raw_print_status = print_info.get("Status")
    job_state = _JOB_STATE_MAP.get(raw_print_status, "unknown" if raw_print_status is not None else "idle")

    return {
        "id": mainboard_id,
        "name": entry.get("name"),
        "model": entry.get("model"),
        "ip": entry.get("ip"),
        "online": online,
        "status": "online" if online else "offline",
        "temps": {
            "extruder": {
                "current": status.get("TempOfNozzle"),
                "target": status.get("TempTargetNozzle"),
            },
            "heater_bed": {
                "current": status.get("TempOfHotbed"),
                "target": status.get("TempTargetHotbed"),
            },
        },
        "job": {
            "state": job_state,
            "filename": print_info.get("Filename") or None,
            "progress": print_info.get("Progress"),
            "current_layer": print_info.get("CurrentLayer"),
            "total_layer": print_info.get("TotalLayer"),
        },
    }


def get_registered_printers_with_status() -> List[Dict[str, Any]]:
    """Arranca (si hace falta) el listener persistente de cada impresora
    registrada y devuelve el último status cacheado -- no hay poll acá, SDCP
    empuja los cambios solo."""
    entries = _load_registry()
    for entry in entries:
        _ensure_listener(entry["mainboard_id"], entry["ip"])
    return [normalize_elegoo_status(entry) for entry in entries]
