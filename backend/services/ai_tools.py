"""Herramientas de NOPAL expuestas a la capa de IA — SOLO LECTURA.

El modelo nunca toca el sistema operativo ni los servicios directamente:
solo puede llamar a las funciones registradas en `TOOLS`, y cada una es un
envoltorio delgado sobre servicios que NOPAL ya tenía (dashboard_service,
klipper_service, laser_service, notification_service, el log de la app y
los plugins cargados). No hay ninguna herramienta que mueva ejes, caliente,
inicie o cancele trabajos, haga home, resetee el MCU ni ejecute shell.

Cuando existan acciones físicas irán en un registro aparte, con
confirmación explícita del usuario. Láser y CNC no deben poder arrancarse
por esta vía nunca.

Identidad de máquina
--------------------
NOPAL no tiene un id único global de máquina: cada marca identifica lo suyo
a su manera (Klipper por puerto de Moonraker, Marlin por dispositivo serie,
Elegoo por mainboard_id, FlashForge por número de serie, Bambu por id,
láser/CNC por host). Acá se construye un id compuesto y estable
`<tipo>:<id-nativo>` — por ejemplo `klipper:7125` o `laser:192.168.0.61` —
y además se acepta el nombre visible ("TTS 55 PRO") porque es lo que el
usuario va a escribir en su pregunta.

Todo lo que devuelven estas funciones es dato real medido por NOPAL o por
sus integraciones. Cuando algo no se puede saber se devuelve
`{"available": false, "reason": ...}` en vez de un valor inventado — la
misma convención que ya usa el resto de NOPAL (ambient/maintenance en
dashboard_service, "unknown" en los mapeos de estado de cada marca).
"""

import asyncio
import logging
import os
import re
from typing import Any, Callable, Dict, List, Optional

from backend.config import LOG_FILE
from backend.services.bambu_service import get_registered_printers_with_status as get_bambu_printers
from backend.services.dashboard_service import get_dashboard_summary
from backend.services.elegoo_service import get_registered_printers_with_status as get_elegoo_printers
from backend.services.flashforge_service import get_registered_printers_with_status as get_flashforge_printers
from backend.services.klipper_service import (
    get_all_printers_status,
    get_printer_status,
    get_temperature_snapshot,
)
from backend.services.laser_service import get_registered_lasers_status, get_status as get_laser_status
from backend.services.marlin_printer_service import get_registered_printers_with_status as get_marlin_printers
from backend.services.notification_service import get_notifications
from backend.services.plugin_loader_service import get_loaded_plugin_module

logger = logging.getLogger(__name__)

# Formato de las líneas de logs/nopal.log (ver LOG_FORMAT en config.py):
# "2026-08-11 11:03:22 WARNING  [backend.services.klipper_service] mensaje"
_LOG_LINE = re.compile(
    r"^(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+"
    r"(?P<level>[A-Z]+)\s+\[(?P<source>[^\]]+)\]\s+(?P<message>.*)$"
)


def _unavailable(reason: str) -> Dict[str, Any]:
    return {"available": False, "reason": reason}


# --------------------------------------------------------------------------
# Inventario unificado de máquinas
# --------------------------------------------------------------------------

async def _collect_machines() -> List[Dict[str, Any]]:
    """Normaliza las 5 familias de impresoras + láser/CNC a una forma común.

    Cada marca conserva su payload crudo en `details` — el modelo casi nunca
    lo necesita, pero las herramientas de diagnóstico sí.
    """
    loop = asyncio.get_event_loop()
    klipper, marlin, flashforge, bambu, lasers = await asyncio.gather(
        loop.run_in_executor(None, get_all_printers_status),
        loop.run_in_executor(None, get_marlin_printers),
        loop.run_in_executor(None, get_flashforge_printers),
        loop.run_in_executor(None, get_bambu_printers),
        get_registered_lasers_status(),
    )
    # Sin executor a propósito, igual que en dashboard_service: arranca las
    # tareas asyncio de los listeners WS de Elegoo, que necesitan el event
    # loop de este mismo hilo.
    elegoo = get_elegoo_printers()

    machines: List[Dict[str, Any]] = []

    for printer in klipper:
        machines.append({
            "id": f"klipper:{printer.get('port')}",
            "name": printer.get("name"),
            "kind": "printer",
            "brand": "klipper",
            "online": printer.get("status") == "online",
            "state": printer.get("state"),
            "job": printer.get("job") or None,
            "details": printer,
        })

    for printer in marlin:
        machines.append({
            "id": f"marlin:{printer.get('device')}",
            "name": printer.get("name") or printer.get("device"),
            "kind": "printer",
            "brand": "marlin",
            "online": bool(printer.get("online")),
            "state": printer.get("state"),
            "job": printer.get("job") or None,
            "details": printer,
        })

    for printer in elegoo:
        machines.append({
            "id": f"elegoo:{printer.get('mainboard_id')}",
            "name": printer.get("name"),
            "kind": "printer",
            "brand": "elegoo",
            "online": bool(printer.get("online")),
            "state": printer.get("state"),
            "job": printer.get("job") or None,
            "details": printer,
        })

    for printer in flashforge:
        machines.append({
            "id": f"flashforge:{printer.get('serial_number')}",
            "name": printer.get("name"),
            "kind": "printer",
            "brand": "flashforge",
            "online": bool(printer.get("online")),
            "state": printer.get("state"),
            "job": printer.get("job") or None,
            "details": printer,
        })

    for printer in bambu:
        machines.append({
            "id": f"bambu:{printer.get('id')}",
            "name": printer.get("name"),
            "kind": "printer",
            "brand": "bambu",
            "online": bool(printer.get("online")),
            "state": printer.get("state"),
            "job": printer.get("job") or None,
            "details": printer,
        })

    for device in lasers:
        kind = "cnc" if device.get("kind") == "cnc" else "laser"
        machines.append({
            "id": f"{kind}:{device.get('host')}",
            "name": device.get("name") or device.get("host"),
            "kind": kind,
            "brand": device.get("firmware") or "grbl",
            "online": bool(device.get("online")),
            "state": device.get("state"),
            "job": None,
            "details": device,
        })

    return machines


def _resolve_machine(machines: List[Dict[str, Any]], machine_id: str) -> Optional[Dict[str, Any]]:
    """Acepta el id compuesto (`klipper:7125`), el id nativo suelto
    (`7125`, `192.168.0.61`) o el nombre visible — el usuario pregunta por
    "ET4-WE", no por "elegoo:0a1b2c"."""
    needle = (machine_id or "").strip().lower()
    if not needle:
        return None
    for machine in machines:
        if str(machine["id"]).lower() == needle:
            return machine
    for machine in machines:
        if str(machine.get("name") or "").lower() == needle:
            return machine
    for machine in machines:
        native = str(machine["id"]).split(":", 1)[-1].lower()
        if native == needle:
            return machine
    return None


async def _require_machine(machine_id: str) -> Dict[str, Any]:
    machines = await _collect_machines()
    machine = _resolve_machine(machines, machine_id)
    if machine is None:
        return {
            "error": "machine_not_found",
            "requested": machine_id,
            # Devolver los ids válidos hace que el modelo se corrija solo en
            # la siguiente vuelta en vez de inventar una máquina.
            "known_machines": [{"id": m["id"], "name": m["name"]} for m in machines],
        }
    return machine


# --------------------------------------------------------------------------
# Herramientas
# --------------------------------------------------------------------------

async def get_workshop_status() -> Dict[str, Any]:
    """Panorama general del taller. Reusa el mismo agregado que ya alimenta
    al panel de control (/api/dashboard/summary) — no hay tracking nuevo."""
    summary = await get_dashboard_summary()
    host = dict(summary.get("host") or {})
    # cpu_history son 60 muestras para un sparkline: puro ruido para el
    # modelo y tokens desperdiciados en una i3.
    host.pop("cpu_history", None)
    return {
        "system": summary.get("system"),
        "host": host,
        "devices": summary.get("devices"),
        "jobs": summary.get("jobs"),
        "alerts": summary.get("alerts"),
        "power": summary.get("power"),
        "ambient": summary.get("ambient"),
        "maintenance": summary.get("maintenance"),
    }


async def get_machines() -> Dict[str, Any]:
    """Inventario de máquinas registradas con su estado de conexión."""
    machines = await _collect_machines()
    return {
        "count": len(machines),
        "machines": [
            {k: v for k, v in machine.items() if k != "details"}
            for machine in machines
        ],
    }


async def get_machine_status(machine_id: str) -> Dict[str, Any]:
    """Estado detallado de una máquina puntual."""
    machine = await _require_machine(machine_id)
    return machine


async def get_machine_temperatures(machine_id: str) -> Dict[str, Any]:
    """Temperaturas actuales y objetivo de una máquina.

    Klipper tiene una lectura dedicada (todos los objetos de temperatura
    configurados); el resto de las marcas solo exponen lo que ya viene en su
    payload de estado. Láser/CNC no reportan temperatura.
    """
    machine = await _require_machine(machine_id)
    if machine.get("error"):
        return machine

    brand = machine["brand"]
    details = machine.get("details") or {}

    if brand == "klipper":
        port = int(str(machine["id"]).split(":", 1)[1])
        loop = asyncio.get_event_loop()
        snapshot = await loop.run_in_executor(None, get_temperature_snapshot, port)
        return {"machine_id": machine["id"], "name": machine["name"], "temperatures": snapshot}

    if machine["kind"] in ("laser", "cnc"):
        return {
            "machine_id": machine["id"],
            "name": machine["name"],
            **_unavailable("Los controladores GRBL/FluidNC no reportan temperatura a NOPAL"),
        }

    for key in ("temperatures", "temps", "temperature"):
        if isinstance(details.get(key), (dict, list)):
            return {"machine_id": machine["id"], "name": machine["name"], "temperatures": details[key]}

    partial = {k: details.get(k) for k in ("nozzle_temp", "nozzle_target", "bed_temp", "bed_target", "chamber_temp")
               if details.get(k) is not None}
    if partial:
        return {"machine_id": machine["id"], "name": machine["name"], "temperatures": partial}

    return {
        "machine_id": machine["id"],
        "name": machine["name"],
        **_unavailable(f"NOPAL no está recibiendo temperaturas de esta máquina ({brand})"),
    }


async def get_active_jobs() -> Dict[str, Any]:
    """Trabajos corriendo o en pausa ahora mismo, en todas las máquinas."""
    summary = await get_dashboard_summary()
    jobs = summary.get("jobs") or {}
    return {"total_active": jobs.get("total_active", 0), "jobs": jobs.get("active", [])}


async def get_job_progress(machine_id: str) -> Dict[str, Any]:
    """Avance del trabajo de una máquina puntual."""
    machine = await _require_machine(machine_id)
    if machine.get("error"):
        return machine
    job = machine.get("job")
    if not job or not job.get("state") or job.get("state") in ("standby", "idle", "complete", "cancelled"):
        return {
            "machine_id": machine["id"],
            "name": machine["name"],
            "active": False,
            "state": (job or {}).get("state"),
        }
    return {"machine_id": machine["id"], "name": machine["name"], "active": True, "job": job}


async def get_recent_errors() -> Dict[str, Any]:
    """Problemas activos ahora mismo (máquinas desconectadas, trabajos en
    error o pausados, accesorios que no responden).

    Es el mismo agregado que alimenta la campana de notificaciones: un
    recuento de "qué está mal en este momento", no un buzón histórico.
    """
    notifications = await get_notifications()
    items = notifications.get("items", [])
    return {
        "count": len(items),
        "errors": [i for i in items if i.get("severity") == "error"],
        "warnings": [i for i in items if i.get("severity") == "warning"],
    }


def _read_recent_events(limit: int, level: Optional[str]) -> List[Dict[str, Any]]:
    if not os.path.isfile(LOG_FILE):
        return []
    try:
        with open(LOG_FILE, "r", encoding="utf-8", errors="ignore") as handle:
            lines = handle.readlines()
    except OSError:
        return []

    events: List[Dict[str, Any]] = []
    wanted = level.upper() if level else None
    # De atrás para adelante: interesan los últimos N eventos que coinciden,
    # no los primeros del archivo.
    for line in reversed(lines):
        match = _LOG_LINE.match(line.strip())
        if not match:
            continue
        event = match.groupdict()
        if wanted and event["level"] != wanted:
            continue
        events.append(event)
        if len(events) >= limit:
            break
    events.reverse()
    return events


async def get_recent_events(limit: int = 30, level: str = "") -> Dict[str, Any]:
    """Últimos eventos del log de NOPAL (logs/nopal.log), del más viejo al
    más nuevo. `level` filtra por INFO/WARNING/ERROR."""
    limit = max(1, min(200, int(limit or 30)))
    loop = asyncio.get_event_loop()
    events = await loop.run_in_executor(None, _read_recent_events, limit, level or None)
    return {"count": len(events), "level_filter": level or "all", "events": events}


async def get_klipper_status(machine_id: str) -> Dict[str, Any]:
    """Estado crudo de Klipper/Moonraker para una impresora Klipper.

    Incluye `state_message`, que es donde Klipper explica por qué se
    detuvo (error de MCU, shutdown, config inválida) — el dato clave para
    diagnosticar una impresora parada.
    """
    machine = await _require_machine(machine_id)
    if machine.get("error"):
        return machine
    if machine["brand"] != "klipper":
        return _unavailable(f"{machine['name']} no es una impresora Klipper (es {machine['brand']})")

    port = int(str(machine["id"]).split(":", 1)[1])
    loop = asyncio.get_event_loop()
    status = await loop.run_in_executor(None, get_printer_status, port)
    printer_info = status.get("printer_info") or {}
    return {
        "machine_id": machine["id"],
        "name": status.get("name"),
        "moonraker_port": port,
        "klippy_state": printer_info.get("state"),
        "state_message": printer_info.get("state_message"),
        "software_version": printer_info.get("software_version"),
        "status": status.get("status"),
    }


async def get_grbl_status(machine_id: str) -> Dict[str, Any]:
    """Estado crudo del controlador GRBL/FluidNC de un láser o CNC."""
    machine = await _require_machine(machine_id)
    if machine.get("error"):
        return machine
    if machine["kind"] not in ("laser", "cnc"):
        return _unavailable(f"{machine['name']} no es un láser ni un CNC")
    if not machine.get("online"):
        return {
            "machine_id": machine["id"],
            "name": machine["name"],
            "online": False,
            **_unavailable("El dispositivo no responde, no se puede consultar su estado GRBL"),
        }

    host = str(machine["id"]).split(":", 1)[1]
    status = await get_laser_status(host)
    if status is None:
        return {
            "machine_id": machine["id"],
            "name": machine["name"],
            "online": True,
            **_unavailable("El controlador no respondió al pedido de estado"),
        }
    return {"machine_id": machine["id"], "name": machine["name"], "online": True, "grbl": status}


async def get_material_status() -> Dict[str, Any]:
    """Inventario de filamento vía el plugin de Materiales (Spoolman).

    Spoolman es un plugin, no parte del core: si no está instalado,
    cargado o configurado, se reporta como no disponible en vez de romper.
    """
    config_module = get_loaded_plugin_module("spoolman", "services.config_service")
    if config_module is None:
        return _unavailable("El plugin de Materiales (Spoolman) no está instalado o no está cargado")

    loop = asyncio.get_event_loop()

    def _fetch() -> Dict[str, Any]:
        client = config_module.get_client()
        if client is None:
            return _unavailable("El plugin de Materiales no tiene un servidor Spoolman configurado")
        spools = client.list_spools() or []
        threshold = config_module.get_low_stock_threshold_g()
        summary = []
        for spool in spools:
            filament = spool.get("filament") or {}
            remaining = spool.get("remaining_weight")
            summary.append({
                "id": spool.get("id"),
                "material": filament.get("material"),
                "color": filament.get("name"),
                "vendor": (filament.get("vendor") or {}).get("name"),
                "remaining_g": remaining,
                "low_stock": remaining is not None and remaining < threshold,
            })
        return {
            "count": len(summary),
            "low_stock_threshold_g": threshold,
            "spools": summary,
        }

    try:
        return await loop.run_in_executor(None, _fetch)
    except Exception as exc:
        logger.warning(f"No se pudo consultar Spoolman para la capa de IA: {exc}")
        return _unavailable("No se pudo contactar al servidor Spoolman")


async def get_camera_snapshot(machine_id: str) -> Dict[str, Any]:
    """Reservada para un modelo multimodal futuro. Todavía NO devuelve
    imagen y no se le ofrece al modelo (`exposed=False` más abajo).

    La arquitectura queda lista — el plugin camera-viewer ya asocia cada
    cámara a un dispositivo (`bound_device`) — pero mandar imágenes exige
    decidir formato, tamaño y costo de tokens contra un modelo multimodal
    real, y ninguno corre hoy en esta instalación.

    Aparte: una IA de visión nunca debe ser el único mecanismo de detección
    de incendio, humo, choque, runaway térmico o presencia humana.
    """
    return _unavailable("La lectura de cámaras por IA todavía no está implementada")


async def get_plugins() -> Dict[str, Any]:
    """Qué plugins hay instalados y habilitados.

    Sin esto la IA no sabe siquiera que NOPAL es extensible: puede leer el
    inventario de filamento pero no puede decir de dónde salió, ni sugerir
    lo que otro plugin instalado ya resuelve.
    """
    from backend.services import plugin_installer_service as installer

    loop = asyncio.get_event_loop()

    def _listar() -> List[Dict[str, Any]]:
        instalados = installer.read_installed_state()
        salida = []
        for plugin_id, estado in instalados.items():
            manifest = installer.read_manifest(plugin_id) or {}
            salida.append({
                "id": plugin_id,
                "name": manifest.get("name") or plugin_id,
                "category": manifest.get("category"),
                "description": manifest.get("description"),
                "version": estado.get("version"),
                "enabled": bool(estado.get("enabled")),
            })
        return salida

    plugins = await loop.run_in_executor(None, _listar)
    return {"count": len(plugins), "plugins": plugins}


async def get_accessories() -> Dict[str, Any]:
    """Accesorios del taller: relés, tiras LED, ventiladores, sensores y
    placas Arduino/ESP32 registradas, con su estado de encendido.

    Viene del plugin de Automatización de Taller. `on: null` significa que el
    accesorio no respondió, no que esté apagado — la distinción importa para
    no reportar como apagado algo que en realidad está incomunicado.
    """
    module = get_loaded_plugin_module("arduino-accessories", "services.accessory_service")
    if module is None:
        return _unavailable("El plugin de Automatización de Taller no está instalado o no está cargado")
    try:
        accesorios = await module.get_accessories_status()
    except Exception as exc:
        logger.warning(f"No se pudo consultar los accesorios para la capa de IA: {exc}")
        return _unavailable("No se pudo consultar el estado de los accesorios")

    return {
        "count": len(accesorios),
        "accessories": [
            {
                "id": a.get("id"),
                "name": a.get("name"),
                "driver": a.get("driver"),
                "on": a.get("on"),
                "responding": a.get("on") is not None,
                "led_color": a.get("led_color"),
            }
            for a in accesorios
        ],
    }


async def get_scenes() -> Dict[str, Any]:
    """Escenas de accesorios guardadas.

    Sin esto la IA no puede activar una escena: no conoce sus ids ni sus
    nombres, así que no tiene cómo nombrarla.
    """
    module = get_loaded_plugin_module("arduino-accessories", "services.accessory_scenes")
    if module is None:
        return _unavailable("El plugin de Automatización de Taller no está instalado o no está cargado")
    loop = asyncio.get_event_loop()
    try:
        escenas = await loop.run_in_executor(None, module.get_scenes)
    except Exception as exc:
        logger.warning(f"No se pudieron leer las escenas para la capa de IA: {exc}")
        return _unavailable("No se pudieron leer las escenas")
    return {
        "count": len(escenas),
        "scenes": [{"id": e.get("id"), "name": e.get("name"),
                    "steps": len(e.get("actions") or [])} for e in escenas],
    }


async def get_led_matrix() -> Dict[str, Any]:
    """Todo lo que la Matriz LED tiene guardado: anuncios, reglas y alertas
    por máquina.

    La Matriz LED es un plugin DISTINTO al de accesorios: sus anuncios no son
    las escenas de tiras LED y relés. Confundirlos hacía que un pedido sobre
    la matriz terminara prendiendo tiras.

    Devuelve los tres conceptos porque son tres cosas distintas y el usuario
    pregunta por las tres:

    - `announcements`: los dibujos/textos guardados. Se muestran ahora mismo.
    - `rules`: automatizaciones (inactividad, material bajo). Disparan un
      anuncio cuando se cumple su condición.
    - `machine_alerts`: por máquina, qué anuncio se muestra en cada estado.
      NO se "activan" como una escena: se prenden o apagan, y solo hacen algo
      cuando la máquina cambia de estado.

    Faltaban las dos últimas y el modelo se las inventaba, ids incluidos.
    """
    module = get_loaded_plugin_module("matriz-led", "services.screen_service")
    if module is None:
        return _unavailable("El plugin de Matriz LED no está instalado o no está cargado")

    maquinas = await _collect_machines()
    nombres = {m["id"]: m.get("name") for m in maquinas}
    loop = asyncio.get_event_loop()

    def _leer() -> Dict[str, Any]:
        estado = module.get_status() or {}
        anuncios = module.list_announcements() or []
        # getattr: una instalación con el plugin viejo no tiene reglas ni
        # alertas, y eso no debe romper la consulta del resto.
        reglas = (getattr(module, "list_rules", None) or (lambda: []))() or []
        alertas = (getattr(module, "list_machine_alerts", None) or (lambda: {}))() or {}

        titulos = {a.get("id"): (a.get("name") or a.get("title")) for a in anuncios}
        return {
            "online": bool(estado.get("online", estado.get("connected"))),
            "status": estado,
            "announcements": [{"id": a.get("id"), "name": titulos.get(a.get("id"))}
                              for a in anuncios],
            "rules": [{
                "id": r.get("id"),
                "name": r.get("name"),
                "trigger": r.get("trigger"),
                "enabled": bool(r.get("enabled", True)),
                "announcement": titulos.get(r.get("announcement_id")),
            } for r in reglas],
            "machine_alerts": [{
                "machine_id": machine_id,
                # El nombre visible: el usuario dice "la CNC 3018", no
                # "laser:192.168.0.61". None = quedó configurada para una
                # máquina que ya no existe en NOPAL.
                "machine": nombres.get(machine_id),
                "enabled": bool((cfg or {}).get("enabled")),
                "announcements_by_state": {
                    estado_maquina: titulos.get(anuncio_id)
                    for estado_maquina, anuncio_id in ((cfg or {}).get("state_announcements") or {}).items()
                    if anuncio_id
                },
            } for machine_id, cfg in (alertas.items() if isinstance(alertas, dict) else [])],
        }

    try:
        return await loop.run_in_executor(None, _leer)
    except Exception as exc:
        logger.warning(f"No se pudo consultar la Matriz LED para la capa de IA: {exc}")
        return _unavailable("No se pudo consultar la Matriz LED")


async def get_cameras() -> Dict[str, Any]:
    """Cámaras registradas y a qué máquina está atada cada una.

    NO devuelve imagen: eso es get_camera_snapshot, que sigue reservada para
    un modelo multimodal futuro.
    """
    module = get_loaded_plugin_module("camera-viewer", "services.camera_service")
    if module is None:
        return _unavailable("El plugin de Cámaras no está instalado o no está cargado")

    loop = asyncio.get_event_loop()
    try:
        camaras = await loop.run_in_executor(None, module.get_cameras)
    except Exception as exc:
        logger.warning(f"No se pudo consultar las cámaras para la capa de IA: {exc}")
        return _unavailable("No se pudo consultar las cámaras")

    return {
        "count": len(camaras),
        "cameras": [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "bound_device": c.get("bound_device"),
            }
            for c in camaras
        ],
    }


# Extensiones por tipo de trabajo. La biblioteca guarda todo mezclado en dos
# carpetas (models/ y gcode/), así que el filtro por máquina se hace acá.
# Las extensiones NO se declaran acá: son las de NOPAL, definidas en
# backend/api/models.py, y duplicarlas ya salió caro. La lista propia que
# había antes se había quedado sin ".gc", que es justo la extensión de 53 de
# los 57 archivos de una instalación real -- la IA veía cuatro archivos y
# juraba que eso era toda la biblioteca.
from backend.api.models import GCODE_EXTENSIONS, MODEL_EXTENSIONS  # noqa: E402

# Las dos secciones de la biblioteca, tal como las organiza NOPAL:
#   model -> "Modelos 3D": STL/3MF sin laminar Y G-code de impresora listo.
#   gcode -> "Archivos": G-code suelto (típicamente láser y CNC).
# Se recorren SIEMPRE las dos. Antes solo se miraba una según el `kind`, y
# los 48 archivos de impresora guardados en Modelos 3D eran invisibles.
LIBRARY_ROOTS = {"model": "uploads/models", "gcode": "uploads/gcode"}
LIBRARY_SECTION_NAMES = {"model": "Modelos 3D", "gcode": "Archivos"}
MAX_LIBRARY_FILES = 100


def _extensions_for_kind(kind: Optional[str]) -> set:
    """Qué extensiones cuentan para el tipo de máquina pedido.

    La extensión distingue mal entre láser, CNC e impresora: un .gcode vale
    para las tres y en este taller conviven .gc de láser con .gcode de
    impresora. Así que solo se separan las dos familias que sí son
    distintas -- modelos sin laminar contra G-code -- y para elegir máquina
    orienta mejor la carpeta, que va en cada resultado.
    """
    if kind == "model":
        return set(MODEL_EXTENSIONS)
    if kind in ("printer", "laser", "cnc"):
        return set(GCODE_EXTENSIONS)
    return set(MODEL_EXTENSIONS) | set(GCODE_EXTENSIONS)


def _scan_library(kind: Optional[str], search: Optional[str]) -> Dict[str, Any]:
    extensiones = _extensions_for_kind(kind)
    aguja = (search or "").strip().lower()
    encontrados = []

    for seccion, raiz in LIBRARY_ROOTS.items():
        if not os.path.isdir(raiz):
            continue
        for base, _dirs, archivos in os.walk(raiz):
            for nombre in archivos:
                if nombre.startswith("."):
                    continue
                if os.path.splitext(nombre)[1].lower() not in extensiones:
                    continue
                if aguja and aguja not in nombre.lower():
                    continue
                ruta = os.path.join(base, nombre)
                try:
                    stat = os.stat(ruta)
                except OSError:
                    continue
                relativa = os.path.relpath(ruta, raiz)
                carpeta = os.path.dirname(relativa)
                encontrados.append({
                    # Ruta relativa a la sección: es la que aceptan los
                    # endpoints de NOPAL, no la absoluta del disco.
                    "path": relativa,
                    "name": nombre,
                    "section": seccion,
                    "section_name": LIBRARY_SECTION_NAMES.get(seccion, seccion),
                    # La carpeta es lo que de verdad dice para qué máquina es
                    # ("Creador de Formas", "PERROS CON GAFAS").
                    "folder": carpeta or None,
                    "size_mb": round(stat.st_size / (1024 * 1024), 2),
                    "modified_at": int(stat.st_mtime),
                })

    encontrados.sort(key=lambda f: f["modified_at"], reverse=True)
    return {
        "count": len(encontrados),
        "truncated": len(encontrados) > MAX_LIBRARY_FILES,
        "files": encontrados[:MAX_LIBRARY_FILES],
    }


async def get_library(kind: str = "", search: str = "") -> Dict[str, Any]:
    """Archivos de la biblioteca de NOPAL, filtrados por tipo de máquina.

    Recorre las dos secciones de la biblioteca (Modelos 3D y Archivos) y
    devuelve los más recientes primero. `kind`: model deja solo lo sin
    laminar (STL/3MF); printer, laser o cnc dejan solo G-code.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _scan_library, kind, search)


async def get_print_queue() -> Dict[str, Any]:
    """Cola de trabajos de cada impresora Klipper.

    Es la cola de Moonraker, no una lista propia de NOPAL: refleja lo que la
    impresora realmente tiene encolado.
    """
    from backend.services.klipper_service import get_printer_job_queue

    machines = [m for m in await _collect_machines() if m["brand"] == "klipper"]
    loop = asyncio.get_event_loop()

    colas = []
    for machine in machines:
        port = int(str(machine["id"]).split(":", 1)[1])
        try:
            cola = await loop.run_in_executor(None, get_printer_job_queue, port)
        except Exception as exc:
            logger.warning(f"No se pudo leer la cola de {machine['name']}: {exc}")
            continue
        trabajos = cola.get("queued_jobs") or cola.get("jobs") or []
        colas.append({
            "machine_id": machine["id"],
            "name": machine["name"],
            "queued": len(trabajos),
            "jobs": [j.get("filename") or j.get("name") for j in trabajos][:20],
        })

    return {"count": len(colas), "queues": colas}


# --------------------------------------------------------------------------
# Registro
# --------------------------------------------------------------------------

class Tool:
    """Una herramienta de solo lectura ofrecida a la capa de IA.

    `parameters` es un JSON Schema — el mismo formato que espera el campo
    `tools` de la API estilo OpenAI, así que se manda tal cual.
    """

    def __init__(
        self,
        name: str,
        description: str,
        handler: Callable,
        parameters: Optional[Dict[str, Any]] = None,
        exposed: bool = True,
        core: bool = False,
    ):
        self.name = name
        self.description = description
        self.handler = handler
        self.parameters = parameters or {"type": "object", "properties": {}, "required": []}
        self.exposed = exposed
        # `core` marca las herramientas del perfil "compact": las mínimas
        # para responder las preguntas frecuentes del taller. El catálogo
        # completo son ~1260 tokens de esquema que el modelo tiene que leer
        # ANTES de empezar a pensar, y en un servidor de IA modesto eso es
        # el grueso del tiempo de respuesta. Ver `tool_profile` en
        # ai_config_service.py.
        self.core = core

    def to_openai_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


_MACHINE_ID_PARAM = {
    "type": "object",
    "properties": {
        "machine_id": {
            "type": "string",
            "description": "Id o nombre de la máquina, por ejemplo 'klipper:7125', "
                           "'laser:192.168.0.61' o 'TTS 55 PRO'.",
        }
    },
    "required": ["machine_id"],
}


TOOLS: Dict[str, Tool] = {
    tool.name: tool
    for tool in [
        Tool(
            "get_workshop_status",
            "Panorama general del taller: salud del sistema, host, conteo de máquinas por tipo, "
            "trabajos activos y alertas. Es la herramienta con la que conviene empezar casi siempre.",
            get_workshop_status,
            core=True,
        ),
        Tool(
            "get_machines",
            "Lista todas las máquinas registradas (impresoras 3D, láser, CNC) con su id, nombre y "
            "si están en línea.",
            get_machines,
            core=True,
        ),
        Tool(
            "get_machine_status",
            "Estado detallado de una máquina puntual, incluido su trabajo actual si tiene uno.",
            get_machine_status,
            _MACHINE_ID_PARAM,
            core=True,
        ),
        Tool(
            "get_machine_temperatures",
            "Temperaturas actuales y objetivo de una máquina. Láser y CNC no reportan temperatura.",
            get_machine_temperatures,
            _MACHINE_ID_PARAM,
        ),
        Tool(
            "get_active_jobs",
            "Trabajos que están imprimiendo, grabando o cortando ahora mismo, con su porcentaje de avance.",
            get_active_jobs,
        ),
        Tool(
            "get_job_progress",
            "Avance del trabajo activo de una máquina puntual.",
            get_job_progress,
            _MACHINE_ID_PARAM,
        ),
        Tool(
            "get_recent_errors",
            "Problemas activos en este momento: máquinas desconectadas, trabajos en error o pausados, "
            "accesorios que no responden.",
            get_recent_errors,
            core=True,
        ),
        Tool(
            "get_recent_events",
            "Últimos eventos del log de NOPAL. Útil para saber qué pasó antes de una falla.",
            get_recent_events,
            {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Cuántos eventos devolver (1-200, por omisión 30)."},
                    "level": {"type": "string", "enum": ["INFO", "WARNING", "ERROR"],
                              "description": "Filtrar por nivel. Omitir para todos."},
                },
                "required": [],
            },
        ),
        Tool(
            "get_klipper_status",
            "Estado crudo de Klipper/Moonraker de una impresora Klipper, incluido el mensaje de error "
            "de Klippy. Es la herramienta correcta para diagnosticar por qué una impresora Klipper "
            "está detenida.",
            get_klipper_status,
            _MACHINE_ID_PARAM,
            core=True,
        ),
        Tool(
            "get_grbl_status",
            "Estado crudo del controlador GRBL/FluidNC de un láser o CNC.",
            get_grbl_status,
            _MACHINE_ID_PARAM,
        ),
        Tool(
            "get_library",
            "Archivos de la biblioteca de NOPAL (Modelos 3D y Archivos), los más recientes "
            "primero. kind='model' deja solo lo sin laminar (STL/3MF); 'printer', 'laser' o "
            "'cnc' dejan solo G-code. Ojo: la extensión NO distingue láser de impresora, un "
            ".gcode sirve para ambas; para eso orienta el campo 'folder'. Usa 'search' para "
            "buscar por nombre en vez de listar todo.",
            get_library,
            {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["printer", "laser", "cnc", "model"],
                             "description": "Tipo de máquina para el que sirve el archivo."},
                    "search": {"type": "string", "description": "Filtra por parte del nombre."},
                },
                "required": [],
            },
        ),
        Tool(
            "get_print_queue",
            "Cola de trabajos encolados en cada impresora Klipper.",
            get_print_queue,
        ),
        Tool(
            "get_plugins",
            "Lista los plugins instalados en NOPAL y si están habilitados. Úsala cuando te pregunten "
            "qué puede hacer NOPAL, o antes de decir que algo no se puede: puede haber un plugin que "
            "ya lo resuelva.",
            get_plugins,
            core=True,
        ),
        Tool(
            "get_accessories",
            "Accesorios del taller: relés, tiras LED, ventiladores, sensores y placas Arduino/ESP32, "
            "con su estado de encendido. Si 'responding' es false, el accesorio no contestó — no está "
            "apagado, está incomunicado.",
            get_accessories,
        ),
        Tool(
            "get_scenes",
            "Escenas de ACCESORIOS (tiras LED, relés, ventiladores) guardadas, con su id y nombre. "
            "NO son los anuncios de la Matriz LED, que es otro plugin: para eso usa get_led_matrix. "
            "Consúltala antes de activar una escena de accesorios.",
            get_scenes,
        ),
        Tool(
            "get_led_matrix",
            "Matriz LED: su estado, sus ANUNCIOS guardados, sus REGLAS de automatización y sus "
            "ALERTAS POR MÁQUINA (qué anuncio se muestra en cada estado de cada máquina). Es un "
            "plugin distinto al de accesorios: si te preguntan por la matriz, su pantalla, sus "
            "anuncios, sus reglas o sus alertas por máquina, usa esta y NO get_scenes. Nunca "
            "supongas ids de la matriz: solo existen los que devuelve esta herramienta.",
            get_led_matrix,
        ),
        Tool(
            "get_cameras",
            "Cámaras registradas y a qué máquina está atada cada una. No devuelve imagen.",
            get_cameras,
        ),
        Tool(
            "get_material_status",
            "Inventario de filamento del plugin de Materiales (Spoolman), con qué spools están por acabarse.",
            get_material_status,
        ),
        Tool(
            "get_camera_snapshot",
            "Reservada para un modelo multimodal futuro; todavía no devuelve imagen.",
            get_camera_snapshot,
            _MACHINE_ID_PARAM,
            exposed=False,
        ),
    ]
}


def _plugin_tools() -> List["Tool"]:
    """Herramientas que los propios plugins declaran (ver
    plugin_loader_service.get_plugin_ai_tools). Un plugin puede así exponer
    sus datos a la IA sin que el core tenga que conocerlo.

    Las del core ganan ante un choque de nombres: un plugin no debe poder
    sustituir una herramienta central por una suya.
    """
    from backend.services.plugin_loader_service import get_plugin_ai_tools

    validas = []
    for tool in get_plugin_ai_tools():
        if not isinstance(tool, Tool):
            logger.warning("Un plugin declaró en AI_TOOLS algo que no es un Tool, se omite")
            continue
        if tool.name in TOOLS:
            logger.warning(f"El plugin quiso redefinir la herramienta '{tool.name}' del core, se omite")
            continue
        validas.append(tool)
    return validas


def get_exposed_tools(profile: str = "full") -> List[Tool]:
    """Las herramientas que se le ofrecen al modelo (excluye las reservadas).

    `profile="compact"` deja solo las marcadas como `core`. El catálogo
    completo cuesta ~1260 tokens de esquema que el modelo debe leer antes
    de razonar; en un servidor de IA modesto eso domina el tiempo de
    respuesta. El perfil compacto lo baja a ~570 y sigue cubriendo las
    preguntas frecuentes ("¿cómo está el taller?", "¿por qué está detenida
    X?"). Lo que se pierde son las consultas finas: temperaturas, avance
    por máquina, GRBL, materiales y eventos del log.
    """
    tools = [tool for tool in TOOLS.values() if tool.exposed]
    if profile == "compact":
        # El perfil compacto se queda solo con el núcleo: las de plugins son
        # justo las que sobran cuando el servidor de IA es lento.
        return [tool for tool in tools if tool.core]
    return tools + [t for t in _plugin_tools() if t.exposed]


def get_tools_schema(profile: str = "full") -> List[Dict[str, Any]]:
    return [tool.to_openai_schema() for tool in get_exposed_tools(profile)]


async def call_tool(name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Ejecuta una herramienta por nombre. Un nombre desconocido o un
    argumento inválido devuelven un error estructurado en vez de levantar
    excepción: el ciclo del agente se lo pasa al modelo para que se
    corrija en la vuelta siguiente."""
    tool = TOOLS.get(name) or next((t for t in _plugin_tools() if t.name == name), None)
    if tool is None or not tool.exposed:
        return {"error": "unknown_tool", "requested": name, "available": sorted(t.name for t in get_exposed_tools())}

    arguments = arguments or {}
    allowed = set((tool.parameters.get("properties") or {}).keys())
    filtered = {k: v for k, v in arguments.items() if k in allowed}
    missing = [k for k in tool.parameters.get("required", []) if k not in filtered]
    if missing:
        return {"error": "missing_arguments", "tool": name, "missing": missing}

    try:
        return await tool.handler(**filtered)
    except Exception as exc:
        logger.exception(f"Falló la herramienta de IA '{name}'")
        return {"error": "tool_failed", "tool": name, "detail": str(exc)}
