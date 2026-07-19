"""Impresoras Bambu Lab en modo LAN local (X1C/X1/X1E/P1P/P1S/A1/A1 mini) --
MQTT sobre TLS (puerto 8883, la propia impresora es el broker) para status y
comandos, FTPS implícita (puerto 990) para subir el archivo a imprimir.

No hay SDK oficial de Bambu Lab para modo LAN -- este módulo reimplementa la
parte del protocolo documentada por la comunidad (sin capturas propias contra
hardware real, que no está disponible en este entorno). Los nombres de campo
del JSON de status (nozzle_temper, mc_percent, gcode_state, etc.) y la forma
exacta del comando "project_file" son los aceptados community-wide, pero no
están confirmados contra una impresora física corriendo en este proyecto.
Todo gcode_state no mapeado cae en "unknown" en vez de asumirse (mismo
criterio que _JOB_STATE_MAP en elegoo_service.py).

Diferencia arquitectónica real frente a elegoo_service.py: SDCP (Elegoo) corre
sobre `websockets`, nativamente asyncio, así que un `asyncio.Task` por
impresora alcanza. MQTT vía `paho-mqtt` NO es asyncio -- la librería maneja su
propio hilo de fondo por cliente (`Client.loop_start()`) con reconexión
automática incorporada (`reconnect_delay_set`). En vez de forzarlo a encajar
en el event loop (lo que exigiría un wrapper async artificial alrededor de una
librería pensada para hilos), acá se lo deja manejar su hilo solo: los
callbacks (`on_connect`/`on_message`/`on_disconnect`) corren en ese hilo y
solo escriben en un caché de módulo protegido por `_cache_lock`, un
`threading.Lock` simple (no hace falta nada más fino: el volumen de escritura
es bajo, como mucho un mensaje de status por segundo por impresora).

Cámara (protocolo binario propietario puerto 6000) y AMS (multi-material)
quedan fuera de alcance a propósito -- no se implementan, ver start_print().
"""

import asyncio
import ftplib
import json
import logging
import os
import socket
import ssl
import struct
import threading
import time
from typing import Any, Dict, List, Optional

import paho.mqtt.client as mqtt

from backend.utils import safe_section_path

logger = logging.getLogger(__name__)

MQTT_PORT = 8883
MQTT_USER = "bblp"
FTPS_PORT = 990
CONNECT_TIMEOUT = 5.0
REGISTRY_PATH = "bambu_printer_registry.json"

DISCOVERY_GROUP = "239.255.255.250"
DISCOVERY_PORT = 2021
DISCOVERY_TIMEOUT = 4.0  # más largo que Elegoo/FlashForge: acá no hay probe activo, solo se escucha

_JOB_STATE_MAP = {
    "IDLE": "idle",
    "RUNNING": "printing",
    "PAUSE": "paused",
    "PREPARE": "preparing",
    "SLICING": "preparing",
    "FINISH": "idle",
    "FAILED": "error",
}


# ── Registro de impresoras conocidas (persistido) ──

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


def get_registered_printers() -> List[Dict[str, Any]]:
    return _load_registry()


def _find_entry(serial: str) -> Optional[Dict[str, Any]]:
    return next((e for e in _load_registry() if e.get("serial") == serial), None)


# ── Cliente MQTT persistente (un hilo de paho por impresora) ──

_mqtt_clients: Dict[str, mqtt.Client] = {}
_cache_lock = threading.Lock()
_status_cache: Dict[str, Dict[str, Any]] = {}
_connected: Dict[str, bool] = {}
_last_message_at: Dict[str, float] = {}


def _build_client(serial: str, access_code: str) -> mqtt.Client:
    """userdata=serial permite que los callbacks (compartidos entre todas las
    instancias) sepan a qué impresora corresponden sin closures por cliente."""
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"nopal-{serial}",
        userdata=serial,
        protocol=mqtt.MQTTv311,
    )
    client.username_pw_set(MQTT_USER, access_code)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # certificado self-signed de la impresora, no hay CA que validar
    client.tls_set_context(ctx)
    client.tls_insecure_set(True)
    return client


def _reason_code_ok(reason_code: Any) -> bool:
    if reason_code == 0:
        return True
    return not getattr(reason_code, "is_failure", True)


def _on_connect(client, userdata, flags, reason_code, properties):
    serial = userdata
    ok = _reason_code_ok(reason_code)
    with _cache_lock:
        _connected[serial] = ok
    if ok:
        client.subscribe(f"device/{serial}/report")
        # Pide un dump completo -- si no se pide, la impresora solo empuja
        # deltas parciales y el caché arrancaría incompleto hasta el próximo
        # cambio de cada campo.
        client.publish(f"device/{serial}/request", json.dumps({
            "pushing": {"sequence_id": "0", "command": "pushall"},
        }))
        logger.info(f"[{serial}] MQTT Bambu conectado")
    else:
        logger.warning(f"[{serial}] CONNACK MQTT rechazado (reason_code={reason_code})")


def _on_message(client, userdata, msg):
    serial = userdata
    try:
        payload = json.loads(msg.payload.decode("utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return
    print_fields = payload.get("print")
    if not isinstance(print_fields, dict):
        return
    with _cache_lock:
        # La impresora manda tanto dumps completos (tras el pushall) como
        # deltas parciales con solo los campos que cambiaron -- .update() en
        # vez de reemplazar el dict entero, o se perderían campos que no
        # vienen repetidos en cada mensaje intermedio.
        _status_cache.setdefault(serial, {}).update(print_fields)
        _last_message_at[serial] = time.time()


def _on_disconnect(client, userdata, flags, reason_code, properties):
    serial = userdata
    with _cache_lock:
        _connected[serial] = False
    logger.debug(f"[{serial}] MQTT Bambu desconectado (reason_code={reason_code}); paho reintenta solo")


def _ensure_client(serial: str, ip: str, access_code: str) -> None:
    if serial in _mqtt_clients:
        return
    client = _build_client(serial, access_code)
    client.on_connect = _on_connect
    client.on_message = _on_message
    client.on_disconnect = _on_disconnect
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    _mqtt_clients[serial] = client
    try:
        # No bloquea -- el socket real se abre en el hilo que arranca loop_start().
        client.connect_async(ip, MQTT_PORT, keepalive=30)
        client.loop_start()
    except OSError as e:
        logger.warning(f"[{serial}] No se pudo iniciar la conexión MQTT: {e}")


def _drop_client(serial: str) -> None:
    client = _mqtt_clients.pop(serial, None)
    if client is not None:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass
    with _cache_lock:
        _status_cache.pop(serial, None)
        _connected.pop(serial, None)
        _last_message_at.pop(serial, None)


# ── Validación de access code al registrar (con MQTT real) ──

def _validate_credentials_sync(ip: str, serial: str, access_code: str, timeout: float = CONNECT_TIMEOUT) -> Dict[str, Any]:
    """Abre una conexión MQTT descartable solo para confirmar el access code
    -- no se reusa como listener persistente (ver _ensure_client), para no
    dejar un cliente a medio configurar si la validación falla a mitad de
    camino. `error_code` se fija en el punto exacto donde se conoce la causa
    real (no se adivina después por substring)."""
    done = threading.Event()
    outcome: Dict[str, Any] = {
        "ok": False,
        "error": "Tiempo de espera agotado conectando con la impresora",
        "error_code": "CONNECTION_FAILED",
    }

    def on_connect(client, userdata, flags, reason_code, properties):
        if _reason_code_ok(reason_code):
            outcome["ok"] = True
            outcome["error"] = None
            outcome["error_code"] = None
        else:
            outcome["error"] = f"Access code rechazado (reason_code={reason_code})"
            outcome["error_code"] = "CREDENTIAL_REJECTED"
        done.set()

    def on_disconnect(client, userdata, flags, reason_code, properties):
        # Cubre el caso de que la conexión se caiga antes del CONNACK (IP
        # mala, TLS falla, puerto cerrado, etc.).
        done.set()

    client = _build_client(serial, access_code)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    try:
        client.connect(ip, MQTT_PORT, keepalive=10)
    except (OSError, ssl.SSLError) as e:
        return {"ok": False, "error": f"No se pudo conectar a {ip}:{MQTT_PORT}: {e}", "error_code": "CONNECTION_FAILED"}

    client.loop_start()
    done.wait(timeout)
    client.loop_stop()
    try:
        client.disconnect()
    except Exception:
        pass
    return outcome


async def register_printer(ip: str, serial: str, access_code: str, name: str, model: str = "") -> Dict[str, Any]:
    """A diferencia de FlashForge (sync), acá la validación es async: un
    handshake TLS+MQTT puede tardar varios segundos y no debe bloquear el
    event loop entero para todos los usuarios mientras tanto."""
    loop = asyncio.get_event_loop()
    check = await loop.run_in_executor(None, _validate_credentials_sync, ip, serial, access_code)
    if not check["ok"]:
        return {
            "success": False,
            "error": check["error"] or "No se pudo conectar con la impresora",
            "error_code": check.get("error_code", "UNKNOWN"),
        }

    entries = [e for e in _load_registry() if e.get("serial") != serial]
    entry = {
        "serial": serial,
        "ip": ip,
        "access_code": access_code,
        "name": name,
        "model": model,
        "registered_at": time.time(),
    }
    entries.append(entry)
    _save_registry(entries)
    logger.info(f"Impresora Bambu registrada: {name} ({ip}, {serial})")
    return {"success": True, "printer": entry}


async def test_connection(serial: str) -> Dict[str, Any]:
    """Diagnóstico bajo demanda para una impresora ya registrada -- reusa
    _validate_credentials_sync en vez de reimplementar el handshake."""
    entry = _find_entry(serial)
    if entry is None:
        return {"success": False, "error": "Impresora no encontrada"}

    loop = asyncio.get_event_loop()
    started = time.monotonic()
    check = await loop.run_in_executor(None, _validate_credentials_sync, entry["ip"], serial, entry["access_code"])
    latency_ms = round((time.monotonic() - started) * 1000)
    with _cache_lock:
        last_message_at = _last_message_at.get(serial)
    return {
        "success": check["ok"],
        "error": check.get("error"),
        "latency_ms": latency_ms if check["ok"] else None,
        "mqtt_listener_connected": _connected.get(serial, False),
        "last_communication_at": last_message_at,
    }


def unregister_printer(serial: str) -> bool:
    entries = _load_registry()
    filtered = [e for e in entries if e.get("serial") != serial]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        _drop_client(serial)
        logger.info(f"Impresora Bambu eliminada: {serial}")
    return changed


# ── Descubrimiento (SSDP pasivo -- sin probe activo) ──
#
# A diferencia de Elegoo/FlashForge (mandan un paquete UDP y esperan
# respuesta inmediata), la documentación comunitaria de Bambu no describe
# ningún "search request" que el cliente pueda mandar: el discovery depende
# de capturar un NOTIFY periódico que la propia impresora emite sola por
# multicast. Por eso el timeout es más largo y aun así puede no encontrar una
# impresora si el escaneo cae justo entre dos anuncios -- limitación real,
# no cosmética.

def _parse_ssdp_notify(raw: str, addr_ip: str) -> Optional[Dict[str, Any]]:
    if not raw.startswith("NOTIFY"):
        return None
    headers: Dict[str, str] = {}
    for line in raw.split("\r\n")[1:]:
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        headers[key.strip().upper()] = value.strip()
    usn = headers.get("USN", "")
    serial = usn.split("::", 1)[0].strip() if usn else ""
    if not serial:
        return None
    return {"serial": serial, "ip": headers.get("LOCATION", "") or addr_ip, "name": serial, "model": ""}


def _discover_sync(timeout: float = DISCOVERY_TIMEOUT) -> List[Dict[str, Any]]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    found: Dict[str, Dict[str, Any]] = {}
    try:
        sock.bind(("", DISCOVERY_PORT))
    except OSError as e:
        logger.warning(f"No se pudo escuchar en el puerto de discovery de Bambu ({DISCOVERY_PORT}): {e}")
        return []
    mreq = struct.pack("4sl", socket.inet_aton(DISCOVERY_GROUP), socket.INADDR_ANY)
    try:
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        end_time = time.monotonic() + timeout
        while True:
            remaining = end_time - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                break
            parsed = _parse_ssdp_notify(data.decode("utf-8", errors="ignore"), addr[0])
            if parsed:
                found[parsed["serial"]] = parsed
    finally:
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP, mreq)
        except OSError:
            pass
        sock.close()
    return list(found.values())


async def scan_network(timeout: float = DISCOVERY_TIMEOUT) -> List[Dict[str, Any]]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _discover_sync, timeout)


# ── Comandos (publish no bloqueante, no hace falta executor) ──

def _publish(serial: str, payload: Dict[str, Any]) -> bool:
    client = _mqtt_clients.get(serial)
    if client is None:
        return False
    result = client.publish(f"device/{serial}/request", json.dumps(payload))
    return result.rc == mqtt.MQTT_ERR_SUCCESS


def pause_printer(serial: str) -> bool:
    return _publish(serial, {"print": {"sequence_id": "0", "command": "pause"}})


def resume_printer(serial: str) -> bool:
    return _publish(serial, {"print": {"sequence_id": "0", "command": "resume"}})


def cancel_printer(serial: str) -> bool:
    return _publish(serial, {"print": {"sequence_id": "0", "command": "stop"}})


def start_print(serial: str, filename: str) -> bool:
    """AMS (use_ams) queda forzado a False siempre -- fuera de alcance, ver
    docstring del módulo. bed_leveling=True y las calibraciones en False son
    el comportamiento mínimo "imprimir tal cual", sin pasos extra opcionales.
    param="Metadata/plate_1.gcode" asume que el .3mf tiene un solo plate (el
    primero) -- proyectos multi-plate no se soportan hoy."""
    subtask_name = os.path.splitext(filename)[0]
    payload = {
        "print": {
            "sequence_id": "0",
            "command": "project_file",
            "param": "Metadata/plate_1.gcode",
            "url": f"file:///sdcard/{filename}",
            "subtask_name": subtask_name,
            "bed_leveling": True,
            "flow_cali": False,
            "vibration_cali": False,
            "layer_inspect": False,
            "use_ams": False,
        },
    }
    return _publish(serial, payload)


# ── Subida de archivo (FTPS implícita, puerto 990) ──

class ImplicitFTP_TLS(ftplib.FTP_TLS):
    """ftplib.FTP_TLS de la stdlib solo soporta FTPS EXPLÍCITA (AUTH TLS
    después de conectar en plano vía comando). Bambu Lab usa FTPS IMPLÍCITA
    (TLS desde el handshake inicial, puerto 990) -- patrón conocido en la
    comunidad Python para esto: sobreescribir el setter de `.sock` para
    envolver el socket en TLS apenas se asigna, en vez de esperar a AUTH."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._sock = None

    @property
    def sock(self):
        return self._sock

    @sock.setter
    def sock(self, value):
        if value is not None and not isinstance(value, ssl.SSLSocket):
            value = self.context.wrap_socket(value)
        self._sock = value


def _upload_file_sync(ip: str, access_code: str, abs_path: str) -> Dict[str, Any]:
    filename = os.path.basename(abs_path)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ftp = ImplicitFTP_TLS(context=ctx, timeout=10)
    try:
        ftp.connect(host=ip, port=FTPS_PORT)
        ftp.login(MQTT_USER, access_code)
        ftp.prot_p()  # canal de datos también cifrado -- FTPS implícita lo exige
        with open(abs_path, "rb") as handle:
            ftp.storbinary(f"STOR {filename}", handle)
        ftp.quit()
    except (OSError, ftplib.all_errors) as e:
        logger.warning(f"No se pudo subir {filename} a {ip} por FTPS: {e}")
        return {"success": False, "error": "No se pudo subir el archivo a la impresora"}
    return {"success": True, "filename": filename}


async def send_gcode_to_printer(serial: str, file_path: str, section: str = "model") -> Dict[str, Any]:
    """Sube un archivo de la biblioteca de NOPAL y arranca la impresión --
    dos pasos de protocolo distintos (FTPS + MQTT), a diferencia de
    FlashForge, que lo hace en un solo request HTTP con printNow."""
    entry = _find_entry(serial)
    if entry is None:
        return {"success": False, "error": "Impresora no encontrada"}

    abs_path = safe_section_path(section, file_path)
    if not os.path.isfile(abs_path):
        return {"success": False, "error": "Archivo no encontrado"}
    if not abs_path.lower().endswith(".3mf"):
        # El comando project_file espera un proyecto de Bambu Studio/OrcaSlicer,
        # no gcode plano -- falla rápido en vez de subir algo que después no
        # va a poder arrancar la impresión.
        return {
            "success": False,
            "error": "Las impresoras Bambu Lab solo aceptan archivos .3mf (proyecto de Bambu Studio/OrcaSlicer)",
        }

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _upload_file_sync, entry["ip"], entry["access_code"], abs_path)
    if not result.get("success"):
        return result

    _ensure_client(entry["serial"], entry["ip"], entry["access_code"])
    if not start_print(entry["serial"], result["filename"]):
        return {
            "success": False,
            "error": "Se subió el archivo pero no se pudo iniciar la impresión (¿está la impresora conectada por MQTT?)",
        }
    return result


# ── Normalización y agregación para el dashboard/tarjetas ──

def normalize_bambu_status(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Adapta el status cacheado (empujado por MQTT) al mismo shape que ya
    usan las tarjetas Klipper/Marlin/Elegoo/FlashForge."""
    serial = entry["serial"]
    with _cache_lock:
        status = dict(_status_cache.get(serial, {}))
        online = _connected.get(serial, False)

    raw_state = status.get("gcode_state")
    job_state = _JOB_STATE_MAP.get(raw_state, "unknown" if raw_state else "idle")

    return {
        "id": serial,
        "name": entry.get("name"),
        "model": entry.get("model"),
        "ip": entry.get("ip"),
        "online": online,
        "status": "online" if online else "offline",
        "temps": {
            "extruder": {
                "current": status.get("nozzle_temper"),
                "target": status.get("nozzle_target_temper"),
            },
            "heater_bed": {
                "current": status.get("bed_temper"),
                "target": status.get("bed_target_temper"),
            },
        },
        "job": {
            "state": job_state,
            "filename": status.get("subtask_name") or None,
            "progress": status.get("mc_percent"),
            "current_layer": status.get("layer_num"),
            "total_layer": status.get("total_layer_num"),
        },
    }


def get_registered_printers_with_status() -> List[Dict[str, Any]]:
    entries = _load_registry()
    for entry in entries:
        _ensure_client(entry["serial"], entry["ip"], entry["access_code"])
    return [normalize_bambu_status(entry) for entry in entries]
