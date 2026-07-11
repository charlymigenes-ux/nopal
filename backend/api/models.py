import base64
import os
import re
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import Response

from backend.utils import UPLOAD_FOLDER, get_section_root, safe_section_path

router = APIRouter()

MODEL_EXTENSIONS = {".stl", ".3mf", ".obj", ".step", ".stp"}
GCODE_EXTENSIONS = {".gcode", ".gc", ".gco", ".nc", ".tap", ".cnc"}

# Slicers como OrcaSlicer/PrusaSlicer/SuperSlicer incrustan miniaturas PNG en
# comentarios cerca del encabezado del G-code (formato "thumbnail begin/end").
# Con esto NOPAL puede mostrar la miniatura real del modelo sin necesidad de
# re-renderizar la trayectoria — igual que Mainsail/Fluidd.
THUMBNAIL_HEADER_BYTES = 262144  # 256 KB: de sobra, las miniaturas van al inicio del archivo
THUMBNAIL_BLOCK_RE = re.compile(
    r";\s*thumbnail(?:_QOI)?\s+begin\s+(\d+)x(\d+)\s+\d+\s*\r?\n(.*?);\s*thumbnail(?:_QOI)?\s+end",
    re.DOTALL | re.IGNORECASE,
)


def _extract_embedded_thumbnail(filepath: str) -> Optional[bytes]:
    """Busca las miniaturas PNG incrustadas por el slicer y devuelve la de
    mayor resolución ya decodificada, o None si el archivo no trae ninguna."""
    try:
        with open(filepath, "rb") as handle:
            header = handle.read(THUMBNAIL_HEADER_BYTES)
    except OSError:
        return None

    text = header.decode("utf-8", errors="ignore")
    best_pixels = -1
    best_b64 = None
    for match in THUMBNAIL_BLOCK_RE.finditer(text):
        width, height, body = int(match.group(1)), int(match.group(2)), match.group(3)
        pixels = width * height
        if pixels <= best_pixels:
            continue
        lines = [line.strip().lstrip(";").strip() for line in body.splitlines()]
        b64_data = "".join(line for line in lines if line)
        if b64_data:
            best_pixels = pixels
            best_b64 = b64_data

    if not best_b64:
        return None
    try:
        return base64.b64decode(best_b64)
    except (ValueError, base64.binascii.Error):
        return None


def _section_for_type(type_param: str) -> str:
    return "gcode" if type_param == "gcode" else "model"


def _estimate_print_time(filepath: str, extension: str) -> dict:
    size_bytes = os.path.getsize(filepath)
    size_mb = max(size_bytes / (1024 * 1024), 0.1)

    if extension in GCODE_EXTENSIONS:
        try:
            with open(filepath, "r", encoding="utf-8", errors="ignore") as handle:
                for line in handle.readlines()[:200]:
                    lower = line.lower()
                    if "estimated" in lower and "time" in lower:
                        match = re.search(r"(\d+)\s*:\s*(\d+)", line)
                        if match:
                            minutes = int(match.group(1)) * 60 + int(match.group(2))
                            return {
                                "estimated_time": f"{match.group(1)}h {match.group(2)}m",
                                "estimated_time_minutes": minutes,
                            }
        except Exception:
            pass

    multiplier = {".stl": 12, ".obj": 10, ".step": 8, ".stp": 8, ".3mf": 9}.get(extension, 6)
    minutes = int(max(20, round(size_mb * multiplier)))
    hours, rem = divmod(minutes, 60)
    return {
        "estimated_time": f"{hours}h {rem}m" if hours else f"{minutes}m",
        "estimated_time_minutes": minutes,
    }


def _build_file_entry(filepath: str, url_rel_dir: str, filename: str) -> dict:
    extension = os.path.splitext(filename)[1].lower()
    rel_path = f"{url_rel_dir}/{filename}" if url_rel_dir else filename
    estimated = _estimate_print_time(filepath, extension)

    return {
        "id": rel_path,
        "name": filename,
        "extension": extension,
        "size": os.path.getsize(filepath),
        "modified": int(os.path.getmtime(filepath)),
        "file_url": f"/uploads/{rel_path}",
        "view_url": f"/view/{rel_path}",
        "estimated_time": estimated["estimated_time"],
        "estimated_time_minutes": estimated["estimated_time_minutes"],
        "material": "PLA",
        "tags": ["#modelo3D", "#impresion3D"],
    }


@router.get("/api/models/thumbnail")
async def get_model_thumbnail(path: str, section: str = "model"):
    """Miniatura PNG incrustada por el slicer en el propio G-code (thumbnail
    begin/end). 404 si el archivo no trae ninguna incrustada."""
    filepath = safe_section_path(section, path)
    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    png_bytes = _extract_embedded_thumbnail(filepath)
    if not png_bytes:
        raise HTTPException(status_code=404, detail="El archivo no tiene miniatura incrustada")

    return Response(content=png_bytes, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/api/models")
async def get_models():
    """Listado plano y recursivo de todos los archivos (usado por estadísticas)."""
    base = Path(UPLOAD_FOLDER)
    files = []

    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        extension = path.suffix.lower()
        if extension not in MODEL_EXTENSIONS | GCODE_EXTENSIONS:
            continue
        rel_dir = str(path.parent.relative_to(base))
        rel_dir = "" if rel_dir == "." else rel_dir
        files.append(_build_file_entry(str(path), rel_dir, path.name))

    return files


def _count_files_recursive(dir_path: str, extensions: set) -> int:
    count = 0
    for _root, _dirs, filenames in os.walk(dir_path):
        for filename in filenames:
            if os.path.splitext(filename)[1].lower() in extensions:
                count += 1
    return count


@router.get("/api/browse")
async def browse_folder(path: str = "", type: str = "model"):
    """Contenido (carpetas + archivos) de una carpeta dentro de la sección indicada."""
    section = _section_for_type(type)
    section_prefix = "gcode" if section == "gcode" else "models"
    # La sección "model" (Modelos 3D) muestra tanto STL/3MF sin laminar como
    # G-code de impresora ya listo para enviar, todo en la misma carpeta.
    extensions = GCODE_EXTENSIONS if section == "gcode" else (MODEL_EXTENSIONS | GCODE_EXTENSIONS)
    target_dir = safe_section_path(section, path)

    os.makedirs(get_section_root(section), exist_ok=True)

    if not os.path.isdir(target_dir):
        raise HTTPException(status_code=404, detail="Carpeta no encontrada")

    folders = []
    files = []
    url_rel_dir = f"{section_prefix}/{path}" if path else section_prefix

    for entry in sorted(os.listdir(target_dir), key=str.lower):
        if entry.startswith("."):
            continue

        entry_path = os.path.join(target_dir, entry)

        if os.path.isdir(entry_path):
            rel_entry = f"{path}/{entry}" if path else entry
            folders.append({
                "name": entry,
                "path": rel_entry,
                "file_count": _count_files_recursive(entry_path, extensions),
            })
        else:
            extension = os.path.splitext(entry)[1].lower()
            if extension in extensions:
                files.append(_build_file_entry(entry_path, url_rel_dir, entry))

    return {
        "path": path,
        "folders": folders,
        "files": files,
    }


@router.post("/api/folders")
async def create_folder(path: str = Form(""), name: str = Form(...), type: str = Form("model")):
    """Crea una subcarpeta dentro de la sección indicada."""
    section = _section_for_type(type)
    clean_name = name.strip()
    if not clean_name or "/" in clean_name or "\\" in clean_name or clean_name in (".", ".."):
        raise HTTPException(status_code=400, detail="Nombre de carpeta inválido")

    parent_dir = safe_section_path(section, path)
    new_dir = os.path.join(parent_dir, clean_name)

    if os.path.exists(new_dir):
        raise HTTPException(status_code=409, detail="La carpeta ya existe")

    os.makedirs(new_dir)

    return {
        "success": True,
        "path": f"{path}/{clean_name}" if path else clean_name,
    }


@router.patch("/api/folders")
async def rename_folder(path: str = Form(...), new_name: str = Form(...), type: str = Form("model")):
    """Renombra una subcarpeta existente."""
    section = _section_for_type(type)
    clean_name = new_name.strip()
    if not clean_name or "/" in clean_name or "\\" in clean_name or clean_name in (".", ".."):
        raise HTTPException(status_code=400, detail="Nombre de carpeta inválido")

    current_dir = safe_section_path(section, path)
    if not os.path.isdir(current_dir):
        raise HTTPException(status_code=404, detail="Carpeta no encontrada")

    parent_path = "/".join(path.split("/")[:-1])
    new_dir = os.path.join(safe_section_path(section, parent_path), clean_name)

    if os.path.exists(new_dir):
        raise HTTPException(status_code=409, detail="Ya existe una carpeta con ese nombre")

    os.rename(current_dir, new_dir)

    return {
        "success": True,
        "path": f"{parent_path}/{clean_name}" if parent_path else clean_name,
    }


@router.delete("/api/folders")
async def delete_folder(path: str, type: str = "model"):
    """Elimina una subcarpeta (y su contenido) de la sección indicada."""
    if not path:
        raise HTTPException(status_code=400, detail="No se puede eliminar la carpeta raíz")

    section = _section_for_type(type)
    target_dir = safe_section_path(section, path)

    if not os.path.isdir(target_dir):
        raise HTTPException(status_code=404, detail="Carpeta no encontrada")

    shutil.rmtree(target_dir)

    return {"success": True}


@router.patch("/api/files")
async def rename_file(path: str = Form(...), new_name: str = Form(...), type: str = Form("model")):
    """Renombra un archivo existente (conserva la extensión)."""
    section = _section_for_type(type)
    extensions = GCODE_EXTENSIONS if section == "gcode" else (MODEL_EXTENSIONS | GCODE_EXTENSIONS)

    current_path = safe_section_path(section, path)
    if not os.path.isfile(current_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    clean_name = new_name.strip()
    if not clean_name or "/" in clean_name or "\\" in clean_name:
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido")

    original_extension = os.path.splitext(path)[1].lower()
    if os.path.splitext(clean_name)[1].lower() != original_extension:
        clean_name = f"{clean_name}{original_extension}"

    if os.path.splitext(clean_name)[1].lower() not in extensions:
        raise HTTPException(status_code=400, detail="Extensión de archivo inválida")

    parent_path = "/".join(path.split("/")[:-1])
    new_path = os.path.join(safe_section_path(section, parent_path), clean_name)

    if os.path.exists(new_path):
        raise HTTPException(status_code=409, detail="Ya existe un archivo con ese nombre")

    os.rename(current_path, new_path)

    return {
        "success": True,
        "path": f"{parent_path}/{clean_name}" if parent_path else clean_name,
    }


@router.delete("/api/files")
async def delete_file(path: str, type: str = "model"):
    """Elimina un archivo de la sección indicada."""
    section = _section_for_type(type)
    target_path = safe_section_path(section, path)

    if not os.path.isfile(target_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    os.remove(target_path)

    return {"success": True}


@router.post("/api/files/move")
async def move_file(path: str = Form(...), destination: str = Form(""), type: str = Form("model")):
    """Mueve un archivo a otra carpeta dentro de la misma sección."""
    section = _section_for_type(type)

    current_path = safe_section_path(section, path)
    if not os.path.isfile(current_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    dest_dir = safe_section_path(section, destination)
    if not os.path.isdir(dest_dir):
        raise HTTPException(status_code=404, detail="Carpeta de destino no encontrada")

    filename = os.path.basename(path)
    new_path = os.path.join(dest_dir, filename)

    if os.path.abspath(new_path) == os.path.abspath(current_path):
        raise HTTPException(status_code=400, detail="El archivo ya está en esa carpeta")

    if os.path.exists(new_path):
        raise HTTPException(status_code=409, detail="Ya existe un archivo con ese nombre en la carpeta destino")

    shutil.move(current_path, new_path)

    return {
        "success": True,
        "path": f"{destination}/{filename}" if destination else filename,
    }
