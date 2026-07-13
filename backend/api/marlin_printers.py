import os
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services.marlin_printer_service import (
    list_usb_marlin_ports,
    probe_marlin,
    get_registered_printers,
    get_registered_printers_with_status,
    register_printer,
    unregister_printer,
    get_status,
    jog,
    home,
    get_temperature_snapshot,
    set_heater_target,
    ensure_listener,
    get_console_buffer,
    send_console_command,
    start_print,
    get_job_status,
    get_active_job_devices,
    pause_job,
    resume_job,
    cancel_job,
)
from backend.utils import safe_section_path

router = APIRouter()


@router.get("/api/marlin-printers/discover")
async def marlin_printers_discover_endpoint(user: dict = Depends(require_auth)):
    """Puertos USB conectados que podrían ser una impresora Marlin (aún no registrados)."""
    return {"ports": list_usb_marlin_ports()}


@router.get("/api/marlin-printers/registry")
async def marlin_printers_registry_endpoint(user: dict = Depends(require_auth)):
    return {"printers": get_registered_printers()}


@router.get("/api/marlin-printers/registry/status")
async def marlin_printers_registry_status_endpoint(user: dict = Depends(require_auth)):
    return {"printers": get_registered_printers_with_status()}


@router.post("/api/marlin-printers/usb-ports/test")
async def marlin_usb_test_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    """Prueba si el puerto USB indicado responde al protocolo Marlin (M105)."""
    if not await probe_marlin(device):
        raise HTTPException(status_code=502, detail="No se detectó respuesta Marlin en este puerto")
    return {"connected": True, "device": device}


@router.post("/api/marlin-printers/registry")
async def marlin_printers_registry_add_endpoint(
    device: str = Form(...),
    name: str = Form(...),
    baud: int = Form(115200),
    user: dict = Depends(require_role("admin")),
):
    """Registra una impresora Marlin conectada por USB. El handshake es
    obligatorio server-side (no solo confiar en que el frontend haya
    llamado a /usb-ports/test antes) — así el registro sigue siendo
    seguro incluso si algo llama a este endpoint directo."""
    verified_marlin = await probe_marlin(device, baud)
    return register_printer(device, name, baud, verified_marlin)


@router.post("/api/marlin-printers/registry/remove")
async def marlin_printers_registry_remove_endpoint(device: str = Form(...), user: dict = Depends(require_role("admin"))):
    if not unregister_printer(device):
        raise HTTPException(status_code=404, detail="No encontrado en el registro")
    return {"success": True}


@router.get("/api/marlin-printers/status")
async def marlin_printers_status_endpoint(device: str, user: dict = Depends(require_auth)):
    status = await get_status(device)
    if status is None:
        return {"connected": False, "device": device}
    return {"connected": True, "device": device, "firmware": "marlin", **status}


@router.post("/api/marlin-printers/jog")
async def marlin_printers_jog_endpoint(
    device: str = Form(...),
    axis: str = Form(...),
    distance: float = Form(...),
    feed: float = Form(...),
    user: dict = Depends(require_auth),
):
    if not await jog(device, axis, distance, feed):
        raise HTTPException(status_code=502, detail="No se pudo mover el eje")
    return {"success": True}


@router.post("/api/marlin-printers/home")
async def marlin_printers_home_endpoint(
    device: str = Form(...),
    axes: Optional[str] = Form(None),
    user: dict = Depends(require_auth),
):
    if not await home(device, axes):
        raise HTTPException(status_code=502, detail="No se pudo iniciar el home")
    return {"success": True}


@router.get("/api/marlin-printers/temperatures")
async def marlin_printers_temperatures_endpoint(device: str, user: dict = Depends(require_auth)):
    return await get_temperature_snapshot(device)


@router.post("/api/marlin-printers/temperature-target")
async def marlin_printers_temperature_target_endpoint(
    device: str = Form(...),
    heater: str = Form(...),
    target: float = Form(...),
    user: dict = Depends(require_auth),
):
    if not set_heater_target(device, heater, target):
        raise HTTPException(status_code=502, detail="No se pudo actualizar la temperatura objetivo")
    return {"success": True}


@router.get("/api/marlin-printers/console")
async def marlin_printers_console_endpoint(device: str, count: int = 100, user: dict = Depends(require_auth)):
    ensure_listener(device)
    return {"messages": get_console_buffer(device, count=count)}


@router.post("/api/marlin-printers/console")
async def marlin_printers_console_command_endpoint(
    device: str = Form(...),
    command: str = Form(...),
    user: dict = Depends(require_auth),
):
    if not await send_console_command(device, command):
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    return {"success": True}


@router.post("/api/marlin-printers/print/start")
async def marlin_printers_print_start_endpoint(
    device: str = Form(...),
    path: str = Form(...),
    user: dict = Depends(require_auth),
):
    """Inicia el envío de un archivo G-code (de la biblioteca) a la impresora."""
    file_path = safe_section_path("gcode", path)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
        gcode_text = handle.read()

    try:
        job = start_print(device, gcode_text, filename=os.path.basename(path))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return job


@router.get("/api/marlin-printers/print/status")
async def marlin_printers_print_status_endpoint(device: str, user: dict = Depends(require_auth)):
    return await get_job_status(device)


@router.get("/api/marlin-printers/jobs/active")
async def marlin_printers_active_jobs_endpoint(user: dict = Depends(require_auth)):
    return {"jobs": get_active_job_devices()}


@router.post("/api/marlin-printers/print/pause")
async def marlin_printers_print_pause_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    if not await pause_job(device):
        raise HTTPException(status_code=409, detail="No hay una impresión en curso para pausar")
    return {"success": True}


@router.post("/api/marlin-printers/print/resume")
async def marlin_printers_print_resume_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    if not await resume_job(device):
        raise HTTPException(status_code=409, detail="No hay una impresión pausada para reanudar")
    return {"success": True}


@router.post("/api/marlin-printers/print/cancel")
async def marlin_printers_print_cancel_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    if not await cancel_job(device):
        raise HTTPException(status_code=409, detail="No hay una impresión en curso para cancelar")
    return {"success": True}
