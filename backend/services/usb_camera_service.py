"""Webcams USB conectadas localmente (/dev/video*) -- detección real vía
ioctl V4L2 (stdlib `fcntl`/`struct`, sin librería nueva) y streaming propio
delegado a `ffmpeg` como subproceso.

No hay SDK/librería de captura en este proyecto a propósito (ver
requirements.txt, deliberadamente liviano) -- en vez de sumar OpenCV, se
lanza `ffmpeg` (ya presente en la mayoría de los setups Klipper/Pi, es lo
mismo que usa Crowsnest para algunos de sus streamers) para leer el
dispositivo y devolver MJPEG.

Un dispositivo V4L2 normalmente solo admite un lector activo a la vez, y la
UI de camera-viewer.js ya abre dos <img> al mismo stream_url en simultáneo
(grid + lightbox) -- por eso acá va un único proceso ffmpeg por cámara,
compartido entre todos los suscriptores, mismo espíritu que
bambu_service._ensure_client / elegoo_service._ensure_listener / la
conexión serie persistente de laser_service.py (un solo canal real hacia el
dispositivo, cacheado y repartido a quien lo pida).
"""

import asyncio
import fcntl
import glob
import logging
import os
import shutil
import struct
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

FFMPEG_BIN = "ffmpeg"
IDLE_STOP_DELAY = 3.0  # margen antes de matar ffmpeg tras el último suscriptor -- evita cortar por una reconexión momentánea (ej. el lightbox cerrándose mientras el grid sigue mirando)
JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"

# ── VIDIOC_QUERYCAP -- calculado con la misma fórmula que usa el kernel de
# Linux para _IOR(), no un número mágico copiado de otro lado. ──
_IOC_READ = 2
_IOC_NRBITS, _IOC_TYPEBITS, _IOC_SIZEBITS = 8, 8, 14
_IOC_TYPESHIFT = _IOC_NRBITS
_IOC_SIZESHIFT = _IOC_TYPESHIFT + _IOC_TYPEBITS
_IOC_DIRSHIFT = _IOC_SIZESHIFT + _IOC_SIZEBITS

# struct v4l2_capability (linux/videodev2.h): u8 driver[16]; u8 card[32];
# u8 bus_info[32]; u32 version; u32 capabilities; u32 device_caps;
# u32 reserved[3]; -- 104 bytes, sin padding (formato nativo explícito).
_V4L2_CAP_STRUCT_FMT = "=16s32s32sIII12s"
_V4L2_CAP_STRUCT_SIZE = struct.calcsize(_V4L2_CAP_STRUCT_FMT)


def _ioc(direction: int, type_char: str, nr: int, size: int) -> int:
    return (direction << _IOC_DIRSHIFT) | (ord(type_char) << _IOC_TYPESHIFT) | (nr << 0) | (size << _IOC_SIZESHIFT)


VIDIOC_QUERYCAP = _ioc(_IOC_READ, "V", 0, _V4L2_CAP_STRUCT_SIZE)

V4L2_CAP_VIDEO_CAPTURE = 0x00000001
V4L2_CAP_DEVICE_CAPS = 0x80000000


def _query_v4l2_capability(device_path: str) -> Optional[Dict[str, Any]]:
    """None si no se pudo abrir/consultar (permiso denegado, no es un nodo
    V4L2 real, etc.) -- se descarta en silencio, no es un error del usuario."""
    try:
        fd = os.open(device_path, os.O_RDWR | os.O_NONBLOCK)
    except OSError as e:
        logger.debug(f"No se pudo abrir {device_path}: {e}")
        return None
    try:
        buf = bytearray(_V4L2_CAP_STRUCT_SIZE)
        fcntl.ioctl(fd, VIDIOC_QUERYCAP, buf)
        driver, card, _bus_info, _version, capabilities, device_caps, _reserved = struct.unpack(_V4L2_CAP_STRUCT_FMT, bytes(buf))
        return {
            "driver": driver.split(b"\x00", 1)[0].decode("utf-8", errors="ignore").strip(),
            "card": card.split(b"\x00", 1)[0].decode("utf-8", errors="ignore").strip(),
            "capabilities": capabilities,
            "device_caps": device_caps,
        }
    except OSError as e:
        logger.debug(f"VIDIOC_QUERYCAP falló en {device_path}: {e}")
        return None
    finally:
        os.close(fd)


def _is_capture_device(caps: Dict[str, Any]) -> bool:
    """Algunas webcams UVC exponen un segundo nodo /dev/video (metadata,
    sin video real) junto al de captura -- hay que mirar `device_caps` (por
    nodo) en vez de `capabilities` (agregado de todo el dispositivo) cuando
    el driver expone V4L2_CAP_DEVICE_CAPS, o se cuela ese nodo extra."""
    effective = caps["device_caps"] if caps["capabilities"] & V4L2_CAP_DEVICE_CAPS else caps["capabilities"]
    return bool(effective & V4L2_CAP_VIDEO_CAPTURE)


def _resolve_usb_identity(device_path: str) -> Dict[str, Optional[str]]:
    """Ubicación física estable (puerto USB, ej. "1-2" -- no cambia entre
    reinicios aunque el nodo /dev/videoN sí podría) + idVendor/idProduct/
    nombre real del dispositivo USB. El symlink
    /sys/class/video4linux/videoN/device apunta a la INTERFAZ USB
    (.../1-2/1-2:1.0); un nivel arriba está el dispositivo USB real, con los
    atributos idVendor/idProduct/product -- mismo espíritu que
    laser_service._resolve_usb_location, pero recorriendo el árbol sysfs de
    V4L2 en vez de pyserial."""
    video_name = os.path.basename(device_path)
    sysfs_device_link = f"/sys/class/video4linux/{video_name}/device"
    result: Dict[str, Optional[str]] = {"usb_location": None, "vendor_id": None, "product_id": None, "product_name": None}
    try:
        interface_path = os.path.realpath(sysfs_device_link)
        usb_device_path = os.path.dirname(interface_path)
        result["usb_location"] = os.path.basename(usb_device_path)
        for attr, key in (("idVendor", "vendor_id"), ("idProduct", "product_id"), ("product", "product_name")):
            attr_path = os.path.join(usb_device_path, attr)
            if os.path.isfile(attr_path):
                with open(attr_path, "r", encoding="utf-8") as handle:
                    result[key] = handle.read().strip()
    except OSError as e:
        logger.debug(f"No se pudo resolver la identidad USB de {device_path}: {e}")
    return result


def list_usb_video_devices() -> List[Dict[str, Any]]:
    """Dispositivos de captura de video reales conectados por USB --
    descarta nodos de metadata-only y cualquier /dev/video* que no responda
    a VIDIOC_QUERYCAP (no simula ni asume nada sobre lo que no pudo leer)."""
    devices = []
    for device_path in sorted(glob.glob("/dev/video*")):
        caps = _query_v4l2_capability(device_path)
        if caps is None or not _is_capture_device(caps):
            continue
        identity = _resolve_usb_identity(device_path)
        name = identity["product_name"] or caps["card"] or os.path.basename(device_path)
        devices.append({
            "device_path": device_path,
            "usb_location": identity["usb_location"],
            "name": name,
            "driver": caps["driver"],
            "vendor_id": identity["vendor_id"],
            "product_id": identity["product_id"],
        })
    return devices


# ── Streaming: un proceso ffmpeg por cámara activa, repartido a N suscriptores ──

class _CameraStream:
    def __init__(self, device_path: str):
        self.device_path = device_path
        self.process: Optional[asyncio.subprocess.Process] = None
        self.subscribers: List["asyncio.Queue[bytes]"] = []
        self.reader_task: Optional[asyncio.Task] = None
        self.stop_task: Optional[asyncio.Task] = None


_streams: Dict[str, _CameraStream] = {}
_streams_lock = asyncio.Lock()


async def _read_frames_loop(camera_id: str, stream: _CameraStream):
    assert stream.process is not None and stream.process.stdout is not None
    buffer = b""
    try:
        while True:
            chunk = await stream.process.stdout.read(65536)
            if not chunk:
                break
            buffer += chunk
            while True:
                start = buffer.find(JPEG_SOI)
                if start == -1:
                    buffer = b""
                    break
                end = buffer.find(JPEG_EOI, start + 2)
                if end == -1:
                    # Frame incompleto todavía -- se descarta lo previo al
                    # inicio del JPEG en curso para no crecer sin límite.
                    buffer = buffer[start:]
                    break
                frame = bytes(buffer[start:end + 2])
                buffer = buffer[end + 2:]
                for queue in list(stream.subscribers):
                    if queue.full():
                        try:
                            queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                    queue.put_nowait(frame)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning(f"[{camera_id}] Lector de frames de ffmpeg terminó: {e}")
    finally:
        await stop_stream(camera_id)


async def ensure_stream(camera_id: str, device_path: str) -> _CameraStream:
    """Reusa el proceso ffmpeg si ya está corriendo para esta cámara; si no,
    lo lanza. Lanza RuntimeError con un mensaje accionable si ffmpeg no está
    instalado -- nunca falla en silencio."""
    async with _streams_lock:
        existing = _streams.get(camera_id)
        if existing is not None and existing.process is not None and existing.process.returncode is None:
            if existing.stop_task:
                existing.stop_task.cancel()
                existing.stop_task = None
            return existing

        if shutil.which(FFMPEG_BIN) is None:
            raise RuntimeError("ffmpeg no está instalado en este equipo (instalalo con: sudo apt install ffmpeg)")

        process = await asyncio.create_subprocess_exec(
            FFMPEG_BIN, "-f", "v4l2", "-i", device_path,
            "-f", "mjpeg", "-q:v", "5", "-r", "10", "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stream = _CameraStream(device_path)
        stream.process = process
        _streams[camera_id] = stream
        stream.reader_task = asyncio.create_task(_read_frames_loop(camera_id, stream))
        logger.info(f"[{camera_id}] ffmpeg iniciado para {device_path} (pid {process.pid})")
        return stream


async def subscribe(camera_id: str, device_path: str) -> "asyncio.Queue[bytes]":
    stream = await ensure_stream(camera_id, device_path)
    queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=2)
    stream.subscribers.append(queue)
    return queue


async def unsubscribe(camera_id: str, queue: "asyncio.Queue[bytes]") -> None:
    stream = _streams.get(camera_id)
    if stream is None:
        return
    if queue in stream.subscribers:
        stream.subscribers.remove(queue)
    if not stream.subscribers and stream.stop_task is None:
        stream.stop_task = asyncio.create_task(_delayed_stop(camera_id))


async def _delayed_stop(camera_id: str) -> None:
    try:
        await asyncio.sleep(IDLE_STOP_DELAY)
    except asyncio.CancelledError:
        return
    stream = _streams.get(camera_id)
    if stream is not None and not stream.subscribers:
        await stop_stream(camera_id)


async def stop_stream(camera_id: str) -> None:
    stream = _streams.pop(camera_id, None)
    if stream is None:
        return
    if stream.reader_task is not None and not stream.reader_task.done():
        stream.reader_task.cancel()
    if stream.process is not None and stream.process.returncode is None:
        stream.process.kill()
        try:
            await stream.process.wait()
        except Exception:
            pass
    logger.info(f"[{camera_id}] ffmpeg detenido")


def is_device_present(device_path: Optional[str]) -> bool:
    return bool(device_path) and os.path.exists(device_path)
