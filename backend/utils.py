import subprocess
from pathlib import Path

from fastapi import HTTPException

UPLOAD_FOLDER = "uploads"
MODELS_ROOT = "uploads/models"
GCODE_ROOT = "uploads/gcode"


def get_app_version() -> str:
    """Versión semántica de la app (archivo VERSION en la raíz del proyecto)."""
    try:
        return Path("VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0"


def get_section_root(section: str) -> str:
    return GCODE_ROOT if section == "gcode" else MODELS_ROOT


def is_git_update_available(timeout: int = 6) -> bool:
    """Chequeo liviano de si el remoto tiene commits nuevos — usado por las
    notificaciones. No repite la lógica completa de /api/system/version (que
    además informa ahead/pending_commits para esa pantalla), acá solo
    interesa el booleano, así que es una función aparte y no una que ese
    endpoint reutilice."""
    try:
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        branch = branch_result.stdout.strip() or "main"

        fetch_result = subprocess.run(
            ["git", "fetch", "--quiet", "origin", branch],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        if fetch_result.returncode != 0:
            return False

        counts_result = subprocess.run(
            ["git", "rev-list", "--left-right", "--count", f"HEAD...origin/{branch}"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        parts = counts_result.stdout.split()
        if len(parts) == 2:
            return int(parts[1]) > 0
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return False


def safe_section_path(section: str, relative_path: str = "") -> str:
    """Resuelve `relative_path` dentro de la raíz de la sección (models/gcode),
    evitando path traversal."""
    base = Path(get_section_root(section)).resolve()
    target = (base / (relative_path or "")).resolve()
    if target != base and base not in target.parents:
        raise HTTPException(status_code=400, detail="Ruta inválida")
    return str(target)
