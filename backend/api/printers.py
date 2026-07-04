from fastapi import APIRouter, HTTPException, Request

from backend.services.klipper_service import (
    find_moonraker_instances,
    get_all_printers_status,
    get_printer_status,
    get_recent_printer_files,
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
async def get_all_status():
    """Obtener estado de todas las impresoras"""
    try:
        printers = get_all_printers_status()

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