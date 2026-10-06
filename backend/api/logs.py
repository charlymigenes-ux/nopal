"""Consola del sistema: lectura del registro de NOPAL (ver log_viewer_service).

Lectura para cualquier sesión (operador incluido), igual que antes.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from backend.auth_deps import require_auth
from backend.services import log_viewer_service

router = APIRouter()


@router.get("/api/logs")  # def (no async): la lectura de archivo corre en el pool de hilos
def get_logs(file: int = 0, component: str = "", level: str = "", q: str = "",
             limit: Optional[int] = None, lines: Optional[int] = None,
             after: Optional[int] = None, file_id: str = "",
             user: dict = Depends(require_auth)):
    # `lines` es el nombre anterior de `limit`; se sigue aceptando.
    if limit is None:
        limit = lines if lines is not None else log_viewer_service.DEFAULT_LIMIT
    try:
        return log_viewer_service.read_entries(file=file, component=component, level=level, q=q,
                                               limit=limit, after=after, file_id=file_id)
    except log_viewer_service.LogViewerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except log_viewer_service.LogFileNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
