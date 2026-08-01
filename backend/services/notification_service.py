import asyncio
import time
from typing import Any, Dict, List

from backend.services.klipper_service import get_all_printers_status
from backend.services.laser_service import get_laser_jobs_with_errors, get_registered_lasers_status
from backend.services.plugin_loader_service import get_loaded_plugin_module
from backend.utils import is_git_update_available

# Ventana de eventos de movimiento a mostrar como "atención requerida" --
# get_recent_motion_events() del plugin es un buffer en memoria, no
# persistido, así que sin este corte un evento viejo quedaría en la lista
# para siempre (o hasta que se llene el buffer por otras cámaras).
CAMERA_MOTION_WINDOW_S = 300


def _get_camera_motion_alerts() -> List[Dict[str, Any]]:
    """Las cámaras son un plugin, no un módulo de core -- si no está
    instalado/cargado no hay eventos que agregar, se trata como [] en vez
    de romper el resto de las notificaciones."""
    module = get_loaded_plugin_module("camera-viewer", "services.timelapse_service")
    if module is None:
        return []
    events = module.get_recent_motion_events(since=time.time() - CAMERA_MOTION_WINDOW_S)
    return [
        {
            "id": f"camera-motion:{event['camera_id']}:{int(event['timestamp'])}",
            "severity": "warning",
            "source": "camera",
            "section": "settings",
            "message": f"Movimiento detectado en {event.get('camera_name') or 'una cámara'}",
        }
        for event in events
    ]


async def _get_accessories_status() -> List[Dict[str, Any]]:
    """Los accesorios Arduino son un plugin, no un módulo de core -- si no
    está instalado/cargado no hay señal que agregar, no es un error."""
    module = get_loaded_plugin_module("arduino-accessories", "services.accessory_service")
    if module is None:
        return []
    return await module.get_accessories_status()


async def get_notifications() -> Dict[str, Any]:
    """Agrega señales que ya existen en otros servicios (nada de tracking
    nuevo, sin concepto de leído/no-leído) — el conteo es "cuántos problemas
    hay ahora mismo", recalculado en cada consulta, no un buzón persistente."""
    loop = asyncio.get_event_loop()
    printers, lasers, accessories, update_available = await asyncio.gather(
        loop.run_in_executor(None, get_all_printers_status),
        get_registered_lasers_status(),
        _get_accessories_status(),
        loop.run_in_executor(None, is_git_update_available),
    )

    items: List[Dict[str, Any]] = []
    # host -> "laser"/"cnc", para que el frontend sepa a qué sección de nav
    # mandar al usuario al hacer click en un problema (ver campo "section").
    laser_kind_by_host = {laser.get("host"): ("cnc" if laser.get("kind") == "cnc" else "laser") for laser in lasers}

    for printer in printers:
        name = printer.get("name", "Impresora")
        # "port" identifica a la impresora Klipper puntual (ver
        # klipper_service.get_all_printers_status) -- sin esto el frontend
        # solo podía mandar al usuario a la sección "dashboard" en general,
        # nunca abrir la tarjeta/modal de la impresora que reportó el error.
        if printer.get("status") == "offline":
            items.append({"id": f"printer:{printer.get('port')}", "severity": "error", "source": "printer", "section": "dashboard", "port": printer.get("port"), "message": f"{name} desconectada"})
        else:
            job_state = printer.get("job", {}).get("state")
            if job_state in ("paused", "error"):
                items.append({"id": f"printer-job:{printer.get('port')}", "severity": "warning", "source": "printer", "section": "dashboard", "port": printer.get("port"), "message": f"{name}: {job_state}"})

    for laser in lasers:
        if not laser.get("online"):
            label = laser.get("name") or laser.get("host", "Dispositivo")
            section = "cnc" if laser.get("kind") == "cnc" else "laser"
            items.append({"id": f"laser:{laser.get('host')}", "severity": "error", "source": "laser", "section": section, "message": f"{label} desconectado"})

    for job in get_laser_jobs_with_errors():
        section = laser_kind_by_host.get(job["host"], "laser")
        items.append({"id": f"laser-job:{job['host']}", "severity": "error", "source": "laser", "section": section, "message": f"Trabajo en {job['host']} con error"})

    for accessory in accessories:
        if accessory.get("on") is None:
            label = accessory.get("name", "Accesorio")
            items.append({"id": f"accessory:{label}", "severity": "warning", "source": "accessory", "section": "dashboard", "message": f"{label} no responde"})

    if update_available:
        items.append({"id": "update", "severity": "info", "source": "update", "section": "settings", "message": "Actualización disponible"})

    items.extend(_get_camera_motion_alerts())

    return {"count": len(items), "items": items}
