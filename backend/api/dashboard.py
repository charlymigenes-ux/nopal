from fastapi import APIRouter, Depends

from backend.auth_deps import require_auth
from backend.services.dashboard_service import get_dashboard_summary

router = APIRouter()


@router.get("/api/dashboard/summary")
async def dashboard_summary_endpoint(user: dict = Depends(require_auth)):
    """Resumen agregado para el panel de control: salud del sistema, host,
    conteo de dispositivos, trabajos activos y alertas — compone datos que
    ya existen en otros servicios, sin tracking nuevo."""
    return await get_dashboard_summary()
