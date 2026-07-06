import os
import shutil
from typing import Optional
from fastapi import APIRouter, Form, HTTPException

from backend.services.klipper_service import get_system_stats, get_temperature_snapshot, set_heater_target

router = APIRouter()


@router.get("/api/status")
async def status():
    return {
        "status": "online",
        "version": "0.1",
        "models": 0,
    }


@router.get("/api/storage")
async def get_storage():
    """Get disk storage information"""
    upload_folder = "uploads"

    # Create uploads folder if it doesn't exist
    if not os.path.exists(upload_folder):
        os.makedirs(upload_folder)

    # Get disk space info
    stat = shutil.disk_usage(upload_folder)

    # Calculate used space recursively (los archivos viven en uploads/models y uploads/gcode)
    used_bytes = 0
    for root, _dirs, files in os.walk(upload_folder):
        for filename in files:
            filepath = os.path.join(root, filename)
            if os.path.isfile(filepath):
                used_bytes += os.path.getsize(filepath)

    return {
        "used": used_bytes,
        "free": stat.free,
        "total": stat.total,
    }


@router.get("/api/system/stats")
async def get_system_stats_endpoint(port: Optional[int] = None):
    """Estadísticas de hardware (MCU + host) de la impresora indicada."""
    try:
        return get_system_stats(port=port)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/system/temperatures")
async def get_temperatures_endpoint(port: int):
    """Temperaturas actuales/objetivo e historial de la impresora indicada."""
    try:
        return get_temperature_snapshot(port=port)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/system/temperature-target")
async def set_temperature_target_endpoint(port: int = Form(...), heater: str = Form(...), target: float = Form(...)):
    """Actualiza la temperatura objetivo de un heater (extruder, heater_bed, etc.)."""
    success = set_heater_target(port=port, heater=heater, target=target)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo actualizar la temperatura objetivo")
    return {"success": True}
