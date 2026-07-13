import logging

from fastapi import APIRouter, Depends, Form, HTTPException, Request

from backend.auth_deps import require_auth
from backend.services.klipper_service import (
    add_scheduled_print,
    cancel_printer_print,
    find_moonraker_instances,
    firmware_restart_printer,
    get_all_printers_status,
    get_printer_job_queue,
    get_printer_status,
    get_recent_printer_files,
    get_scheduled_prints,
    pause_printer_print,
    remove_printer_queue_job,
    remove_scheduled_print,
    restart_printer_klipper,
    resume_printer_print,
    send_gcode_to_printer,
    start_printer_job_queue,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/printers")
async def get_printers(user: dict = Depends(require_auth)):
    """Obtener lista de impresoras detectadas"""
    try:
        printers = find_moonraker_instances()

        return {
            "count": len(printers),
            "printers": printers,
        }

    except Exception as e:
        logger.exception("Error al listar impresoras")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/printers/status")
async def get_all_status(request: Request, user: dict = Depends(require_auth)):
    """Obtener estado de todas las impresoras"""
    try:
        printers = get_all_printers_status(host=request.url.hostname)

        return {
            "count": len(printers),
            "printers": printers,
        }

    except Exception as e:
        logger.exception("Error al leer el estado de las impresoras")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/printers/recent-files")
async def get_printers_recent_files(request: Request, user: dict = Depends(require_auth)):
    """Últimos 3 archivos impresos en cada impresora detectada"""
    try:
        printers = get_recent_printer_files(host=request.url.hostname, limit=3)

        return {
            "count": len(printers),
            "printers": printers,
        }

    except Exception as e:
        logger.exception("Error al leer archivos recientes de las impresoras")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/printers/{port}/pause")
async def pause_printer(port: int, user: dict = Depends(require_auth)):
    if not pause_printer_print(port):
        raise HTTPException(status_code=409, detail="No se pudo pausar la impresión")
    return {"success": True}


@router.post("/api/printers/{port}/resume")
async def resume_printer(port: int, user: dict = Depends(require_auth)):
    if not resume_printer_print(port):
        raise HTTPException(status_code=409, detail="No se pudo reanudar la impresión")
    return {"success": True}


@router.post("/api/printers/{port}/cancel")
async def cancel_printer(port: int, user: dict = Depends(require_auth)):
    if not cancel_printer_print(port):
        raise HTTPException(status_code=409, detail="No se pudo cancelar la impresión")
    return {"success": True}


@router.post("/api/printers/{port}/restart")
async def restart_printer_endpoint(port: int, user: dict = Depends(require_auth)):
    """Reinicia el proceso de Klipper (equivalente a RESTART)."""
    if not restart_printer_klipper(port):
        raise HTTPException(status_code=400, detail="No se pudo reiniciar Klipper")
    return {"success": True}


@router.post("/api/printers/{port}/firmware-restart")
async def firmware_restart_endpoint(port: int, user: dict = Depends(require_auth)):
    """Reinicia el firmware del MCU (equivalente a FIRMWARE_RESTART)."""
    if not firmware_restart_printer(port):
        raise HTTPException(status_code=400, detail="No se pudo reiniciar el firmware")
    return {"success": True}


@router.post("/api/printers/{port}/send")
async def send_to_printer_endpoint(
    port: int, path: str = Form(...), mode: str = Form("print"), section: str = Form("model"),
    user: dict = Depends(require_auth),
):
    """Sube un archivo de la biblioteca de NOPAL al firmware y lo imprime
    de inmediato o lo agrega a la cola nativa de Moonraker."""
    result = send_gcode_to_printer(port, path, mode, section)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "No se pudo enviar el archivo"))
    return result


@router.get("/api/printers/{port}/queue")
async def printer_queue_endpoint(port: int, user: dict = Depends(require_auth)):
    return get_printer_job_queue(port)


@router.delete("/api/printers/{port}/queue/{job_id}")
async def printer_queue_remove_endpoint(port: int, job_id: str, user: dict = Depends(require_auth)):
    if not remove_printer_queue_job(port, [job_id]):
        raise HTTPException(status_code=400, detail="No se pudo quitar el trabajo de la cola")
    return {"success": True}


@router.post("/api/printers/{port}/queue/start")
async def printer_queue_start_endpoint(port: int, user: dict = Depends(require_auth)):
    if not start_printer_job_queue(port):
        raise HTTPException(status_code=400, detail="No se pudo iniciar la cola")
    return {"success": True}


@router.get("/api/printers/schedule")
async def get_scheduled_prints_endpoint(user: dict = Depends(require_auth)):
    return get_scheduled_prints()


@router.post("/api/printers/schedule")
async def add_scheduled_print_endpoint(
    port: int = Form(...),
    path: str = Form(...),
    filename: str = Form(...),
    scheduled_at: str = Form(...),
    section: str = Form("model"),
    user: dict = Depends(require_auth),
):
    result = add_scheduled_print(port, path, section, filename, scheduled_at)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "No se pudo programar la impresión"))
    return result


@router.delete("/api/printers/schedule/{schedule_id}")
async def remove_scheduled_print_endpoint(schedule_id: str, user: dict = Depends(require_auth)):
    if not remove_scheduled_print(schedule_id):
        raise HTTPException(status_code=404, detail="Programación no encontrada")
    return {"success": True}


@router.get("/api/printers/{printer_name}/status")
async def get_single_status(printer_name: str, user: dict = Depends(require_auth)):
    """Obtener estado de una impresora específica"""

    try:
        printers = find_moonraker_instances()

        printer = next(
            (p for p in printers if p["name"] == printer_name),
            None
        )

        if printer is None:
            raise HTTPException(
                status_code=404,
                detail="Impresora no encontrada"
            )

        return get_printer_status(printer["port"])

    except HTTPException:
        raise

    except Exception as e:
        logger.exception("Error al leer el estado de una impresora")
        raise HTTPException(status_code=500, detail=str(e))
