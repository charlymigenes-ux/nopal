import logging

from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth
from backend.services.klipper_service import (
    get_console_messages,
    send_console_command,
    get_macros,
    run_macro,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/console/messages")
async def get_console_messages_endpoint(port: int, count: int = 50, user: dict = Depends(require_auth)):
    """Últimos mensajes de la consola G-code de la impresora indicada."""
    try:
        return {"messages": get_console_messages(port=port, count=count)}
    except Exception as e:
        logger.exception(f"Error al leer la consola (puerto {port})")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/console/command")
async def send_console_command_endpoint(port: int = Form(...), command: str = Form(...), user: dict = Depends(require_auth)):
    """Envía un comando de consola/G-code a la impresora indicada."""
    success = send_console_command(port=port, command=command)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    return {"success": True}


@router.get("/api/macros")
async def get_macros_endpoint(port: int, user: dict = Depends(require_auth)):
    """Lista de macros configurados en la impresora indicada."""
    try:
        return {"macros": get_macros(port=port)}
    except Exception as e:
        logger.exception(f"Error al leer macros (puerto {port})")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/macros/run")
async def run_macro_endpoint(port: int = Form(...), macro: str = Form(...), user: dict = Depends(require_auth)):
    """Ejecuta un macro por nombre en la impresora indicada."""
    success = run_macro(port=port, macro=macro)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo ejecutar el macro")
    return {"success": True}
