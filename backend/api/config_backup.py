"""Exportar e importar la configuración de NOPAL.

Todo admin-only: un respaldo puede llevar usuarios y claves de API, e
importar sobrescribe la configuración de la instalación entera.
"""

import logging

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from backend.auth_deps import require_role
from backend.services import config_backup_service as backup
from backend.services.config_backup_service import BackupError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/config-backup", tags=["config-backup"])


@router.get("/groups")
async def list_groups_endpoint(user: dict = Depends(require_role("admin"))):
    """Qué se puede respaldar, y cuáles existen en esta instalación."""
    return backup.list_groups()


@router.post("/export")
async def export_endpoint(
    payload: dict = Body(...),
    user: dict = Depends(require_role("admin")),
):
    try:
        contenido = backup.export_config(payload.get("groups") or [], payload.get("passphrase") or "")
    except BackupError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    from datetime import datetime

    nombre = f"nopal-config-{datetime.now().strftime('%Y%m%d-%H%M')}.nopal"
    return Response(
        content=contenido,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{nombre}"'},
    )


@router.post("/inspect")
async def inspect_endpoint(
    file: UploadFile = File(...),
    passphrase: str = Form(""),
    user: dict = Depends(require_role("admin")),
):
    """Qué trae el respaldo, sin escribir nada. La persona tiene derecho a
    ver qué va a sobrescribir antes de aceptarlo."""
    try:
        return backup.inspect_backup(await file.read(), passphrase)
    except BackupError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/import")
async def import_endpoint(
    file: UploadFile = File(...),
    groups: str = Form(...),
    passphrase: str = Form(""),
    user: dict = Depends(require_role("admin")),
):
    seleccionados = [g.strip() for g in groups.split(",") if g.strip()]
    try:
        return backup.import_config(await file.read(), seleccionados, passphrase)
    except BackupError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
