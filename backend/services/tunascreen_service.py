"""Facade unificada para TUNA-Screen (cliente Android): la única puerta de
entrada que ese cliente tiene a NOPAL. No reimplementa control de
impresoras/láser -- llama las funciones de servicio de cada marca que ya
existen (backend/services/{klipper,marlin_printer,bambu,elegoo,flashforge,
laser}_service.py) y les da forma común: una lista de "capabilities" por
máquina y un status normalizado, para que TUNA-Screen nunca necesite saber
qué marca es cada una.

Las capabilities y actions que se listan reflejan lo que YA está implementado
para cada driver -- no se inventa soporte. Klipper obtiene home/move/extrude
reusando klipper_service.send_console_command (G28/G1 vía Moonraker), no un
endpoint REST dedicado; Bambu/Elegoo/FlashForge siguen sin esa acción porque
sus integraciones no exponen un canal de G-code equivalente todavía."""

import asyncio
import hashlib
import json
import logging
import os
import secrets
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Set

from fastapi import WebSocket

from backend.services import (
    bambu_service,
    elegoo_service,
    flashforge_service,
    klipper_service,
    laser_service,
    marlin_printer_service,
)
from backend.services.plugin_loader_service import get_loaded_plugin_module

logger = logging.getLogger(__name__)

REGISTRY_PATH = "tunascreen_devices.json"
PAIRING_CODE_TTL_SECONDS = 300
API_VERSION = 1

# Contrato de acciones que consume Android. ``capabilities`` describe lo que
# puede mostrar la pantalla; ``actions`` describe lo que realmente puede
# ordenar a esa máquina. Mantenerlos separados evita botones falsos en
# equipos que reportan temperatura pero no permiten cambiarla por su driver.
TRANSPORT_ACTIONS = ["pause", "resume", "cancel"]
KLIPPER_ACTIONS = [
    *TRANSPORT_ACTIONS,
    "home",
    "move",
    "extrude",
    "set_temperature",
]
MARLIN_ACTIONS = [
    *TRANSPORT_ACTIONS,
    "home",
    "move",
    "extrude",
    "set_temperature",
]
LASER_ACTIONS = [
    *TRANSPORT_ACTIONS,
    "home",
    "move",
    "set_laser_power",
    "set_air_assist",
]
CNC_ACTIONS = [
    *TRANSPORT_ACTIONS,
    "home",
    "move",
    "set_work_zero",
    "set_spindle",
    "set_coolant",
]

# Códigos de pairing: en memoria, nunca en disco -- de un solo uso y de vida
# corta (5 min), a diferencia de tunascreen_devices.json (persistente,
# guarda los tokens ya emitidos).
_pending_codes: Dict[str, float] = {}

# Conexiones WS activas -- primer WebSocket servidor->cliente de NOPAL, no
# hay infraestructura previa que reutilizar acá.
_ws_connections: Set[WebSocket] = set()
_registry_lock = threading.RLock()
_last_broadcast_payload: Optional[str] = None


# ── Registro de dispositivos pareados ──
# Guarda credenciales (hash de token), no estado de hardware -- sigue el
# patrón atomic-write de auth_service.py (tmp file + os.replace + chmod
# 0600), no el overwrite simple que usan los *_registry.json de impresoras.

def _load_registry_unlocked() -> List[Dict[str, Any]]:
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _load_registry() -> List[Dict[str, Any]]:
    with _registry_lock:
        return _load_registry_unlocked()


def _save_registry_unlocked(devices: List[Dict[str, Any]]):
    registry_dir = os.path.dirname(os.path.abspath(REGISTRY_PATH))
    temp_path = ""
    try:
        # Cada escritor necesita su propio temporal. El nombre fijo
        # tunascreen_devices.json.tmp provocaba que REST y WebSocket se
        # borraran/movieran mutuamente el archivo durante la autenticación.
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=registry_dir,
            prefix=".tunascreen_devices.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = handle.name
            json.dump(devices, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, REGISTRY_PATH)
    except OSError as exc:
        logger.exception("No se pudo guardar el registro de dispositivos TUNA-Screen")
        try:
            if temp_path:
                os.unlink(temp_path)
        except OSError:
            pass
        raise RuntimeError("No se pudo guardar el dispositivo emparejado") from exc


def _save_registry(devices: List[Dict[str, Any]]):
    with _registry_lock:
        _save_registry_unlocked(devices)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ── Pairing ──

def generate_pairing_code() -> Dict[str, Any]:
    """Solo se llama desde un endpoint que ya exige sesión de admin -- el
    código no reemplaza esa autenticación, es la credencial de un solo uso
    que el dispositivo nuevo va a canjear por un token permanente."""
    now = time.time()
    for code in list(_pending_codes):
        if _pending_codes[code] < now:
            del _pending_codes[code]

    code = f"{secrets.randbelow(1_000_000):06d}"
    _pending_codes[code] = now + PAIRING_CODE_TTL_SECONDS
    return {"code": code, "expires_in": PAIRING_CODE_TTL_SECONDS}


def has_pending_codes() -> bool:
    now = time.time()
    return any(expires_at >= now for expires_at in _pending_codes.values())


def confirm_pairing(code: str, device_name: str) -> Dict[str, Any]:
    expires_at = _pending_codes.get(code)
    if expires_at is None or expires_at < time.time():
        raise ValueError("Código inválido o vencido")
    del _pending_codes[code]  # de un solo uso

    token = secrets.token_urlsafe(32)
    device_id = f"tuna_{secrets.token_hex(8)}"
    with _registry_lock:
        devices = _load_registry_unlocked()
        devices.append({
            "device_id": device_id,
            "name": device_name or "Dispositivo TUNA-Screen",
            "token_hash": _hash_token(token),
            "paired_at": time.time(),
            "last_seen": None,
        })
        _save_registry_unlocked(devices)
    logger.info(f"TUNA-Screen emparejado: {device_name or device_id}")
    return {"device_id": device_id, "token": token}


def resolve_device(token: str) -> Optional[Dict[str, Any]]:
    """None si el token no matchea ningún dispositivo pareado -- quien llama
    (el dependency de FastAPI) decide levantar el 401, acá no."""
    if not token:
        return None
    token_hash = _hash_token(token)
    with _registry_lock:
        devices = _load_registry_unlocked()
        for device in devices:
            if device.get("token_hash") == token_hash:
                now = time.time()
                # last_seen es informativo, no telemetría. Escribirlo en cada
                # request convertía cada ping/acción en I/O sincronizado.
                if now - float(device.get("last_seen") or 0) >= 30:
                    device["last_seen"] = now
                    _save_registry_unlocked(devices)
                return dict(device)
    return None


def list_paired_devices() -> List[Dict[str, Any]]:
    """Para una futura UI de Settings -- nunca incluye token_hash."""
    return [{k: v for k, v in d.items() if k != "token_hash"} for d in _load_registry()]


def revoke_device(device_id: str) -> bool:
    with _registry_lock:
        devices = _load_registry_unlocked()
        filtered = [d for d in devices if d.get("device_id") != device_id]
        if len(filtered) == len(devices):
            return False
        _save_registry_unlocked(filtered)
        return True


# ── Normalización de status ──

# GRBL/Marlin usan "running", los servicios de impresora normalizan a
# "printing" -- un solo vocabulario para que TUNA-Screen no tenga que
# conocer la diferencia por marca.
_JOB_STATE_ALIASES = {"running": "printing"}


def _normalize_job_state(state: Optional[str]) -> str:
    if not state:
        return "idle"
    return _JOB_STATE_ALIASES.get(state, state)


def _temp_pair(current: Any, target: Any) -> Optional[Dict[str, Any]]:
    if current is None and target is None:
        return None
    return {"current": current, "target": target}


def _job_progress_from_normalized(job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Para klipper/bambu/elegoo/flashforge, cuyo `job` normalizado ya trae
    `progress` como porcentaje 0-100."""
    if not job or not job.get("filename"):
        return None
    return {
        "filename": job.get("filename"),
        "percent": job.get("progress"),
        "elapsed_s": job.get("print_duration"),
        "remaining_s": job.get("estimated_remaining"),
    }


def _job_progress_from_counts(job: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Para marlin/laser, cuyo job trae `current`/`total` (conteo de líneas),
    no un porcentaje ya calculado -- mismo cálculo que
    dashboard_service._active_jobs para estas dos marcas."""
    if not job or job.get("state") not in ("running", "paused"):
        return None
    total = job.get("total") or 0
    current = job.get("current") or 0
    return {
        "filename": job.get("filename") or None,
        "percent": round((current / total) * 100) if total else 0,
        "elapsed_s": None,
        "remaining_s": None,
    }


def _klipper_spool_capability(port: int) -> List[str]:
    """El link impresora<->spool es del plugin Spoolman (opcional) -- si no
    está instalado o esa impresora no tiene spool vinculado, no se anuncia
    la capability (evita un botón muerto en la UI)."""
    module = get_loaded_plugin_module("spoolman", "services.spool_link_service")
    if module is None:
        return []
    try:
        return ["spool"] if module.get_link(port) else []
    except Exception:
        logger.exception("No se pudo consultar el link de spool para port=%s", port)
        return []


def _camera_fields(device_type: str, device_id: str) -> Any:
    """Las cámaras son un plugin, no un módulo de core -- si no está
    instalado/cargado, o si esta máquina puntual no tiene ninguna cámara
    vinculada (purpose="timelapse" + bound_device, ver camera_service.py del
    plugin), no se anuncia la capability (mismo criterio que
    _klipper_spool_capability). Devuelve (capabilities_extra, camera_dict) --
    cada *_machine llama esto una sola vez y usa ambas partes: la lista para
    sumar a "capabilities", el dict para el sub-objeto "camera" del status.

    `device_id` debe coincidir con el mismo identificador que ya usa
    dashboard_service._active_jobs() por marca (nombre para Klipper, serial/
    mainboard_id para Bambu/Elegoo/FlashForge, ruta de dispositivo para
    Marlin, host para láser/CNC) -- es el mismo valor que la UI de "vincular
    cámara" del plugin ya usa para guardar bound_device."""
    module = get_loaded_plugin_module("camera-viewer", "services.camera_service")
    if module is None or not device_id:
        return [], None
    try:
        bound = module.get_camera_bound_to(device_type, device_id)
        if bound is None:
            return [], None
        camera = module.get_camera_by_id(bound["id"])
    except Exception:
        logger.exception("No se pudo consultar la cámara vinculada para %s:%s", device_type, device_id)
        return [], None
    if camera is None:
        return [], None
    return ["camera"], {"stream_url": camera.get("stream_url"), "name": camera.get("name")}


def _klipper_machine(entry: Dict[str, Any]) -> Dict[str, Any]:
    port = entry["port"]
    online = entry.get("status") == "online"
    data = entry.get("data") or {}
    job = entry.get("job") or {}
    hotend = data.get("extruder") or {}
    bed = data.get("heater_bed") or {}
    # Klipper no tiene id/serial propio expuesto acá (a diferencia de las
    # otras marcas) -- el vínculo de cámara usa el nombre, misma convención
    # que dashboard_service._active_jobs() y que la UI de "vincular cámara".
    camera_capabilities, camera = _camera_fields("klipper", entry.get("name"))
    return {
        "id": f"klipper:{port}",
        "name": entry.get("name") or f"Klipper {port}",
        "type": "printer",
        "driver": "klipper",
        "online": online,
        "capabilities": [
            "temperature",
            "movement",
            "extrusion",
            *_klipper_spool_capability(port),
            *camera_capabilities,
        ],
        "actions": KLIPPER_ACTIONS,
        "status": {
            "state": _normalize_job_state(job.get("state")) if online else "offline",
            "hotend": _temp_pair(hotend.get("temperature"), hotend.get("target")),
            "bed": _temp_pair(bed.get("temperature"), bed.get("target")),
            "job": _job_progress_from_normalized(job),
            "camera": camera,
        },
    }


def _bambu_like_machine(entry: Dict[str, Any], brand: str) -> Dict[str, Any]:
    """bambu/elegoo/flashforge ya normalizan a la misma forma (ver
    normalize_bambu_status/normalize_elegoo_status/normalize_flashforge_status,
    documentadas ahí mismo como intencionalmente iguales)."""
    online = bool(entry.get("online"))
    temps = entry.get("temps") or {}
    job = entry.get("job") or {}
    hotend = temps.get("extruder") or {}
    bed = temps.get("heater_bed") or {}
    camera_capabilities, camera = _camera_fields(brand, entry.get("id"))
    return {
        "id": f"{brand}:{entry['id']}",
        "name": entry.get("name") or str(entry["id"]),
        "type": "printer",
        "driver": brand,
        "online": online,
        # Sin REST de home/jog/extrude para estas marcas todavía -- ver
        # docstring del módulo. Sin evidencia de link a Spoolman tampoco (a
        # diferencia de Klipper), así que no se anuncia "spool" acá.
        "capabilities": ["temperature", *camera_capabilities],
        "actions": TRANSPORT_ACTIONS,
        "status": {
            "state": _normalize_job_state(job.get("state")) if online else "offline",
            "hotend": _temp_pair(hotend.get("current"), hotend.get("target")),
            "bed": _temp_pair(bed.get("current"), bed.get("target")),
            "job": _job_progress_from_normalized(job),
            "camera": camera,
        },
    }


async def _marlin_machine(entry: Dict[str, Any]) -> Dict[str, Any]:
    device = entry["device"]
    registered_online = bool(entry.get("online"))
    status = await marlin_printer_service.get_status(device) if registered_online else None
    job = await marlin_printer_service.get_job_status(device) if registered_online else None
    online = registered_online and status is not None
    hotend = (status or {}).get("extruder") or {}
    bed = (status or {}).get("heater_bed") or {}
    camera_capabilities, camera = _camera_fields("marlin", device)
    return {
        "id": f"marlin:{device}",
        "name": entry.get("name") or device,
        "type": "printer",
        "driver": "marlin",
        "online": online,
        "capabilities": ["temperature", "movement", "extrusion", *camera_capabilities],
        "actions": MARLIN_ACTIONS,
        "status": {
            "state": _normalize_job_state((status or {}).get("state")) if online else "offline",
            "hotend": _temp_pair(hotend.get("current"), hotend.get("target")),
            "bed": _temp_pair(bed.get("current"), bed.get("target")),
            "position": (
                {"x": status["x"], "y": status["y"], "z": status["z"]} if status else None
            ),
            "job": _job_progress_from_counts(job),
            "camera": camera,
        },
    }


async def _laser_machine(entry: Dict[str, Any]) -> Dict[str, Any]:
    host = entry["host"]
    registered_online = bool(entry.get("online"))
    kind = entry.get("kind") or "laser"
    status = await laser_service.get_status(host) if registered_online else None
    job = await laser_service.get_job_status(host) if registered_online else None
    online = registered_online and status is not None

    if kind == "cnc":
        # spindle/coolant vía M3/M4/M5 (RPM con S) y M7/M8/M9 -- mismo
        # convenio de relé que documenta laser_service para air_assist en
        # modo láser, reutilizado acá como refrigerante. Sin "probe": no hay
        # ciclo de sondeo (G38.2) expuesto por NOPAL todavía.
        capabilities = ["movement", "spindle", "spindle_rpm", "coolant", "limits"]
    else:
        # laser_power vía M3/M5 (potencia con S), air_assist vía M8/M9 --ver
        # el comentario en laser_service sobre el relé de flood cableado a
        # la asistencia de aire. Sin "exhaust": no hay relé/comando propio
        # documentado para extracción todavía.
        capabilities = ["movement", "laser_power", "air_assist", "limits"]

    # bound_device.type de una cámara vinculada a láser/CNC es "laser" o
    # "cnc" (no un prefijo compartido) -- mismo `kind` que ya resolvimos
    # arriba, ver dashboard_service._active_jobs() para la misma convención.
    camera_capabilities, camera = _camera_fields(kind, host)

    return {
        "id": f"laser:{host}",
        "name": entry.get("name") or host,
        "type": kind,
        "driver": "grbl",
        "online": online,
        "capabilities": [*capabilities, *camera_capabilities],
        "actions": CNC_ACTIONS if kind == "cnc" else LASER_ACTIONS,
        "status": {
            "state": _normalize_job_state((job or {}).get("state")) if online else "offline",
            "position": (
                {"x": status["x"], "y": status["y"], "z": status["z"]} if status else None
            ),
            "feed": (status or {}).get("feed"),
            "speed": (status or {}).get("speed"),
            # GRBL reporta ``FS:feed,spindle``. En láser el segundo valor es
            # potencia S (no porcentaje); en CNC sí representa RPM.
            "laser_power": (status or {}).get("speed") if kind != "cnc" else None,
            "spindle_rpm": (status or {}).get("speed") if kind == "cnc" else None,
            "job": _job_progress_from_counts(job),
            "camera": camera,
        },
    }


MACHINE_CACHE_TTL_SECONDS = 2.5
OFFLINE_GRACE_SNAPSHOTS = 3
_machines_cache: List[Dict[str, Any]] = []
_machines_cache_at = 0.0
_machines_source_signature: tuple = ()
_machine_offline_counts: Dict[str, int] = {}
_machines_refresh_lock = asyncio.Lock()


def _current_source_signature() -> tuple:
    """También invalida el caché cuando pytest reemplaza un servicio."""
    return (
        id(klipper_service.get_all_printers_status),
        id(bambu_service.get_registered_printers_with_status),
        id(elegoo_service.get_registered_printers_with_status),
        id(flashforge_service.get_registered_printers_with_status),
        id(marlin_printer_service.get_registered_printers_with_status),
        id(laser_service.get_registered_lasers_status),
    )


def _cached_driver(driver: str) -> List[Dict[str, Any]]:
    return [machine for machine in _machines_cache if machine.get("driver") == driver]


async def _collect_machines() -> List[Dict[str, Any]]:
    loop = asyncio.get_event_loop()
    results = await asyncio.gather(
        loop.run_in_executor(None, klipper_service.get_all_printers_status),
        loop.run_in_executor(None, bambu_service.get_registered_printers_with_status),
        loop.run_in_executor(None, elegoo_service.get_registered_printers_with_status),
        loop.run_in_executor(None, flashforge_service.get_registered_printers_with_status),
        loop.run_in_executor(None, marlin_printer_service.get_registered_printers_with_status),
        laser_service.get_registered_lasers_status(),
        return_exceptions=True,
    )

    machines: List[Dict[str, Any]] = []
    source_specs = (
        ("klipper", results[0], lambda entry: _klipper_machine(entry)),
        ("bambu", results[1], lambda entry: _bambu_like_machine(entry, "bambu")),
        ("elegoo", results[2], lambda entry: _bambu_like_machine(entry, "elegoo")),
        ("flashforge", results[3], lambda entry: _bambu_like_machine(entry, "flashforge")),
    )
    for driver, entries, normalizer in source_specs:
        if isinstance(entries, BaseException):
            logger.warning("Estado %s no disponible; se conserva el último snapshot: %s", driver, entries)
            machines.extend(_cached_driver(driver))
            continue
        machines.extend(normalizer(entry) for entry in entries)

    marlin_entries = results[4]
    if isinstance(marlin_entries, BaseException):
        logger.warning("Estado marlin no disponible; se conserva el último snapshot: %s", marlin_entries)
        machines.extend(_cached_driver("marlin"))
    else:
        for entry in marlin_entries:
            try:
                machines.append(await _marlin_machine(entry))
            except Exception as exc:
                logger.warning("No se pudo actualizar Marlin %s: %s", entry.get("device"), exc)
                machine_id = f"marlin:{entry.get('device')}"
                previous = next((m for m in _machines_cache if m.get("id") == machine_id), None)
                if previous:
                    machines.append(previous)

    laser_entries = results[5]
    if isinstance(laser_entries, BaseException):
        logger.warning("Estado GRBL no disponible; se conserva el último snapshot: %s", laser_entries)
        machines.extend(_cached_driver("grbl"))
    else:
        for entry in laser_entries:
            try:
                machines.append(await _laser_machine(entry))
            except Exception as exc:
                logger.warning("No se pudo actualizar GRBL %s: %s", entry.get("host"), exc)
                machine_id = f"laser:{entry.get('host')}"
                previous = next((m for m in _machines_cache if m.get("id") == machine_id), None)
                if previous:
                    machines.append(previous)
    return machines


def _stabilize_machine_presence(fresh: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Un timeout aislado no debe hacer parpadear una tarjeta como offline."""
    previous_by_id = {machine["id"]: machine for machine in _machines_cache}
    stable: List[Dict[str, Any]] = []
    seen: Set[str] = set()

    for machine in fresh:
        machine_id = machine["id"]
        seen.add(machine_id)
        previous = previous_by_id.get(machine_id)
        if previous and previous.get("online") and not machine.get("online"):
            failures = _machine_offline_counts.get(machine_id, 0) + 1
            _machine_offline_counts[machine_id] = failures
            stable.append(previous if failures < OFFLINE_GRACE_SNAPSHOTS else machine)
        else:
            _machine_offline_counts.pop(machine_id, None)
            stable.append(machine)

    for machine_id, previous in previous_by_id.items():
        if machine_id in seen:
            continue
        failures = _machine_offline_counts.get(machine_id, 0) + 1
        _machine_offline_counts[machine_id] = failures
        if failures < OFFLINE_GRACE_SNAPSHOTS:
            stable.append(previous)

    return stable


async def list_machines() -> List[Dict[str, Any]]:
    global _machines_cache, _machines_cache_at, _machines_source_signature

    now = time.monotonic()
    signature = _current_source_signature()
    if (
        _machines_cache
        and signature == _machines_source_signature
        and now - _machines_cache_at < MACHINE_CACHE_TTL_SECONDS
    ):
        return _machines_cache

    async with _machines_refresh_lock:
        now = time.monotonic()
        signature = _current_source_signature()
        if (
            _machines_cache
            and signature == _machines_source_signature
            and now - _machines_cache_at < MACHINE_CACHE_TTL_SECONDS
        ):
            return _machines_cache

        if signature != _machines_source_signature:
            _machines_cache = []
            _machine_offline_counts.clear()

        fresh = await _collect_machines()
        _machines_cache = _stabilize_machine_presence(fresh)
        _machines_cache_at = time.monotonic()
        _machines_source_signature = signature
        return _machines_cache


async def get_machine(machine_id: str) -> Optional[Dict[str, Any]]:
    """Recalcula list_machines() entero y filtra -- correcto y simple; a la
    escala de un taller (unas pocas máquinas) no vale la pena un camino
    separado más eficiente todavía."""
    machines = await list_machines()
    return next((m for m in machines if m["id"] == machine_id), None)


# ── Despacho de acciones ──

_ACTION_CAPABILITY = {
    "home": "movement",
    "move": "movement",
    "extrude": "extrusion",
    "set_temperature": "temperature",
    "set_laser_power": "laser_power",
    "set_air_assist": "air_assist",
    "set_spindle": "spindle",
    "set_coolant": "coolant",
    "set_work_zero": "movement",
    # pause/resume/cancel no están acá a propósito: están soportadas por
    # todas las marcas (ver exploración), no hace falta gatear por capability.
}


def _split_machine_id(machine_id: str) -> tuple:
    brand, sep, raw_id = machine_id.partition(":")
    if not sep or not raw_id:
        raise ValueError("id de máquina inválido")
    return brand, raw_id


async def dispatch_action(machine_id: str, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
    brand, raw_id = _split_machine_id(machine_id)
    machine = await get_machine(machine_id)
    if machine is None:
        raise ValueError("Máquina no encontrada")
    if not machine.get("online"):
        raise ValueError("La máquina está fuera de línea")
    if action not in machine.get("actions", []):
        raise ValueError("Acción no soportada para esta máquina")

    required_capability = _ACTION_CAPABILITY.get(action)
    if required_capability is not None and required_capability not in machine["capabilities"]:
        raise ValueError("Acción no soportada para esta máquina")

    if brand == "klipper":
        return await _dispatch_klipper(int(raw_id), action, params)
    if brand == "marlin":
        return await _dispatch_marlin(raw_id, action, params)
    if brand == "bambu":
        return _dispatch_bambu(raw_id, action)
    if brand == "elegoo":
        return await _dispatch_elegoo(raw_id, action)
    if brand == "flashforge":
        return _dispatch_flashforge(raw_id, action)
    if brand == "laser":
        return await _dispatch_laser(raw_id, action, params)
    raise ValueError(f"Marca desconocida: {brand}")


async def _dispatch_klipper(port: int, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if action == "pause":
        ok = klipper_service.pause_printer_print(port)
    elif action == "resume":
        ok = klipper_service.resume_printer_print(port)
    elif action == "cancel":
        ok = klipper_service.cancel_printer_print(port)
    elif action == "set_temperature":
        heater = _heater_param(params)
        ok = klipper_service.set_heater_target(port, heater, _float_param(params, "target", 0, 500))
    elif action == "home":
        axes = _axes_param(params)
        ok = klipper_service.send_console_command(port, f"G28 {' '.join(axes)}".strip())
    elif action == "move":
        axis = _axis_param(params, allow_extruder=False)
        distance = _float_param(params, "distance", -1000, 1000)
        feed = _float_param(params, "feed", 1, 30000, default=1500)
        script = (
            "SAVE_GCODE_STATE NAME=TUNA_SCREEN_MOVE\n"
            "G91\n"
            f"G0 {axis}{distance:g} F{feed:g}\n"
            "RESTORE_GCODE_STATE NAME=TUNA_SCREEN_MOVE"
        )
        ok = klipper_service.send_console_command(port, script)
    elif action == "extrude":
        distance = _float_param(params, "distance", -200, 200)
        feed = _float_param(params, "feed", 1, 3000, default=300)
        script = (
            "SAVE_GCODE_STATE NAME=TUNA_SCREEN_EXTRUDE\n"
            "M83\n"
            f"G1 E{distance:g} F{feed:g}\n"
            "RESTORE_GCODE_STATE NAME=TUNA_SCREEN_EXTRUDE"
        )
        ok = klipper_service.send_console_command(port, script)
    else:
        raise ValueError(f"Acción no soportada para Klipper: {action}")
    return {"success": bool(ok)}


async def _dispatch_marlin(device: str, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if action == "pause":
        ok = await marlin_printer_service.pause_job(device)
    elif action == "resume":
        ok = await marlin_printer_service.resume_job(device)
    elif action == "cancel":
        ok = await marlin_printer_service.cancel_job(device)
    elif action == "home":
        ok = await marlin_printer_service.home(device, _axes_param(params) or None)
    elif action == "move":
        ok = await marlin_printer_service.jog(
            device,
            _axis_param(params, allow_extruder=False),
            _float_param(params, "distance", -1000, 1000),
            _float_param(params, "feed", 1, 30000, default=1500),
        )
    elif action == "extrude":
        ok = await marlin_printer_service.jog(
            device,
            "E",
            _float_param(params, "distance", -200, 200),
            _float_param(params, "feed", 1, 3000, default=300),
        )
    elif action == "set_temperature":
        ok = marlin_printer_service.set_heater_target(
            device,
            _heater_param(params),
            _float_param(params, "target", 0, 500),
        )
    else:
        raise ValueError(f"Acción no soportada para Marlin: {action}")
    return {"success": bool(ok)}


def _dispatch_bambu(serial: str, action: str) -> Dict[str, Any]:
    if action == "pause":
        ok = bambu_service.pause_printer(serial)
    elif action == "resume":
        ok = bambu_service.resume_printer(serial)
    elif action == "cancel":
        ok = bambu_service.cancel_printer(serial)
    else:
        raise ValueError(f"Acción no soportada para Bambu: {action}")
    return {"success": bool(ok)}


async def _dispatch_elegoo(mainboard_id: str, action: str) -> Dict[str, Any]:
    if action == "pause":
        ok = await elegoo_service.pause_printer(mainboard_id)
    elif action == "resume":
        ok = await elegoo_service.resume_printer(mainboard_id)
    elif action == "cancel":
        ok = await elegoo_service.cancel_printer(mainboard_id)
    else:
        raise ValueError(f"Acción no soportada para Elegoo: {action}")
    return {"success": bool(ok)}


def _dispatch_flashforge(serial_number: str, action: str) -> Dict[str, Any]:
    if action == "pause":
        ok = flashforge_service.pause_printer(serial_number)
    elif action == "resume":
        ok = flashforge_service.resume_printer(serial_number)
    elif action == "cancel":
        ok = flashforge_service.cancel_printer(serial_number)
    else:
        raise ValueError(f"Acción no soportada para FlashForge: {action}")
    return {"success": bool(ok)}


async def _dispatch_laser(host: str, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if action == "pause":
        ok = await laser_service.pause_job(host)
    elif action == "resume":
        ok = await laser_service.resume_job(host)
    elif action == "cancel":
        ok = await laser_service.cancel_job(host)
    elif action == "home":
        ok = await laser_service.home(host, _axes_param(params) or None)
    elif action == "move":
        ok = await laser_service.jog(
            host,
            _axis_param(params, allow_extruder=False),
            _float_param(params, "distance", -1000, 1000),
            _float_param(params, "feed", 1, 30000, default=1000),
        )
    elif action in ("set_laser_power", "set_spindle"):
        ok = await _send_grbl_spindle_command(host, params)
    elif action in ("set_air_assist", "set_coolant"):
        ok = await _send_grbl_relay_command(host, _bool_param(params, "on"))
    elif action == "set_work_zero":
        axes = _axes_param(params) or "XYZ"
        coordinates = " ".join(f"{axis}0" for axis in axes)
        loop = asyncio.get_event_loop()
        ok = await loop.run_in_executor(
            None,
            laser_service.send_raw_command,
            host,
            f"G10 L20 P1 {coordinates}",
        )
    else:
        raise ValueError(f"Acción no soportada para láser/CNC: {action}")
    return {"success": bool(ok)}


async def _send_grbl_spindle_command(host: str, params: Dict[str, Any]) -> bool:
    loop = asyncio.get_event_loop()
    if not _bool_param(params, "on"):
        return await loop.run_in_executor(None, laser_service.send_raw_command, host, "M5")
    value_key = "rpm" if "rpm" in params else "power"
    rpm_or_power = int(_float_param(params, value_key, 0, 100000, default=1000))
    direction_gcode = "M4" if params.get("direction") == "ccw" else "M3"
    return await loop.run_in_executor(
        None, laser_service.send_raw_command, host, f"{direction_gcode} S{rpm_or_power}"
    )


async def _send_grbl_relay_command(host: str, on: bool) -> bool:
    """M8/M9 -- mismo relé de flood que laser_service ya documenta como
    cableado a la asistencia de aire en modo láser; en modo CNC se
    reinterpreta como refrigerante, es el mismo comando físico."""
    loop = asyncio.get_event_loop()
    command = "M8" if on else "M9"
    return await loop.run_in_executor(None, laser_service.send_raw_command, host, command)


def _float_param(
    params: Dict[str, Any],
    name: str,
    minimum: float,
    maximum: float,
    default: Optional[float] = None,
) -> float:
    value = params.get(name, default)
    if value is None:
        raise ValueError(f"Falta el parámetro {name}")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"El parámetro {name} debe ser numérico") from exc
    if not minimum <= number <= maximum:
        raise ValueError(f"El parámetro {name} debe estar entre {minimum:g} y {maximum:g}")
    return number


def _bool_param(params: Dict[str, Any], name: str) -> bool:
    value = params.get(name)
    if not isinstance(value, bool):
        raise ValueError(f"El parámetro {name} debe ser booleano")
    return value


def _axis_param(params: Dict[str, Any], allow_extruder: bool) -> str:
    axis = str(params.get("axis", "")).upper()
    allowed = {"X", "Y", "Z", "E"} if allow_extruder else {"X", "Y", "Z"}
    if axis not in allowed:
        raise ValueError("Eje inválido")
    return axis


def _axes_param(params: Dict[str, Any]) -> str:
    axes = str(params.get("axes", "")).upper().replace(" ", "")
    if any(axis not in "XYZ" for axis in axes) or len(set(axes)) != len(axes):
        raise ValueError("Los ejes deben ser una combinación de X, Y y Z")
    return axes


def _heater_param(params: Dict[str, Any]) -> str:
    heater = str(params.get("heater", "")).lower()
    aliases = {"hotend": "extruder", "extruder": "extruder", "bed": "heater_bed", "heater_bed": "heater_bed"}
    normalized = aliases.get(heater)
    if normalized is None:
        raise ValueError("Calentador inválido")
    return normalized


# ── WebSocket: difusión de estado en vivo ──

def register_connection(websocket: WebSocket):
    _ws_connections.add(websocket)


def unregister_connection(websocket: WebSocket):
    _ws_connections.discard(websocket)


async def broadcast_machines():
    global _last_broadcast_payload
    if not _ws_connections:
        return
    try:
        machines = await list_machines()
    except Exception:
        logger.exception("No se pudo generar el estado de máquinas para difundir por WS")
        return

    payload = json.dumps({
        "type": "machines",
        "api_version": API_VERSION,
        "machines": machines,
    })
    if payload == _last_broadcast_payload:
        return
    _last_broadcast_payload = payload
    stale: List[WebSocket] = []
    for websocket in list(_ws_connections):
        try:
            await websocket.send_text(payload)
        except Exception:
            stale.append(websocket)
    for websocket in stale:
        _ws_connections.discard(websocket)


async def broadcaster_loop():
    """Arrancado desde main.py (mismo patrón que
    _start_scheduled_prints_loop) -- un tick cada 2s es suficiente para que
    la app se sienta "en vivo" sin generar carga real en Klipper/Bambu/etc."""
    while True:
        await asyncio.sleep(2)
        await broadcast_machines()
