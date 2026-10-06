"""Configuración → Registro (logs). Ver logging_config_service.

Leer la configuración: cualquier sesión (operador incluido, igual que leer
los logs hoy). Modificarla: solo admin, con la Authorization Policy
(`system_control`); se aplica en caliente y queda guardada.
"""

from fastapi import APIRouter, Body, Depends, HTTPException

from backend.auth_deps import ensure_authorized, require_auth
from backend.services import logging_config_service
from backend.services.authorization_policy import Action

router = APIRouter()


@router.get("/api/logs/config")
async def get_logging_config_endpoint(user: dict = Depends(require_auth)):
    return logging_config_service.public_view()


@router.put("/api/logs/config")
async def update_logging_config_endpoint(payload: dict = Body(...), user: dict = Depends(require_auth)):
    ensure_authorized(user, Action.SYSTEM_CONTROL)
    try:
        logging_config_service.save_config(payload)
    except logging_config_service.LoggingConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return logging_config_service.public_view()
