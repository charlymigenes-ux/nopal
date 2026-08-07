from fastapi import APIRouter, Depends

from backend.auth_deps import require_auth
from backend.services import tunascreen_service

router = APIRouter()


@router.get("/api/devices/registry")
async def devices_registry_endpoint(user: dict = Depends(require_auth)):
    """Snapshot normalizado de TODAS las marcas (Klipper/Marlin/Bambu/Elegoo/
    FlashForge/Láser-CNC), para la tarjeta "Todos los dispositivos" de
    Configuración -- mismo dato que ya usa TUNA-Screen (ver
    tunascreen_service.list_machines()), solo que con auth de sesión normal
    en vez de token de dispositivo pareado."""
    return {"machines": await tunascreen_service.list_machines()}
