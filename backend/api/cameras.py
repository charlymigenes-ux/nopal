from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request

from backend.auth_deps import require_auth, require_role
from backend.services.camera_service import get_cameras, register_camera, unregister_camera
from backend.services.onvif_service import resolve_rtsp_uri_autoscan

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
    host: str = Form(...),
    port: Optional[int] = Form(None),
    username: str = Form(...),
    password: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    """Resuelve la URL RTSP real vía ONVIF (GetCapabilities/GetProfiles/
    GetStreamUri) y registra la cámara con esa URL -- el usuario no tiene
    que saber ni el puerto ONVIF ni el formato de URL RTSP de su cámara:
    si no da un puerto (o el que dio no responde), se prueban los puertos
    donde suelen publicarlo los fabricantes."""
    try:
        rtsp_uri, resolved_port = resolve_rtsp_uri_autoscan(host.strip(), username.strip(), password, port)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    entry = register_camera(name.strip() or "Cámara", rtsp_uri)
    return {**entry, "onvif_port": resolved_port}


@router.post("/api/cameras/remove")
async def camera_remove_endpoint(id: str = Form(...), user: dict = Depends(require_role("admin"))):
    if not unregister_camera(id):
        raise HTTPException(status_code=404, detail="Cámara no encontrada")
    return {"success": True}
