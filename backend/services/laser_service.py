import asyncio
import itertools
import json
import logging
import os
import re
import socket
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import requests
import websockets

from backend.services import marlin_driver

logger = logging.getLogger(__name__)

DEFAULT_LASER_HOST = "192.168.0.61"
HTTP_TIMEOUT = 4
WS_PORT = 81
REGISTRY_PATH = "laser_registry.json"
HISTORY_PATH = "laser_history.json"
HISTORY_MAX_ENTRIES = 200

STATUS_RE = re.compile(r"<(?P<state>\w+)(?::\d+)?\|(?P<fields>[^>]*)>")

_active_host = DEFAULT_LASER_HOST


def get_active_host() -> str:
    return _active_host


def set_active_host(host: str):
    global _active_host
    _active_host = host


def _is_usb_host(host: str) -> bool:
    return host.startswith("usb:")


def _usb_device(host: str) -> str:
    return host[len("usb:"):]


# ── Registro de placas conocidas (persistido) ──

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


def get_registered_lasers() -> List[Dict[str, Any]]:
    return _load_registry()


def _registry_entry_online(entry: Dict[str, Any], network_probe_results: Dict[str, bool]) -> bool:
    if entry.get("conflict"):
        # Hay algo respondiendo en ese puerto, pero la reconciliación no
        # pudo confirmar que sigue siendo la misma placa — se reporta
        # offline a propósito para que no se le manden comandos a ciegas.
        return False
    host = entry.get("host", "")
    if _is_usb_host(host):
        return os.path.exists(_usb_device(host))
    return network_probe_results.get(host, False)


def _reconcile_usb_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Autocorrige la ruta /dev/ttyUSBx de las entradas USB cuando el kernel
    la renumeró, usando la ubicación física del puerto (estable) como ancla
    — pero solo tras confirmar con un handshake GRBL real que ahí sigue
    respondiendo el mismo tipo de placa. Si no confirma, no toca el host
    (para no mandarle comandos a otra máquina) y marca 'conflict'.

    Deliberadamente NO reintenta el handshake en cada poll mientras una
    entrada sigue en conflicto — eso implicaría abrir/cerrar el puerto (y
    resetear vía DTR) la placa que ahora ocupa ese lugar cada ~5s, lo que
    podría interrumpirle un trabajo en curso. Mientras esté en conflicto,
    solo se revisa (sin tocar el puerto) si la ubicación volvió a resolver
    a la ruta que ya tenía guardada, para limpiar el conflicto solo."""
    changed = False
    result: List[Dict[str, Any]] = []

    for entry in entries:
        host = entry.get("host", "")
        if not _is_usb_host(host):
            result.append(entry)
            continue

        location = entry.get("location")
        stored_device = _usb_device(host)

        if not location:
            # Entrada de antes de este cambio: backfillear la ubicación si
            # el puerto guardado sigue existiendo, sin exigir un handshake
            # retroactivo sobre algo que ya venía funcionando.
            if os.path.exists(stored_device):
                found_location = _location_for_device(stored_device)
                if found_location:
                    entry = {**entry, "location": found_location}
                    changed = True
            result.append(entry)
            continue

        if entry.get("conflict"):
            resolved = _resolve_usb_location(location)
            if resolved == stored_device:
                entry = {**entry, "conflict": None}
                changed = True
            result.append(entry)
            continue

        resolved_device = _resolve_usb_location(location)
        if resolved_device is None or resolved_device == stored_device:
            result.append(entry)
            continue

        # La ubicación física resolvió a una ruta distinta de la guardada
        # (renumeración) — confirmar con un handshake antes de adoptarla.
        if _probe_grbl_sync(resolved_device):
            entry = {**entry, "host": f"usb:{resolved_device}", "conflict": None}
            changed = True
            logger.info(f"Puerto USB renumerado, autocorregido: {host} -> usb:{resolved_device}")
        else:
            entry = {**entry, "conflict": "Puerto reasignado a otra placa — revisar cableado"}
            changed = True
            logger.warning(f"[{host}] Conflicto: '{location}' ya no responde como GRBL (ahora en {resolved_device})")
        result.append(entry)

    if changed:
        _save_registry(result)
    return result


def get_registered_lasers_with_status(timeout: float = 1.0) -> List[Dict[str, Any]]:
    """Registro completo (red y USB), online o no, con un campo "online"
    agregado por entrada — pensado para una pantalla de "todos los
    dispositivos" en Configuración, separada del listado plano que ya
    consumen varias pantallas (`get_registered_lasers`/`/api/laser/registry`)
    para no sumarle una probada de red a esos llamados frecuentes.

    USB: existe el /dev/ttyUSBx ahora mismo (no confirma que el firmware
    responda, solo que el puerto sigue ahí — igual que hace list_usb_laser_ports).
    Red: probe puntual por host registrado (no un barrido de subred como
    /api/laser/scan)."""
    entries = _reconcile_usb_entries(_load_registry())
    network_hosts = [e["host"] for e in entries if not _is_usb_host(e.get("host", ""))]

    probe_results: Dict[str, bool] = {}
    if network_hosts:
        with ThreadPoolExecutor(max_workers=min(len(network_hosts), 20)) as executor:
            for host, reachable in executor.map(
                lambda h: (h, _probe_host(h, timeout) is not None), network_hosts
            ):
                probe_results[host] = reachable

    return [
        {**entry, "online": _registry_entry_online(entry, probe_results)}
        for entry in entries
    ]


async def get_registered_lasers_status() -> List[Dict[str, Any]]:
    """Versión async de get_registered_lasers_with_status (en un hilo aparte,
    mismo criterio que scan_network) — el probeo de red no debe bloquear el
    event loop de FastAPI mientras espera los timeouts."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, get_registered_lasers_with_status)


# ── Historial de trabajos láser (persistido) ──

def _load_history() -> List[Dict[str, Any]]:
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _save_history(entries: List[Dict[str, Any]]):
    try:
        with open(HISTORY_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2)
    except OSError:
        pass


def get_laser_history(limit: int = 50) -> List[Dict[str, Any]]:
    """Trabajos láser más recientes primero."""
    entries = _load_history()
    return entries[:limit]


def record_laser_job_history(job: "LaserJob"):
    """Guarda el resultado final de un trabajo (completado, cancelado o con
    error) en el historial persistente, más reciente primero."""
    entries = _load_history()
    entry = {
        "host": job.host,
        "filename": job.filename,
        "source": job.source,
        "state": job.state,
        "current": job.current,
        "total": job.total,
        "error": job.error_message,
        "started_at": job.started_at,
        "completed_at": time.time(),
    }
    entries.insert(0, entry)
    _save_history(entries[:HISTORY_MAX_ENTRIES])


def attach_laser_history_snapshot(host: str, snapshot: str) -> bool:
    """Adjunta la captura del grill (con la figura trazada) a la entrada más
    reciente del historial para ese host — el navegador la genera y la manda
    justo después de ver que el trabajo terminó."""
    entries = _load_history()
    for entry in entries:
        if entry.get("host") == host:
            entry["snapshot"] = snapshot
            _save_history(entries)
            return True
    return False


def register_laser(
    host: str,
    name: str,
    transport: str,
    work_area_width: Optional[float] = None,
    work_area_height: Optional[float] = None,
    home_corner: Optional[str] = None,
    kind: str = "laser",
    machine_profile: Optional[str] = None,
    firmware: Optional[str] = None,
    verified_grbl: Optional[bool] = None,
) -> Dict[str, Any]:
    entries = [e for e in _load_registry() if e.get("host") != host]
    existing = next((e for e in _load_registry() if e.get("host") == host), None)
    entry = {
        "host": host,
        "name": name,
        "transport": transport,
        "kind": kind or "laser",
        "registered_at": existing.get("registered_at") if existing else time.time(),
    }

    # Ancla estable para hosts USB: la ubicación física del puerto (topología
    # de bus/hub), no la ruta /dev/ttyUSBx que el kernel puede renumerar. Se
    # recalcula en cada alta/edición porque es barato (solo lee sysfs, sin
    # abrir el puerto) y así una placa reconectada en otro puerto físico
    # queda con su ubicación actualizada al re-registrarla a mano.
    if _is_usb_host(host):
        entry["location"] = _location_for_device(_usb_device(host))
        # No resetear a False si esta llamada no vino acompañada de un
        # handshake (ej. solo se está renombrando la placa) — mismo criterio
        # que machine_profile/firmware más abajo.
        entry["verified_grbl"] = verified_grbl if verified_grbl is not None else (
            existing.get("verified_grbl") if existing else False
        )
    if work_area_width is not None and work_area_height is not None:
        entry["work_area"] = {"width": work_area_width, "height": work_area_height}
    if home_corner:
        entry["home_corner"] = home_corner

    # machine_profile ("router"/"plotter") NO se resetea a un default cuando
    # no viene explícito: el flujo de renombrar reenvía el registro entero en
    # cada edición (nombre, ancho, alto...), y si acá cayera a "router" por
    # defecto, renombrar un dispositivo "plotter" lo reclasificaría solo con
    # cada guardado. Solo se pisa cuando alguien lo manda a propósito.
    if machine_profile not in ("router", "plotter"):
        machine_profile = None
    entry["machine_profile"] = machine_profile or (existing.get("machine_profile") if existing else None) or "router"

    # Mismo criterio que machine_profile: no resetear a "fluidnc" en cada
    # edición si no viene explícito. Entradas viejas sin este campo (de antes
    # de que existiera) se tratan como "fluidnc" — el único firmware que
    # NOPAL soportaba hasta ahora.
    if firmware not in ("fluidnc", "marlin"):
        firmware = None
    entry["firmware"] = firmware or (existing.get("firmware") if existing else None) or "fluidnc"

    entries.append(entry)
    _save_registry(entries)
    logger.info(f"Dispositivo registrado: {host} ({name}, {entry['kind']}, perfil={entry['machine_profile']}, firmware={entry['firmware']})")
    return entry


def _firmware_for_host(host: str) -> str:
    entry = next((e for e in _load_registry() if e.get("host") == host), None)
    return (entry or {}).get("firmware") or "fluidnc"


def get_host_firmware(host: str) -> str:
    """Firmware registrado para `host` ('fluidnc' por defecto para hosts sin
    registrar o entradas viejas) — expuesta para anotar respuestas de la API
    sin depender de un símbolo privado."""
    return _firmware_for_host(host)


def unregister_laser(host: str) -> bool:
    entries = _load_registry()
    filtered = [e for e in entries if e.get("host") != host]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        logger.info(f"Dispositivo eliminado: {host}")
    return changed


# ── Descubrimiento por red (ESP3D) ──

def _get_local_subnet() -> str:
    """Detecta el prefijo /24 de la red local del servidor (ej. '192.168.0')."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            local_ip = sock.getsockname()[0]
        return ".".join(local_ip.split(".")[:3])
    except Exception:
        return ".".join(DEFAULT_LASER_HOST.split(".")[:3])


def _parse_esp420_response(text: str) -> Dict[str, str]:
    """Parsea la respuesta del comando [ESP420]. Tanto ESP3D como FluidNC (que
    trae integrada la misma WebUI de ESP3D) devuelven texto plano "clave:
    valor" por línea sobre HTTP — confirmado probando en vivo contra una
    placa FluidNC real, aunque por USB/serie FluidNC sí responde JSON
    ({"data": [{"id": "...", "value": "..."}]}), por eso se intenta primero."""
    try:
        payload = json.loads(text)
        data = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(data, list):
            return {
                str(item.get("id", "")).strip(): str(item.get("value", "")).strip()
                for item in data
                if isinstance(item, dict) and item.get("id")
            }
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass

    info: Dict[str, str] = {}
    for line in text.splitlines():
        # Las líneas "[MSG:...]" son avisos informativos de FluidNC, no un
        # campo real "clave: valor" — se descartan para no mostrar basura.
        if line.startswith("[") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        info[key.strip()] = value.strip()
    return info


def _probe_host(ip: str, timeout: float) -> Optional[Dict[str, Any]]:
    """Prueba si `ip` responde como una placa ESP3D o FluidNC (comando [ESP420]).
    ESP3D siempre trae "Hostname" en la respuesta; FluidNC no lo expone pero sí
    "Chip ID"/"FW version" — se acepta si aparece cualquiera de los tres como
    campo real ya parseado (no una búsqueda de texto suelta), para no aceptar
    por error una página HTML cualquiera que solo mencione esas palabras."""
    try:
        response = requests.get(
            f"http://{ip}/command",
            params={"commandText": "[ESP420]"},
            timeout=timeout,
        )
        if response.status_code != 200:
            return None

        info = _parse_esp420_response(response.text)
        if not (info.get("Hostname") or info.get("Chip ID") or info.get("FW version") or info.get("Firmware")):
            return None

        return {
            "host": ip,
            "hostname": info.get("Hostname", ""),
            "firmware": info.get("Firmware") or info.get("FW version", ""),
        }
    except requests.exceptions.RequestException as e:
        # DEBUG y no WARNING: un escaneo de red sondea hasta 254 IPs y que la
        # mayoría no responda es el caso normal, no un problema real.
        logger.debug(f"Sondeo de {ip} sin respuesta: {e}")
        return None


def _scan_network_sync(timeout: float = 0.4, max_workers: int = 60) -> List[Dict[str, Any]]:
    subnet = _get_local_subnet()
    candidates = [f"{subnet}.{i}" for i in range(1, 255)]
    found: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for result in executor.map(lambda ip: _probe_host(ip, timeout), candidates):
            if result:
                found.append(result)
    return found


async def scan_network() -> List[Dict[str, Any]]:
    """Escanea la red local (en un hilo aparte) buscando placas ESP3D/GRBL."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _scan_network_sync)


async def probe_single_host(ip: str, timeout: float = 1.5) -> Optional[Dict[str, Any]]:
    """Prueba una IP puntual (búsqueda manual), sin barrer toda la subred —
    útil para placas fuera del rango detectado automáticamente, o que están
    en modo Punto de Acceso propio (p.ej. FluidNC recién flasheado arranca
    como AP con IP fija 192.168.0.1 hasta configurarle una red WiFi)."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _probe_host(ip, timeout))


# ── Detección de placas por USB ──
# Chips USB-serial típicos de controladoras GRBL/ESP32 (Sculpfun, DLC32, etc.)
KNOWN_USB_CHIPS = [
    {"vid": 0x1A86, "pid": 0x7523, "label": "CH340"},
    {"vid": 0x1A86, "pid": 0x5523, "label": "CH340K"},
    {"vid": 0x10C4, "pid": 0xEA60, "label": "CP2102/CP2109"},
    {"vid": 0x303A, "pid": None, "label": "ESP32 (USB nativo)"},
]


def _resolve_usb_location(location: str) -> Optional[str]:
    """Dada una ubicación física de puerto USB (topología de bus/hub/puerto,
    ej. '6-2' — estable mientras no se cambie el cable de puerto), devuelve
    el /dev/ttyUSBx que ocupa esa ubicación ahora mismo, o None si no hay
    nada conectado ahí. Escaneo SIN el filtro de chips conocidos ni la
    exclusión de reclamados de list_usb_laser_ports(): una placa ya
    registrada está, por definición, excluida de esa lista, así que no sirve
    para resolver la ubicación de algo que ya está dado de alta."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    for port in list_ports.comports():
        if port.location and port.location == location:
            return port.device
    return None


def _location_for_device(device: str) -> Optional[str]:
    """Inversa de _resolve_usb_location: dado un /dev/ttyUSBx, la ubicación
    física del puerto donde está conectado ahora, si sigue conectado."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    for port in list_ports.comports():
        if port.device == device:
            return port.location
    return None


def _probe_grbl_sync(device: str, baud: int = 115200, timeout: float = 2.5) -> bool:
    """Handshake liviano y autocontenido: abre el puerto, manda '?' y confirma
    que responde con una línea de estado GRBL. A propósito NO usa
    ensure_listener/_serial_connections (la conexión persistente compartida
    por host) — este probe se dispara también durante la reconciliación
    periódica para placas que todavía no se sabe si corresponde adoptar, y
    adoptar until confirmado dejaría hilos/puertos abiertos colgados si el
    resultado termina siendo negativo. Abre y cierra su propia conexión."""
    try:
        import serial
    except ImportError:
        return False
    try:
        ser = serial.Serial(device, baud, timeout=0.5)
    except Exception:
        return False
    try:
        # Mismo margen que _serial_reader_loop: CH340 resetea la placa al
        # abrir el puerto (toggle de DTR) — mandar el '?' de inmediato puede
        # perderse mientras la placa sigue arrancando.
        time.sleep(2)
        try:
            ser.reset_input_buffer()
            ser.write(b"?")
        except Exception:
            return False
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            try:
                raw = ser.readline()
            except Exception:
                return False
            if not raw:
                continue
            text = raw.decode("utf-8", errors="ignore").strip()
            if _parse_grbl_status_line(text):
                return True
        return False
    finally:
        try:
            ser.close()
        except Exception:
            pass


async def probe_grbl(device: str, timeout: float = 2.5) -> bool:
    """Versión async de _probe_grbl_sync (en un hilo aparte, no debe bloquear
    el event loop mientras espera el margen de arranque + timeout)."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _probe_grbl_sync, device, 115200, timeout)


def list_usb_laser_ports() -> List[Dict[str, Any]]:
    """Lista los puertos serie USB conectados que coinciden con chips
    típicos de controladoras láser (CH340, CP2102, ESP32), excluyendo los
    puertos que ya están configurados como MCU de alguna impresora Klipper
    local, ya registrados como impresora Marlin en NOPAL, o ya registrados
    como láser/CNC (mismo criterio simétrico que list_usb_marlin_ports
    aplica del lado de láser, para que un mismo puerto físico no se ofrezca
    como candidato "nuevo" en las listas de alta ni siga disparando el
    aviso de "controladora detectada" para algo que ya está dado de alta)."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return []

    try:
        from backend.services.klipper_service import get_claimed_serial_devices
        claimed = set(get_claimed_serial_devices())
    except Exception:
        claimed = set()

    try:
        from backend.services.marlin_printer_service import get_registered_printers
        marlin_entries = get_registered_printers()
    except Exception:
        marlin_entries = []
    claimed_marlin_locations = {e["location"] for e in marlin_entries if e.get("location")}
    claimed_marlin_devices = {e["device"] for e in marlin_entries if not e.get("location") and e.get("device")}

    claimed_laser_devices = {
        entry["host"][4:] for entry in _load_registry()
        if entry.get("transport") == "usb" and str(entry.get("host", "")).startswith("usb:")
    }

    results = []
    for port in list_ports.comports():
        if port.vid is None:
            continue

        chip_label = None
        for chip in KNOWN_USB_CHIPS:
            if chip["vid"] == port.vid and (chip["pid"] is None or chip["pid"] == port.pid):
                chip_label = chip["label"]
                break

        if not chip_label:
            continue

        if claimed and os.path.realpath(port.device) in claimed:
            continue

        if port.location and port.location in claimed_marlin_locations:
            continue
        if port.device in claimed_marlin_devices:
            continue
        if port.device in claimed_laser_devices:
            continue

        vid_pid = f"{port.vid:04X}:{port.pid:04X}" if port.pid is not None else f"{port.vid:04X}"
        results.append({
            "device": port.device,
            "description": port.description or "",
            "manufacturer": port.manufacturer or "",
            "chip": chip_label,
            "vid_pid": vid_pid,
            "location": port.location,
        })

    return results


def _command_url(host: str) -> str:
    return f"http://{host}/command"


REALTIME_SERIAL_COMMANDS = {"?", "!", "~", "\x18"} | {chr(b) for b in range(0x90, 0x9F)}


def _is_conflicted(host: str) -> bool:
    entry = next((e for e in _load_registry() if e.get("host") == host), None)
    return bool((entry or {}).get("conflict"))


def _send_serial_command(host: str, command: str) -> bool:
    if _is_conflicted(host):
        # La reconciliación (_reconcile_usb_entries) no pudo confirmar que
        # ahí sigue la misma placa que se registró — no se le manda nada
        # hasta que el usuario re-vincule a mano desde Configuración.
        logger.warning(f"[{host}] Comando bloqueado: dispositivo en conflicto, requiere re-vincular")
        return False
    ser = _serial_connections.get(host)
    if ser is None:
        ensure_listener(host)
        ser = _serial_connections.get(host)
        if ser is None:
            return False
    try:
        # Los bytes realtime (sin '\n') son un protocolo exclusivo de GRBL —
        # Marlin no tiene equivalente, todo comando ahí lleva salto de línea.
        is_realtime = command in REALTIME_SERIAL_COMMANDS and _firmware_for_host(host) == "fluidnc"
        payload = command if is_realtime else command + "\n"
        ser.write(payload.encode("utf-8"))
        logger.debug(f"[{host}] TX (serie): {command!r}")
        return True
    except Exception as e:
        logger.warning(f"[{host}] Fallo al escribir por serie '{command!r}': {e}")
        return False


def send_raw_command(host: str, command: str) -> bool:
    """Envía un comando GRBL. Por red vía HTTP (ESP3D no responde el resultado en
    el cuerpo, la respuesta real llega por websocket); por USB, escribiendo
    directo al puerto serie."""
    if _is_usb_host(host):
        return _send_serial_command(host, command)
    try:
        response = requests.get(
            _command_url(host),
            params={"commandText": command},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        # DEBUG porque '?' se manda varias veces por segundo entre todos los
        # dispositivos activos — sería puro ruido a INFO.
        logger.debug(f"[{host}] TX: {command!r}")
        return True
    except requests.exceptions.RequestException as e:
        logger.warning(f"[{host}] Fallo al enviar '{command!r}': {e}")
        return False


def _parse_grbl_status_line(line: str) -> Optional[Dict[str, Any]]:
    """Parsea una línea de status de GRBL/FluidNC, ej:
    '<Idle|MPos:-994.500,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>'
    Los campos opcionales (WCO/Pn/Bf/Ov/WCS) no siempre vienen, y el orden
    varía entre firmwares — confirmado en vivo que en FluidNC aparecen
    DESPUÉS de FS, no antes como asumía el regex original (que por eso
    nunca los llegó a capturar). Se parsea genérico por segmentos "clave:valor"
    en vez de una posición fija, para no depender del orden."""
    match = STATUS_RE.search(line)
    if not match:
        return None

    fields: Dict[str, str] = {}
    for segment in match.group("fields").split("|"):
        key, _, value = segment.partition(":")
        if key:
            fields[key] = value

    mpos = fields.get("MPos", "").split(",")
    if len(mpos) < 3:
        return None
    try:
        x, y, z = (float(p) for p in mpos[:3])
    except ValueError:
        return None

    fs = fields.get("FS", "0,0").split(",")
    try:
        feed = float(fs[0]) if fs and fs[0] else 0.0
        speed = float(fs[1]) if len(fs) > 1 and fs[1] else 0.0
    except ValueError:
        feed = speed = 0.0

    result: Dict[str, Any] = {
        "state": match.group("state"),
        "x": x,
        "y": y,
        "z": z,
        "feed": feed,
        "speed": speed,
    }

    if "WCO" in fields:
        parts = fields["WCO"].split(",")
        if len(parts) >= 3:
            try:
                result["wco"] = {"x": float(parts[0]), "y": float(parts[1]), "z": float(parts[2])}
            except ValueError:
                pass

    if "Pn" in fields:
        # Solo trae las letras de los pines ACTIVOS (ej. "XD" = límite X + puerta).
        # Ausencia de una letra = ese pin no está activo, no "desconocido".
        result["pins"] = fields["Pn"]

    if "Bf" in fields:
        parts = fields["Bf"].split(",")
        if len(parts) >= 2:
            try:
                result["buffer"] = {"planner": int(parts[0]), "rx": int(parts[1])}
            except ValueError:
                pass

    if "Ov" in fields:
        parts = fields["Ov"].split(",")
        if len(parts) >= 3:
            try:
                result["overrides"] = {"feed": int(parts[0]), "rapid": int(parts[1]), "spindle": int(parts[2])}
            except ValueError:
                pass

    if "WCS" in fields:
        result["wcs"] = fields["WCS"]

    if "A" in fields:
        # Estado de accesorios de GRBL: S/C = spindle CW/CCW (láser encendido
        # vía M3/M4), F/M = flood/mist (M8/M9 / M7). GRBL no tiene un comando
        # dedicado para "aire" — en la gran mayoría de estos láseres la bomba
        # de asistencia de aire está cableada al relé de flood (M8), así que
        # "flood" es en la práctica el aire asistido, aunque el nombre viene
        # del protocolo de GRBL, no es una lectura directa de "aire".
        accessory = fields["A"]
        result["accessories"] = {
            "spindle_cw": "S" in accessory,
            "spindle_ccw": "C" in accessory,
            "flood": "F" in accessory,
            "mist": "M" in accessory,
        }

    return result


def get_board_info(host: str = DEFAULT_LASER_HOST) -> Dict[str, Any]:
    """Info de la placa: por red, comando [ESP420] (chip, firmware, red...);
    por USB, los datos del descriptor serie (chip, VID:PID, descripción)."""
    if _is_usb_host(host):
        device = _usb_device(host)
        for port in list_usb_laser_ports():
            if port["device"] == device:
                return {
                    "Device": port["device"],
                    "Chip": port["chip"],
                    "Description": port["description"],
                    "VID:PID": port["vid_pid"],
                }
        return {"Device": device}

    try:
        response = requests.get(
            _command_url(host),
            params={"commandText": "[ESP420]"},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        text = response.text
    except requests.exceptions.RequestException:
        return {}

    return _parse_esp420_response(text)


# ── Tarjeta SD (ESP3D, solo placas de red) ──
#
# El endpoint real de ESP3D para la SD (descubierto inspeccionando su propio
# WebUI) es `/upload`, no `/files` (ese solo sirve la memoria interna SPIFFS
# y en esta placa siempre reporta vacío). `/upload?path=X` (GET) lista, y con
# `action=delete|deletedir|createdir&filename=Y` administra archivos/carpetas.
# La subida real es POST multipart con un campo `path`, un campo
# `<path><nombre>S` con el tamaño en bytes, y el archivo en `myfile[]`.

SD_HTTP_TIMEOUT = 30


def _normalize_sd_path(path: str) -> str:
    path = path or "/"
    if not path.startswith("/"):
        path = "/" + path
    if not path.endswith("/"):
        path += "/"
    return path


def sd_list_files(host: str, path: str = "/") -> Dict[str, Any]:
    if _is_usb_host(host):
        return {"status": "error", "message": "La tarjeta SD solo está disponible en placas de red (ESP3D)", "files": [], "path": path}
    try:
        response = requests.get(
            f"http://{host}/upload",
            params={"path": _normalize_sd_path(path)},
            timeout=SD_HTTP_TIMEOUT,
        )
        response.raise_for_status()
        return response.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"status": "error", "message": str(e), "files": [], "path": path}


def sd_create_folder(host: str, path: str, name: str) -> bool:
    try:
        response = requests.get(
            f"http://{host}/upload",
            params={"path": _normalize_sd_path(path), "action": "createdir", "filename": name},
            timeout=HTTP_TIMEOUT,
        )
        return response.ok
    except requests.exceptions.RequestException as e:
        logger.warning(f"[{host}] Operación SD (crear carpeta) falló: {e}")
        return False


def sd_delete_entry(host: str, path: str, name: str, is_dir: bool) -> bool:
    action = "deletedir" if is_dir else "delete"
    try:
        response = requests.get(
            f"http://{host}/upload",
            params={"path": _normalize_sd_path(path), "action": action, "filename": name},
            timeout=HTTP_TIMEOUT,
        )
        return response.ok
    except requests.exceptions.RequestException as e:
        logger.warning(f"[{host}] Operación SD (borrar) falló: {e}")
        return False


def sd_upload_file(host: str, path: str, filename: str, file_bytes: bytes) -> bool:
    norm_path = _normalize_sd_path(path)
    full_name = f"{norm_path}{filename}"
    size_field = f"{full_name}S"
    try:
        response = requests.post(
            f"http://{host}/upload",
            data={"path": norm_path, size_field: str(len(file_bytes))},
            files={"myfile[]": (full_name, file_bytes)},
            timeout=120,
        )
        return response.ok
    except requests.exceptions.RequestException as e:
        logger.warning(f"[{host}] Operación SD (subir {filename}) falló: {e}")
        return False


# ── Conexión (websocket o serie) única y compartida por host ──
#
# La placa (ESP32 con ESP3D) solo soporta UN cliente websocket a la vez: abrir
# varias conexiones concurrentes hace que deje de responder por completo
# (se comprobó en vivo). Por eso aquí se mantiene una sola conexión persistente
# de fondo por host (websocket para red, hilo de lectura para USB), y todo lo
# demás (status, consola, ajustes, trabajos) se suscribe a esa transmisión en
# vez de abrir su propia conexión.

_console_buffers: Dict[str, deque] = {}
_subscribers: Dict[str, List[asyncio.Queue]] = {}
_listener_ready_events: Dict[str, asyncio.Event] = {}

_listener_tasks: Dict[str, asyncio.Task] = {}  # red (websocket)

_serial_connections: Dict[str, Any] = {}  # usb (serial.Serial), keyed por host "usb:/dev/..."
_serial_reader_threads: Dict[str, threading.Thread] = {}
_serial_stop_flags: Dict[str, threading.Event] = {}

_main_loop: Optional[asyncio.AbstractEventLoop] = None


def set_main_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Guarda una referencia al loop principal de FastAPI/uvicorn.

    _ensure_serial_listener() se dispara desde un hilo de ThreadPoolExecutor
    (via run_in_executor), donde asyncio.get_event_loop() ya no funciona en
    Python 3.13 ('no hay event loop en este hilo'). El hilo lector de serie
    necesita ese loop para reenviar datos de forma segura con
    call_soon_threadsafe, así que lo capturamos una vez al arrancar la app.
    """
    global _main_loop
    _main_loop = loop


_ws_was_connected: Dict[str, bool] = {}


def _is_status_noise(host: str, text: str) -> bool:
    """Filtra del buffer de consola visible las líneas que son solo
    telemetría para los widgets, no mensajes reales de consola: los reportes
    push de GRBL ('<...>') o, en Marlin (que no empuja nada), las respuestas
    del polling de posición/temperatura (M114/M105) que igual llegan varias
    veces por segundo mientras se muestra el estado en vivo."""
    if _firmware_for_host(host) == "marlin":
        return bool(marlin_driver.POSITION_RE.search(text) or marlin_driver.TEMP_RE.search(text))
    return bool(STATUS_RE.search(text))


async def _ws_listener_loop(host: str):
    # ESP3D clásico sirve su websocket en un puerto propio (81); FluidNC (que
    # reutiliza la WebUI de ESP3D) no abre ese puerto — su websocket vive en
    # el mismo puerto que el HTTP normal, en la ruta raíz. Confirmado en vivo
    # contra una placa FluidNC real: por ahí sí llega el volcado de "$$" y el
    # status en tiempo real, exactamente igual que por el puerto 81 en ESP3D.
    candidate_uris = [f"ws://{host}:{WS_PORT}", f"ws://{host}/"]
    buffer = _console_buffers.setdefault(host, deque(maxlen=300))
    ready_event = _listener_ready_events.setdefault(host, asyncio.Event())
    while True:
        if _ws_was_connected.get(host):
            # Si llegamos acá con el flag en True es porque la conexión que
            # estaba activa recién se cayó — se loguea UNA vez la transición,
            # no en cada reintento de 3s mientras sigue caído (mismo error
            # de "machacar" que se acaba de arreglar en el polling del
            # dashboard, esta vez aplicado al log en vez de a la red).
            logger.warning(f"[{host}] WS desconectado, reintentando...")
            _ws_was_connected[host] = False
        for uri in candidate_uris:
            try:
                async with websockets.connect(
                    uri,
                    open_timeout=HTTP_TIMEOUT,
                    # ESP3D/FluidNC no siempre responde a los pings del
                    # protocolo WebSocket. El keepalive predeterminado de
                    # websockets (20 s) cerraba conexiones sanas en bucle.
                    ping_interval=None,
                    # Varias implementaciones embebidas tampoco negocian
                    # correctamente permessage-deflate.
                    compression=None,
                ) as ws:
                    ready_event.set()
                    logger.info(f"[{host}] WS conectado ({uri})")
                    _ws_was_connected[host] = True
                    async for message in ws:
                        if isinstance(message, bytes):
                            message = message.decode("utf-8", errors="ignore")
                        # Un solo frame puede traer varias líneas separadas por \r\n
                        # (por ejemplo, el volcado completo de "$$").
                        for line in message.splitlines():
                            text = line.strip()
                            if not text:
                                continue
                            # Mismo criterio que en el lector serie: los
                            # reportes de status alimentan widgets, no la
                            # consola visible (ver comentario en
                            # _serial_reader_loop).
                            if not _is_status_noise(host, text):
                                buffer.append({"message": text, "time": time.time()})
                            for queue in list(_subscribers.get(host, [])):
                                queue.put_nowait(text)
                break  # el candidato conectó (aunque se haya caído después); no probar el siguiente
            except Exception as e:
                logger.debug(f"[{host}] WS candidato {uri} falló: {e}")
                continue
        ready_event.clear()
        await asyncio.sleep(3)


def _ensure_ws_listener(host: str):
    task = _listener_tasks.get(host)
    if task is None or task.done():
        _listener_ready_events.setdefault(host, asyncio.Event()).clear()
        _subscribers.setdefault(host, [])
        _listener_tasks[host] = asyncio.create_task(_ws_listener_loop(host))


_serial_open_failed_logged: Dict[str, bool] = {}


def _serial_reader_loop(host: str, device: str, baud: int, loop: asyncio.AbstractEventLoop):
    import serial

    buffer = _console_buffers.setdefault(host, deque(maxlen=300))
    stop_flag = _serial_stop_flags[host]

    try:
        ser = serial.Serial(device, baud, timeout=0.5)
        _serial_connections[host] = ser
        logger.info(f"[{host}] Puerto serie {device} abierto")
        _serial_open_failed_logged[host] = False
    except Exception as e:
        # Se llama a ensure_listener() en cada poll de estado de un
        # dispositivo registrado — si el puerto USB no está conectado, cada
        # intento genera un hilo nuevo que falla al abrir y muere al toque,
        # así que sin este flag el mismo WARNING se repetiría en cada ciclo
        # de poll (mismo criterio ya aplicado al listener WS).
        if not _serial_open_failed_logged.get(host):
            logger.warning(f"[{host}] No se pudo abrir {device}: {e}")
            _serial_open_failed_logged[host] = True
        return

    # La mayoría de los adaptadores USB-serie (incluido CH340) reinician la
    # placa al abrir el puerto (toggle de DTR). Si el primer comando se manda
    # de inmediato, la placa puede seguir arrancando y la respuesta se pierde
    # — dando un falso "no responde" en el test de detección. Le damos margen
    # antes de avisar que el listener ya está listo para recibir comandos.
    time.sleep(2)

    loop.call_soon_threadsafe(_listener_ready_events.setdefault(host, asyncio.Event()).set)

    while not stop_flag.is_set():
        try:
            raw = ser.readline()
        except Exception as e:
            logger.debug(f"[{host}] Puerto serie cerrado/desconectado: {e}")
            break
        if not raw:
            continue
        text = raw.decode("utf-8", errors="ignore").strip()
        if not text:
            continue
        # Los reportes de status ("<Run|MPos:...|FS:...>") llegan varias
        # veces por segundo mientras algo los pida (polling de posición,
        # jog en vivo) — son datos para los widgets (posición/estado/feed/
        # overrides), no mensajes de consola; imprimirlos línea por línea
        # inunda el log visible sin agregar nada legible para el usuario.
        # Igual se reenvían a las colas de correlación (get_status() y
        # afines los esperan ahí), solo no quedan en el buffer visible.
        if not _is_status_noise(host, text):
            buffer.append({"message": text, "time": time.time()})
        for queue in list(_subscribers.get(host, [])):
            loop.call_soon_threadsafe(queue.put_nowait, text)

    try:
        ser.close()
    except Exception:
        pass
    _serial_connections.pop(host, None)


def _ensure_serial_listener(host: str, baud: int = 115200):
    thread = _serial_reader_threads.get(host)
    if thread is not None and thread.is_alive():
        return
    _listener_ready_events.setdefault(host, asyncio.Event()).clear()
    _subscribers.setdefault(host, [])
    _serial_stop_flags[host] = threading.Event()
    loop = _main_loop
    if loop is None:
        # Fallback por si se llama fuera de una app FastAPI ya arrancada
        # (p. ej. en un script suelto): intenta el loop del hilo actual.
        loop = asyncio.get_event_loop()
    device = _usb_device(host)
    thread = threading.Thread(
        target=_serial_reader_loop,
        args=(host, device, baud, loop),
        daemon=True,
    )
    _serial_reader_threads[host] = thread
    thread.start()


def ensure_listener(host: str = DEFAULT_LASER_HOST):
    """Garantiza que exista una única conexión persistente hacia `host`
    (websocket para placas de red, hilo de lectura serie para USB)."""
    if _is_usb_host(host):
        _ensure_serial_listener(host)
    else:
        _ensure_ws_listener(host)


async def ensure_listener_ready(host: str = DEFAULT_LASER_HOST, timeout: float = 5.0):
    """Como `ensure_listener`, pero espera a que la conexión esté realmente
    establecida antes de continuar (evita perder las primeras líneas de la
    respuesta a un comando enviado justo después)."""
    ensure_listener(host)
    event = _listener_ready_events.get(host)
    if event is None:
        return
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass


def _subscribe(host: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(host, []).append(queue)
    return queue


def _unsubscribe(host: str, queue: asyncio.Queue):
    subs = _subscribers.get(host)
    if subs and queue in subs:
        subs.remove(queue)


def _marlin_transport_for(host: str) -> marlin_driver.MarlinTransport:
    """Envuelve la conexión ya existente (websocket o serie, compartida por
    host) en la interfaz mínima que marlin_driver necesita — reutiliza el
    mismo gestor de conexión que ya usa el protocolo GRBL, sin duplicarlo."""
    return marlin_driver.MarlinTransport(
        send=lambda command: send_raw_command(host, command),
        ensure_ready=lambda: ensure_listener_ready(host),
        subscribe=lambda: _subscribe(host),
        unsubscribe=lambda queue: _unsubscribe(host, queue),
    )


def get_console_buffer(host: str = DEFAULT_LASER_HOST, count: int = 100) -> List[Dict[str, Any]]:
    messages = list(_console_buffers.get(host, []))
    return messages[-count:]


async def send_console_command(host: str, command: str) -> bool:
    await ensure_listener_ready(host)
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, send_raw_command, host, command)


async def get_status(host: str = DEFAULT_LASER_HOST, timeout: float = 3.0) -> Optional[Dict[str, Any]]:
    if _firmware_for_host(host) == "marlin":
        return await _get_marlin_status(host, timeout)
    return await _get_grbl_status(host, timeout)


async def _get_grbl_status(host: str, timeout: float) -> Optional[Dict[str, Any]]:
    """Dispara '?' y espera la línea de estado de GRBL en la transmisión compartida."""
    await ensure_listener_ready(host)
    queue = _subscribe(host)
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, send_raw_command, host, "?")
        if not sent:
            return None
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            remaining = max(end_time - time.monotonic(), 0.1)
            try:
                text = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            parsed = _parse_grbl_status_line(text)
            if parsed:
                return parsed
    finally:
        _unsubscribe(host, queue)
    return None


async def _get_marlin_status(host: str, timeout: float) -> Optional[Dict[str, Any]]:
    """Sin reportes push: arma el mismo shape de get_status a partir de
    M114 (posición) + M105 (temperaturas), y sintetiza el estado desde el
    job propio (Marlin no tiene una máquina de estados como GRBL)."""
    transport = _marlin_transport_for(host)
    position = await marlin_driver.get_position(transport, timeout=timeout)
    if position is None:
        return None

    job = _jobs.get(host)
    if job and job.state == "running":
        state = "Run"
    elif job and job.state == "paused":
        state = "Hold"
    else:
        state = "Idle"

    result: Dict[str, Any] = {
        "state": state,
        "x": position["x"],
        "y": position["y"],
        "z": position["z"],
        "feed": None,
        "speed": None,
    }
    temps = await marlin_driver.get_temperatures(transport, timeout=timeout)
    if temps:
        result.update(temps)
    return result


GCODE_PARSER_STATE_RE = re.compile(r"\[GC:(?P<words>[^\]]*)\]")
WORK_COORDINATE_SYSTEMS = {"G54", "G55", "G56", "G57", "G58", "G59"}


async def get_parser_state(host: str = DEFAULT_LASER_HOST, timeout: float = 3.0) -> Optional[Dict[str, Any]]:
    """Dispara '$G' y espera la línea de estado del parser GRBL, ej.
    '[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]' — de ahí se saca el sistema
    de coordenadas activo (G54/G55/...) para mostrarlo en la ficha CNC.

    Marlin no tiene sistemas de coordenadas de trabajo (G54-G59) ni un
    comando equivalente a '$G' — se devuelve "no soportado" para que el
    frontend oculte el selector de WCS en vez de mostrar un valor inventado."""
    if _firmware_for_host(host) == "marlin":
        return {"wcs": None, "words": [], "supported": False}

    await ensure_listener_ready(host)
    queue = _subscribe(host)
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, send_raw_command, host, "$G")
        if not sent:
            return None
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            remaining = max(end_time - time.monotonic(), 0.1)
            try:
                text = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            match = GCODE_PARSER_STATE_RE.search(text)
            if not match:
                continue
            words = match.group("words").split()
            wcs = next((w for w in words if w in WORK_COORDINATE_SYSTEMS), None)
            return {"wcs": wcs, "words": words}
    finally:
        _unsubscribe(host, queue)
    return None


async def get_grbl_settings(host: str = DEFAULT_LASER_HOST, timeout: float = 5.0) -> List[Dict[str, str]]:
    """Obtiene los parámetros $$ actuales de la placa.

    Marlin no tiene este protocolo (su volcado M503 es texto libre, no pares
    clave=valor) — se devuelve vacío en vez de intentar imitar un formato
    que no existe."""
    if _firmware_for_host(host) == "marlin":
        return []

    await ensure_listener_ready(host)
    queue = _subscribe(host)
    settings: List[Dict[str, str]] = []
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, send_raw_command, host, "$$")
        if not sent:
            return []
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            remaining = max(end_time - time.monotonic(), 0.1)
            try:
                text = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            if text.startswith("$") and "=" in text:
                key, _, value = text.partition("=")
                settings.append({"key": key.strip(), "value": value.strip()})
            elif text.lower() == "ok" and settings:
                break
    finally:
        _unsubscribe(host, queue)
    return settings


async def set_grbl_setting(host: str, key: str, value: str, timeout: float = 4.0) -> Dict[str, Any]:
    """Actualiza un parámetro $$ individual (ej. key='$0', value='10')."""
    if _firmware_for_host(host) == "marlin":
        return {"success": False, "message": "Ajustes no editables en Marlin desde NOPAL"}

    await ensure_listener_ready(host)
    queue = _subscribe(host)
    command = f"{key}={value}"
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, send_raw_command, host, command)
        if not sent:
            return {"success": False, "message": "No se pudo enviar el comando"}
        end_time = time.monotonic() + timeout
        while time.monotonic() < end_time:
            remaining = max(end_time - time.monotonic(), 0.1)
            try:
                text = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            normalized = text.lower()
            if normalized == "ok":
                return {"success": True}
            if normalized.startswith("error"):
                return {"success": False, "message": text}
    finally:
        _unsubscribe(host, queue)
    return {"success": False, "message": "Sin respuesta de la placa"}


async def jog(host: str, axis: str, distance: float, feed: float) -> bool:
    """Mueve un eje en relativo. fluidnc usa el modo de jog en tiempo real de
    GRBL ($J=, no bloqueante); Marlin no tiene modo de jog dedicado, así que
    se arma la secuencia G91/G1/G90 esperando el 'ok' de cada línea."""
    if _firmware_for_host(host) == "marlin":
        transport = _marlin_transport_for(host)
        for line in marlin_driver.build_jog_lines(axis, distance, feed):
            result = await marlin_driver.send_and_await_ok(transport, line)
            if not result["success"]:
                return False
        return True
    command = f"$J=G91 G21 {axis.upper()}{distance:.3f} F{feed}"
    return await asyncio.get_event_loop().run_in_executor(None, send_raw_command, host, command)


async def home(host: str, axes: Optional[str] = None) -> bool:
    """fluidnc usa el ciclo de home de GRBL ($H, siempre todos los ejes);
    Marlin usa G28, que sí acepta ejes puntuales."""
    if _firmware_for_host(host) == "marlin":
        transport = _marlin_transport_for(host)
        result = await marlin_driver.send_and_await_ok(
            transport, marlin_driver.build_home_command(axes), timeout=60.0
        )
        return result["success"]
    return await asyncio.get_event_loop().run_in_executor(None, send_raw_command, host, "$H")


class LaserJob:
    def __init__(self, host: str, lines: List[str], filename: str = "", source: str = "stream"):
        self.host = host
        self.lines = lines
        self.filename = filename
        self.source = source  # "stream" (línea por línea vía WiFi/USB) o "sd" (corre local desde la SD)
        self.total = len([line for line in lines if line.strip() and not line.strip().startswith((";", "("))])
        self.current = 0
        self.state = "running"
        self.error_message: Optional[str] = None
        self.cancel_requested = False
        self.pause_requested = False
        self.started_at = time.time()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filename": self.filename,
            "source": self.source,
            "state": self.state,
            "current": self.current,
            "total": self.total,
            "error": self.error_message,
        }


# Un trabajo activo por placa (host) — así se puede correr un trabajo distinto
# en cada láser/impresora al mismo tiempo, sin que uno bloquee a los demás.
_jobs: Dict[str, LaserJob] = {}


GRBL_RX_BUFFER_SIZE = 120  # margen seguro bajo el buffer serie real de GRBL/grblHAL (128 bytes)


async def _run_job(job: LaserJob):
    """Streaming con protocolo de conteo de caracteres: llena el buffer serie
    de GRBL con varias líneas en vez de esperar el 'ok' de cada una antes de
    enviar la siguiente. Esperar línea por línea vacía el planificador de
    movimiento de GRBL y produce cortes/tirones visibles en el grabado
    (confirmado con Sculpfun por USB); manteniendo el buffer lleno, GRBL
    puede anticipar los siguientes movimientos y el trazo queda fluido."""
    await ensure_listener_ready(job.host)
    queue = _subscribe(job.host)
    loop = asyncio.get_event_loop()

    lines = [
        line.strip() for line in job.lines
        if line.strip() and not line.strip().startswith((";", "("))
    ]
    job.total = len(lines)

    pending_lengths: List[int] = []  # bytes en tránsito por línea enviada, en orden
    buffer_used = 0
    idx = 0

    try:
        while idx < len(lines) or pending_lengths:
            if job.cancel_requested:
                job.state = "cancelled"
                await loop.run_in_executor(None, send_raw_command, job.host, "\x18")
                return

            while job.pause_requested:
                await asyncio.sleep(0.3)
                if job.cancel_requested:
                    job.state = "cancelled"
                    await loop.run_in_executor(None, send_raw_command, job.host, "\x18")
                    return

            # Llena el buffer serie con tantas líneas como entren de una vez.
            while idx < len(lines):
                next_line = lines[idx]
                needed = len(next_line) + 1  # +1 por el salto de línea
                if pending_lengths and buffer_used + needed > GRBL_RX_BUFFER_SIZE:
                    break
                sent = await loop.run_in_executor(None, send_raw_command, job.host, next_line)
                if not sent:
                    job.state = "error"
                    job.error_message = f"No se pudo enviar la línea {job.current + 1}"
                    return
                pending_lengths.append(needed)
                buffer_used += needed
                idx += 1

            if not pending_lengths:
                break

            try:
                text = await asyncio.wait_for(queue.get(), timeout=20)
            except asyncio.TimeoutError:
                job.state = "error"
                job.error_message = f"Sin respuesta del láser en la línea {job.current + 1}"
                return

            normalized = text.lower()
            if normalized == "ok":
                buffer_used -= pending_lengths.pop(0)
                job.current += 1
            elif normalized.startswith("error") or normalized.startswith("alarm"):
                job.state = "error"
                job.error_message = f"{text} (línea {job.current + 1})"
                return
            # otras líneas (reportes de estado, etc.) se ignoran

        job.state = "completed"
    except Exception as e:
        logger.exception(f"[{job.host}] Excepción no controlada en el trabajo")
        job.state = "error"
        job.error_message = str(e)
    finally:
        if job.state == "completed":
            logger.info(f"[{job.host}] Trabajo completado ({job.current}/{job.total} líneas)")
        elif job.state == "error":
            logger.warning(f"[{job.host}] Trabajo terminó con error: {job.error_message}")
        _unsubscribe(job.host, queue)
        record_laser_job_history(job)


async def _run_sd_job(job: LaserJob):
    """Corre un archivo ya subido a la SD directo en la placa ($F=archivo),
    sin transmitir línea por línea. El progreso se seduce del estado GRBL
    (Run -> Idle = terminado; Alarm = error)."""
    sd_filename = job.filename
    sent = await asyncio.get_event_loop().run_in_executor(
        None, send_raw_command, job.host, f"$F={sd_filename}"
    )
    if not sent:
        job.state = "error"
        job.error_message = "No se pudo iniciar el trabajo desde la SD"
        logger.warning(f"[{job.host}] Trabajo (SD) terminó con error: {job.error_message}")
        record_laser_job_history(job)
        return

    await asyncio.sleep(2)  # da tiempo a que la placa deje Idle y entre a Run

    run_seen = False
    waited_for_run = 0.0
    RUN_TIMEOUT = 20  # segundos máximos esperando que la placa arranque el archivo

    try:
        while True:
            if job.cancel_requested:
                await asyncio.get_event_loop().run_in_executor(None, send_raw_command, job.host, "\x18")
                job.state = "cancelled"
                return

            while job.pause_requested:
                await asyncio.sleep(0.5)
                if job.cancel_requested:
                    await asyncio.get_event_loop().run_in_executor(None, send_raw_command, job.host, "\x18")
                    job.state = "cancelled"
                    return

            status = await get_status(job.host, timeout=3)
            if status:
                state_value = (status.get("state") or "").lower()
                if state_value == "alarm":
                    job.state = "error"
                    job.error_message = "La placa reportó una alarma"
                    return
                if state_value == "run":
                    run_seen = True
                elif state_value == "idle":
                    if run_seen:
                        job.state = "completed"
                        return
                    if waited_for_run >= RUN_TIMEOUT:
                        job.state = "error"
                        job.error_message = (
                            "La placa nunca inició el archivo (revisa el nombre/ruta en la SD)"
                        )
                        return

            if not run_seen:
                waited_for_run += 2

            await asyncio.sleep(2)
    except Exception as e:
        logger.exception(f"[{job.host}] Excepción no controlada en el trabajo (SD)")
        job.state = "error"
        job.error_message = str(e)
    finally:
        if job.state == "completed":
            logger.info(f"[{job.host}] Trabajo completado (SD): {job.filename}")
        elif job.state == "error":
            logger.warning(f"[{job.host}] Trabajo (SD) terminó con error: {job.error_message}")
        record_laser_job_history(job)


def start_job(host: str, gcode_text: str, filename: str = "") -> Dict[str, Any]:
    """Inicia streaming línea por línea (WiFi/USB) — para placas sin SD.

    No detecta si ya hay un trabajo EXTERNO en curso (ej. mandado por
    LightBurn directo por Bluetooth) — solo mira _jobs, que nunca se entera
    de esos. Si arranca uno propio encima, los dos streams de G-code se
    intercalan en el mismo parser de GRBL. Bug preexistente, fuera de
    alcance por ahora — ver get_job_status para el lado de solo-lectura."""
    existing = _jobs.get(host)
    if existing is not None and existing.state in ("running", "paused"):
        logger.warning(f"[{host}] No se pudo iniciar '{filename}': ya hay un trabajo en curso")
        raise RuntimeError("Ya hay un trabajo en curso en este láser")

    lines = gcode_text.splitlines()
    job = LaserJob(host, lines, filename, source="stream")
    _jobs[host] = job
    logger.info(f"[{host}] Trabajo iniciado: {filename or '(stream)'} ({len(lines)} líneas)")
    if _firmware_for_host(host) == "marlin":
        asyncio.create_task(_run_marlin_job(job))
    else:
        asyncio.create_task(_run_job(job))
    return job.to_dict()


async def _run_marlin_job(job: "LaserJob"):
    """Envoltorio fino sobre marlin_driver.run_job: agrega el logueo y el
    registro de historial que ya tiene _run_job para GRBL, pero que
    marlin_driver no conoce (no sabe qué es un "historial de láser")."""
    transport = _marlin_transport_for(job.host)
    await marlin_driver.run_job(transport, job)
    if job.state == "completed":
        logger.info(f"[{job.host}] Trabajo completado (Marlin, {job.current}/{job.total} líneas)")
    elif job.state == "error":
        logger.warning(f"[{job.host}] Trabajo (Marlin) terminó con error: {job.error_message}")
    record_laser_job_history(job)


def start_sd_job(host: str, sd_filename: str) -> Dict[str, Any]:
    """Inicia un trabajo ya subido a la SD, corriéndolo localmente en la placa."""
    if _firmware_for_host(host) == "marlin":
        raise RuntimeError("SD nativa no soportada para Marlin en esta versión")

    existing = _jobs.get(host)
    if existing is not None and existing.state in ("running", "paused"):
        logger.warning(f"[{host}] No se pudo iniciar '{sd_filename}' (SD): ya hay un trabajo en curso")
        raise RuntimeError("Ya hay un trabajo en curso en este láser")

    job = LaserJob(host, [], sd_filename, source="sd")
    _jobs[host] = job
    logger.info(f"[{host}] Trabajo iniciado (SD): {sd_filename}")
    asyncio.create_task(_run_sd_job(job))
    return job.to_dict()


def _external_job_state(grbl_state: Optional[str]) -> Optional[str]:
    """Traduce el estado crudo de GRBL a 'running'/'paused' para un trabajo
    que NOPAL no inició (ej. mandado directo por LightBurn vía Bluetooth/USB
    en paralelo) — None si la placa no está corriendo nada."""
    state = (grbl_state or "").lower()
    if state == "run":
        return "running"
    if state in ("hold", "door"):
        return "paused"
    return None


async def get_job_status(host: str) -> Dict[str, Any]:
    """Estado del trabajo — el propio si NOPAL lo inició Y sigue activo, o si
    no, el estado crudo de la placa reinterpretado como un trabajo "externo"
    (LightBurn u otro cliente hablándole por otra vía — Bluetooth, otro
    puerto, etc. — mientras NOPAL solo observa vía su propia conexión). No
    hay forma de saber el nombre de archivo, el G-code o el progreso real de
    un trabajo externo — GRBL no expone esa metadata, así que quedan vacíos
    a propósito, nunca inventados.

    Un job propio en estado terminal (error/completed/cancelled) NO cuenta
    como activo acá — sigue guardado en _jobs solo como último resultado
    conocido, y si no se cae a revisar el estado externo, un trabajo externo
    que arranca después en el mismo host queda invisible detrás del
    resultado viejo (confirmado en vivo: pasó exactamente esto probando)."""
    job = _jobs.get(host)
    if job is not None and job.state in ("running", "paused"):
        return job.to_dict()

    status = await get_status(host, timeout=1.5)
    external_state = _external_job_state(status.get("state") if status else None)
    if external_state is not None:
        return {
            "filename": "",
            "source": "external",
            "state": external_state,
            "current": 0,
            "total": 0,
            "error": None,
        }
    return {"filename": "", "source": "", "state": "idle", "current": 0, "total": 0, "error": None}


def get_active_job_hosts() -> List[Dict[str, Any]]:
    """Hosts con un trabajo propio (iniciado por NOPAL) actualmente en curso
    (running/paused) — solo mira el estado ya en memoria de _jobs, sin volver
    a probar la placa, para que sea barato llamarlo seguido desde el
    frontend. Pensado para no perder de vista un corte mientras se navega a
    otro láser en la interfaz (que antes solo mostraba el estado del host
    seleccionado en pantalla, no el que realmente tiene el trabajo activo).
    No detecta trabajos externos (ej. mandados por LightBurn) — mismo límite
    que el resto de este módulo, ver get_job_status."""
    return [
        {**job.to_dict(), "host": host}
        for host, job in _jobs.items()
        if job.state in ("running", "paused")
    ]


def get_laser_jobs_with_errors() -> List[Dict[str, Any]]:
    """Trabajos propios con estado "error" — para el badge de notificaciones.
    A propósito una función aparte de get_active_job_hosts (que solo mira
    running/paused y ya alimenta la UI de "trabajo activo" en el frontend):
    ensanchar ese filtro para incluir error cambiaría ese comportamiento
    existente sin que venga a cuento acá."""
    return [
        {**job.to_dict(), "host": host}
        for host, job in _jobs.items()
        if job.state == "error"
    ]


async def pause_job(host: str) -> bool:
    job = _jobs.get(host)
    if job and job.state == "running":
        job.pause_requested = True
        job.state = "paused"
        # Marlin no tiene protocolo realtime — el propio loop de
        # marlin_driver.run_job ya deja de mandar líneas al ver
        # pause_requested, sin que haga falta ningún comando.
        if _firmware_for_host(host) == "fluidnc":
            send_raw_command(job.host, "!")
        logger.info(f"[{host}] Trabajo pausado")
        return True
    if job is None or job.state not in ("running", "paused"):
        # Sin trabajo propio activo (no hay job, o quedó uno viejo ya
        # terminado/con error): puede ser un trabajo externo (LightBurn u
        # otro cliente). Revalidar contra la placa antes de mandar '!' a
        # ciegas — el último poll puede estar desactualizado. Concepto
        # solo-GRBL: Marlin no expone ninguna señal para distinguir "alguien
        # más está imprimiendo" de "está inactivo".
        if _firmware_for_host(host) != "fluidnc":
            return False
        status = await get_status(host, timeout=1.5)
        if _external_job_state(status.get("state") if status else None) == "running":
            send_raw_command(host, "!")
            logger.info(f"[{host}] Pausa enviada a un trabajo externo")
            return True
    return False


async def resume_job(host: str) -> bool:
    job = _jobs.get(host)
    if job and job.state == "paused":
        job.pause_requested = False
        job.state = "running"
        if _firmware_for_host(host) == "fluidnc":
            send_raw_command(job.host, "~")
        logger.info(f"[{host}] Trabajo reanudado")
        return True
    if job is None or job.state not in ("running", "paused"):
        if _firmware_for_host(host) != "fluidnc":
            return False
        status = await get_status(host, timeout=1.5)
        if _external_job_state(status.get("state") if status else None) == "paused":
            send_raw_command(host, "~")
            logger.info(f"[{host}] Reanudación enviada a un trabajo externo")
            return True
    return False


async def cancel_job(host: str) -> bool:
    job = _jobs.get(host)
    if job and job.state in ("running", "paused"):
        job.cancel_requested = True
        job.pause_requested = False
        # Igual que pause: Marlin no manda nada acá, el runner corta el
        # streaming solo al ver cancel_requested. No se manda M112 (parada
        # de emergencia) — demasiado agresivo para lo que "cancelar" significa
        # en el resto de NOPAL.
        logger.info(f"[{host}] Cancelación de trabajo solicitada")
        return True
    if job is None or job.state not in ("running", "paused"):
        # No hay loop propio (_run_job/_run_sd_job) que note un
        # cancel_requested para un trabajo externo, así que acá el reset
        # (\x18) se manda directo en vez de solo marcar una bandera.
        # Solo-GRBL, mismo motivo que en pause_job/resume_job.
        if _firmware_for_host(host) != "fluidnc":
            return False
        status = await get_status(host, timeout=1.5)
        if _external_job_state(status.get("state") if status else None) is not None:
            send_raw_command(host, "\x18")
            logger.warning(
                f"[{host}] Reset enviado a un trabajo externo — quien lo esté "
                "transmitiendo (ej. LightBurn) no se entera y va a seguir "
                "pensando que el trabajo sigue en curso"
            )
            return True
    return False


def has_sd_card(host: str) -> bool:
    """Detecta si `host` tiene una tarjeta SD navegable (solo placas de red/ESP3D)."""
    if _is_usb_host(host):
        return False
    result = sd_list_files(host, "/")
    return result.get("status") == "Ok"


# ── Cola de trabajos ──

_queue_counter = itertools.count(1)
_laser_queue: List[Dict[str, Any]] = []


def add_to_queue(path: str, filename: str, kind: str = "laser") -> Dict[str, Any]:
    entry = {
        "id": next(_queue_counter),
        "path": path,
        "filename": filename,
        "added_at": time.time(),
        # "laser"/"cnc" — a qué ficha de Cola pertenece el archivo. Sin esto
        # la cola era un único pool sin tipo, y tanto la ficha de Láser como
        # la de CNC mostraban exactamente los mismos archivos sin importar
        # a cuál se los mandó el usuario.
        "kind": kind,
    }
    _laser_queue.append(entry)
    return entry


def get_queue() -> List[Dict[str, Any]]:
    return list(_laser_queue)


def remove_from_queue(entry_id: int) -> bool:
    global _laser_queue
    before = len(_laser_queue)
    _laser_queue = [item for item in _laser_queue if item["id"] != entry_id]
    return len(_laser_queue) < before


def pop_from_queue(entry_id: int) -> Optional[Dict[str, Any]]:
    global _laser_queue
    for index, item in enumerate(_laser_queue):
        if item["id"] == entry_id:
            return _laser_queue.pop(index)
    return None
