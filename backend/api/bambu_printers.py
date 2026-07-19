from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.errors import PrinterRegistrationError
from backend.services.bambu_service import (
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


@router.get("/api/bambu/printers")
async def bambu_printers_endpoint(user: dict = Depends(require_auth)):
    """Impresoras Bambu Lab registradas en NOPAL, con su status actual (leído
    del caché que mantiene el hilo MQTT persistente de cada una)."""
    return {"printers": get_registered_printers_with_status()}


@router.post("/api/bambu/printers/discover")
async def bambu_discover_endpoint(user: dict = Depends(require_auth)):
    """Escucha anuncios SSDP de impresoras Bambu Lab en modo LAN (pasivo, sin
    probe activo -- ver bambu_service.py)."""
    devices = await scan_network()
    return {"devices": devices}


@router.post("/api/bambu/printers")
async def bambu_register_endpoint(
    ip: str = Form(...),
    serial: str = Form(...),
    access_code: str = Form(...),
    name: str = Form(...),
    model: str = Form(""),
    user: dict = Depends(require_role("admin")),
):
    """Registra una impresora Bambu Lab -- valida el access code contra la
    impresora real (handshake MQTT) antes de guardar."""
    ip = validate_printer_ip(ip)
    name = sanitize_device_name(name)
    result = await register_printer(ip, serial, access_code, name, model)
    if not result.get("success"):
        raise PrinterRegistrationError(
            result.get("error_code", "UNKNOWN"),
            result.get("error", "No se pudo registrar la impresora"),
        )
    # No devolver access_code en texto plano en la respuesta -- el GET de
    # listado ya lo filtra vía normalize_bambu_status, esto cierra el mismo
    # hueco en la respuesta del POST de alta.
    return {k: v for k, v in result["printer"].items() if k != "access_code"}


@router.post("/api/bambu/printers/{printer_id}/test-connection")
async def bambu_test_connection_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    """Diagnóstico bajo demanda de una impresora ya registrada -- de solo
    lectura, no requiere admin."""
    return await test_connection(printer_id)


@router.delete("/api/bambu/printers/{printer_id}")
async def bambu_unregister_endpoint(printer_id: str, user: dict = Depends(require_role("admin"))):
    if not unregister_printer(printer_id):
        raise HTTPException(status_code=404, detail="No encontrado en el registro")
    return {"success": True}


@router.post("/api/bambu/printers/{printer_id}/pause")
async def bambu_pause_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not pause_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo pausar la impresión")
    return {"success": True}


@router.post("/api/bambu/printers/{printer_id}/resume")
async def bambu_resume_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not resume_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo reanudar la impresión")
    return {"success": True}


@router.post("/api/bambu/printers/{printer_id}/cancel")
async def bambu_cancel_endpoint(printer_id: str, user: dict = Depends(require_auth)):
    if not cancel_printer(printer_id):
        raise HTTPException(status_code=409, detail="No se pudo cancelar la impresión")
    return {"success": True}


@router.post("/api/bambu/printers/{printer_id}/send")
async def bambu_send_endpoint(
    printer_id: str,
    path: str = Form(...),
    section: str = Form("model"),
    user: dict = Depends(require_auth),
):
    """Sube un archivo .3mf de la biblioteca de NOPAL a la impresora y
    arranca la impresión."""
    result = await send_gcode_to_printer(printer_id, path, section)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "No se pudo enviar el archivo"))
    return result
