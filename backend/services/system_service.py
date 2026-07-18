"""Control de servicios systemd (Klipper/Moonraker/Crowsnest) y del host.

No se llama a systemctl directamente para reiniciar/detener nada -- el
usuario que corre nopal.service no tiene privilegios de sudo para eso, y
dárselos sería agregar una superficie de ataque nueva. En cambio se delega en
la API "machine" de Moonraker (/machine/services/*, /machine/reboot,
/machine/shutdown): en cualquier instalación real de Klipper esa API ya viene
configurada con los permisos correctos para administrar tanto su propio
proceso como los servicios hermanos (Crowsnest, otras instancias) y el
apagado/reinicio del equipo, así que no hace falta ninguna regla de sudo
nueva. Listar servicios (`systemctl list-units`) sí es una operación sin
privilegios, así que esa parte se hace directo.
"""

import asyncio
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

SERVICE_NAME_PATTERN = re.compile(r"^(klipper|moonraker|crowsnest|go2rtc)", re.IGNORECASE)
INSTANCE_SUFFIX_PATTERN = re.compile(r"-(\d+)$")
DEFAULT_MOONRAKER_PORT = 7125
HTTP_TIMEOUT = 5


def _list_systemd_services() -> List[Dict[str, str]]:
    """Servicios de Klipper/Moonraker/Crowsnest visibles en el host, con su
    estado real (active/failed/inactive) -- no requiere privilegios."""
    try:
        result = subprocess.run(
            ["systemctl", "list-units", "--type=service", "--all", "--plain", "--no-legend"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning(f"No se pudo listar servicios systemd: {e}")
        return []

    services = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        unit, load, active, sub = parts[0], parts[1], parts[2], parts[3]
        if not unit.endswith(".service"):
            continue
        name = unit[: -len(".service")]
        if not SERVICE_NAME_PATTERN.match(name):
            continue
        services.append({"unit": name, "load": load, "active": active, "sub": sub})
    return services


def _moonraker_ports() -> Dict[Optional[int], int]:
    """Mapea número de instancia -> puerto real de Moonraker, leyendo
    ~/printer[_N]_data/config/moonraker.conf (misma convención multi-instancia
    que ya usa klipper_service.py). None = instancia sin numerar (host de una
    sola impresora)."""
    ports: Dict[Optional[int], int] = {}
    for config_path in Path.home().glob("printer*_data/config/moonraker.conf"):
        instance_dir = config_path.parent.parent.name  # printer_data | printer_N_data
        match = re.match(r"printer_?(\d+)?_data$", instance_dir)
        instance = int(match.group(1)) if match and match.group(1) else None
        try:
            text = config_path.read_text(encoding="utf-8")
        except OSError:
            continue
        server_section = re.search(r"\[server\](.*?)(\n\[|\Z)", text, re.DOTALL)
        port = DEFAULT_MOONRAKER_PORT
        if server_section:
            port_match = re.search(r"^port:\s*(\d+)", server_section.group(1), re.MULTILINE)
            if port_match:
                port = int(port_match.group(1))
        ports[instance] = port
    return ports


def _base_url_for(unit_name: str, ports: Dict[Optional[int], int]) -> Optional[str]:
    """Para klipper-N/moonraker-N usa la instancia N (viven en el mismo
    printer_N_data); para crowsnest u otro servicio sin numerar, cualquier
    instancia disponible sirve -- Moonraker administra a sus hermanos.
    go2rtc es un servicio propio de NOPAL, no un hermano de Klipper/Moonraker
    -- Moonraker no tiene permiso para administrarlo, así que se muestra en
    el panel (para ver su estado) pero sin acción de reiniciar/parar."""
    if unit_name == "go2rtc":
        return None
    match = INSTANCE_SUFFIX_PATTERN.search(unit_name)
    instance = int(match.group(1)) if match else None
    port = ports.get(instance) or next(iter(ports.values()), None)
    return f"http://127.0.0.1:{port}" if port else None


def get_services() -> List[Dict[str, Any]]:
    ports = _moonraker_ports()
    services = [
        {**entry, "controllable": _base_url_for(entry["unit"], ports) is not None}
        for entry in _list_systemd_services()
    ]
    services.sort(key=lambda s: s["unit"])
    return services


def control_service(unit_name: str, action: str) -> bool:
    """action: restart | start | stop. Valida unit_name contra los servicios
    realmente detectados en el host antes de reenviarlo a Moonraker, para no
    proxyear un nombre de servicio arbitrario que venga del cliente."""
    if action not in ("restart", "start", "stop"):
        raise ValueError(f"Acción inválida: {action}")

    ports = _moonraker_ports()
    valid_units = {entry["unit"] for entry in _list_systemd_services()}
    if unit_name not in valid_units:
        raise ValueError(f"Servicio desconocido: {unit_name}")

    base_url = _base_url_for(unit_name, ports)
    if not base_url:
        logger.warning(f"No hay una instancia de Moonraker disponible para controlar {unit_name}")
        return False
    try:
        response = requests.post(
            f"{base_url}/machine/services/{action}",
            params={"service": unit_name},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        return True
    except Exception as e:
        logger.warning(f"[{unit_name}] {action} falló: {e}")
        return False


def _any_base_url() -> Optional[str]:
    port = next(iter(_moonraker_ports().values()), None)
    return f"http://127.0.0.1:{port}" if port else None


def reboot_host() -> bool:
    base_url = _any_base_url()
    if not base_url:
        return False
    try:
        response = requests.post(f"{base_url}/machine/reboot", timeout=HTTP_TIMEOUT)
        response.raise_for_status()
        return True
    except Exception as e:
        logger.warning(f"Reinicio del equipo falló: {e}")
        return False


def shutdown_host() -> bool:
    base_url = _any_base_url()
    if not base_url:
        return False
    try:
        response = requests.post(f"{base_url}/machine/shutdown", timeout=HTTP_TIMEOUT)
        response.raise_for_status()
        return True
    except Exception as e:
        logger.warning(f"Apagado del equipo falló: {e}")
        return False


async def _delayed_self_exit() -> None:
    # Le da tiempo a la respuesta HTTP de salir antes de matar el proceso.
    await asyncio.sleep(0.5)
    # os._exit (no sys.exit) para salir ya, sin correr cleanup/atexit que
    # podría colgarse -- el código de salida 1 es lo que hace que
    # "Restart=on-failure" en nopal.service dispare el reinicio automático.
    os._exit(1)


def schedule_nopal_restart() -> None:
    """No hay forma de que NOPAL se reinicie a sí mismo vía systemctl sin
    sudo (a diferencia de Klipper/Moonraker/Crowsnest, no hay ninguna API
    tipo Moonraker que administre a nopal.service). En cambio el proceso se
    auto-termina con un código de salida que cuenta como falla, y como la
    unidad ya tiene Restart=on-failure + RestartSec=5, systemd lo vuelve a
    levantar solo -- sin necesitar ningún permiso nuevo."""
    asyncio.create_task(_delayed_self_exit())
