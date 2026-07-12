import asyncio
from typing import Any, Dict, List

from backend.services.accessory_service import get_accessories_status
from backend.services.klipper_service import get_all_printers_status
from backend.services.laser_service import get_laser_jobs_with_errors, get_registered_lasers_status
from backend.utils import is_git_update_available


async def get_notifications() -> Dict[str, Any]:
    """Agrega señales que ya existen en otros servicios (nada de tracking
    nuevo, sin concepto de leído/no-leído) — el conteo es "cuántos problemas
    hay ahora mismo", recalculado en cada consulta, no un buzón persistente."""
    loop = asyncio.get_event_loop()
    printers, lasers, accessories, update_available = await asyncio.gather(
        loop.run_in_executor(None, get_all_printers_status),
        get_registered_lasers_status(),
        get_accessories_status(),
        loop.run_in_executor(None, is_git_update_available),
    )

    items: List[Dict[str, Any]] = []

    for printer in printers:
        name = printer.get("name", "Impresora")
        if printer.get("status") == "offline":
            items.append({"severity": "error", "source": "printer", "message": f"{name} desconectada"})
        else:
            job_state = printer.get("job", {}).get("state")
            if job_state in ("paused", "error"):
                items.append({"severity": "warning", "source": "printer", "message": f"{name}: {job_state}"})

    for laser in lasers:
        if not laser.get("online"):
            label = laser.get("name") or laser.get("host", "Dispositivo")
            items.append({"severity": "error", "source": "laser", "message": f"{label} desconectado"})

    for job in get_laser_jobs_with_errors():
        items.append({"severity": "error", "source": "laser", "message": f"Trabajo en {job['host']} con error"})

    for accessory in accessories:
        if accessory.get("on") is None:
            label = accessory.get("name", "Accesorio")
            items.append({"severity": "warning", "source": "accessory", "message": f"{label} no responde"})

    if update_available:
        items.append({"severity": "info", "source": "update", "message": "Actualización disponible"})

    return {"count": len(items), "items": items}
