import json
import logging
import os
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


def _load_temperature_presets() -> dict:
    try:
        with open(TEMP_PRESETS_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


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
    """Temperaturas preestablecidas (globales) por heater, usadas por el botón PREESTAB."""
    return _load_temperature_presets()


@router.post("/api/system/temperature-presets")
async def set_temperature_presets_endpoint(presets: str = Form(...), user: dict = Depends(require_role("admin"))):
    """Guarda las temperaturas preestablecidas por heater (JSON: {heater: target})."""
    try:
        parsed = json.loads(presets)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="JSON inválido")
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Formato inválido")
    _save_temperature_presets(parsed)
    return {"success": True}


@router.get("/api/system/version")
async def get_version_endpoint(user: dict = Depends(require_auth)):
    """Versión actual (commit de git) y si hay una actualización disponible en el remoto."""
    local_sha = _run_git(["rev-parse", "--short", "HEAD"])
    commit_date = _run_git(["log", "-1", "--format=%cI"])
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"]) or "main"

    status_value = "unknown"
    ahead = 0
    behind = 0
    pending_commits = []

    fetched = _run_git(["fetch", "--quiet", "origin", branch]) is not None
    if fetched:
        counts = _run_git(["rev-list", "--left-right", "--count", f"HEAD...origin/{branch}"])
        if counts:
            parts = counts.split()
            if len(parts) == 2:
                ahead, behind = int(parts[0]), int(parts[1])
        status_value = "update_available" if behind > 0 else "up_to_date"

        if behind > 0:
            log_output = _run_git(["log", "--oneline", f"HEAD..origin/{branch}"]) or ""
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

    _run_git(["fetch", "--quiet", "origin", branch])
    pull_output = _run_git(["pull", "--ff-only", "origin", branch])
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
