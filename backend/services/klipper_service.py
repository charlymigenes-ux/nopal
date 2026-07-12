import json
import logging
import os
import re
import time
import uuid
from datetime import datetime
from typing import Dict, Any, List, Optional
from urllib.parse import quote

import requests

from backend.utils import safe_section_path

SCHEDULE_PATH = "scheduled_prints.json"

logger = logging.getLogger(__name__)


def _derive_printer_name(
    port: int,
    server: Dict[str, Any],
    printer_info: Dict[str, Any],
    mainsail_name: str = None,
) -> str:
    """Obtiene un nombre visible para la impresora a partir de la configuración local."""

    for candidate in (
        mainsail_name,
        server.get("name"),
        server.get("hostname"),
        printer_info.get("name"),
        printer_info.get("hostname"),
    ):
        if candidate and str(candidate).strip().lower() != "klippers":
            return str(candidate).strip()

    config_path = (
        printer_info.get("config_file")
        or server.get("config_file")
        or ""
    )
    match = re.search(r"/printer_(\d+)_data/", config_path)
    if match:
        return f"manchas {match.group(1)}"

    port_names = {
        7125: "manchas 1",
        7126: "manchas 2",
        7127: "manchas 3",
    }
    return port_names.get(port, f"printer_{port}")


def normalize_printer_payload(
    printer: Dict[str, Any],
    port: int,
    client: Optional["MoonrakerClient"] = None,
    host: Optional[str] = None,
) -> Dict[str, Any]:
    """Convierte la respuesta de Moonraker a un formato simple para la UI."""

    printer_info = printer.get("printer_info") or {}
    status_payload = printer.get("status") or {}
    status_data = status_payload.get("status") or {}

    raw_state = printer.get("state") or printer_info.get("state") or "unknown"
    state_text = str(raw_state).lower()
    is_online = state_text in {"ready", "printing", "paused", "busy", "standby"}

    print_stats = status_data.get("print_stats") or {}
    print_stats_info = print_stats.get("info") or {}
    gcode_move = status_data.get("gcode_move") or {}
    virtual_sdcard = status_data.get("virtual_sdcard") or {}
    progress = virtual_sdcard.get("progress")
    print_duration = print_stats.get("print_duration") or 0
    job_state = print_stats.get("state") or ""
    filename = print_stats.get("filename") or ""

    layer_height = None
    filament_type = None
    estimated_time = None
    thumbnail_url = None
    file_size_mb = None
    modified_at = None
    if client and host and filename and job_state in ("printing", "paused"):
        metadata = client.get_file_metadata(filename) or {}
        layer_height = metadata.get("layer_height")
        filament_type = metadata.get("filament_type")
        estimated_time = metadata.get("estimated_time")
        if metadata.get("size") is not None:
            file_size_mb = round(metadata["size"] / (1024 * 1024), 2)
        if metadata.get("modified") is not None:
            modified_at = metadata["modified"]
        thumbnails = metadata.get("thumbnails") or []
        if thumbnails:
            largest = max(thumbnails, key=lambda thumb: thumb.get("width", 0))
            relative_path = largest.get("relative_path", "")
            directory = filename.rsplit("/", 1)[0] if "/" in filename else ""
            thumb_path = f"{directory}/{relative_path}" if directory else relative_path
            thumbnail_url = f"http://{host}:{port}/server/files/gcodes/{thumb_path}"

    return {
        "name": printer.get("name") or f"printer_{port}",
        "port": port,
        "state": raw_state,
        "status": "online" if is_online else "offline",
        "printer_info": printer_info,
        "data": {
            "heater_bed": {
                "temperature": status_data.get("heater_bed", {}).get("temperature"),
                "target": status_data.get("heater_bed", {}).get("target"),
            },
            "extruder": {
                "temperature": status_data.get("extruder", {}).get("temperature"),
                "target": status_data.get("extruder", {}).get("target"),
            },
        },
        "job": {
            "filename": filename,
            "state": job_state,
            "progress": round((progress or 0) * 100),
            "print_duration": print_duration,
            "estimated_remaining": (
                round((print_duration / progress) - print_duration)
                if progress and progress > 0.01
                else None
            ),
            "current_layer": print_stats_info.get("current_layer"),
            "total_layer": print_stats_info.get("total_layer"),
            "speed": gcode_move.get("speed"),
            "layer_height": layer_height,
            "filament_type": filament_type,
            "estimated_time": estimated_time,
            "thumbnail_url": thumbnail_url,
            "file_size_mb": file_size_mb,
            "modified_at": modified_at,
        },
        "path": printer_info.get("config_file") or printer_info.get("log_file") or f"/printer/{port}",
    }


class MoonrakerClient:
    """Cliente para comunicarse con Moonraker vía REST API"""

    def __init__(self, port: int):
        self.port = port
        self.base_url = f"http://localhost:{port}"
        self.timeout = 2

    def _get(self, endpoint: str) -> Dict[str, Any]:
        try:
            response = requests.get(
                f"{self.base_url}{endpoint}",
                timeout=self.timeout
            )

            response.raise_for_status()

            return response.json().get("result", {})

        except requests.exceptions.ConnectionError:
            # No hay Moonraker en este puerto (es normal durante el escaneo)
            return {}

        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return {}

    def get_server_info(self):
        return self._get("/server/info")

    def get_printer_info(self):
        return self._get("/printer/info")

    def get_printer_status(self):
        return self._get(
            "/printer/objects/query?extruder&heater_bed&print_stats&toolhead&virtual_sdcard&gcode_move"
        )

    def get_file_metadata(self, filename: str):
        """Metadata del gcode (altura de capa, filamento, miniaturas) que Moonraker extrae al cargar el archivo."""
        return self._get(f"/server/files/metadata?filename={quote(filename)}")

    def get_toolhead_objects(self):
        return self._get("/printer/objects/query?toolhead&gcode_move").get("status", {})

    def get_mainsail_printername(self):
        """Nombre configurado por el usuario en Mainsail (Machine > General)."""
        value = self._get(
            "/server/database/item?namespace=mainsail&key=general.printername"
        ).get("value")
        return str(value).strip() if value else None

    def get_recent_jobs(self, limit: int = 3):
        """Últimos trabajos de impresión (historial de Moonraker)."""
        return self._get(
            f"/server/history/list?limit={limit}&order=desc"
        ).get("jobs", [])

    def get_system_info(self):
        """Información estática de hardware/SO (CPU, distro, red)."""
        return self._get("/machine/system_info").get("system_info", {})

    def get_proc_stats(self):
        """Uso de CPU/memoria/red y temperatura en tiempo real."""
        return self._get("/machine/proc_stats")

    def get_mcu_status(self):
        """Estado del MCU (versión, carga, frecuencia)."""
        return self._get("/printer/objects/query?mcu").get("status", {}).get("mcu", {})

    def get_object_list(self):
        """Lista de todos los objetos disponibles en Klipper (heaters, sensores, etc.)."""
        return self._get("/printer/objects/list").get("objects", [])

    def get_temperature_store(self):
        """Historial reciente de temperaturas (actual/objetivo) por objeto."""
        return self._get("/server/temperature_store")

    def get_gcode_store(self, count: int = 50):
        """Últimos mensajes de la consola G-code."""
        return self._get(f"/server/gcode_store?count={count}").get("gcode_store", [])

    def run_gcode_script(self, script: str) -> bool:
        try:
            response = requests.post(
                f"{self.base_url}/printer/gcode/script",
                json={"script": script},
                timeout=self.timeout,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False

    def pause_print(self) -> bool:
        return self.run_gcode_script("PAUSE")

    def resume_print(self) -> bool:
        return self.run_gcode_script("RESUME")

    def cancel_print(self) -> bool:
        return self.run_gcode_script("CANCEL_PRINT")

    def restart_klipper(self) -> bool:
        try:
            response = requests.post(f"{self.base_url}/printer/restart", timeout=5)
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False

    def firmware_restart(self) -> bool:
        try:
            response = requests.post(f"{self.base_url}/printer/firmware_restart", timeout=5)
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False

    def upload_gcode_file(self, filename: str, content: bytes) -> bool:
        """Sube un archivo a la carpeta gcodes de Moonraker (biblioteca de la impresora)."""
        try:
            response = requests.post(
                f"{self.base_url}/server/files/upload",
                files={"file": (filename, content, "text/plain")},
                data={"root": "gcodes"},
                timeout=20,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False

    def start_print(self, filename: str) -> bool:
        try:
            response = requests.post(
                f"{self.base_url}/printer/print/start",
                params={"filename": filename},
                timeout=self.timeout,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False

    def get_job_queue_status(self):
        return self._get("/server/job_queue/status")

    def add_to_job_queue(self, filenames: List[str]) -> bool:
        try:
            response = requests.post(
                f"{self.base_url}/server/job_queue/job",
                json={"filenames": filenames},
                timeout=self.timeout,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False

    def start_job_queue(self) -> bool:
        try:
            response = requests.post(f"{self.base_url}/server/job_queue/start", timeout=self.timeout)
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False

    def remove_from_job_queue(self, job_ids: List[str]) -> bool:
        try:
            response = requests.delete(
                f"{self.base_url}/server/job_queue/job",
                params={"job_ids": ",".join(job_ids)},
                timeout=self.timeout,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[{self.port}] {e}")
            return False


_moonraker_ports_seen: set = set()


def find_moonraker_instances() -> List[Dict[str, Any]]:
    """
    Busca instancias activas de Moonraker.

    Escanea desde el puerto 7125 hasta el 7127.
    """

    printers = []
    ports_found = set()

    for port in range(7125, 7128):

        client = MoonrakerClient(port)

        server = client.get_server_info()
        printer_info = client.get_printer_info()

        if not server:
            continue

        mainsail_name = client.get_mainsail_printername()
        real_name = _derive_printer_name(port, server, printer_info, mainsail_name)

        printers.append({
            "name": str(real_name),
            "port": port
        })
        ports_found.add(port)

        # Esta función se llama cada 5s desde el poll del dashboard — loguear
        # "encontrado" en cada ciclo, para cada instancia, inunda el archivo
        # sin aportar nada nuevo. Solo se avisa la primera vez que aparece.
        if port not in _moonraker_ports_seen:
            logger.info(f"Moonraker encontrado en puerto {port}")

    for port in _moonraker_ports_seen - ports_found:
        logger.warning(f"Moonraker en puerto {port} dejó de responder")

    _moonraker_ports_seen.clear()
    _moonraker_ports_seen.update(ports_found)

    return printers


def get_claimed_serial_devices() -> List[str]:
    """Rutas serie (resueltas a su ruta real, sin symlinks) que ya están
    configuradas en el printer.cfg de alguna instancia Klipper detectada
    localmente, para no ofrecerlas también como láser."""
    claimed = set()
    for printer in find_moonraker_instances():
        client = MoonrakerClient(printer["port"])
        config_path = client.get_printer_info().get("config_file")
        if not config_path or not os.path.isfile(config_path):
            continue
        try:
            with open(config_path, "r", encoding="utf-8", errors="ignore") as handle:
                text = handle.read()
        except OSError:
            continue
        for match in re.finditer(r"^\s*serial\s*:\s*(\S+)", text, re.MULTILINE):
            try:
                claimed.add(os.path.realpath(match.group(1)))
            except OSError:
                continue
    return list(claimed)


def pause_printer_print(port: int) -> bool:
    return MoonrakerClient(port).pause_print()


def resume_printer_print(port: int) -> bool:
    return MoonrakerClient(port).resume_print()


def cancel_printer_print(port: int) -> bool:
    return MoonrakerClient(port).cancel_print()


def restart_printer_klipper(port: int) -> bool:
    return MoonrakerClient(port).restart_klipper()


def firmware_restart_printer(port: int) -> bool:
    return MoonrakerClient(port).firmware_restart()


def send_gcode_to_printer(port: int, file_path: str, mode: str = "print", section: str = "model") -> Dict[str, Any]:
    """Sube un archivo de la biblioteca de NOPAL (Modelos 3D o G-code) a la
    impresora y lo imprime de inmediato (mode='print') o lo agrega a la cola
    nativa de Moonraker (mode='queue')."""
    abs_path = safe_section_path(section, file_path)
    if not os.path.isfile(abs_path):
        return {"success": False, "error": "Archivo no encontrado"}

    filename = os.path.basename(abs_path)
    with open(abs_path, "rb") as handle:
        content = handle.read()

    client = MoonrakerClient(port)
    if not client.upload_gcode_file(filename, content):
        return {"success": False, "error": "No se pudo subir el archivo a la impresora"}

    if mode == "queue":
        # Solo se agrega a la cola — no se arranca. El usuario decide cuándo
        # iniciarla con el botón "Iniciar cola" (evita que "agregar a cola"
        # termine imprimiendo de inmediato, que era el bug real).
        if not client.add_to_job_queue([filename]):
            return {"success": False, "error": "No se pudo agregar el archivo a la cola"}
    else:
        if not client.start_print(filename):
            return {"success": False, "error": "No se pudo iniciar la impresión"}

    return {"success": True, "filename": filename}


def get_printer_job_queue(port: int) -> Dict[str, Any]:
    status = MoonrakerClient(port).get_job_queue_status()
    return status or {"queued_jobs": [], "queue_state": "paused"}


# ── Impresiones programadas (persistidas) ──

def _load_schedule() -> List[Dict[str, Any]]:
    try:
        with open(SCHEDULE_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _save_schedule(entries: List[Dict[str, Any]]):
    try:
        with open(SCHEDULE_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2)
    except OSError:
        pass


def get_scheduled_prints() -> List[Dict[str, Any]]:
    return sorted(_load_schedule(), key=lambda entry: entry.get("scheduled_at", 0))


def add_scheduled_print(port: int, file_path: str, section: str, filename: str, scheduled_at_iso: str) -> Dict[str, Any]:
    try:
        scheduled_dt = datetime.fromisoformat(scheduled_at_iso)
    except ValueError:
        return {"success": False, "error": "Fecha/hora inválida"}

    abs_path = safe_section_path(section, file_path)
    if not os.path.isfile(abs_path):
        return {"success": False, "error": "Archivo no encontrado"}

    entries = _load_schedule()
    entry = {
        "id": uuid.uuid4().hex,
        "port": port,
        "file_path": file_path,
        "section": section,
        "filename": filename,
        "scheduled_at": scheduled_dt.timestamp(),
        "scheduled_at_iso": scheduled_at_iso,
        "created_at": time.time(),
    }
    entries.append(entry)
    _save_schedule(entries)
    return {"success": True, "entry": entry}


def remove_scheduled_print(schedule_id: str) -> bool:
    entries = _load_schedule()
    filtered = [entry for entry in entries if entry.get("id") != schedule_id]
    if len(filtered) == len(entries):
        return False
    _save_schedule(filtered)
    return True


def run_due_scheduled_prints():
    """Revisa la lista de impresiones programadas y dispara las que ya
    llegaron a su hora — pensado para llamarse periódicamente desde una
    tarea de fondo en el arranque de la app."""
    entries = _load_schedule()
    if not entries:
        return

    now = time.time()
    due = [entry for entry in entries if entry.get("scheduled_at", 0) <= now]
    if not due:
        return

    remaining = [entry for entry in entries if entry.get("scheduled_at", 0) > now]
    _save_schedule(remaining)

    for entry in due:
        result = send_gcode_to_printer(
            entry["port"], entry["file_path"], mode="print", section=entry.get("section", "model")
        )
        if not result.get("success"):
            logger.warning(f"Impresión programada falló ({entry.get('filename')}): {result.get('error')}")


def remove_printer_queue_job(port: int, job_ids: List[str]) -> bool:
    return MoonrakerClient(port).remove_from_job_queue(job_ids)


def start_printer_job_queue(port: int) -> bool:
    return MoonrakerClient(port).start_job_queue()


def get_all_printers_status(host: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Devuelve el estado de todas las impresoras detectadas.
    """

    printers = []

    for printer in find_moonraker_instances():

        client = MoonrakerClient(printer["port"])

        info = client.get_printer_info()
        status = client.get_printer_status()

        printers.append(
            normalize_printer_payload(
                {
                    "name": printer["name"],
                    "port": printer["port"],
                    "state": info.get("state", "unknown"),
                    "printer_info": info,
                    "status": status,
                },
                printer["port"],
                client=client,
                host=host,
            )
        )

    return printers


def _get_primary_network_interface(network_stats: Dict[str, Any], network_info: Dict[str, Any]) -> Dict[str, Any]:
    """Detecta la interfaz de red activa (mayor tráfico) y su IP."""

    candidates = [
        (name, iface) for name, iface in network_stats.items() if name != "lo"
    ]
    if not candidates:
        return {}

    primary_name, primary_stats = max(
        candidates,
        key=lambda item: item[1].get("rx_bytes", 0) + item[1].get("tx_bytes", 0),
    )

    ip_address = None
    for addr in network_info.get(primary_name, {}).get("ip_addresses", []):
        if addr.get("family") == "ipv4" and not addr.get("is_link_local"):
            ip_address = addr.get("address")
            break

    return {
        "name": primary_name,
        "ip": ip_address,
        "rx_gb": round(primary_stats.get("rx_bytes", 0) / (1024 ** 3), 2),
        "tx_gb": round(primary_stats.get("tx_bytes", 0) / (1024 ** 3), 2),
    }


def get_system_stats(port: int = None) -> Dict[str, Any]:
    """
    Estadísticas de hardware (MCU + host) de una impresora.

    Si no se indica `port`, usa la primera impresora detectada. Los datos de
    host (CPU, memoria, red) son los mismos sin importar cuál se elija, ya que
    las instancias de Moonraker corren en la misma máquina física; lo que
    cambia es el MCU consultado.
    """

    printers = find_moonraker_instances()
    if not printers:
        return {}

    if port is not None:
        printer = next((p for p in printers if p["port"] == port), None)
        if printer is None:
            return {}
    else:
        printer = printers[0]

    client = MoonrakerClient(printer["port"])

    system_info = client.get_system_info()
    proc_stats = client.get_proc_stats()
    printer_info = client.get_printer_info()
    mcu_status = client.get_mcu_status()

    cpu_info = system_info.get("cpu_info", {})
    distribution = system_info.get("distribution", {})
    system_memory = proc_stats.get("system_memory", {})
    system_cpu_usage = proc_stats.get("system_cpu_usage", {})
    network = proc_stats.get("network", {})
    cpu_temp = proc_stats.get("cpu_temp")

    total_bandwidth = sum(
        iface.get("bandwidth", 0)
        for name, iface in network.items()
        if name != "lo"
    )

    mem_total = system_memory.get("total", 0)
    mem_used = system_memory.get("used", 0)
    mem_percent = round((mem_used / mem_total) * 100) if mem_total else 0

    mcu_constants = mcu_status.get("mcu_constants", {})
    mcu_stats = mcu_status.get("last_stats", {})
    freq_hz = mcu_stats.get("freq") or mcu_constants.get("CLOCK_FREQ", 0)

    network_info = system_info.get("network", {})
    primary_network = _get_primary_network_interface(network, network_info)

    return {
        "printer_name": printer["name"],
        "mcu": {
            "name": mcu_constants.get("MCU", "mcu"),
            "version": mcu_status.get("mcu_version"),
            "load": mcu_stats.get("mcu_task_avg"),
            "awake": mcu_stats.get("mcu_awake"),
            "freq_mhz": round(freq_hz / 1_000_000, 1) if freq_hz else None,
            "temp": cpu_temp,
        },
        "host": {
            "version": printer_info.get("software_version"),
            "os": distribution.get("name"),
            "cpu_desc": cpu_info.get("cpu_desc"),
            "cpu_bits": cpu_info.get("bits"),
            "cpu_percent": round(system_cpu_usage.get("cpu", 0)),
            "mem_percent": mem_percent,
            "mem_used_gb": round(mem_used / (1024 * 1024), 2),
            "mem_total_gb": round(mem_total / (1024 * 1024), 2),
            "temp": cpu_temp,
            "bandwidth_kbps": round(total_bandwidth / 1024, 1),
            "network_interface": primary_network.get("name"),
            "network_ip": primary_network.get("ip"),
            "rx_gb": primary_network.get("rx_gb"),
            "tx_gb": primary_network.get("tx_gb"),
        },
    }


TEMPERATURE_OBJECT_PREFIXES = (
    "extruder",
    "heater_bed",
    "heater_generic ",
    "temperature_sensor ",
    "temperature_fan ",
)


def _temperature_object_label(key: str) -> str:
    if key == "extruder":
        return "Extruder"
    if key == "heater_bed":
        return "Heater Bed"
    for prefix in ("heater_generic ", "temperature_sensor ", "temperature_fan "):
        if key.startswith(prefix):
            return key[len(prefix):]
    return key


def _heater_gcode_name(key: str) -> str:
    """Nombre que Klipper espera en HEATER=... (sin el prefijo del tipo de objeto)."""
    if key.startswith("heater_generic "):
        return key.split(" ", 1)[1]
    return key


def get_temperature_snapshot(port: int) -> Dict[str, Any]:
    """
    Snapshot de temperaturas (actual/objetivo/historial) para el widget de
    Temperaturas, análogo al de Mainsail.
    """

    client = MoonrakerClient(port)

    objects = client.get_object_list()
    matched_keys = [
        obj for obj in objects
        if any(
            obj == prefix or obj.startswith(prefix)
            for prefix in TEMPERATURE_OBJECT_PREFIXES
        )
    ]

    store = client.get_temperature_store() or {}

    sensors = []
    series = {}

    for key in matched_keys:
        entry = store.get(key)
        if not entry:
            continue

        temperatures = entry.get("temperatures") or []
        targets = entry.get("targets")
        is_heater = targets is not None

        current = temperatures[-1] if temperatures else None
        target = targets[-1] if is_heater and targets else None

        sensors.append({
            "key": key,
            "label": _temperature_object_label(key),
            "kind": "heater" if is_heater else "sensor",
            "current": round(current, 1) if current is not None else None,
            "target": round(target, 1) if target is not None else None,
        })
        series[key] = [round(value, 1) for value in temperatures]

    return {
        "sensors": sensors,
        "history": {
            "interval_seconds": 1,
            "series": series,
        },
    }


def set_heater_target(port: int, heater: str, target: float) -> bool:
    """Envía SET_HEATER_TEMPERATURE al heater indicado."""
    client = MoonrakerClient(port)
    gcode_name = _heater_gcode_name(heater)
    script = f"SET_HEATER_TEMPERATURE HEATER={gcode_name} TARGET={target}"
    return client.run_gcode_script(script)


def get_toolhead_status(port: int) -> Dict[str, Any]:
    """Posición actual del cabezal, ejes homeados, factor de velocidad y offset Z."""
    client = MoonrakerClient(port)
    status = client.get_toolhead_objects()
    toolhead = status.get("toolhead", {})
    gcode_move = status.get("gcode_move", {})
    position = toolhead.get("position") or [0, 0, 0, 0]
    gcode_position = gcode_move.get("gcode_position") or position
    homing_origin = gcode_move.get("homing_origin") or [0, 0, 0, 0]
    return {
        "position": {"x": position[0], "y": position[1], "z": position[2]},
        "gcode_position": {"x": gcode_position[0], "y": gcode_position[1], "z": gcode_position[2]},
        "homed_axes": toolhead.get("homed_axes", ""),
        "speed_factor": gcode_move.get("speed_factor", 1.0),
        "z_offset": homing_origin[2] if len(homing_origin) > 2 else 0,
        "absolute_coordinates": gcode_move.get("absolute_coordinates", True),
    }


def get_console_messages(port: int, count: int = 50) -> List[Dict[str, Any]]:
    """Últimos mensajes de la consola G-code (comandos y respuestas)."""
    client = MoonrakerClient(port)
    return client.get_gcode_store(count=count)


def send_console_command(port: int, command: str) -> bool:
    """Envía un comando arbitrario de G-code/consola."""
    client = MoonrakerClient(port)
    return client.run_gcode_script(command)


def get_macros(port: int) -> List[Dict[str, str]]:
    """Lista de macros configurados (nombre + descripción, si Klipper la expone
    vía `description:` en el [gcode_macro <nombre>] del printer.cfg)."""
    client = MoonrakerClient(port)
    objects = client.get_object_list()
    macro_objects = [
        obj for obj in objects
        if obj.startswith("gcode_macro ") and not obj.split(" ", 1)[1].startswith("_")
    ]
    if not macro_objects:
        return []

    query = "&".join(obj.replace(" ", "%20") for obj in macro_objects)
    status = client._get(f"/printer/objects/query?{query}").get("status", {})

    macros = []
    for obj in macro_objects:
        name = obj.split(" ", 1)[1]
        description = (status.get(obj, {}) or {}).get("description", "")
        if description == "G-Code macro":
            description = ""
        macros.append({"name": name, "description": description})
    return sorted(macros, key=lambda m: m["name"])


def run_macro(port: int, macro: str) -> bool:
    """Ejecuta un macro por nombre."""
    client = MoonrakerClient(port)
    return client.run_gcode_script(macro)


def get_recent_printer_files(host: str, limit: int = 3) -> List[Dict[str, Any]]:
    """
    Devuelve los últimos `limit` trabajos de impresión de cada impresora detectada,
    incluyendo la miniatura servida directamente por Moonraker.
    """

    result = []

    for printer in find_moonraker_instances():
        port = printer["port"]
        client = MoonrakerClient(port)
        jobs = client.get_recent_jobs(limit=limit)

        parsed_jobs = []
        for job in jobs:
            filename = job.get("filename") or ""
            directory = filename.rsplit("/", 1)[0] if "/" in filename else ""
            metadata = job.get("metadata") or {}
            thumbnails = metadata.get("thumbnails") or []

            thumbnail_url = None
            if thumbnails:
                largest = max(thumbnails, key=lambda thumb: thumb.get("width", 0))
                relative_path = largest.get("relative_path", "")
                thumb_path = f"{directory}/{relative_path}" if directory else relative_path
                thumbnail_url = f"http://{host}:{port}/server/files/gcodes/{thumb_path}"

            file_url = f"http://{host}:{port}/server/files/gcodes/{filename}" if filename else None

            parsed_jobs.append({
                "filename": filename.rsplit("/", 1)[-1] if filename else "—",
                "status": job.get("status", "unknown"),
                "end_time": job.get("end_time"),
                "print_duration": job.get("print_duration"),
                "thumbnail_url": thumbnail_url,
                "file_url": file_url,
            })

        result.append({
            "printer": printer["name"],
            "port": port,
            "jobs": parsed_jobs,
        })

    return result


def get_printer_status(port: int) -> Dict[str, Any]:
    """
    Devuelve el estado de una sola impresora.
    """

    client = MoonrakerClient(port)

    server = client.get_server_info()
    printer_info = client.get_printer_info()
    mainsail_name = client.get_mainsail_printername()

    return {
        "name": _derive_printer_name(port, server, printer_info, mainsail_name),
        "port": port,
        "printer_info": printer_info,
        "status": client.get_printer_status()
    }