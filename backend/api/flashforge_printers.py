from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.errors import PrinterRegistrationError
from backend.services.flashforge_service import (
    cancel_printer,
    get_registered_printers_with_status,
    pause_printer,
    register_printer,
    resume_printer,
    scan_network,
    send_gcode_to_printer,
    test_connection,
    unregister_printer,
)
from backend.utils import sanitize_device_name, validate_printer_ip

router = APIRouter()


@router.get("/api/flashforge/printers")
async def flashforge_printers_endpoint(user: dict = Depends(require_auth)):
    """Impresoras FlashForge registradas en NOPAL, con su status actual (acá sí
    se hace un /detail real por impresora, a diferencia de Elegoo)."""
    return {"printers": get_registered_printers_with_status()}


@router.post("/api/flashforge/printers/discover")
async def flashforge_discover_endpoint(user: dict = Depends(require_auth)):
    """Escanea la red local en busca de impresoras FlashForge modernas (5M/5M Pro/AD5X/Creator 5)."""
    devices = await scan_network()
    return {"devices": devices}


@router.post("/api/flashforge/printers")
async def flashforge_register_endpoint(
    ip: str = Form(...),
    serial_number: str = Form(...),
    check_code: str = Form(...),
    name: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    """Registra una impresora FlashForge -- valida serialNumber/checkCode contra
    la impresora real antes de guardar (a diferencia de Elegoo, acá sí hace falta)."""
    ip = validate_printer_ip(ip)
    name = sanitize_device_name(name)
    result = register_printer(ip, serial_number, check_code, name)
    if not result.get("success"):
        raise PrinterRegistrationError(
            result.get("error_code", "UNKNOWN"),
            result.get("error", "No se pudo registrar la impresora"),
        )
    # No devolver check_code en texto plano en la respuesta -- el GET de
    # listado ya lo filtra vía normalize_flashforge_status, esto cierra el
    # mismo hueco en la respuesta del POST de alta.
    return {k: v for k, v in result["printer"].items() if k != "check_code"}


@router.post("/api/flashforge/printers/{printer_id}/test-connection")
async def flashforge_test_connection_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    """Diagnóstico bajo demanda de una impresora ya registrada -- de solo
    lectura, no requiere admin."""
    return test_connection(printer_id)


@router.delete("/api/flashforge/printers/{printer_id}")
async def flashforge_unregister_endpoint(printer_id: str, user: dict = Depends(require_role("admin"))):
    if not unregister_printer(printer_id):
        raise HTTPException(status_code=404, detail="No encontrado en el registro")
    return {"success": True}


@router.post("/api/flashforge/printers/{printer_id}/pause")
async def flashforge_pause_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not pause_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo pausar la impresión")
    return {"success": True}


@router.post("/api/flashforge/printers/{printer_id}/resume")
async def flashforge_resume_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not resume_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo reanudar la impresión")
    return {"success": True}


@router.post("/api/flashforge/printers/{printer_id}/cancel")
async def flashforge_cancel_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not cancel_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo cancelar la impresión")
    return {"success": True}


@router.post("/api/flashforge/printers/{printer_id}/send")
async def flashforge_send_endpoint(
    printer_id: str,
    path: str = Form(...),
    section: str = Form("model"),
    user: dict = Depends(require_auth),
):
    """Sube un archivo de la biblioteca de NOPAL a la impresora y arranca la impresión."""
    result = send_gcode_to_printer(printer_id, path, section)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "No se pudo enviar el archivo"))
    return result
