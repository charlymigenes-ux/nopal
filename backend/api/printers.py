from fastapi import APIRouter, HTTPException, Request

from backend.services.klipper_service import (
    cancel_printer_print,
    find_moonraker_instances,
    get_all_printers_status,
    get_printer_status,
    get_recent_printer_files,
    pause_printer_print,
    resume_printer_print,
)

router = APIRouter()


@router.get("/api/printers")
async def get_printers():
    """Obtener lista de impresoras detectadas"""
    try:
        printers = find_moonraker_instances()

        return {
            "count": len(printers),
            "printers": printers,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/printers/status")
async def get_all_status(request: Request):
    """Obtener estado de todas las impresoras"""
    try:
        printers = get_all_printers_status(host=request.url.hostname)

        return {
            "count": len(printers),
            "printers": printers,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/printers/recent-files")
async def get_printers_recent_files(request: Request):
    """Últimos 3 archivos impresos en cada impresora detectada"""
    try:
        printers = get_recent_printer_files(host=request.url.hostname, limit=3)

        return {
            "count": len(printers),
            "printers": printers,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/printers/{port}/pause")
async def pause_printer(port: int):
    if not pause_printer_print(port):
        raise HTTPException(status_code=409, detail="No se pudo pausar la impresión")
    return {"success": True}


@router.post("/api/printers/{port}/resume")
async def resume_printer(port: int):
    if not resume_printer_print(port):
        raise HTTPException(status_code=409, detail="No se pudo reanudar la impresión")
    return {"success": True}


@router.post("/api/printers/{port}/cancel")
async def cancel_printer(port: int):
    if not cancel_printer_print(port):
        raise HTTPException(status_code=409, detail="No se pudo cancelar la impresión")
    return {"success": True}


@router.get("/api/printers/{printer_name}/status")
async def get_single_status(printer_name: str):
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
        raise HTTPException(status_code=500, detail=str(e))