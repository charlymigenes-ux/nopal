import json
import logging
import os
import shutil
import subprocess
from typing import Optional
from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services.klipper_service import get_system_stats, get_temperature_snapshot, set_heater_target, get_toolhead_status
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
    upload_folder = "uploads"

    # Create uploads folder if it doesn't exist
    if not os.path.exists(upload_folder):
        os.makedirs(upload_folder)

    # Get disk space info
    stat = shutil.disk_usage(upload_folder)

    # Calculate used space recursively (los archivos viven en uploads/models y uploads/gcode)
    used_bytes = 0
    for root, _dirs, files in os.walk(upload_folder):
        for filename in files:
            filepath = os.path.join(root, filename)
            if os.path.isfile(filepath):
                used_bytes += os.path.getsize(filepath)

    return {
        "used": used_bytes,
        "free": stat.free,
        "total": stat.total,
    }


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
async def update_app_endpoint(user: dict = Depends(require_role("admin"))):
    """Aplica `git pull --ff-only` para traer la última versión del repositorio."""
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"]) or "main"

    dirty = _run_git(["status", "--porcelain"])
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
        return {"success": True, "updated": False, "commits": [], "app_version": get_app_version()}

    log_output = _run_git(["log", "--oneline", f"{before_sha}..{after_sha}"]) or ""
    commits = [line for line in log_output.splitlines() if line.strip()]

    return {
        "success": True,
        "updated": True,
        "commits": commits,
        "app_version": get_app_version(),
    }
