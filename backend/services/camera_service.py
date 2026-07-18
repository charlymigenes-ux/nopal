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
import time
import uuid
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

REGISTRY_PATH = "camera_registry.json"
GO2RTC_API = "http://127.0.0.1:1984/api"
HTTP_TIMEOUT = 5


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


def register_camera(name: str, source_url: str) -> Dict[str, Any]:
    entries = _load_registry()
    entry_id = uuid.uuid4().hex[:12]
    if _is_rtsp(source_url):
        _go2rtc_add_stream(entry_id, source_url)
    entry = {
        "id": entry_id,
        "name": name,
        "source_url": source_url,
        "registered_at": time.time(),
    }
    entries.append(entry)
    _save_registry(entries)
    return entry


def unregister_camera(camera_id: str) -> bool:
    entries = _load_registry()
    removed = next((e for e in entries if e.get("id") == camera_id), None)
    filtered = [e for e in entries if e.get("id") != camera_id]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        if removed and _is_rtsp(removed.get("source_url", "")):
            _go2rtc_remove_stream(camera_id)
    return changed
