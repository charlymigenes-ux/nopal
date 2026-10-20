import logging

from datetime import datetime
from typing import Any, Dict, List, NamedTuple, Optional

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

from backend.api.laser import JOB_ACTIVE_MESSAGE, _laser_resource
from backend.api.marlin_printers import _marlin_resource
from backend.services import console_service, laser_service, marlin_printer_service

logger = logging.getLogger(__name__)
router = APIRouter()


def klipper_resource(port: int) -> Resource:
    """Recurso de la Authorization Policy (ADR-006) para una impresora
    Klipper: el id normalizado de la máquina (`klipper:<port>`, el mismo del
    modelo de TUNA-Screen). Única construcción para las rutas migradas."""
    return Resource(ResourceKind.PRINTER, f"klipper:{port}")


class Target(NamedTuple):
    """Máquina a la que va una petición de consola: una Klipper (`port`), una
    Marlin (`device`, la ruta/endpoint del registro) o un láser/CNC (`host`)."""
    kind: str  # "klipper" | "marlin" | "laser"
    port: Optional[int]
    device: Optional[str]
    host: Optional[str]
    history_key: str
    resource: Resource
    label: str
    scope: str  # "printer" | "laser" | "cnc": qué macros le sirven


def resolve_target(port: Optional[int] = None, device: Optional[str] = None, host: Optional[str] = None) -> Target:
    """Exactamente uno: `port` (Klipper), `device` (Marlin) o `host` (láser/CNC).
    Marlin y láser/CNC se guardan por su id interno (estable) y no por la ruta
    o dirección, que cambian."""
    device = (device or "").strip() or None
    host = (host or "").strip() or None
    if sum(value is not None for value in (port, device, host)) > 1:
        raise HTTPException(status_code=422, detail="Indica la máquina con port, device o host, no con varios.")
    if host:
        entry = next((e for e in laser_service.get_registered_lasers() if e.get("host") == host), None)
        if entry is None:
            raise HTTPException(status_code=404, detail="Láser o CNC no registrado")
        key = f"laser:{entry.get('id') or host}"
        label = host.replace("/", "_").replace(":", "_").strip("_") or "laser"
        return Target("laser", None, None, host, key, _laser_resource(host), label, "cnc" if entry.get("kind") == "cnc" else "laser")
    if device:
        entry = next((e for e in marlin_printer_service.get_registered_printers() if e.get("device") == device), None)
        if entry is None:
            raise HTTPException(status_code=404, detail="Impresora Marlin no registrada")
        key = f"marlin:{entry.get('id') or device}"
        return Target("marlin", None, device, None, key, _marlin_resource(device), device.replace("/", "_").strip("_") or "marlin", "printer")
    if port is None:
        raise HTTPException(status_code=422, detail="Falta la máquina (port, device o host).")
    return Target("klipper", port, None, None, str(port), klipper_resource(port), str(port), "printer")


def _require_no_laser_job(target: Target) -> None:
    """Mientras corre un trabajo, un comando ajeno desincroniza el búfer de
    GRBL (ver laser_service.job_active): se rechaza con un error claro."""
    if target.kind == "laser" and laser_service.job_active(target.host):
        raise HTTPException(status_code=409, detail=JOB_ACTIVE_MESSAGE)


async def _send_one(target: Target, command: str) -> bool:
    _require_no_laser_job(target)
    if target.kind == "laser":
        ok = await laser_service.send_console_command(target.host, command)
        if ok:
            laser_service.log_console_command(target.host, command)
        return ok
    if target.kind == "marlin":
        ok = await marlin_printer_service.send_console_command(target.device, command)
        if ok:
            marlin_printer_service.log_console_command(target.device, command)
        return ok
    return send_console_command(port=target.port, command=command)


def _messages(target: Target, count: int) -> List[Dict[str, Any]]:
    if target.kind == "laser":
        laser_service.ensure_listener(target.host)
        return laser_service.get_console_buffer(target.host, count=count)
    if target.kind == "marlin":
        marlin_printer_service.ensure_listener(target.device)
        return marlin_printer_service.get_console_buffer(target.device, count=count)
    return get_console_messages(port=target.port, count=count)


@router.get("/api/console/messages")
async def get_console_messages_endpoint(
    port: Optional[int] = None, device: Optional[str] = None, host: Optional[str] = None, count: int = 50,
    user: dict = Depends(require_auth),
):
    """Últimos mensajes de la consola G-code de la máquina indicada."""
    target = resolve_target(port, device, host)
    try:
        return {"messages": _messages(target, count)}
    except Exception as e:
        logger.exception(f"Error al leer la consola ({target.history_key})")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/console/command")
async def send_console_command_endpoint(
    port: Optional[int] = Form(None), device: Optional[str] = Form(None), host: Optional[str] = Form(None),
    command: str = Form(...), user: dict = Depends(require_auth),
):
    """Envía un comando de consola/G-code a la máquina indicada."""
    target = resolve_target(port, device, host)
    # ADR-006 (D3-Q2): consola / G-code arbitrario solo admin. Antes, cualquier
    # usuario autenticado. Se autoriza antes de enviar nada.
    ensure_authorized(user, Action.SEND_CONSOLE_COMMAND, target.resource)
    if not await _send_one(target, command):
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    console_service.record_command(target.history_key, command)
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
async def get_history_endpoint(
    port: Optional[int] = None, device: Optional[str] = None, host: Optional[str] = None, limit: int = 50,
    user: dict = Depends(require_auth),
):
    """Últimos comandos enviados a la máquina (el más reciente primero)."""
    return {"history": console_service.get_history(resolve_target(port, device, host).history_key, limit)}


@router.delete("/api/console/history")
async def clear_history_endpoint(
    port: Optional[int] = None, device: Optional[str] = None, host: Optional[str] = None,
    user: dict = Depends(require_role("admin")),
):
    console_service.clear_history(resolve_target(port, device, host).history_key)
    return {"success": True}


@router.get("/api/console/log/export")
async def export_log_endpoint(
    port: Optional[int] = None, device: Optional[str] = None, host: Optional[str] = None, count: int = 500,
    user: dict = Depends(require_auth),
):
    """Log de la consola como texto descargable."""
    target = resolve_target(port, device, host)
    try:
        messages = _messages(target, max(1, min(count, 2000)))
    except Exception as e:
        logger.exception(f"Error al exportar la consola ({target.history_key})")
        raise HTTPException(status_code=502, detail=str(e))
    filename = f"consola-{target.label}-{datetime.now():%Y%m%d-%H%M%S}.log"
    return PlainTextResponse(
        console_service.format_log(messages),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _send_lines(target: Target, lines: List[str]) -> int:
    """Envía las líneas; si una falla avisa cuántas salieron. Klipper recibe
    bloques. Marlin, línea por línea esperando el 'ok' de cada una: su búfer
    de recepción es corto y un bloque grande se pierde."""
    _require_no_laser_job(target)
    sent = 0
    if target.kind in ("marlin", "laser"):
        chunks = [[line] for line in lines]
    else:
        chunks = console_service.chunked(lines)
    for chunk in chunks:
        if target.kind == "marlin":
            ok = await marlin_printer_service.send_line_and_wait(target.device, chunk[0])
            if ok:
                marlin_printer_service.log_console_command(target.device, chunk[0])
        elif target.kind == "laser":
            ok = await laser_service.send_line_and_wait(target.host, chunk[0])
            if ok:
                laser_service.log_console_command(target.host, chunk[0])
        else:
            ok = send_console_command(port=target.port, command="\n".join(chunk))
        if not ok:
            detail = "No se pudo enviar el comando"
            if sent:
                detail += f"; se alcanzaron a enviar {sent} de {len(lines)} líneas"
            raise HTTPException(status_code=502, detail=detail)
        sent += len(chunk)
    return sent


@router.post("/api/console/run-file")
async def run_file_endpoint(
    port: Optional[int] = Form(None), device: Optional[str] = Form(None), host: Optional[str] = Form(None),
    file: UploadFile = File(...), user: dict = Depends(require_auth),
):
    """Envía línea por línea un archivo de G-code corto (calibraciones, pruebas)."""
    target = resolve_target(port, device, host)
    ensure_authorized(user, Action.SEND_CONSOLE_COMMAND, target.resource)
    raw = await file.read(console_service.MAX_FILE_BYTES + 1)
    try:
        parsed = console_service.parse_gcode_upload(raw)
    except console_service.ConsoleError as e:
        status = 413 if "muy grande" in str(e) or "máximo para la consola" in str(e) else 422
        raise HTTPException(status_code=status, detail=str(e))
    sent = await _send_lines(target, parsed["lines"])
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


async def _run_item(target: Target, item_id: str, params: Dict[str, Any], template: bool, user: dict) -> Dict[str, Any]:
    # Mismo criterio que /api/macros/run (ADR-006): ejecutar G-code es de admin.
    ensure_authorized(user, Action.RUN_MACRO, target.resource)
    item = _crud_errors(lambda: console_service.get_item(item_id, template=template))
    if target.scope not in item["scopes"]:
        raise HTTPException(status_code=422, detail="Esa macro no está habilitada para este tipo de máquina.")
    commands = _crud_errors(lambda: console_service.render_commands(item, params))
    sent = await _send_lines(target, commands)
    return {"success": True, "sent": sent, "commands": commands}


@router.get("/api/console/macros")
async def list_custom_macros_endpoint(scope: Optional[str] = None, user: dict = Depends(require_auth)):
    return {"macros": _crud_errors(lambda: (console_service.check_scope(scope), console_service.list_macros(scope))[1])}


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
    return await _run_item(_target_from(payload), macro_id, {}, False, user)


@router.get("/api/console/templates")
async def list_templates_endpoint(scope: Optional[str] = None, user: dict = Depends(require_auth)):
    return {"templates": _crud_errors(lambda: (console_service.check_scope(scope), console_service.list_templates(scope))[1])}


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
    return await _run_item(_target_from(payload), template_id, params, True, user)


def _target_from(payload: Dict[str, Any]) -> Target:
    try:
        port = int(payload["port"]) if payload.get("port") is not None else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="El puerto (port) no es válido.")
    return resolve_target(port, payload.get("device"), payload.get("host"))
