import asyncio
import os
import shutil
from collections import deque
from typing import Any, Dict, List, Optional

from backend.services.bambu_service import get_registered_printers_with_status as get_bambu_printers
from backend.services.elegoo_service import get_registered_printers_with_status as get_elegoo_printers
from backend.services.flashforge_service import get_registered_printers_with_status as get_flashforge_printers
from backend.services.klipper_service import get_all_printers_status, get_system_stats
from backend.services.laser_service import get_active_job_hosts, get_registered_lasers_status
from backend.services.marlin_printer_service import get_active_job_devices, get_registered_printers_with_status
from backend.services import maintenance_service
from backend.services.notification_service import get_notifications
from backend.services.plugin_loader_service import get_loaded_plugin_module
from backend.utils import is_git_update_available

UPLOAD_FOLDER = "uploads"


def _get_camera_health_counts() -> Dict[str, int]:
    """Las cámaras son un plugin, no un módulo de core -- si no está
    instalado/cargado no hay conteo real que sumar, se trata como 0/0 en
    vez de romper el arranque de NOPAL."""
    module = get_loaded_plugin_module("camera-viewer", "services.camera_service")
    if module is None:
        return {"online": 0, "total": 0}
    return module.get_camera_health_counts()


async def _get_ambient_temperature_c() -> Optional[float]:
    """Temperatura ambiente del taller, si el usuario eligió una placa con
    DHT11 en Automatización de Taller -- ver
    accessory_service.get_ambient_temperature_c(). Ese plugin no es un
    módulo de core -- si no está instalado/cargado, o si nadie eligió una
    placa todavía, se trata como None en vez de inventar un dato (mismo
    patrón que _get_camera_health_counts más arriba)."""
    module = get_loaded_plugin_module("arduino-accessories", "services.accessory_service")
    if module is None:
        return None
    return await module.get_ambient_temperature_c()

# Historial de carga del host para el sparkline de "Rendimiento del host" —
# se va llenando con cada consulta al resumen (cada ~10s desde el frontend),
# no es un dato inventado ni interpolado, solo empieza vacío hasta que se
# acumulan muestras reales desde que el proceso arrancó.
_CPU_HISTORY_MAXLEN = 60
_cpu_history: deque = deque(maxlen=_CPU_HISTORY_MAXLEN)


def _read_load_average() -> Optional[float]:
    """Carga promedio de 1 minuto vía /proc/uptime's sibling /proc/loadavg
    (estándar de Unix, no relacionado con cpu_percent de Moonraker). None
    fuera de Linux."""
    try:
        with open("/proc/loadavg", "r", encoding="utf-8") as handle:
            return float(handle.read().split()[0])
    except (FileNotFoundError, ValueError, IndexError, OSError):
        return None


def get_storage_snapshot() -> Dict[str, Any]:
    """Uso de disco de la partición que aloja uploads/ (modelos + G-code).
    Compartido por /api/storage y el resumen del panel para no repetir la
    misma caminata de archivos dos veces."""
    if not os.path.exists(UPLOAD_FOLDER):
        os.makedirs(UPLOAD_FOLDER)
    stat = shutil.disk_usage(UPLOAD_FOLDER)
    used_bytes = 0
    for root, _dirs, files in os.walk(UPLOAD_FOLDER):
        for filename in files:
            filepath = os.path.join(root, filename)
            if os.path.isfile(filepath):
                used_bytes += os.path.getsize(filepath)
    return {"used": used_bytes, "free": stat.free, "total": stat.total}


def _read_uptime_seconds() -> Optional[float]:
    """Uptime real del host vía /proc/uptime, sin sumar psutil como
    dependencia nueva solo para un número. None fuera de Linux."""
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as handle:
            return float(handle.read().split()[0])
    except (FileNotFoundError, ValueError, IndexError, OSError):
        return None


def _device_counts(
    klipper: List[Dict[str, Any]],
    marlin: List[Dict[str, Any]],
    elegoo: List[Dict[str, Any]],
    flashforge: List[Dict[str, Any]],
    bambu: List[Dict[str, Any]],
    laser_cnc: List[Dict[str, Any]],
    camera: Dict[str, int],
) -> Dict[str, Dict[str, int]]:
    counts = {
        "printer": {"online": 0, "total": 0},
        "laser": {"online": 0, "total": 0},
        "cnc": {"online": 0, "total": 0},
        "camera": dict(camera),
    }
    for printer in klipper:
        counts["printer"]["total"] += 1
        if printer.get("status") == "online":
            counts["printer"]["online"] += 1
    for printer in marlin:
        counts["printer"]["total"] += 1
        if printer.get("online"):
            counts["printer"]["online"] += 1
    for printer in elegoo:
        counts["printer"]["total"] += 1
        if printer.get("online"):
            counts["printer"]["online"] += 1
    for printer in flashforge:
        counts["printer"]["total"] += 1
        if printer.get("online"):
            counts["printer"]["online"] += 1
    for printer in bambu:
        counts["printer"]["total"] += 1
        if printer.get("online"):
            counts["printer"]["online"] += 1
    for entry in laser_cnc:
        kind = "cnc" if entry.get("kind") == "cnc" else "laser"
        counts[kind]["total"] += 1
        if entry.get("online"):
            counts[kind]["online"] += 1
    return counts


def _active_jobs(
    klipper: List[Dict[str, Any]],
    elegoo: List[Dict[str, Any]],
    flashforge: List[Dict[str, Any]],
    bambu: List[Dict[str, Any]],
    marlin_jobs: List[Dict[str, Any]],
    marlin_registry: List[Dict[str, Any]],
    laser_cnc_jobs: List[Dict[str, Any]],
    laser_cnc_registry: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    jobs: List[Dict[str, Any]] = []

    for printer in klipper:
        job = printer.get("job") or {}
        if job.get("state") in ("printing", "paused"):
            jobs.append({
                "machine_type": "printer",
                # device_type/device_id identifican la máquina física puntual
                # -- misma convención que bound_device del plugin camera-viewer
                # (Klipper no tiene un id/serial propio expuesto acá, así que
                # usa el nombre, igual que la asociación cámara-dispositivo).
                "device_type": "klipper",
                "device_id": printer.get("name"),
                "name": printer.get("name"),
                "filename": job.get("filename"),
                "state": job.get("state"),
                "progress": job.get("progress"),
                "time_remaining_s": job.get("estimated_remaining"),
                "current_layer": job.get("current_layer"),
                "total_layer": job.get("total_layer"),
            })

    for printer in elegoo:
        job = printer.get("job") or {}
        if job.get("state") in ("printing", "paused"):
            jobs.append({
                "machine_type": "printer",
                "device_type": "elegoo",
                "device_id": printer.get("mainboard_id"),
                "name": printer.get("name"),
                "filename": job.get("filename"),
                "state": job.get("state"),
                "progress": job.get("progress"),
                "time_remaining_s": None,
                "current_layer": job.get("current_layer"),
                "total_layer": job.get("total_layer"),
            })

    for printer in flashforge:
        job = printer.get("job") or {}
        if job.get("state") in ("printing", "paused"):
            jobs.append({
                "machine_type": "printer",
                "device_type": "flashforge",
                "device_id": printer.get("serial_number"),
                "name": printer.get("name"),
                "filename": job.get("filename"),
                "state": job.get("state"),
                "progress": job.get("progress"),
                "time_remaining_s": None,
                "current_layer": job.get("current_layer"),
                "total_layer": job.get("total_layer"),
            })

    for printer in bambu:
        job = printer.get("job") or {}
        if job.get("state") in ("printing", "paused"):
            jobs.append({
                "machine_type": "printer",
                "device_type": "bambu",
                "device_id": printer.get("id"),
                "name": printer.get("name"),
                "filename": job.get("filename"),
                "state": job.get("state"),
                "progress": job.get("progress"),
                # mc_remaining_time de Bambu viene en minutos, no segundos --
                # se prefiere omitirlo a convertir a ciegas sin poder
                # confirmar la unidad contra hardware real.
                "time_remaining_s": None,
                "current_layer": job.get("current_layer"),
                "total_layer": job.get("total_layer"),
            })

    marlin_names = {entry.get("device"): entry.get("name") for entry in marlin_registry}
    for job in marlin_jobs:
        total = job.get("total") or 0
        current = job.get("current") or 0
        jobs.append({
            "machine_type": "printer",
            "device_type": "marlin",
            "device_id": job.get("device"),
            "name": marlin_names.get(job.get("device")) or job.get("device"),
            "filename": job.get("filename"),
            "state": job.get("state"),
            "progress": round((current / total) * 100) if total else 0,
            "time_remaining_s": None,
            "current_layer": None,
            "total_layer": None,
        })

    laser_meta = {entry.get("host"): entry for entry in laser_cnc_registry}
    for job in laser_cnc_jobs:
        entry = laser_meta.get(job.get("host"), {})
        kind = "cnc" if entry.get("kind") == "cnc" else "laser"
        total = job.get("total") or 0
        current = job.get("current") or 0
        jobs.append({
            "machine_type": kind,
            "device_type": kind,
            "device_id": job.get("host"),
            "name": entry.get("name") or job.get("host"),
            "filename": job.get("filename"),
            "state": job.get("state"),
            "progress": round((current / total) * 100) if total else 0,
            "time_remaining_s": None,
            "current_layer": None,
            "total_layer": None,
        })

    return jobs


def _estimated_active_power_watts(active_job_kinds: List[str]) -> Optional[int]:
    """Estimación, no medición: suma la potencia nominal configurada (en
    Cotizador > Ajustes) de cada máquina con un trabajo corriendo ahora
    mismo. NOPAL no tiene integración con medidores de energía reales.

    Cotizador es un plugin, no un módulo de core -- si no está
    instalado/cargado no hay ajustes reales que sumar, se trata como {} en
    vez de romper el arranque de NOPAL (mismo patrón que
    _get_camera_health_counts más arriba).

    None (no 0) si no hay NINGUNA potencia configurada -- 0 significa "sí
    está configurado pero ahora mismo no hay nada corriendo", una
    distinción real: el dashboard oculta la ficha entera con None, en vez
    de mostrar un "~0 W" que no significa nada para quien nunca configuró
    esto."""
    module = get_loaded_plugin_module("cotizador", "services.pricing_service")
    watts_default = module.get_settings().get("machine_watts_default", {}) if module else {}
    if not any(float(value or 0) > 0 for value in watts_default.values()):
        return None
    total = sum(float(watts_default.get(kind, 0) or 0) for kind in active_job_kinds)
    return round(total)


async def get_dashboard_summary() -> Dict[str, Any]:
    loop = asyncio.get_event_loop()
    (
        klipper,
        marlin_registry,
        flashforge,
        bambu,
        laser_cnc_registry,
        notifications,
        update_available,
        host_stats,
        storage,
        ambient,
    ) = await asyncio.gather(
        loop.run_in_executor(None, get_all_printers_status),
        loop.run_in_executor(None, get_registered_printers_with_status),
        loop.run_in_executor(None, get_flashforge_printers),
        # A diferencia de Elegoo (ver más abajo), get_bambu_printers() sí
        # entra en el batch de executor: _ensure_client() usa hilos propios
        # de paho-mqtt (Client.loop_start()), no asyncio.create_task, así
        # que no depende del event loop de este hilo para arrancar.
        loop.run_in_executor(None, get_bambu_printers),
        get_registered_lasers_status(),
        get_notifications(),
        loop.run_in_executor(None, is_git_update_available),
        loop.run_in_executor(None, get_system_stats),
        loop.run_in_executor(None, get_storage_snapshot),
        _get_ambient_temperature_c(),
    )
    marlin_jobs = await loop.run_in_executor(None, get_active_job_devices)
    laser_cnc_jobs = await loop.run_in_executor(None, get_active_job_hosts)
    camera_counts = await loop.run_in_executor(None, _get_camera_health_counts)
    # Sin executor a propósito: arranca (si hace falta) las tareas asyncio de
    # los listeners WS persistentes de elegoo_service.py, que necesitan el
    # event loop de este mismo hilo (asyncio.create_task) para registrarse.
    elegoo = get_elegoo_printers()

    device_counts = _device_counts(klipper, marlin_registry, elegoo, flashforge, bambu, laser_cnc_registry, camera_counts)
    jobs = _active_jobs(klipper, elegoo, flashforge, bambu, marlin_jobs, marlin_registry, laser_cnc_jobs, laser_cnc_registry)

    # Cámaras ya suman al total/salud general -- antes se excluían a
    # propósito porque el bucket era un placeholder fijo en 0/0, ahora viene
    # de un conteo real (ver get_camera_health_counts en camera_service.py).
    services_total = sum(v["total"] for v in device_counts.values())
    services_online = sum(v["online"] for v in device_counts.values())

    alert_counts = {"error": 0, "warning": 0, "info": 0}
    for item in notifications.get("items", []):
        severity = item.get("severity", "info")
        if severity in alert_counts:
            alert_counts[severity] += 1
    alert_counts["total"] = notifications.get("count", 0)

    health = "ok"
    if alert_counts["error"] > 0:
        health = "error"
    elif alert_counts["warning"] > 0:
        health = "warning"

    host = host_stats.get("host") or {}
    # 2 decimales: uploads/ suele ser una fracción minúscula del disco total
    # (ej. 0.03%) — redondear a entero lo dejaba siempre en 0, indistinguible
    # de "sin datos" en el gauge.
    disk_percent = round((storage["used"] / storage["total"]) * 100, 2) if storage.get("total") else None

    if host.get("cpu_percent") is not None:
        _cpu_history.append(host["cpu_percent"])

    power_watts = _estimated_active_power_watts([job["machine_type"] for job in jobs])

    # Bajo demanda, cacheado (ver maintenance_service.py): dispara un
    # recálculo en segundo plano si la IA está activada y el caché venció,
    # pero NUNCA espera el resultado acá -- este resumen se sondea cada
    # pocos segundos y no puede depender de que la IA responda a tiempo.
    await maintenance_service.maybe_refresh(
        notifications.get("items", []), jobs, services_online, services_total,
    )

    return {
        "system": {
            "health": health,
            "services_online": services_online,
            "services_total": services_total,
            "uptime_seconds": _read_uptime_seconds(),
            "update_status": "update_available" if update_available else "up_to_date",
        },
        "host": {
            "online": bool(host_stats),
            "cpu_percent": host.get("cpu_percent"),
            "mem_percent": host.get("mem_percent"),
            "mem_used_gb": host.get("mem_used_gb"),
            "mem_total_gb": host.get("mem_total_gb"),
            "temp": host.get("temp"),
            "disk_percent": disk_percent,
            "disk_used_bytes": storage.get("used"),
            "disk_total_bytes": storage.get("total"),
            "ip": host.get("network_ip"),
            "bandwidth_kbps": host.get("bandwidth_kbps"),
            "rx_gb": host.get("rx_gb"),
            "tx_gb": host.get("tx_gb"),
            "cpu_history": list(_cpu_history),
            "load_average": _read_load_average(),
        },
        "devices": device_counts,
        "jobs": {"active": jobs[:6], "total_active": len(jobs)},
        "alerts": alert_counts,
        # None (no un objeto con "~0 W") si Cotizador no tiene ninguna
        # potencia configurada -- el frontend oculta la ficha entera en vez
        # de mostrar un número que no significa nada.
        "power": {"active_watts": power_watts, "estimated": True} if power_watts is not None else None,
        # None si no hay ninguna placa elegida como sensor ambiente en
        # Automatización de Taller (o el plugin no está instalado) -- ver
        # _get_ambient_temperature_c más arriba.
        "ambient": ambient,
        # None si NOPAL Intelligence está apagada, o si todavía no hay
        # ninguna sugerencia cacheada -- ver maintenance_service.py.
        "maintenance": maintenance_service.get_cached_suggestion(),
    }
