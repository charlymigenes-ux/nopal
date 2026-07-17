from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services.elegoo_service import (
    cancel_printer,
    get_registered_printers_with_status,
    pause_printer,
    register_printer,
    resume_printer,
    scan_network,
    send_gcode_to_printer,
    unregister_printer,
)

router = APIRouter()


@router.get("/api/elegoo/printers")
async def elegoo_printers_endpoint(user: dict = Depends(require_auth)):
    """Impresoras Elegoo registradas en NOPAL, con su último status conocido
    (SDCP empuja los cambios solo, no hace falta encuestar acá)."""
    return {"printers": get_registered_printers_with_status()}


@router.post("/api/elegoo/printers/discover")
async def elegoo_discover_endpoint(user: dict = Depends(require_auth)):
    """Escanea la red local en busca de impresoras Elegoo (broadcast UDP)."""
    devices = await scan_network()
    return {"devices": devices}


@router.post("/api/elegoo/printers")
async def elegoo_register_endpoint(
    ip: str = Form(...),
    mainboard_id: str = Form(...),
    name: str = Form(...),
    model: str = Form(""),
    user: dict = Depends(require_role("admin")),
):
    """Registra una impresora Elegoo encontrada por /discover."""
    return register_printer(ip, mainboard_id, name, model)


@router.delete("/api/elegoo/printers/{printer_id}")
async def elegoo_unregister_endpoint(printer_id: str, user: dict = Depends(require_role("admin"))):
    if not unregister_printer(printer_id):
        raise HTTPException(status_code=404, detail="No encontrado en el registro")
    return {"success": True}


@router.post("/api/elegoo/printers/{printer_id}/pause")
async def elegoo_pause_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not await pause_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo pausar la impresión")
    return {"success": True}


@router.post("/api/elegoo/printers/{printer_id}/resume")
async def elegoo_resume_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not await resume_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo reanudar la impresión")
    return {"success": True}


@router.post("/api/elegoo/printers/{printer_id}/cancel")
async def elegoo_cancel_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not await cancel_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo cancelar la impresión")
    return {"success": True}


@router.post("/api/elegoo/printers/{printer_id}/send")
async def elegoo_send_endpoint(
    printer_id: str,
    path: str = Form(...),
    section: str = Form("model"),
    user: dict = Depends(require_auth),
):
    """Sube un archivo de la biblioteca de NOPAL a la impresora y arranca la impresión."""
    result = await send_gcode_to_printer(printer_id, path, section)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "No se pudo enviar el archivo"))
    return result
