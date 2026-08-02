import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from backend.auth_deps import require_role
from backend.services import tunascreen_service
from backend.utils import get_app_version

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tunascreen"])


def require_device_token(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """Auth paralela a la de sesión (require_auth/require_role) -- TUNA-Screen
    nunca tiene cookie de NOPAL, solo el token permanente que recibió al
    parear (ver POST /pair/confirm)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Falta el token del dispositivo")
    token = authorization.split(" ", 1)[1].strip()
    device = tunascreen_service.resolve_device(token)
    if device is None:
        raise HTTPException(status_code=401, detail="Token de dispositivo inválido")
    return device


@router.get("/api/tunascreen/info")
async def tunascreen_info():
    return {
        "name": "NOPAL",
        "server_version": get_app_version(),
        "api_version": tunascreen_service.API_VERSION,
        "pairing_open": tunascreen_service.has_pending_codes(),
        "websocket_path": "/ws/tunascreen",
    }


@router.post("/api/tunascreen/pair/start")
async def tunascreen_pair_start(user: dict = Depends(require_role("admin"))):
    """Solo un admin logueado en la web de NOPAL puede generar el código --
    el código en sí es la credencial que después usa el dispositivo nuevo,
    que todavía no tiene ninguna forma de autenticarse."""
    return tunascreen_service.generate_pairing_code()


@router.get("/api/tunascreen/devices")
async def tunascreen_devices(user: dict = Depends(require_role("admin"))):
    return {"devices": tunascreen_service.list_paired_devices()}


@router.delete("/api/tunascreen/devices/{device_id}")
async def tunascreen_revoke_device(device_id: str, user: dict = Depends(require_role("admin"))):
    if not tunascreen_service.revoke_device(device_id):
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    return {"success": True}


@router.post("/api/tunascreen/pair/confirm")
async def tunascreen_pair_confirm(payload: Dict[str, Any]):
    code = str(payload.get("code", "")).strip()
    device_name = str(payload.get("device_name", "")).strip()
    try:
        return tunascreen_service.confirm_pairing(code, device_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/tunascreen/machines")
async def tunascreen_machines(device: dict = Depends(require_device_token)):
    return {
        "api_version": tunascreen_service.API_VERSION,
        "machines": await tunascreen_service.list_machines(),
    }


@router.get("/api/tunascreen/config")
async def tunascreen_config(device: dict = Depends(require_device_token)):
    """Bootstrap autocontenido para clientes nuevos.

    Android puede seguir usando ``/machines``; este endpoint evita que otras
    pantallas tengan que adivinar la versión del contrato o la ruta WS.
    """
    return {
        "server": {
            "name": "NOPAL",
            "version": get_app_version(),
            "api_version": tunascreen_service.API_VERSION,
        },
        "websocket_path": "/ws/tunascreen",
        "machines": await tunascreen_service.list_machines(),
    }


@router.get("/api/tunascreen/machine/{machine_id}")
async def tunascreen_machine_detail(machine_id: str, device: dict = Depends(require_device_token)):
    machine = await tunascreen_service.get_machine(machine_id)
    if machine is None:
        raise HTTPException(status_code=404, detail="Máquina no encontrada")
    return machine


@router.get("/api/tunascreen/machine/{machine_id}/macros")
async def tunascreen_machine_macros(machine_id: str, device: dict = Depends(require_device_token)):
    try:
        return {"macros": await tunascreen_service.get_machine_macros(machine_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/tunascreen/machine/{machine_id}/console")
async def tunascreen_machine_console(
    machine_id: str,
    count: int = 50,
    device: dict = Depends(require_device_token),
):
    try:
        return {"messages": await tunascreen_service.get_machine_console(machine_id, count)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/tunascreen/cameras/{camera_id}/stream")
async def tunascreen_camera_stream(camera_id: str, device: dict = Depends(require_device_token)):
    """MJPEG de una webcam vinculada, autenticado con token TUNA-Screen."""
    try:
        queue, usb_module = await tunascreen_service.subscribe_camera_stream(camera_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Cámara USB vinculada no encontrada") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    async def generator():
        try:
            while True:
                frame = await queue.get()
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n" +
                    frame + b"\r\n"
                )
        finally:
            await usb_module.unsubscribe(camera_id, queue)

    return StreamingResponse(generator(), media_type="multipart/x-mixed-replace; boundary=frame")


@router.post("/api/tunascreen/action")
async def tunascreen_action(payload: Dict[str, Any], device: dict = Depends(require_device_token)):
    machine_id = payload.get("machine_id")
    action = payload.get("action")
    params = payload.get("params") or {}
    if not machine_id or not action:
        raise HTTPException(status_code=400, detail="Faltan machine_id/action")
    try:
        result = await tunascreen_service.dispatch_action(machine_id, action, params)
        return {
            "success": bool(result.get("success")),
            "action": action,
            "machine_id": machine_id,
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.websocket("/ws/tunascreen")
async def tunascreen_ws(websocket: WebSocket):
    """Auth por header en el handshake (no query param, para no dejar el
    token en logs de acceso) -- se valida antes de accept()."""
    auth_header = websocket.headers.get("authorization", "")
    token = auth_header.split(" ", 1)[1].strip() if auth_header.lower().startswith("bearer ") else ""
    device = tunascreen_service.resolve_device(token)
    if device is None:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    tunascreen_service.register_connection(websocket)
    try:
        # Snapshot inmediato -- no esperar el próximo tick del broadcaster
        # (hasta 2s) para la primera pintada de pantalla.
        machines = await tunascreen_service.list_machines()
        await websocket.send_text(json.dumps({
            "type": "machines",
            "api_version": tunascreen_service.API_VERSION,
            "machines": machines,
        }))
        while True:
            # Canal de solo push por ahora -- igual hay que leer para
            # detectar la desconexión del cliente.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Error en el WebSocket de TUNA-Screen")
    finally:
        tunascreen_service.unregister_connection(websocket)
