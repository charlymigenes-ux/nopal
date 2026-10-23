"""Render 2D de un G-code, con el mismo aspecto del visor del Editor G-Code.

Una sola imagen por archivo, hecha una vez (en segundo plano al importar) y
guardada en disco: galería, lista, mosaico, vista previa y la sección Láser
leen ese mismo PNG, en vez de que cada pantalla dibuje el suyo.

El criterio visual es el del visor (static/js/visor/thumbnail.js + renderer.js):
- Fondo oscuro, trazo gris azulado cuyo brillo sigue la potencia S.
- Los desplazamientos (G0 / láser apagado) se dibujan tenues: en un grabado
  ráster la imagen la forman justo los huecos sin quemar (S0).
- En un ráster la capa de relleno se oculta, que si no tapa el dibujo.
- Se dibuja a 4x y se reduce promediando: el tramado vuelve a leerse como
  medio tono.

Junto al PNG se guarda un .json con los límites reales (mm) del trazo, para
poder colocar la imagen en el área de trabajo de la máquina sin reparsear.
"""

import json
import logging
import math
import os
import re
import threading
from array import array
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageDraw

from backend.utils import safe_section_path

logger = logging.getLogger(__name__)

RENDER_ROOT = "uploads/.thumbnails"
# Subir esta versión invalida todo lo cacheado (el render anterior era otro).
RENDER_VERSION = "v2"

LONG_SIDE = 640            # lado largo del PNG final
SUPER = 4                  # supermuestreo antes de reducir
MAX_LINES = 30_000_000     # techo de seguridad, no un recorte: un ráster de LightBurn pasa de 4 millones de líneas

BG_COLOR = (8, 20, 16)
INK = (201, 214, 229)      # mismo gris azulado del visor (#c9d6e5)
TRAVEL_ALPHA = 0.55
MIN_POWER_BRIGHTNESS = 0.45

# Mismas reglas del visor para ocultar el relleno de un ráster.
FILL_MIN_SEGMENTS = 20_000
FILL_MIN_SHARE = 0.7
MAX_LAYERS = 32
ARC_TOLERANCE = 0.02

# Los segmentos se guardan compactos (arrays, ~18 bytes c/u) y no como tuplas
# (~150 bytes c/u): un ráster grande trae millones y la memoria se iba a GB.
#   coords: x1, y1, x2, y2 (float32)   power: 0..255   kind: capa | 0x80 si es trabajo
CUT_FLAG = 0x80

_WORD_RE = re.compile(r"([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))")


# Avance de los renders en curso, por ruta relativa: lo lee la barra de
# "renderizando" de la biblioteca (GET /api/gcode/render-progress). Se borra al
# terminar; sin entrada, el estado se deduce de si el PNG ya está en disco.
_progress: Dict[str, Dict[str, Any]] = {}
PARSE_SHARE = 0.4          # parte de la barra que se lleva leer el archivo; el resto es dibujar
PROGRESS_EVERY = 4000      # líneas/segmentos entre avisos (no frenar el bucle)

ProgressFn = Optional[Any]  # callable(fracción 0..1)


def _set_progress(rel_path: Optional[str], status: str, percent: float) -> None:
    if rel_path is not None:
        _progress[rel_path] = {"status": status, "percent": max(0, min(100, round(percent)))}


def get_progress(rel_path: str) -> Dict[str, Any]:
    """{"status": queued|rendering|done|none, "percent": 0..100}."""
    state = _progress.get(rel_path)
    if state:
        return dict(state)
    try:
        source = safe_section_path("gcode", rel_path)
        png, meta = _cache_paths(rel_path)
        if os.path.isfile(source) and _is_fresh(png, meta, os.path.getmtime(source)):
            return {"status": "done", "percent": 100}
    except Exception:
        pass
    return {"status": "none", "percent": 0}


def _parse_segments(filepath: str, on_progress: ProgressFn = None) -> Dict[str, Any]:
    """Parser modal equivalente al del visor (G0-G3, G90/91, G20/21, G92,
    M3/M4/M5, S, arcos aplanados). Devuelve los segmentos y sus límites."""
    coords = array("f")
    powers = bytearray()
    kinds = bytearray()
    x = y = 0.0
    off_x = off_y = 0.0
    absolute = True
    scale = 1.0
    power = 0.0
    max_power = 0.0
    laser_on = False
    motion = 0
    layer_key: Dict[Any, int] = {}
    layer_counts: List[int] = []
    pending_layer: Optional[str] = None
    current_layer: Optional[str] = None
    layer_idx = 0
    min_x = min_y = math.inf
    max_x = max_y = -math.inf

    def layer_for(feed: float) -> int:
        nonlocal pending_layer, current_layer, layer_idx
        if pending_layer is not None:
            current_layer = pending_layer
            pending_layer = None
        key = ("n", current_layer) if current_layer is not None else ("s", power, feed)
        idx = layer_key.get(key)
        if idx is None:
            if len(layer_counts) >= MAX_LAYERS:
                return layer_idx
            idx = len(layer_counts)
            layer_key[key] = idx
            layer_counts.append(0)
        layer_idx = idx
        return idx

    feed = 0.0

    def add(x1, y1, x2, y2, pow_n, cutting, layer):
        nonlocal min_x, min_y, max_x, max_y
        if x1 == x2 and y1 == y2:
            return
        min_x = min(min_x, x1, x2)
        max_x = max(max_x, x1, x2)
        min_y = min(min_y, y1, y2)
        max_y = max(max_y, y1, y2)
        if cutting:
            layer_counts[layer] += 1
        coords.extend((x1, y1, x2, y2))
        powers.append(round(pow_n * 255))
        kinds.append(layer | (CUT_FLAG if cutting else 0))

    try:
        handle = open(filepath, "r", encoding="utf-8", errors="ignore")
    except OSError:
        return {"coords": coords, "powers": powers, "kinds": kinds, "bounds": None, "layer_counts": []}

    try:
        total_bytes = max(os.path.getsize(filepath), 1)
    except OSError:
        total_bytes = 1
    read_bytes = 0

    with handle:
        for line_no, raw in enumerate(handle):
            if line_no >= MAX_LINES:
                break
            read_bytes += len(raw)
            if on_progress and line_no % PROGRESS_EVERY == 0:
                on_progress(min(1.0, read_bytes / total_bytes))
            line = raw
            comment = None
            semi = line.find(";")
            if semi >= 0:
                comment = line[semi + 1:]
                line = line[:semi]
            if "(" in line:
                start = line.find("(")
                end = line.find(")", start)
                comment = line[start + 1:end if end >= 0 else len(line)]
                line = line[:start] + (line[end + 1:] if end >= 0 else "")
            if comment:
                lowered = comment.strip().lower()
                for prefix in ("layer", "capa"):
                    pos = lowered.find(prefix)
                    if pos >= 0 and (pos == 0 or lowered[pos - 1].isspace()):
                        name = comment.strip()[pos + len(prefix):].lstrip(" :#").strip()
                        if name:
                            pending_layer = name
                        break

            g = m = None
            vals: Dict[str, float] = {}
            for letter, number in _WORD_RE.findall(line):
                letter = letter.upper()
                value = float(number)
                if letter == "G":
                    g = value
                elif letter == "M":
                    m = value
                elif letter == "F":
                    feed = value
                elif letter == "S":
                    power = value
                else:
                    vals[letter] = value

            if g == 90:
                absolute = True
                continue
            if g == 91:
                absolute = False
                continue
            if g == 20:
                scale = 25.4
                continue
            if g == 21:
                scale = 1.0
                continue
            if g == 92:
                if "X" in vals:
                    off_x = x - vals["X"] * scale
                if "Y" in vals:
                    off_y = y - vals["Y"] * scale
                continue
            if m in (3, 4):
                laser_on = True
            elif m in (5, 2, 30):
                laser_on = False
            if g is not None and 0 <= g <= 3:
                motion = int(g)
            elif g is not None and g > 3:
                continue
            if not any(k in vals for k in "XYZIJ"):
                continue

            px, py = x, y
            nx, ny = px, py
            if absolute:
                if "X" in vals:
                    nx = vals["X"] * scale + off_x
                if "Y" in vals:
                    ny = vals["Y"] * scale + off_y
            else:
                if "X" in vals:
                    nx = px + vals["X"] * scale
                if "Y" in vals:
                    ny = py + vals["Y"] * scale

            if power > max_power:
                max_power = power
            cutting = motion != 0 and laser_on and power > 0
            layer = layer_for(feed) if cutting else layer_idx
            # La potencia se normaliza al máximo visto hasta ese momento, igual
            # que el visor (el brillo del trazo depende de eso).
            pow_n = min(1.0, power / max_power) if max_power > 0 else 0.0

            if motion in (2, 3) and ("I" in vals or "J" in vals or "R" in vals):
                _emit_arc(add, px, py, nx, ny, vals.get("I", 0.0) * scale,
                          vals.get("J", 0.0) * scale, vals.get("R"), motion == 2,
                          pow_n, cutting, layer, scale)
            else:
                add(px, py, nx, ny, pow_n, cutting, layer)
            x, y = nx, ny

    bounds = None
    if math.isfinite(min_x):
        bounds = {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y}
    return {"coords": coords, "powers": powers, "kinds": kinds, "bounds": bounds, "layer_counts": layer_counts}


def _emit_arc(add, x1, y1, x2, y2, i, j, r, cw, pow_n, cutting, layer, scale):
    """Aplana un arco G2/G3 en tramos rectos (misma tolerancia del visor)."""
    if i or j or r is None:
        cx, cy = x1 + i, y1 + j
    else:
        dx, dy = x2 - x1, y2 - y1
        d = math.hypot(dx, dy)
        if not d:
            add(x1, y1, x2, y2, pow_n, cutting, layer)
            return
        radius = r * scale
        h2 = radius * radius - (d / 2) ** 2
        h = math.sqrt(h2) if h2 > 0 else 0.0
        sign = 1 if (radius < 0) == cw else -1
        cx = x1 + dx / 2 + sign * h * (-dy / d)
        cy = y1 + dy / 2 + sign * h * (dx / d)

    rad = math.hypot(x1 - cx, y1 - cy)
    if not math.isfinite(rad) or rad < 1e-9:
        add(x1, y1, x2, y2, pow_n, cutting, layer)
        return
    a1 = math.atan2(y1 - cy, x1 - cx)
    a2 = math.atan2(y2 - cy, x2 - cx)
    sweep = a2 - a1
    if cw:
        while sweep >= 0:
            sweep -= math.tau
    else:
        while sweep <= 0:
            sweep += math.tau
    if abs(sweep) < 1e-9:
        sweep = -math.tau if cw else math.tau
    step = 2 * math.acos(max(-1.0, min(1.0, 1 - ARC_TOLERANCE / rad)))
    steps = max(2, min(2000, math.ceil(abs(sweep) / (step or 0.2))))
    px, py = x1, y1
    for k in range(1, steps + 1):
        a = a1 + sweep * (k / steps)
        qx = x2 if k == steps else cx + rad * math.cos(a)
        qy = y2 if k == steps else cy + rad * math.sin(a)
        add(px, py, qx, qy, pow_n, cutting, layer)
        px, py = qx, qy


def _hidden_layer(layer_counts: List[int]) -> int:
    """Índice de la capa de relleno de un ráster (que se oculta), o -1."""
    total = sum(layer_counts)
    if total < FILL_MIN_SEGMENTS:
        return -1
    biggest = max(range(len(layer_counts)), key=layer_counts.__getitem__)
    return biggest if layer_counts[biggest] / total >= FILL_MIN_SHARE else -1


def _blend(color: Tuple[int, int, int], bg: Tuple[int, int, int], alpha: float):
    return tuple(round(bg[c] + (color[c] - bg[c]) * alpha) for c in range(3))


def render_gcode(filepath: str, rel_path: Optional[str] = None) -> Tuple[Image.Image, Optional[Dict[str, float]]]:
    """Devuelve (imagen, límites en mm). Sin trayectoria real: lienzo liso y
    límites None — nunca una imagen rota ni datos inventados. Con `rel_path`
    va informando el avance (ver get_progress)."""
    _set_progress(rel_path, "rendering", 0)
    parsed = _parse_segments(
        filepath, lambda frac: _set_progress(rel_path, "rendering", frac * PARSE_SHARE * 100))
    bounds = parsed["bounds"]
    if not parsed["powers"] or bounds is None:
        return Image.new("RGB", (LONG_SIDE, LONG_SIDE), BG_COLOR), None

    width_mm = max(bounds["maxX"] - bounds["minX"], 1e-3)
    height_mm = max(bounds["maxY"] - bounds["minY"], 1e-3)
    ratio = width_mm / height_mm
    if ratio >= 1:
        out_w, out_h = LONG_SIDE, max(1, round(LONG_SIDE / ratio))
    else:
        out_w, out_h = max(1, round(LONG_SIDE * ratio)), LONG_SIDE

    big_w, big_h = out_w * SUPER, out_h * SUPER
    px_per_mm = min(big_w / width_mm, big_h / height_mm)
    min_x, max_y = bounds["minX"], bounds["maxY"]

    hidden = _hidden_layer(parsed["layer_counts"])
    img = Image.new("RGB", (big_w, big_h), BG_COLOR)
    draw = ImageDraw.Draw(img)
    travel_color = _blend(INK, BG_COLOR, TRAVEL_ALPHA)

    # Brillo por potencia, precalculado en 256 niveles.
    ink_levels = [
        tuple(round(c * (MIN_POWER_BRIGHTNESS + (1 - MIN_POWER_BRIGHTNESS) * k / 255)) for c in INK)
        for k in range(256)
    ]

    coords, powers, kinds = parsed["coords"], parsed["powers"], parsed["kinds"]
    total_segments = max(len(powers), 1)
    for index in range(len(powers)):
        if index % PROGRESS_EVERY == 0:
            _set_progress(rel_path, "rendering", (PARSE_SHARE + (1 - PARSE_SHARE) * index / total_segments) * 100)
        kind = kinds[index]
        cutting = bool(kind & CUT_FLAG)
        if cutting and (kind & ~CUT_FLAG) == hidden:
            continue
        base = index * 4
        p1 = ((coords[base] - min_x) * px_per_mm, (max_y - coords[base + 1]) * px_per_mm)  # Y invertida: la imagen crece hacia abajo
        p2 = ((coords[base + 2] - min_x) * px_per_mm, (max_y - coords[base + 3]) * px_per_mm)
        color = ink_levels[powers[index]] if cutting else travel_color
        draw.line([p1, p2], fill=color, width=1)

    return img.resize((out_w, out_h), Image.LANCZOS), bounds


def _cache_paths(rel_path: str) -> Tuple[str, str]:
    base = os.path.join(RENDER_ROOT, "gcode", rel_path)
    return f"{base}.{RENDER_VERSION}.png", f"{base}.{RENDER_VERSION}.json"


def _is_fresh(png: str, meta: str, source_mtime: float) -> bool:
    return (
        os.path.isfile(png) and os.path.isfile(meta)
        and os.path.getmtime(png) >= source_mtime
    )


_build_lock = threading.Lock()


def ensure_render(rel_path: str) -> Tuple[str, Dict[str, Any]]:
    """Devuelve (ruta del PNG, metadatos), generándolos si no existen o si el
    archivo cambió. Nunca regenera en cada pedido."""
    source = safe_section_path("gcode", rel_path)
    if not os.path.isfile(source):
        raise FileNotFoundError(source)
    png, meta = _cache_paths(rel_path)
    mtime = os.path.getmtime(source)
    if _is_fresh(png, meta, mtime):
        return png, read_meta(meta)

    # Un archivo a la vez: parsear un ráster grande es pesado y dos pedidos
    # del mismo archivo (galería + segundo plano) no deben duplicar el trabajo.
    with _build_lock:
        if _is_fresh(png, meta, mtime):
            return png, read_meta(meta)
        os.makedirs(os.path.dirname(png), exist_ok=True)
        try:
            image, bounds = render_gcode(source, rel_path)
        except Exception:
            _progress.pop(rel_path, None)
            raise
        info = {
            "width_px": image.width,
            "height_px": image.height,
            "bounds": bounds,
            "width_mm": (bounds["maxX"] - bounds["minX"]) if bounds else 0,
            "height_mm": (bounds["maxY"] - bounds["minY"]) if bounds else 0,
        }
        tmp_png = png + ".tmp"
        image.save(tmp_png, format="PNG")
        with open(meta, "w", encoding="utf-8") as handle:
            json.dump(info, handle)
        os.replace(tmp_png, png)  # el PNG va al final: es lo que marca "listo"
        _progress.pop(rel_path, None)
        return png, info


def read_meta(meta_path: str) -> Dict[str, Any]:
    try:
        with open(meta_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"bounds": None}


_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gcode-render")
_pending = set()
_pending_lock = threading.Lock()


def schedule_render(rel_path: str) -> None:
    """Pide el render en segundo plano (al importar). No bloquea ni propaga
    errores: si falla, se reintenta cuando alguien pida la imagen."""
    with _pending_lock:
        if rel_path in _pending:
            return
        _pending.add(rel_path)
    _set_progress(rel_path, "queued", 0)

    def job():
        try:
            ensure_render(rel_path)
        except Exception as exc:
            logger.warning(f"No se pudo renderizar {rel_path} en segundo plano: {exc}")
            _progress.pop(rel_path, None)
        finally:
            with _pending_lock:
                _pending.discard(rel_path)

    _executor.submit(job)
