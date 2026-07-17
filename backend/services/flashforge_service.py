"""Impresoras FlashForge modernas (Adventurer 5M/5M Pro, AD5X, Creator 5/5 Pro) por
HTTP REST -- puerto 8898, JSON, autenticada con serialNumber+checkCode.

No se soportan acá las FlashForge legadas (Adventurer 3, Adventurer 4 Pro/Lite): esas
son TCP puro (puerto 8899) con un modelo de sesión exclusiva (M601/M602, un solo
cliente a la vez) -- el mismo esfuerzo de conexión persistente que ya se hizo para
Elegoo/láser, dejado para una vuelta futura si hace falta.

A diferencia de Elegoo (WebSocket persistente, la placa empuja el status sola), acá es
puro request/response sin estado de conexión -- mismo patrón que klipper_service.py
(`MoonrakerClient`): un cliente HTTP fino y funciones de módulo síncronas, sin listener
de fondo ni reconexión.
"""

import asyncio
import json
import logging
import os
import socket
import struct
import time
from typing import Any, Dict, List, Optional

import requests

from backend.utils import safe_section_path

logger = logging.getLogger(__name__)

HTTP_PORT = 8898
MULTICAST_GROUP = "225.0.0.9"
MULTICAST_PORT = 19000
BROADCAST_PORT = 48899
DISCOVERY_TIMEOUT = 2.0
REGISTRY_PATH = "flashforge_printer_registry.json"

# Paquete de discovery moderno (276 bytes, big-endian) -- ver Discovery-Protocol de
# Parallel-7/flashforge-api-docs. Las legadas (140 bytes, sin serial number) no se
# parsean acá, quedan fuera de alcance.
_DISCOVERY_STRUCT = struct.Struct(">128s4xHHHHHHBB128s2x")

_MODEL_BY_PID = {
    35: "Adventurer 5M",
    36: "Adventurer 5M Pro",
    38: "Adventurer 5X (AD5X)",
    40: "Creator 5",
    41: "Creator 5 Pro",
}

_JOB_STATE_MAP = {
    "ready": "idle",
    "completed": "idle",
    "heating": "printing",
    "printing": "printing",
    "working": "printing",
    "building": "printing",
    "pausing": "pausing",
    "paused": "paused",
    "pause": "paused",
    "canceling": "busy",
    "cancel": "busy",
    "busy": "busy",
    "calibrate_doing": "busy",
    "error": "error",
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


def _find_entry(serial_number: str) -> Optional[Dict[str, Any]]:
    return next((e for e in _load_registry() if e.get("serial_number") == serial_number), None)


def _parse_pid(raw: Any) -> Optional[int]:
    """El pid de /detail viene como string hexadecimal ("0024"), pero se tolera
    también un int llano por si una versión de firmware lo manda distinto."""
    if raw is None:
        return None
    try:
        return int(str(raw), 16)
    except ValueError:
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None


def unregister_printer(serial_number: str) -> bool:
    entries = _load_registry()
    filtered = [e for e in entries if e.get("serial_number") != serial_number]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        logger.info(f"Impresora FlashForge eliminada: {serial_number}")
    return changed


# ── Descubrimiento (UDP, solo protocolo moderno) ──

def _parse_discovery_packet(data: bytes, ip: str) -> Optional[Dict[str, Any]]:
    if len(data) < _DISCOVERY_STRUCT.size:
        # Paquete de 140 bytes (legado, sin serial number) u otra cosa -- no
        # soportado en esta primera pasada.
        return None
    try:
        (
            name, _cmd_port, _vid, pid, _status_code, _product_type,
            http_port, lan_mode, _reserved, serial,
        ) = _DISCOVERY_STRUCT.unpack(data[:_DISCOVERY_STRUCT.size])
    except struct.error:
        return None
    serial_number = serial.split(b"\x00", 1)[0].decode("utf-8", errors="ignore").strip()
    if not serial_number:
        return None
    return {
        "serial_number": serial_number,
        "ip": ip,
        "name": name.split(b"\x00", 1)[0].decode("utf-8", errors="ignore").strip() or serial_number,
        "model": _MODEL_BY_PID.get(pid, ""),
        "http_port": http_port or HTTP_PORT,
        "lan_only": bool(lan_mode),
    }


def _discover_sync(timeout: float = DISCOVERY_TIMEOUT) -> List[Dict[str, Any]]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    found: Dict[str, Dict[str, Any]] = {}
    try:
        # El payload no importa (la placa lo ignora) -- alcanza con que llegue
        # algo a cada dirección de descubrimiento conocida.
        sock.sendto(b"probe", (MULTICAST_GROUP, MULTICAST_PORT))
        sock.sendto(b"probe", ("255.255.255.255", BROADCAST_PORT))
        end_time = time.monotonic() + timeout
        while True:
            remaining = end_time - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, addr = sock.recvfrom(1024)
            except socket.timeout:
                break
            parsed = _parse_discovery_packet(data, addr[0])
            if parsed:
                found[parsed["serial_number"]] = parsed
    finally:
        sock.close()
    return list(found.values())


async def scan_network(timeout: float = DISCOVERY_TIMEOUT) -> List[Dict[str, Any]]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _discover_sync, timeout)


# ── Cliente HTTP (sin estado de conexión, mismo rol que MoonrakerClient) ──

class FlashForgeClient:
    def __init__(self, ip: str, serial_number: str, check_code: str):
        self.ip = ip
        self.serial_number = serial_number
        self.check_code = check_code
        self.base_url = f"http://{ip}:{HTTP_PORT}"
        self.timeout = 3

    def _post(self, endpoint: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {"serialNumber": self.serial_number, "checkCode": self.check_code}
        if extra:
            payload.update(extra)
        try:
            response = requests.post(f"{self.base_url}{endpoint}", json=payload, timeout=self.timeout)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.ConnectionError:
            # Impresora apagada/fuera de línea -- caso normal, no un error a loguear.
            return {}
        except Exception as e:
            logger.warning(f"[{self.serial_number}] {endpoint}: {e}")
            return {}

    def check_auth(self) -> Dict[str, Any]:
        """Respuesta cruda de /detail (con "code"/"message") -- se usa para
        validar credenciales al registrar, antes de quedarnos solo con el
        contenido de "detail" como hace get_detail()."""
        return self._post("/detail")

    def get_detail(self) -> Dict[str, Any]:
        return self._post("/detail").get("detail", {})

    def send_control(self, cmd: str, args: Dict[str, Any]) -> bool:
        result = self._post("/control", {"payload": {"cmd": cmd, "args": args}})
        return result.get("code") == 0

    def pause(self) -> bool:
        return self.send_control("jobCtl_cmd", {"jobID": "", "action": "pause"})

    def resume(self) -> bool:
        return self.send_control("jobCtl_cmd", {"jobID": "", "action": "continue"})

    def cancel(self) -> bool:
        return self.send_control("jobCtl_cmd", {"jobID": "", "action": "cancel"})

    def upload_and_print(self, filename: str, content: bytes) -> Dict[str, Any]:
        try:
            response = requests.post(
                f"{self.base_url}/uploadGcode",
                headers={
                    "serialNumber": self.serial_number,
                    "checkCode": self.check_code,
                    "fileSize": str(len(content)),
                    "printNow": "true",
                    "levelingBeforePrint": "true",
                },
                files={"gcodeFile": (filename, content, "application/octet-stream")},
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
        except requests.exceptions.RequestException as e:
            logger.warning(f"[{self.serial_number}] Falló la subida de {filename}: {e}")
            return {"success": False, "error": "No se pudo subir el archivo a la impresora"}
        if data.get("code") != 0:
            return {"success": False, "error": data.get("message", "Error desconocido")}
        return {"success": True, "filename": filename}


# ── Alta (valida credenciales reales antes de guardar) ──

def register_printer(ip: str, serial_number: str, check_code: str, name: str) -> Dict[str, Any]:
    response = FlashForgeClient(ip, serial_number, check_code).check_auth()
    if response.get("code") != 0:
        return {"success": False, "error": response.get("message") or "No se pudo conectar con la impresora"}

    model = _MODEL_BY_PID.get(_parse_pid(response.get("detail", {}).get("pid")), "")
    entries = [e for e in _load_registry() if e.get("serial_number") != serial_number]
    entry = {
        "serial_number": serial_number,
        "ip": ip,
        "check_code": check_code,
        "name": name,
        "model": model,
        "registered_at": time.time(),
    }
    entries.append(entry)
    _save_registry(entries)
    logger.info(f"Impresora FlashForge registrada: {name} ({ip}, {serial_number})")
    return {"success": True, "printer": entry}


# ── Control ──

def pause_printer(serial_number: str) -> bool:
    entry = _find_entry(serial_number)
    if entry is None:
        return False
    return FlashForgeClient(entry["ip"], entry["serial_number"], entry["check_code"]).pause()


def resume_printer(serial_number: str) -> bool:
    entry = _find_entry(serial_number)
    if entry is None:
        return False
    return FlashForgeClient(entry["ip"], entry["serial_number"], entry["check_code"]).resume()


def cancel_printer(serial_number: str) -> bool:
    entry = _find_entry(serial_number)
    if entry is None:
        return False
    return FlashForgeClient(entry["ip"], entry["serial_number"], entry["check_code"]).cancel()


def send_gcode_to_printer(serial_number: str, file_path: str, section: str = "model") -> Dict[str, Any]:
    """Sube un archivo de la biblioteca de NOPAL y arranca la impresión en un
    solo request (uploadGcode con printNow) -- mismo contrato que
    klipper_service.send_gcode_to_printer / elegoo_service.send_gcode_to_printer."""
    entry = _find_entry(serial_number)
    if entry is None:
        return {"success": False, "error": "Impresora no encontrada"}

    abs_path = safe_section_path(section, file_path)
    if not os.path.isfile(abs_path):
        return {"success": False, "error": "Archivo no encontrado"}

    filename = os.path.basename(abs_path)
    with open(abs_path, "rb") as handle:
        content = handle.read()

    client = FlashForgeClient(entry["ip"], entry["serial_number"], entry["check_code"])
    return client.upload_and_print(filename, content)


# ── Normalización y agregación para el dashboard/tarjetas ──

def normalize_flashforge_status(entry: Dict[str, Any], detail: Dict[str, Any]) -> Dict[str, Any]:
    """Adapta /detail al mismo shape que ya usan las tarjetas Klipper/Marlin/Elegoo
    (ver klipper_service.normalize_printer_payload, elegoo_service.normalize_elegoo_status)."""
    online = bool(detail)
    raw_status = detail.get("status")
    job_state = _JOB_STATE_MAP.get(raw_status, "unknown" if raw_status else "idle")
    progress = detail.get("printProgress")

    return {
        "id": entry["serial_number"],
        "name": entry.get("name"),
        "model": entry.get("model"),
        "ip": entry.get("ip"),
        "online": online,
        "status": "online" if online else "offline",
        "temps": {
            "extruder": {
                "current": detail.get("rightTemp"),
                "target": detail.get("rightTargetTemp"),
            },
            "heater_bed": {
                "current": detail.get("platTemp"),
                "target": detail.get("platTargetTemp"),
            },
        },
        "job": {
            "state": job_state,
            "filename": detail.get("printFileName") or None,
            # printProgress es 0.0-1.0, no un porcentaje -- ver HTTP-REST-API.md.
            "progress": round(progress * 100) if isinstance(progress, (int, float)) else None,
            "current_layer": detail.get("printLayer"),
            "total_layer": detail.get("targetPrintLayer"),
        },
    }


def get_registered_printers_with_status() -> List[Dict[str, Any]]:
    """A diferencia de Elegoo (status cacheado, empujado por WS), acá cada
    llamada hace un /detail real por impresora -- se corre en executor desde
    dashboard_service.py, igual que get_all_printers_status de klipper_service.py."""
    entries = _load_registry()
    results = []
    for entry in entries:
        client = FlashForgeClient(entry["ip"], entry["serial_number"], entry["check_code"])
        detail = client.get_detail()
        results.append(normalize_flashforge_status(entry, detail))
    return results
