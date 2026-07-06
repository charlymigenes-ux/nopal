import os
import shutil
from typing import Optional
from fastapi import APIRouter, HTTPException

from backend.services.klipper_service import get_system_stats

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
    
    # Calculate used space from uploads folder
    used_bytes = 0
    for filename in os.listdir(upload_folder):
        filepath = os.path.join(upload_folder, filename)
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
