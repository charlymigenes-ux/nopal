import logging

from datetime import datetime
from typing import Any, Dict, List

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

from backend.auth_deps import ensure_authorized, require_auth, require_role
from backend.services.authorization_policy import Action, Resource, ResourceKind
from backend.services.klipper_service import (
    get_console_messages,
    send_console_command,
    get_macros,
    run_macro,
)

from backend.services import console_service

logger = logging.getLogger(__name__)
router = APIRouter()


def klipper_resource(port: int) -> Resource:
    """Recurso de la Authorization Policy (ADR-006) para una impresora
    Klipper: el id normalizado de la máquina (`klipper:<port>`, el mismo del
    modelo de TUNA-Screen). Única construcción para las rutas migradas."""
    return Resource(ResourceKind.PRINTER, f"klipper:{port}")


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
    # ADR-006 (D3-Q2): consola / G-code arbitrario solo admin. Antes, cualquier
    # usuario autenticado. Se autoriza antes de enviar nada.
    ensure_authorized(user, Action.SEND_CONSOLE_COMMAND, klipper_resource(port))
    success = send_console_command(port=port, command=command)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    console_service.record_command(port, command)
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
    # ADR-006 (C-1): un macro puede ejecutar G-code arbitrario; solo admin.
    # Antes, cualquier usuario autenticado. Se autoriza antes de ejecutarlo.
    ensure_authorized(user, Action.RUN_MACRO, klipper_resource(port))
    success = run_macro(port=port, macro=macro)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo ejecutar el macro")
    return {"success": True}


# ── Historial, log y archivos ──

@router.get("/api/console/history")
async def get_history_endpoint(port: int, limit: int = 50, user: dict = Depends(require_auth)):
    """Últimos comandos enviados a la máquina (el más reciente primero)."""
    return {"history": console_service.get_history(port, limit)}


@router.delete("/api/console/history")
async def clear_history_endpoint(port: int, user: dict = Depends(require_role("admin"))):
    console_service.clear_history(port)
    return {"success": True}


@router.get("/api/console/log/export")
async def export_log_endpoint(port: int, count: int = 500, user: dict = Depends(require_auth)):
    """Log de la consola como texto descargable."""
    try:
        messages = get_console_messages(port=port, count=max(1, min(count, 2000)))
    except Exception as e:
        logger.exception(f"Error al exportar la consola (puerto {port})")
        raise HTTPException(status_code=502, detail=str(e))
    filename = f"consola-{port}-{datetime.now():%Y%m%d-%H%M%S}.log"
    return PlainTextResponse(
        console_service.format_log(messages),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _send_lines(port: int, lines: List[str]) -> int:
    """Envía las líneas en bloques; si un bloque falla avisa cuántas salieron."""
    sent = 0
    for chunk in console_service.chunked(lines):
        if not send_console_command(port=port, command="\n".join(chunk)):
            detail = "No se pudo enviar el comando"
            if sent:
                detail += f"; se alcanzaron a enviar {sent} de {len(lines)} líneas"
            raise HTTPException(status_code=502, detail=detail)
        sent += len(chunk)
    return sent


@router.post("/api/console/run-file")
async def run_file_endpoint(port: int = Form(...), file: UploadFile = File(...), user: dict = Depends(require_auth)):
    """Envía línea por línea un archivo de G-code corto (calibraciones, pruebas)."""
    ensure_authorized(user, Action.SEND_CONSOLE_COMMAND, klipper_resource(port))
    raw = await file.read(console_service.MAX_FILE_BYTES + 1)
    try:
        parsed = console_service.parse_gcode_upload(raw)
    except console_service.ConsoleError as e:
        status = 413 if "muy grande" in str(e) or "máximo para la consola" in str(e) else 422
        raise HTTPException(status_code=status, detail=str(e))
    sent = _send_lines(port, parsed["lines"])
    return {"success": True, "sent": sent, "skipped": parsed["skipped"]}


# ── Macros y plantillas propias ──

def _crud_errors(call):
    try:
        return call()
    except console_service.ConsoleError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except console_service.NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except console_service.ReadOnlyError as e:
        raise HTTPException(status_code=403, detail=str(e))


def _run_item(port: int, item_id: str, params: Dict[str, Any], template: bool, user: dict) -> Dict[str, Any]:
    # Mismo criterio que /api/macros/run (ADR-006): ejecutar G-code es de admin.
    ensure_authorized(user, Action.RUN_MACRO, klipper_resource(port))
    item = _crud_errors(lambda: console_service.get_item(item_id, template=template))
    commands = _crud_errors(lambda: console_service.render_commands(item, params))
    sent = _send_lines(port, commands)
    return {"success": True, "sent": sent, "commands": commands}


@router.get("/api/console/macros")
async def list_custom_macros_endpoint(user: dict = Depends(require_auth)):
    return {"macros": console_service.list_macros()}


@router.post("/api/console/macros", status_code=201)
async def create_custom_macro_endpoint(payload: Dict[str, Any] = Body(...), user: dict = Depends(require_role("admin"))):
    return {"macro": _crud_errors(lambda: console_service.create_item(payload, template=False))}


@router.put("/api/console/macros/{macro_id}")
async def update_custom_macro_endpoint(macro_id: str, payload: Dict[str, Any] = Body(...), user: dict = Depends(require_role("admin"))):
    return {"macro": _crud_errors(lambda: console_service.update_item(macro_id, payload, template=False))}


@router.delete("/api/console/macros/{macro_id}")
async def delete_custom_macro_endpoint(macro_id: str, user: dict = Depends(require_role("admin"))):
    _crud_errors(lambda: console_service.delete_item(macro_id, template=False))
    return {"success": True}


@router.post("/api/console/macros/{macro_id}/run")
async def run_custom_macro_endpoint(macro_id: str, payload: Dict[str, Any] = Body(...), user: dict = Depends(require_auth)):
    return _run_item(_port_from(payload), macro_id, {}, False, user)


@router.get("/api/console/templates")
async def list_templates_endpoint(user: dict = Depends(require_auth)):
    return {"templates": console_service.list_templates()}


@router.post("/api/console/templates", status_code=201)
async def create_template_endpoint(payload: Dict[str, Any] = Body(...), user: dict = Depends(require_role("admin"))):
    return {"template": _crud_errors(lambda: console_service.create_item(payload, template=True))}


@router.put("/api/console/templates/{template_id}")
async def update_template_endpoint(template_id: str, payload: Dict[str, Any] = Body(...), user: dict = Depends(require_role("admin"))):
    return {"template": _crud_errors(lambda: console_service.update_item(template_id, payload, template=True))}


@router.delete("/api/console/templates/{template_id}")
async def delete_template_endpoint(template_id: str, user: dict = Depends(require_role("admin"))):
    _crud_errors(lambda: console_service.delete_item(template_id, template=True))
    return {"success": True}


@router.post("/api/console/templates/{template_id}/run")
async def run_template_endpoint(template_id: str, payload: Dict[str, Any] = Body(...), user: dict = Depends(require_auth)):
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        raise HTTPException(status_code=422, detail="Los parámetros deben ser un objeto.")
    return _run_item(_port_from(payload), template_id, params, True, user)


def _port_from(payload: Dict[str, Any]) -> int:
    try:
        return int(payload["port"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=422, detail="Falta la máquina (port).")
