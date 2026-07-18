from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_role
from backend.services.system_service import (
    control_service,
    get_services,
    reboot_host,
    schedule_nopal_restart,
    shutdown_host,
)

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/services")
async def list_services_endpoint(user: dict = Depends(require_role("admin"))):
    """Servicios systemd de Klipper/Moonraker/Crowsnest detectados en el host."""
    return {"services": get_services()}


@router.post("/services/{action}")
async def control_service_endpoint(
    action: str,
    service: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    try:
        ok = control_service(service, action)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=502, detail="No se pudo completar la acción sobre el servicio")
    return {"ok": True}


@router.post("/nopal/restart")
async def restart_nopal_endpoint(user: dict = Depends(require_role("admin"))):
    """Reinicia el propio panel NOPAL (no el host ni Klipper). No afecta
    impresiones ni conexiones de Klipper/Moonraker -- solo el panel queda
    inaccesible unos segundos mientras systemd lo vuelve a levantar."""
    schedule_nopal_restart()
    return {"ok": True}


@router.post("/host/reboot")
async def reboot_host_endpoint(user: dict = Depends(require_role("admin"))):
    if not reboot_host():
        raise HTTPException(status_code=502, detail="No se pudo reiniciar el equipo")
    return {"ok": True}


@router.post("/host/shutdown")
async def shutdown_host_endpoint(user: dict = Depends(require_role("admin"))):
    if not shutdown_host():
        raise HTTPException(status_code=502, detail="No se pudo apagar el equipo")
    return {"ok": True}
