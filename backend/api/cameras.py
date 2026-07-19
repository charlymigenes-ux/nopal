import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import StreamingResponse

from backend.auth_deps import require_auth, require_role
from backend.services import usb_camera_service
from backend.services.camera_service import get_cameras, register_camera, unregister_camera
from backend.services.onvif_service import resolve_rtsp_uri_autoscan, resolve_rtsp_uri_from_url

router = APIRouter()


@router.get("/api/cameras")
async def camera_list_endpoint(request: Request, user: dict = Depends(require_auth)):
    """Cámaras registradas. Las RTSP vienen resueltas a la URL MJPEG que
    expone go2rtc para esa fuente -- el navegador nunca ve la URL RTSP."""
    return {"cameras": get_cameras(request_host=request.url.hostname)}


@router.post("/api/cameras")
async def camera_register_endpoint(
    name: str = Form(...),
    stream_url: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    if not stream_url.strip():
        raise HTTPException(status_code=400, detail="La URL del stream es obligatoria")
    return register_camera(name.strip() or "Cámara", stream_url.strip())


@router.post("/api/cameras/onvif")
async def camera_register_onvif_endpoint(
    name: str = Form(...),
    host: Optional[str] = Form(None),
    port: Optional[int] = Form(None),
    onvif_url: Optional[str] = Form(None),
    username: str = Form(...),
    password: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    """Resuelve la URL RTSP real vía ONVIF (GetCapabilities/GetProfiles/
    GetStreamUri) y registra la cámara con esa URL. Dos caminos:
    - Solo con `host` (+ `port` opcional): autoscan sobre el path estándar
      /onvif/device_service, el usuario no tiene que saber ni el puerto ni
      el formato de URL RTSP (ver resolve_rtsp_uri_autoscan).
    - Con `onvif_url`: usa esa URL completa tal cual, sin adivinar puerto ni
      path -- necesario para fabricantes que no publican el device_service
      en el path estándar (confirmado por el usuario probando la URL exacta
      de su cámara)."""
    onvif_url = (onvif_url or "").strip()
    host = (host or "").strip()
    if not onvif_url and not host:
        raise HTTPException(status_code=400, detail="Indicá la IP de la cámara o la URL completa del servicio ONVIF")
    try:
        if onvif_url:
            rtsp_uri = resolve_rtsp_uri_from_url(onvif_url, username.strip(), password)
            resolved_port = None
        else:
            rtsp_uri, resolved_port = resolve_rtsp_uri_autoscan(host, username.strip(), password, port)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    entry = register_camera(name.strip() or "Cámara", rtsp_uri)
    return {**entry, "onvif_port": resolved_port}


@router.post("/api/cameras/remove")
async def camera_remove_endpoint(id: str = Form(...), user: dict = Depends(require_role("admin"))):
    if not await unregister_camera(id):
        raise HTTPException(status_code=404, detail="Cámara no encontrada")
    return {"success": True}


@router.get("/api/cameras/usb/discover")
async def camera_usb_discover_endpoint(user: dict = Depends(require_auth)):
    """Webcams USB conectadas localmente (V4L2) -- ver usb_camera_service.py."""
    return {"devices": usb_camera_service.list_usb_video_devices()}


@router.post("/api/cameras/usb/register")
async def camera_usb_register_endpoint(
    name: str = Form(...),
    device_path: str = Form(...),
    purpose: Optional[str] = Form(None),
    purpose_note: Optional[str] = Form(None),
    bound_device_type: Optional[str] = Form(None),
    bound_device_id: Optional[str] = Form(None),
    user: dict = Depends(require_role("admin")),
):
    """Registra una webcam USB detectada -- a diferencia de URL directa/ONVIF,
    el stream lo sirve el propio NOPAL (ver usb_camera_service.ensure_stream),
    no una URL externa que el usuario tenga que conocer."""
    if not os.path.exists(device_path):
        raise HTTPException(status_code=400, detail="El dispositivo ya no está conectado")
    entry_id = uuid.uuid4().hex[:12]
    bound_device = (
        {"type": bound_device_type, "id": bound_device_id}
        if bound_device_type and bound_device_id
        else None
    )
    entry = register_camera(
        name.strip() or "Cámara USB",
        f"/api/cameras/usb/{entry_id}/stream",
        purpose=purpose,
        purpose_note=purpose_note if purpose == "other" else None,
        bound_device=bound_device,
        device_path=device_path,
        entry_id=entry_id,
    )
    return entry


@router.get("/api/cameras/usb/{camera_id}/stream")
async def camera_usb_stream_endpoint(camera_id: str, user: dict = Depends(require_auth)):
    entry = next((c for c in get_cameras() if c["id"] == camera_id), None)
    if entry is None or not entry.get("device_path"):
        raise HTTPException(status_code=404, detail="Cámara USB no encontrada")
    try:
        queue = await usb_camera_service.subscribe(camera_id, entry["device_path"])
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

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
            await usb_camera_service.unsubscribe(camera_id, queue)

    return StreamingResponse(generator(), media_type="multipart/x-mixed-replace; boundary=frame")
