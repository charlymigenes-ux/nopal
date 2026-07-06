import os
import shutil
from fastapi import APIRouter, File, Form, UploadFile

from backend.utils import MODELS_ROOT, GCODE_ROOT, safe_section_path

router = APIRouter()

os.makedirs(MODELS_ROOT, exist_ok=True)
os.makedirs(GCODE_ROOT, exist_ok=True)


@router.post("/api/upload")
async def upload_model(file: UploadFile = File(...), path: str = Form(""), type: str = Form("model")):
    section = "gcode" if type == "gcode" else "model"
    target_dir = safe_section_path(section, path)
    os.makedirs(target_dir, exist_ok=True)
    filepath = os.path.join(target_dir, file.filename)

    with open(filepath, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "success": True,
        "filename": file.filename,
        "path": filepath,
    }
