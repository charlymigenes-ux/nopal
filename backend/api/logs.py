from fastapi import APIRouter, Depends

from backend.auth_deps import require_auth
from backend.config import LOG_FILE

router = APIRouter()


@router.get("/api/logs")
async def get_logs(lines: int = 500, level: str = "", user: dict = Depends(require_auth)):
    """Últimas N líneas del log de NOPAL, opcionalmente filtradas por nivel
    (INFO/WARNING/ERROR/DEBUG). Lee el archivo entero y recorta al final —
    con el tope de 5MB por rotación (ver config.py) esto es cuestión de
    milisegundos, no hace falta un tail-seek más elaborado."""
    try:
        with open(LOG_FILE, "r", encoding="utf-8", errors="ignore") as f:
            all_lines = f.readlines()
    except FileNotFoundError:
        return {"lines": []}

    tail = all_lines[-lines:] if lines > 0 else all_lines
    if level:
        needle = f" {level.upper()} "
        tail = [line for line in tail if needle in line]
    return {"lines": [line.rstrip("\n") for line in tail]}
