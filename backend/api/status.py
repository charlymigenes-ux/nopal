import json
import logging
import os
import platform
import subprocess
import time
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services.klipper_service import (
    get_all_printers_status,
    get_system_stats,
    get_temperature_snapshot,
    get_toolhead_status,
    set_heater_target,
)
from backend.services.laser_service import get_active_job_hosts
from backend.services.marlin_printer_service import get_active_job_devices
from backend.services.dashboard_service import get_storage_snapshot
from backend.utils import get_app_version

logger = logging.getLogger(__name__)
router = APIRouter()

TEMP_PRESETS_PATH = "temperature_presets.json"
DEFAULT_MATERIAL_PRESETS = {
    "active": "pla",
    "materials": [
        {"id": "pla", "name": "PLA", "heater_bed": 60, "extruder": 200},
        {"id": "petg", "name": "PETG", "heater_bed": 75, "extruder": 235},
        {"id": "abs", "name": "ABS", "heater_bed": 100, "extruder": 245},
        {"id": "tpu", "name": "TPU", "heater_bed": 50, "extruder": 220},
    ],
}


def _load_temperature_presets() -> dict:
    try:
        with open(TEMP_PRESETS_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            if isinstance(data, dict) and isinstance(data.get("materials"), list):
                return data
            # Compatibilidad con el formato histórico {heater_bed, extruder}.
            if isinstance(data, dict) and data:
                legacy = dict(DEFAULT_MATERIAL_PRESETS)
                legacy["materials"] = [
                    {"id": "personalizado", "name": "Personalizado", **data},
                    *[dict(item) for item in DEFAULT_MATERIAL_PRESETS["materials"]],
                ]
                legacy["active"] = "personalizado"
                return legacy
            return DEFAULT_MATERIAL_PRESETS
    except (FileNotFoundError, json.JSONDecodeError):
        return DEFAULT_MATERIAL_PRESETS


def _save_temperature_presets(presets: dict) -> None:
    with open(TEMP_PRESETS_PATH, "w", encoding="utf-8") as handle:
        json.dump(presets, handle, indent=2, ensure_ascii=False)


def _run_git(args, timeout: int = 6) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip()
    except Exception:
        return None


def _remote_branch_name(local_branch: str) -> str:
    """Nombre de la rama remota a la que le hace push/pull `local_branch`.
    Normalmente es el mismo nombre, pero un checkout puede tener una rama
    local que trackea una remota con otro nombre (`branch.<x>.merge` en la
    config de git) -- usar el nombre local a secas ahí hace que git fetch
    busque una rama remota que no existe."""
    upstream = _run_git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    if upstream and "/" in upstream:
        return upstream.split("/", 1)[1]
    return local_branch


def _collect_active_machine_jobs() -> list[str]:
    """Devuelve trabajos que hacen inseguro actualizar o reiniciar NOPAL.

    No intenta pausarlos ni cancelarlos: la actualización se rechaza y la
    persona conserva el control explícito de la máquina.
    """
    active_jobs: list[str] = []

    for job in get_active_job_hosts():
        label = job.get("filename") or job.get("host") or "Láser/CNC"
        active_jobs.append(f"Láser/CNC: {label} ({job.get('state', 'activo')})")

    for job in get_active_job_devices():
        label = job.get("filename") or job.get("device") or "Impresora Marlin"
        active_jobs.append(f"Marlin: {label} ({job.get('state', 'activo')})")

    try:
        for printer in get_all_printers_status():
            job = printer.get("job") or {}
            state = str(job.get("state") or "").lower()
            if state in {"printing", "paused"}:
                label = job.get("filename") or printer.get("name") or "Impresora Klipper"
                active_jobs.append(f"Klipper: {label} ({state})")
    except Exception:
        # La confirmación de seguridad en pantalla sigue cubriendo equipos
        # externos o temporalmente inaccesibles; dejamos registro del fallo.
        logger.exception("No se pudo verificar el estado de las impresoras Klipper")

    return active_jobs


def _is_systemd_managed() -> bool:
    return bool(os.environ.get("INVOCATION_ID") or os.environ.get("JOURNAL_STREAM"))


def _restart_after_response() -> None:
    """Finaliza con error controlado para que Restart=on-failure lo levante."""
    time.sleep(1.0)
    logger.warning("Reiniciando NOPAL para aplicar la actualización")
    os._exit(75)


def _install_dependencies(timeout: int = 180) -> bool:
    """Corre pip install -r requirements.txt después de un git pull -- sin
    esto, un update que agrega una dependencia nueva (ej. paho-mqtt para
    Bambu Lab) deja el proceso sin poder arrancar tras el reinicio: el
    código nuevo ya está en disco pero el paquete que importa nunca se
    instaló. Ruta del pip relativa al cwd del proceso (WorkingDirectory del
    servicio systemd es la raíz del repo, mismo criterio que _run_git)."""
    pip_path = os.path.join(".venv", "bin", "pip")
    if not os.path.isfile(pip_path):
        # Entorno sin venv estándar (ej. desarrollo) -- no bloquea el update,
        # pero tampoco instala nada por su cuenta.
        return True
    try:
        result = subprocess.run(
            [pip_path, "install", "-q", "-r", "requirements.txt"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            logger.error(f"pip install falló tras el update: {result.stderr[-2000:]}")
        return result.returncode == 0
    except Exception:
        logger.exception("No se pudieron instalar las dependencias tras la actualización")
        return False


@router.get("/api/status")
async def status(user: dict = Depends(require_auth)):
    return {
        "status": "online",
        "version": "0.1",
        "models": 0,
    }


@router.get("/api/storage")
async def get_storage(user: dict = Depends(require_auth)):
    """Get disk storage information"""
    return get_storage_snapshot()


@router.get("/api/system/stats")
async def get_system_stats_endpoint(port: Optional[int] = None, user: dict = Depends(require_auth)):
    """Estadísticas de hardware (MCU + host) de la impresora indicada."""
    try:
        return get_system_stats(port=port)
    except Exception as e:
        logger.exception(f"Error al leer estadísticas del sistema (puerto {port})")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/system/temperatures")
async def get_temperatures_endpoint(port: int, user: dict = Depends(require_auth)):
    """Temperaturas actuales/objetivo e historial de la impresora indicada."""
    try:
        return get_temperature_snapshot(port=port)
    except Exception as e:
        logger.exception(f"Error al leer temperaturas (puerto {port})")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/system/temperature-target")
async def set_temperature_target_endpoint(
    port: int = Form(...), heater: str = Form(...), target: float = Form(...),
    user: dict = Depends(require_role("admin")),
):
    """Actualiza la temperatura objetivo de un heater (extruder, heater_bed, etc.)."""
    success = set_heater_target(port=port, heater=heater, target=target)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo actualizar la temperatura objetivo")
    return {"success": True}


@router.get("/api/system/toolhead")
async def get_toolhead_endpoint(port: int, user: dict = Depends(require_auth)):
    """Posición actual del cabezal, ejes homeados, factor de velocidad y offset Z."""
    try:
        return get_toolhead_status(port=port)
    except Exception as e:
        logger.exception(f"Error al leer el cabezal (puerto {port})")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/system/temperature-presets")
async def get_temperature_presets_endpoint(user: dict = Depends(require_auth)):
    """Perfiles de precalentamiento por material para Klipper y Marlin."""
    return _load_temperature_presets()


@router.post("/api/system/temperature-presets")
async def set_temperature_presets_endpoint(presets: str = Form(...), user: dict = Depends(require_role("admin"))):
    """Guarda perfiles: {active, materials:[{id,name,heater_bed,extruder}]}"""
    try:
        parsed = json.loads(presets)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="JSON inválido")
    if not isinstance(parsed, dict) or not isinstance(parsed.get("materials"), list):
        raise HTTPException(status_code=400, detail="Formato inválido")
    materials = []
    for index, material in enumerate(parsed["materials"]):
        if not isinstance(material, dict):
            raise HTTPException(status_code=400, detail="Material inválido")
        name = str(material.get("name") or "").strip()[:40]
        material_id = str(material.get("id") or f"material-{index + 1}").strip()[:40]
        if not name or not material_id:
            raise HTTPException(status_code=400, detail="Cada material necesita nombre")
        normalized = {"id": material_id, "name": name}
        for heater in ("heater_bed", "extruder"):
            try:
                value = float(material.get(heater, 0))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Temperatura inválida")
            if value < 0 or value > 400:
                raise HTTPException(status_code=400, detail="Temperatura fuera de rango")
            normalized[heater] = value
        materials.append(normalized)
    if not materials:
        raise HTTPException(status_code=400, detail="Agrega al menos un material")
    active = str(parsed.get("active") or materials[0]["id"])
    if active not in {item["id"] for item in materials}:
        active = materials[0]["id"]
    _save_temperature_presets({"active": active, "materials": materials})
    return {"success": True}


@router.get("/api/system/version")
async def get_version_endpoint(user: dict = Depends(require_auth)):
    """Versión actual (commit de git) y si hay una actualización disponible en el remoto."""
    local_sha = _run_git(["rev-parse", "--short", "HEAD"])
    commit_date = _run_git(["log", "-1", "--format=%cI"])
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"]) or "main"
    remote_branch = _remote_branch_name(branch)

    status_value = "unknown"
    ahead = 0
    behind = 0
    pending_commits = []

    fetched = _run_git(["fetch", "--quiet", "origin", remote_branch]) is not None
    if fetched:
        counts = _run_git(["rev-list", "--left-right", "--count", f"HEAD...origin/{remote_branch}"])
        if counts:
            parts = counts.split()
            if len(parts) == 2:
                ahead, behind = int(parts[0]), int(parts[1])
        status_value = "update_available" if behind > 0 else "up_to_date"

        if behind > 0:
            log_output = _run_git(["log", "--oneline", f"HEAD..origin/{remote_branch}"]) or ""
            pending_commits = [line for line in log_output.splitlines() if line.strip()]

    return {
        "app_version": get_app_version(),
        "commit": local_sha or "unknown",
        "date": commit_date,
        "branch": branch,
        "status": status_value,
        "ahead": ahead,
        "behind": behind,
        "pending_commits": pending_commits,
    }


def _os_description() -> str:
    """Distribución + versión legible (ej. "Debian GNU/Linux 13"), no solo
    `platform.system()` ("Linux" a secas no ayuda a diagnosticar nada). Usa
    /etc/os-release (estándar en Linux moderno) y cae a system+release si
    no está disponible (otro SO, o un os-release atípico)."""
    try:
        info = platform.freedesktop_os_release()
        name = info.get("NAME")
        version = info.get("VERSION_ID") or info.get("VERSION")
        if name:
            return f"{name} {version}".strip() if version else name
    except (OSError, AttributeError):
        pass
    return f"{platform.system()} {platform.release()}".strip()


@router.get("/api/system/diagnostics")
async def get_diagnostics_endpoint(user: dict = Depends(require_auth)):
    """Info de "Acerca de NOPAL": versión, commit/rama de git (si el
    checkout es un repo git; si no, "unavailable" -- NOPAL puede correr
    desde un .zip descargado, sin .git), sistema operativo, arquitectura y
    versión de Python. El idioma activo NO va acá: es un dato 100% del
    navegador (currentLanguage en translations.js), no algo que el
    servidor pueda saber.

    Mismo _run_git que /api/system/version (git ausente o "no es un repo
    git" ya caen limpio a None ahí, no hace falta duplicar el chequeo)."""
    commit = _run_git(["rev-parse", "--short", "HEAD"])
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    return {
        "app_version": get_app_version(),
        "commit": commit,  # None si no hay git -- el frontend decide cómo mostrarlo
        "branch": branch,
        "os": _os_description(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
    }


@router.post("/api/system/update")
async def update_app_endpoint(
    background_tasks: BackgroundTasks,
    user: dict = Depends(require_role("admin")),
):
    """Aplica `git pull --ff-only` para traer la última versión del repositorio."""
    active_jobs = _collect_active_machine_jobs()
    if active_jobs:
        summary = "; ".join(active_jobs[:4])
        if len(active_jobs) > 4:
            summary += f"; y {len(active_jobs) - 4} más"
        raise HTTPException(
            status_code=409,
            detail=f"Actualización bloqueada: hay trabajos activos. Deténlos de forma segura antes de continuar. {summary}",
        )

    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"]) or "main"
    remote_branch = _remote_branch_name(branch)

    # Datos, cargas y respaldos locales suelen ser directorios no rastreados y
    # no deben impedir una actualización. Sí bloqueamos cualquier modificación
    # de archivos que ya forman parte del repositorio.
    dirty = _run_git(["status", "--porcelain", "--untracked-files=no"])
    if dirty:
        raise HTTPException(
            status_code=409,
            detail="Hay cambios locales sin guardar en el servidor. Guárdalos o descártalos antes de actualizar.",
        )

    before_sha = _run_git(["rev-parse", "HEAD"])
    if before_sha is None:
        raise HTTPException(status_code=500, detail="No se pudo leer el estado de git")

    _run_git(["fetch", "--quiet", "origin", remote_branch])
    pull_output = _run_git(["pull", "--ff-only", "origin", remote_branch])
    if pull_output is None:
        raise HTTPException(
            status_code=502,
            detail="No se pudo actualizar (sin conexión, o el historial local y el remoto ya no coinciden).",
        )

    after_sha = _run_git(["rev-parse", "HEAD"])

    if before_sha == after_sha:
        return {
            "success": True,
            "updated": False,
            "commits": [],
            "app_version": get_app_version(),
            "restart_scheduled": False,
        }

    log_output = _run_git(["log", "--oneline", f"{before_sha}..{after_sha}"]) or ""
    commits = [line for line in log_output.splitlines() if line.strip()]

    # Si requirements.txt no cambió, no vale la pena esperar el pip install
    # (~segundos) para nada -- solo se corre cuando el pull realmente lo tocó.
    requirements_changed = bool(_run_git(["diff", "--name-only", before_sha, after_sha, "--", "requirements.txt"]))
    deps_installed = _install_dependencies() if requirements_changed else True

    # Si la instalación de dependencias falla, NO se programa el reinicio:
    # el proceso viejo (que sigue corriendo, todavía con el código anterior
    # cargado en memoria) sigue sirviendo mientras tanto -- reiniciar ahora
    # solo produciría el mismo crash-loop por ImportError que esto previene.
    restart_scheduled = _is_systemd_managed() and deps_installed
    if restart_scheduled:
        background_tasks.add_task(_restart_after_response)

    return {
        "success": True,
        "updated": True,
        "commits": commits,
        "app_version": get_app_version(),
        "restart_scheduled": restart_scheduled,
        "dependency_install_failed": requirements_changed and not deps_installed,
    }
