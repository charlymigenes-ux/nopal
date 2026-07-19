"""Instalación/actualización/desinstalación de plugins externos vía git.

Cada plugin instalable es un repo de git aparte (ver `repo_url` en
backend/plugin_catalog.json) que se clona a PLUGINS_DIR/<id>/, una carpeta
fuera del control de versiones de NOPAL (ver .gitignore). Mismo patrón que
el autoupdate de NOPAL (backend/api/status.py: fetch + pull --ff-only +
comparar SHAs), adaptado para operar sobre cualquier carpeta de
plugins/<id>/ en vez del propio repo de NOPAL -- por eso usa `git -C <dir>`
en cada llamada en vez de depender del cwd del proceso, y no se importa
desde acá el `_run_git` de status.py (ese es específicamente sobre el
propio checkout de NOPAL).
"""

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

PLUGINS_DIR = Path("plugins")
MANIFEST_FILENAME = "nopal-plugin.json"
CLONE_TIMEOUT = 60
GIT_TIMEOUT = 20

# Estado de instalación (qué plugins están instalados/habilitados) -- vive
# acá (capa de servicio) y no en backend/api/plugins.py a propósito, para
# que backend/services/plugin_loader_service.py (que arranca antes que
# cualquier router, en el startup de la app) pueda leerlo sin depender de
# la capa de API.
PLUGIN_DATA_DIR = Path(os.getenv("NOPAL_PLUGIN_DATA_DIR", "data/plugins"))
INSTALLED_FILE = PLUGIN_DATA_DIR / "installed.json"


def read_installed_state() -> Dict[str, Dict[str, Any]]:
    try:
        payload = json.loads(INSTALLED_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def write_installed_state(installed: Dict[str, Dict[str, Any]]) -> None:
    PLUGIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary = INSTALLED_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(installed, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(INSTALLED_FILE)


def _run_git(args: List[str], cwd: Optional[Path] = None, timeout: int = GIT_TIMEOUT) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True, text=True, timeout=timeout,
            cwd=str(cwd) if cwd else None,
        )
        if result.returncode != 0:
            logger.warning(f"git {' '.join(args)} falló: {result.stderr.strip()}")
            return None
        return result.stdout.strip()
    except Exception as e:
        logger.warning(f"git {' '.join(args)} falló: {e}")
        return None


def read_manifest(plugin_id: str) -> Optional[Dict[str, Any]]:
    manifest_path = PLUGINS_DIR / plugin_id / MANIFEST_FILENAME
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning(f"No se pudo leer el manifest de {plugin_id}: {e}")
        return None


def is_cloned(plugin_id: str) -> bool:
    return (PLUGINS_DIR / plugin_id / MANIFEST_FILENAME).is_file()


def clone(plugin_id: str, repo_url: str) -> Dict[str, Any]:
    """Clona el repo del plugin a plugins/<id>/. No pisa una instalación ya
    existente -- hay que desinstalar primero para reinstalar desde cero."""
    PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
    target = PLUGINS_DIR / plugin_id
    if target.exists():
        return {"success": False, "error": "Ya existe una carpeta para este plugin -- desinstalalo primero"}

    output = _run_git(["clone", "--depth", "1", repo_url, str(target)], timeout=CLONE_TIMEOUT)
    if output is None:
        return {"success": False, "error": f"No se pudo clonar {repo_url} -- revisá la URL y la conexión"}

    manifest = read_manifest(plugin_id)
    if manifest is None:
        # No dejar una carpeta a medio instalar -- o el manifest es válido
        # y el plugin queda usable, o no queda rastro.
        shutil.rmtree(target, ignore_errors=True)
        return {"success": False, "error": "El repo no tiene un nopal-plugin.json válido en la raíz"}

    return {"success": True, "manifest": manifest}


def update(plugin_id: str) -> Dict[str, Any]:
    """Igual que update_app_endpoint en status.py pero sobre plugins/<id>/:
    fetch + pull --ff-only, compara SHAs antes/después, informa si cambió
    algo bajo backend/ (eso requiere reiniciar NOPAL a mano para tomar el
    código nuevo -- acá no se auto-reinicia el proceso por un plugin)."""
    target = PLUGINS_DIR / plugin_id
    if not target.is_dir():
        return {"success": False, "error": "El plugin no está instalado"}

    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=target) or "main"
    before_sha = _run_git(["rev-parse", "HEAD"], cwd=target)
    if before_sha is None:
        return {"success": False, "error": "No se pudo leer el estado actual del plugin"}

    if _run_git(["fetch", "--quiet", "origin", branch], cwd=target) is None:
        return {"success": False, "error": "No se pudo conectar con el repo del plugin"}

    if _run_git(["pull", "--ff-only", "origin", branch], cwd=target) is None:
        return {"success": False, "error": "No se pudo actualizar (¿hay cambios locales o el historial divergió?)"}

    after_sha = _run_git(["rev-parse", "HEAD"], cwd=target)
    manifest = read_manifest(plugin_id)
    if manifest is None:
        return {"success": False, "error": "El plugin quedó en un estado inconsistente tras actualizar (sin manifest válido)"}

    if before_sha == after_sha:
        return {"success": True, "updated": False, "manifest": manifest}

    log_output = _run_git(["log", "--oneline", f"{before_sha}..{after_sha}"], cwd=target) or ""
    commits = [line for line in log_output.splitlines() if line.strip()]
    backend_diff = _run_git(["diff", "--name-only", before_sha, after_sha, "--", "backend/"], cwd=target)
    backend_changed = bool(manifest.get("backend", {}).get("entry")) and bool(backend_diff)

    return {
        "success": True, "updated": True, "commits": commits,
        "manifest": manifest, "backend_changed": backend_changed,
    }


def remove(plugin_id: str) -> bool:
    target = PLUGINS_DIR / plugin_id
    if not target.is_dir():
        return False
    shutil.rmtree(target, ignore_errors=True)
    return True
