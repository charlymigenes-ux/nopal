import os

from PIL import Image, ImageDraw

from backend.services.gcode_geometry import analyze_gcode_geometry
from backend.utils import safe_section_path

# Mismos colores ya usados en el resto de la app (VISOR CNC, getDeviceKindColor
# del lado JS) — la galería tiene que verse consistente con el resto de NOPAL,
# no inventar una paleta nueva.
THUMB_SIZE = (640, 640)
BG_COLOR = (8, 20, 16)  # 0x081410
COLOR_BY_KIND = {
    "cnc": (245, 158, 11),      # #f59e0b
    "laser": (139, 92, 246),    # #8b5cf6
    "printer": (34, 197, 94),   # #22c55e
}
THUMBNAIL_CACHE_ROOT = "uploads/.thumbnails"


def _parse_gcode_xy(filepath: str, max_lines: int = 50000) -> list:
    """Envoltorio fino sobre gcode_geometry (parser modal compartido con
    pricing_service) — acá se trunca a max_lines a propósito: una miniatura
    aproximada de un archivo gigante es aceptable, a diferencia del cotizador
    de costos, que necesita el archivo completo."""
    return analyze_gcode_geometry(filepath, max_lines=max_lines)["points"]


def generate_gcode_thumbnail(filepath: str, kind: str = "cnc") -> Image.Image:
    """Dibuja el trazado 2D (X/Y) sobre un lienzo chico. Si el archivo no
    tiene una trayectoria real (vacío, sin movimientos, parseo fallido),
    devuelve el lienzo liso — nunca una imagen rota ni datos inventados."""
    points = _parse_gcode_xy(filepath)
    img = Image.new("RGB", THUMB_SIZE, BG_COLOR)
    if len(points) < 2:
        return img

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    margin = 48
    scale = min((THUMB_SIZE[0] - 2 * margin) / span_x, (THUMB_SIZE[1] - 2 * margin) / span_y)

    def to_px(pt):
        px = margin + (pt[0] - min_x) * scale
        py = THUMB_SIZE[1] - margin - (pt[1] - min_y) * scale  # invierte Y: la imagen crece hacia abajo
        return (px, py)

    draw = ImageDraw.Draw(img)
    color = COLOR_BY_KIND.get(kind, COLOR_BY_KIND["cnc"])
    prev_px = to_px((points[0][0], points[0][1]))
    for point_x, point_y, is_cut in points[1:]:
        px = to_px((point_x, point_y))
        if is_cut:
            draw.line([prev_px, px], fill=color, width=3)
        prev_px = px
    return img


def get_or_create_gcode_thumbnail(section: str, rel_path: str, kind: str = "cnc") -> str:
    """Devuelve la ruta al PNG cacheado, generándolo si no existe o si el
    archivo fuente cambió (mtime del cache vs. mtime del archivo). Nunca
    regenera en cada pedido — a diferencia de _estimate_print_time en
    api/models.py, que sí recalcula siempre y por eso ese endpoint es lento."""
    source_path = safe_section_path(section, rel_path)
    if not os.path.isfile(source_path):
        raise FileNotFoundError(source_path)

    cache_path = os.path.join(THUMBNAIL_CACHE_ROOT, section, rel_path + ".png")
    source_mtime = os.path.getmtime(source_path)
    if os.path.isfile(cache_path) and os.path.getmtime(cache_path) >= source_mtime:
        return cache_path

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    img = generate_gcode_thumbnail(source_path, kind)
    img.save(cache_path, "PNG")
    return cache_path
