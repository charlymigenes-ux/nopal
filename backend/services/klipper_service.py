import logging
import re
from typing import Dict, Any, List

import requests

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


def normalize_printer_payload(printer: Dict[str, Any], port: int) -> Dict[str, Any]:
    """Convierte la respuesta de Moonraker a un formato simple para la UI."""

    printer_info = printer.get("printer_info") or {}
    status_payload = printer.get("status") or {}
    status_data = status_payload.get("status") or {}

    raw_state = printer.get("state") or printer_info.get("state") or "unknown"
    state_text = str(raw_state).lower()
    is_online = state_text in {"ready", "printing", "paused", "busy", "standby"}

    return {
        "name": printer.get("name") or f"printer_{port}",
        "port": port,
        "state": raw_state,
        "status": "online" if is_online else "offline",
        "printer_info": printer_info,
        "data": {
            "heater_bed": {
                "temperature": status_data.get("heater_bed", {}).get("temperature")
            },
            "extruder": {
                "temperature": status_data.get("extruder", {}).get("temperature")
            },
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
            "/printer/objects/query?extruder&heater_bed&print_stats&toolhead"
        )

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


def find_moonraker_instances() -> List[Dict[str, Any]]:
    """
    Busca instancias activas de Moonraker.

    Escanea desde el puerto 7125 hasta el 7127.
    """

    printers = []

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

        logger.info(f"Moonraker encontrado en puerto {port}")

    return printers


def get_all_printers_status() -> List[Dict[str, Any]]:
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
            )
        )

    return printers


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