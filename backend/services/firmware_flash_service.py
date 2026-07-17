"""Flasheo de firmware para placas de accesorios NOPAL (ESP32/ESP8266).

NOPAL nunca compila nada acá (no hay arduino-cli/platformio instalado en el
servidor) — este módulo solo administra binarios .bin YA COMPILADOS que el
usuario sube (exportados desde Arduino IDE con "Sketch → Export Compiled
Binary", que en ESP32/ESP8266 produce un binario FUSIONADO con
bootloader+partición+app pensado para escribirse completo en el offset
0x0) y los escribe en una placa real de dos formas:

- Por USB, con esptool (biblioteca Python, sin toolchain de compilación).
- Por OTA, subiendo el binario al ElegantOTA que ya corre en el firmware
  1.3+ (ver firmware/nopal_accessory/nopal_accessory.ino).
"""

from __future__ import annotations

import contextlib
import io
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)

BUILDS_DIR = Path("firmware/nopal_accessory/builds")

# Velocidad de flasheo por USB. Si el adaptador USB-serie no la soporta,
# esptool reintenta solo a una velocidad menor — no hace falta que este
# valor sea "seguro" para el peor de los casos.
ESPTOOL_BAUD = 460800

# Offset fijo: los binarios que produce "Export Compiled Binary" ya vienen
# fusionados (bootloader + tabla de particiones + app), pensados para
# escribirse completos desde el inicio de la flash.
FLASH_OFFSET = "0x0"

# ElegantOTA 3.x (la que instala hoy el gestor de librerías de Arduino IDE
# por defecto) separa la actualización en dos pasos:
#   1) GET  /ota/start  -> Update.begin() del lado de la placa.
#   2) POST /ota/upload -> el binario en sí, como multipart/form-data.
# GET /update solo sirve la páginà HTML/JS del panel, no acepta el binario
# directamente. Confirmado contra el código fuente real de la librería
# (ayushsharma82/ElegantOTA, src/ElegantOTA.cpp) — ver reporte del agente
# para el detalle de qué se pudo verificar y qué no.
OTA_START_PATH = "/ota/start"
OTA_UPLOAD_PATH = "/ota/upload"
OTA_TIMEOUT = 60

_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


# ── Administración de binarios subidos ──

def _ensure_builds_dir() -> None:
    BUILDS_DIR.mkdir(parents=True, exist_ok=True)


def _sanitize_build_filename(filename: str) -> str:
    """Nombre de archivo seguro para guardar/leer dentro de BUILDS_DIR: sin
    componentes de ruta (evita path traversal), extensión .bin obligatoria,
    y solo caracteres inofensivos."""
    name = os.path.basename((filename or "").strip())
    if not name or not name.lower().endswith(".bin"):
        raise ValueError("El archivo debe tener extensión .bin")
    if not _SAFE_FILENAME_RE.match(name):
        raise ValueError(
            "Nombre de archivo inválido (solo letras, números, '.', '_' y '-')"
        )
    return name


def _build_info(path: Path) -> Dict[str, Any]:
    stat = path.stat()
    return {
        "filename": path.name,
        "size": stat.st_size,
        "modified_at": stat.st_mtime,
    }


def list_builds() -> list[Dict[str, Any]]:
    """Binarios .bin disponibles en firmware/nopal_accessory/builds/,
    ordenados del más reciente al más viejo."""
    _ensure_builds_dir()
    entries = [
        _build_info(path)
        for path in BUILDS_DIR.iterdir()
        if path.is_file() and path.suffix.lower() == ".bin"
    ]
    entries.sort(key=lambda entry: entry["modified_at"], reverse=True)
    return entries


def save_build(filename: str, content: bytes) -> Dict[str, Any]:
    """Guarda un binario subido. Escritura atómica (.tmp + replace) porque,
    a diferencia de un registro JSON, un .bin truncado a medio escribir es
    un binario corrupto listo para flashearse a una placa real — vale la
    pena la protección incluso para un archivo que no es JSON."""
    if not content:
        raise ValueError("El archivo está vacío")

    safe_name = _sanitize_build_filename(filename)
    _ensure_builds_dir()

    target = BUILDS_DIR / safe_name
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_bytes(content)
    temporary.replace(target)

    logger.info(f"Binario de firmware guardado: {safe_name} ({len(content)} bytes)")
    return _build_info(target)


def resolve_build_path(filename: str) -> Path:
    """Ruta real de un binario ya guardado, o levanta si no existe / el
    nombre no es válido — usado antes de flashear para no depender de que
    el llamador arme la ruta a mano."""
    safe_name = _sanitize_build_filename(filename)
    path = BUILDS_DIR / safe_name
    if not path.is_file():
        raise FileNotFoundError(f"No se encontró el binario: {safe_name}")
    return path


# ── Flasheo por USB (esptool) ──

def flash_via_usb(device: str, bin_path: str) -> Dict[str, Any]:
    """Escribe `bin_path` (binario fusionado) en `device` (ej.
    /dev/ttyUSB1) usando esptool, en el offset 0x0. Antes de tocar el
    puerto, suelta cualquier conexión serie cacheada por el driver "arduino"
    (accessory_service._arduino_connections) — esptool necesita control
    exclusivo del puerto. No hay reintento automático de esa conexión acá:
    el próximo comando que le llegue a la placa desde el driver la vuelve a
    abrir sola, pero eso no debe pasar mientras el flasheo está en curso."""
    if not device:
        return {"success": False, "error": "Falta el puerto serie (device)"}

    if not os.path.isfile(bin_path):
        return {"success": False, "error": f"No se encontró el binario: {bin_path}"}

    try:
        from backend.services.accessory_service import release_arduino_connection
        release_arduino_connection(device)
    except Exception as e:
        logger.warning(f"[{device}] No se pudo soltar la conexión serie cacheada: {e}")

    try:
        import esptool
    except ImportError:
        return {
            "success": False,
            "error": "El paquete 'esptool' no está instalado en el servidor",
        }

    argv = [
        "--chip", "auto",
        "--port", device,
        "--baud", str(ESPTOOL_BAUD),
        "write_flash",
        FLASH_OFFSET,
        bin_path,
    ]

    output = io.StringIO()
    success = False
    error: Optional[str] = None

    logger.info(f"[{device}] Flasheando {os.path.basename(bin_path)} por USB…")

    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            esptool.main(argv)
        success = True
    except SystemExit as e:
        error = f"esptool terminó con código de error {e.code}"
    except Exception as e:
        # Cubre esptool.FatalError, serial.SerialException, OSError, etc.
        error = str(e)

    log_text = output.getvalue()

    if success:
        logger.info(f"[{device}] Flasheo por USB completado")
    else:
        logger.warning(f"[{device}] Flasheo por USB falló: {error}")

    return {
        "success": success,
        "device": device,
        "log": log_text,
        "error": error,
    }


# ── Flasheo por OTA (ElegantOTA) ──

def flash_via_ota(ip: str, bin_path: str, username: str, password: str) -> Dict[str, Any]:
    """Sube `bin_path` al ElegantOTA que corre en la placa en `ip` (Wi-Fi ya
    conectado, firmware 1.3+). Dos pasos, ver comentario junto a
    OTA_START_PATH/OTA_UPLOAD_PATH más arriba."""
    if not ip:
        return {"success": False, "error": "Falta la IP de la placa"}

    if not os.path.isfile(bin_path):
        return {"success": False, "error": f"No se encontró el binario: {bin_path}"}

    base_url = f"http://{ip}"
    auth = (username, password) if username else None

    try:
        start_response = requests.get(
            f"{base_url}{OTA_START_PATH}",
            params={"mode": "firmware"},
            auth=auth,
            timeout=OTA_TIMEOUT,
        )
    except requests.exceptions.RequestException as e:
        return {"success": False, "error": f"No se pudo contactar la placa en {ip}: {e}"}

    if start_response.status_code == 401:
        return {
            "success": False,
            "error": "La placa rechazó la autenticación de ElegantOTA (usuario/clave incorrectos)",
        }
    if not start_response.ok:
        return {
            "success": False,
            "error": f"La placa no pudo iniciar la actualización ({start_response.status_code}): "
                     f"{start_response.text[:300]}",
        }

    filename = os.path.basename(bin_path)

    try:
        with open(bin_path, "rb") as handle:
            upload_response = requests.post(
                f"{base_url}{OTA_UPLOAD_PATH}",
                auth=auth,
                # El campo del multipart no importa para el servidor: el
                # parser de WebServer/ESP8266WebServer dispara el manejador
                # de subida para cualquier parte que traiga "filename" en su
                # Content-Disposition, sin mirar el nombre del campo (visto
                # en Parsing.cpp del core arduino-esp32). "firmware" es solo
                # para que el log/tráfico sea legible.
                files={"firmware": (filename, handle, "application/octet-stream")},
                timeout=OTA_TIMEOUT,
            )
    except requests.exceptions.RequestException as e:
        return {"success": False, "error": f"Fallo al subir el firmware a {ip}: {e}"}

    if upload_response.status_code == 401:
        return {
            "success": False,
            "error": "La placa rechazó la autenticación de ElegantOTA (usuario/clave incorrectos)",
        }
    if not upload_response.ok:
        return {
            "success": False,
            "error": f"La placa rechazó el firmware ({upload_response.status_code}): "
                     f"{upload_response.text[:300]}",
        }

    logger.info(f"[{ip}] Flasheo por OTA completado ({filename})")

    return {
        "success": True,
        "ip": ip,
        "detail": upload_response.text[:300],
    }
