"""Imagen -> dibujo para la CNC en modo plotter (lápiz con Z). Delgado: la
lógica vive en services/plotter_service.py."""

import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from backend.auth_deps import require_auth
from backend.services import plotter_service as plotter
from backend.utils import get_section_root, safe_section_path

router = APIRouter()

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
DRAWINGS_FOLDER = ""                 # raíz de la Biblioteca (G-code): ahí sí salen en las listas de la CNC y de la Guía


def _check(value: float, low: float, high: float, label: str) -> float:
    if not low <= value <= high:
        raise HTTPException(status_code=400, detail=f"{label} debe estar entre {low:g} y {high:g}")
    return value


async def _read(file: UploadFile) -> bytes:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="La imagen pesa más de 15 MB")
    return data


def _auto_flag(value: Optional[str]) -> Optional[bool]:
    """'true'/'false' fuerzan el valor; vacío o 'auto' lo decide NOPAL al analizar la imagen."""
    text = (value or "").strip().lower()
    if text in ("", "auto"):
        return None
    if text in ("true", "1", "on", "si", "sí"):
        return True
    if text in ("false", "0", "off", "no"):
        return False
    raise HTTPException(status_code=400, detail="Valor no válido para invertir")


async def _trace(file, width_mm, height_mm, threshold, invert, detail, smoothing=1.0, cleanup=1.0):
    """Todo es automático: `threshold` 0 y `invert` vacío dejan que NOPAL analice la imagen
    (la pantalla no los muestra; quedan por si otro cliente los necesita)."""
    _check(width_mm, 5, 2000, "El ancho")
    _check(height_mm, 5, 2000, "El alto")
    if threshold:
        _check(threshold, 1, 254, "El umbral")
    _check(detail, 0.2, 5, "La precisión")
    _check(smoothing, 0.3, 3, "La suavidad")
    _check(cleanup, 0, 4, "La limpieza")
    flag = _auto_flag(invert)
    data = await _read(file)
    try:
        return await run_in_threadpool(plotter.trace_ex, data, width_mm, height_mm, int(threshold), flag, detail,
                                       smoothing, cleanup)
    except plotter.PlotterError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/plotter/preview")
async def plotter_preview(
    file: UploadFile = File(...), width_mm: float = Form(80), height_mm: float = Form(80),
    threshold: float = Form(0), invert: Optional[str] = Form(None), detail: float = Form(1.0),
    smoothing: float = Form(1.0), cleanup: float = Form(1.0),
    feed: float = Form(1500), travel_feed: float = Form(2000),
    user: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Trazos en mm (origen abajo a la izquierda) para dibujar la vista previa, sus números y
    los avisos de la imagen (`notes`)."""
    paths, notes = await _trace(file, width_mm, height_mm, threshold, invert, detail, smoothing, cleanup)
    return {"paths": [[[round(x, 3), round(y, 3)] for x, y in p] for p in paths],
            "stats": plotter.stats(paths, _check(feed, 10, 20000, "La velocidad"),
                                   _check(travel_feed, 10, 20000, "La velocidad de traslado")),
            "notes": notes}


def _unique_name(folder: str, base: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9áéíóúÁÉÍÓÚñÑ _.-]", "", base).strip(" .") or "dibujo"
    name, n = f"{stem}.gc", 2
    while (Path(folder) / name).exists():
        name, n = f"{stem}-{n}.gc", n + 1
    return name


@router.post("/api/plotter/generate")
async def plotter_generate(
    file: UploadFile = File(...), name: str = Form("dibujo"),
    width_mm: float = Form(80), height_mm: float = Form(80),
    threshold: float = Form(0), invert: Optional[str] = Form(None), detail: float = Form(1.0),
    smoothing: float = Form(1.0), cleanup: float = Form(1.0),
    pen_up_z: float = Form(3), pen_down_z: float = Form(0),
    feed: float = Form(1500), plunge_feed: float = Form(500), travel_feed: float = Form(2000),
    user: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Genera el G-code de plotter y lo guarda en la raíz de la Biblioteca (G-code)."""
    _check(pen_up_z, -50, 50, "Z arriba")
    _check(pen_down_z, -50, 50, "Z abajo")
    if pen_up_z == pen_down_z:
        raise HTTPException(status_code=400, detail="Z arriba y Z abajo no pueden ser iguales")
    _check(feed, 10, 20000, "La velocidad de dibujo")
    _check(plunge_feed, 10, 20000, "La velocidad de bajada")
    _check(travel_feed, 10, 20000, "La velocidad de traslado")
    paths, notes = await _trace(file, width_mm, height_mm, threshold, invert, detail, smoothing, cleanup)
    text = plotter.to_gcode(paths, pen_up_z, pen_down_z, feed, plunge_feed, travel_feed,
                            f"{width_mm:g} x {height_mm:g} mm")
    folder = safe_section_path("gcode", DRAWINGS_FOLDER)
    os.makedirs(folder, exist_ok=True)
    filename = _unique_name(folder, name)
    (Path(folder) / filename).write_text(text, encoding="utf-8")
    root = Path(get_section_root("gcode")).resolve()
    return {"success": True, "filename": filename, "path": str((Path(folder) / filename).relative_to(root)),
            "stats": plotter.stats(paths, feed, travel_feed), "notes": notes}
