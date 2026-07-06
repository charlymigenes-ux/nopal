from pathlib import Path

from fastapi import HTTPException

UPLOAD_FOLDER = "uploads"
MODELS_ROOT = "uploads/models"
GCODE_ROOT = "uploads/gcode"


def get_section_root(section: str) -> str:
    return GCODE_ROOT if section == "gcode" else MODELS_ROOT


def safe_section_path(section: str, relative_path: str = "") -> str:
    """Resuelve `relative_path` dentro de la raíz de la sección (models/gcode),
    evitando path traversal."""
    base = Path(get_section_root(section)).resolve()
    target = (base / (relative_path or "")).resolve()
    if target != base and base not in target.parents:
        raise HTTPException(status_code=400, detail="Ruta inválida")
    return str(target)
