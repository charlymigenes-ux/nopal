import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from backend.auth_deps import require_auth
from backend.utils import MODELS_ROOT, GCODE_ROOT, get_section_root, safe_section_path

router = APIRouter()

os.makedirs(MODELS_ROOT, exist_ok=True)
os.makedirs(GCODE_ROOT, exist_ok=True)


def _safe_upload_target(target_dir: str, filename: str) -> Path:
    """Ruta final del archivo subido, garantizada dentro de `target_dir`.

    `filename` llega tal cual lo manda el cliente (UploadFile.filename no se
    sanea): antes se unía directo con os.path.join, así que "../x" o una ruta
    absoluta escribían fuera de uploads/. Se rechaza -- no se "limpia" en
    silencio -- cualquier nombre que no sea un nombre de archivo simple: los
    clientes legítimos (el panel y los plugins) siempre mandan solo el
    nombre base. Se bloquean ambos separadores (/ y \\) aunque en Linux "\\"
    sea un carácter válido, para que el nombre no cambie de sentido si el
    archivo se copia a otro sistema. El mensaje de error nunca incluye
    rutas del servidor.
    """
    name = filename or ""
    if (
        not name.strip()
        or name in (".", "..")
        or "/" in name
        or "\\" in name
        or "\x00" in name
        or os.path.isabs(name)
    ):
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido")

    # Segunda barrera, independiente de la primera: la ruta ya resuelta
    # (symlinks incluidos) debe quedar directamente dentro de la carpeta.
    base = Path(target_dir).resolve()
    target = (base / name).resolve()
    if target.parent != base:
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido")
    return target


@router.post("/api/upload")
async def upload_model(
    file: UploadFile = File(...), path: str = Form(""), type: str = Form("model"),
    user: dict = Depends(require_auth),
):
    section = "gcode" if type == "gcode" else "model"
    target_dir = safe_section_path(section, path)
    # Se valida el nombre antes de crear carpetas o escribir nada.
    target = _safe_upload_target(target_dir, file.filename)
    os.makedirs(target_dir, exist_ok=True)

    with open(target, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "success": True,
        "filename": target.name,
        # Relativa a la sección (antes era la ruta absoluta del servidor);
        # ningún cliente lee este campo.
        "path": str(target.relative_to(Path(get_section_root(section)).resolve())),
    }
