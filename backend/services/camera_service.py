"""Registro local de cámaras: URL de stream MJPEG directa, o RTSP puenteado
por go2rtc.

Para MJPEG no hay protocolo propio: el usuario pega la URL que ya expone su
cámara (Crowsnest, mjpg-streamer, ustreamer, cámara IP) y el navegador la
reproduce directo con un <img>. RTSP (DVR/NVR genéricos, cámaras IP que no
hablan MJPEG) no lo puede reproducir un <img> -- se registra automáticamente
como fuente en go2rtc (puente RTSP -> MJPEG, corre en :1984, ver
go2rtc.service) y al navegador se le devuelve la URL MJPEG que expone go2rtc
para esa fuente, nunca la URL RTSP original.

Persiste nombre + URL en un archivo plano, mismo patrón que
accessory_service.py (accessory_registry.json).
"""

import json
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

import requests

from backend.services import usb_camera_service

logger = logging.getLogger(__name__)

REGISTRY_PATH = "camera_registry.json"
GO2RTC_API = "http://127.0.0.1:1984/api"
HTTP_TIMEOUT = 5
PROBE_TIMEOUT = 1.5


def _is_rtsp(url: str) -> bool:
    return url.lower().startswith(("rtsp://", "rtsps://"))


def _load_registry() -> List[Dict[str, Any]]:
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _save_registry(entries: List[Dict[str, Any]]):
    try:
        with open(REGISTRY_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2)
    except OSError:
        pass


def _go2rtc_add_stream(stream_id: str, source_url: str) -> None:
    """Best-effort: si go2rtc todavía no está corriendo, la cámara igual
    queda registrada en NOPAL -- el navegador solo ve 'sin señal' hasta que
    el servicio esté arriba (mismo criterio tolerante a fallos que el resto
    del panel de cámaras)."""
    try:
        requests.put(
            f"{GO2RTC_API}/streams",
            params={"name": stream_id, "src": source_url},
            timeout=HTTP_TIMEOUT,
        )
    except Exception as e:
        logger.warning(f"No se pudo registrar la cámara {stream_id} en go2rtc: {e}")


def _go2rtc_remove_stream(stream_id: str) -> None:
    try:
        requests.delete(f"{GO2RTC_API}/streams", params={"src": stream_id}, timeout=HTTP_TIMEOUT)
    except Exception as e:
        logger.warning(f"No se pudo limpiar la cámara {stream_id} en go2rtc: {e}")


def get_cameras(request_host: Optional[str] = None) -> List[Dict[str, Any]]:
    """`request_host` es el host (sin puerto) que el navegador usó para
    llegar a NOPAL -- se reusa para armar la URL de go2rtc (mismo equipo,
    puerto 1984) sin hardcodear ninguna IP."""
    host = request_host or "127.0.0.1"
    result = []
    for entry in _load_registry():
        source_url = entry.get("source_url", "")
        playback_url = (
            f"http://{host}:1984/api/stream.mjpeg?src={entry['id']}"
            if _is_rtsp(source_url)
            else source_url
        )
        result.append({**entry, "stream_url": playback_url})
    return result


def register_camera(
    name: str,
    source_url: str,
    purpose: Optional[str] = None,
    purpose_note: Optional[str] = None,
    bound_device: Optional[Dict[str, str]] = None,
    device_path: Optional[str] = None,
    entry_id: Optional[str] = None,
) -> Dict[str, Any]:
    """`purpose`/`bound_device` (para qué se va a usar la cámara -- ver
    usb_camera_service.py) y `device_path` (nodo /dev/videoN real, solo para
    cámaras USB servidas por NOPAL) son opcionales y aditivos: los registros
    viejos (URL directa/ONVIF, de antes de esta feature) no los tienen y
    siguen funcionando igual -- get_cameras()/get_camera_health_counts() los
    tratan como ausentes, no como un error. `entry_id` es opcional: el alta
    de cámara USB necesita conocer el id ANTES de guardar (para poder armar
    `source_url=/api/cameras/usb/{id}/stream`), así que lo genera y lo pasa
    -- si no se da, se genera acá como siempre."""
    entries = _load_registry()
    entry_id = entry_id or uuid.uuid4().hex[:12]
    if _is_rtsp(source_url):
        _go2rtc_add_stream(entry_id, source_url)
    entry = {
        "id": entry_id,
        "name": name,
        "source_url": source_url,
        "registered_at": time.time(),
        "purpose": purpose,
        "purpose_note": purpose_note,
        "bound_device": bound_device,
        "device_path": device_path,
    }
    entries.append(entry)
    _save_registry(entries)
    return entry


def _go2rtc_stream_has_producer(stream_id: str) -> bool:
    """Best-effort: consulta el estado real de go2rtc para esa fuente en vez
    de asumir que "registrada" significa "online" (mismo criterio que ya se
    aplicó a Elegoo: no marcar conectado sin comprobación real)."""
    try:
        response = requests.get(f"{GO2RTC_API}/streams", timeout=PROBE_TIMEOUT)
        response.raise_for_status()
        streams = response.json()
        return bool(streams.get(stream_id))
    except Exception:
        return False


def _probe_http_source(url: str) -> bool:
    """GET corto (no HEAD -- muchos streamers MJPEG no lo soportan) que se
    cierra apenas llega el primer byte, sin descargar el stream entero."""
    if not url or not url.lower().startswith(("http://", "https://")):
        return False
    try:
        with requests.get(url, timeout=PROBE_TIMEOUT, stream=True) as response:
            return response.status_code < 400
    except Exception:
        return False


def get_camera_health_counts() -> Dict[str, int]:
    """Conteo real para el resumen del dashboard -- nunca "online" sin
    comprobarlo. Tres caminos según el tipo de fuente: cámara USB servida
    por NOPAL (existencia del nodo /dev/videoN), RTSP puenteada por go2rtc
    (estado real de esa fuente en go2rtc), o MJPEG directa (GET corto)."""
    entries = _load_registry()
    online = 0
    for entry in entries:
        device_path = entry.get("device_path")
        source_url = entry.get("source_url", "")
        if device_path:
            if os.path.exists(device_path):
                online += 1
        elif _is_rtsp(source_url):
            if _go2rtc_stream_has_producer(entry["id"]):
                online += 1
        elif _probe_http_source(source_url):
            online += 1
    return {"online": online, "total": len(entries)}


async def unregister_camera(camera_id: str) -> bool:
    entries = _load_registry()
    removed = next((e for e in entries if e.get("id") == camera_id), None)
    filtered = [e for e in entries if e.get("id") != camera_id]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        if removed and _is_rtsp(removed.get("source_url", "")):
            _go2rtc_remove_stream(camera_id)
        if removed and removed.get("device_path"):
            # Cámara USB -- si había un proceso ffmpeg corriendo para ella,
            # se lo detiene acá; si no había nadie mirándola, es un no-op.
            await usb_camera_service.stop_stream(camera_id)
    return changed
