from fastapi import APIRouter, Depends

from backend.auth_deps import require_auth
from backend.services.notification_service import get_notifications

router = APIRouter()


@router.get("/api/notifications")
async def notifications_endpoint(user: dict = Depends(require_auth)):
    """Cuenta de problemas activos ahora mismo (impresoras/láser/CNC/
    accesorios desconectados, trabajos con error, actualización disponible)
    — no un buzón persistente, se recalcula en cada consulta."""
    return await get_notifications()
