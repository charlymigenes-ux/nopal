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

# Grabados raster de imagen (LightBurn "Image") caen muy por encima de esto
# (250k+ puntos); un corte/grabado vectorial normal se queda muy por debajo
# (cientos a pocos miles). Se usa como proxy barato de "¿es raster?" sin tener
# que oler el G-code de nuevo.
DENSE_POINT_THRESHOLD = 20_000
# Los tramos de una fila de raster miden fracciones de mm: a la escala final
# de 640px, un trazo de ancho fijo (pensado para una línea de corte
# vectorial) es más ancho que la separación real entre filas, así que las
# filas se emborronan unas con otras y el resultado sale como un bloque
# sólido/invertido en vez de la imagen. Dibujando a esta resolución
# intermedia mucho más alta, con trazo de 1px, cada fila sí tiene espacio
# real, y al reducir con LANCZOS el detalle fino se promedia en tonos en vez
# de perderse.
DENSE_RENDER_SIZE = (2000, 2000)


def _parse_gcode_xy(filepath: str, max_lines: int = 2_000_000) -> list:
    """Envoltorio fino sobre gcode_geometry (parser modal compartido con
    pricing_service). El tope es solo un techo de seguridad, no un recorte
    para "aligerar" la miniatura: un grabado raster de imagen (LightBurn
    "Image", modo G91 con miles de micro-tramos S0/S<power> por fila,
    barriendo de arriba hacia abajo) puede tener cientos de miles de líneas,
    y truncar a un número chico solo capturaba las primeras filas del
    grabado (una tira, no la imagen completa) — de ahí miniaturas que salían
    como un bloque sólido en vez de la imagen real. Confirmado con archivos
    reales de hasta ~270k líneas (3s de parseo, aceptable porque el
    resultado se cachea a PNG y no se recalcula salvo que el archivo
    cambie)."""
    return analyze_gcode_geometry(filepath, max_lines=max_lines)["points"]


def generate_gcode_thumbnail(filepath: str, kind: str = "cnc") -> Image.Image:
    """Dibuja el trazado 2D (X/Y) sobre un lienzo chico. Si el archivo no
    tiene una trayectoria real (vacío, sin movimientos, parseo fallido),
    devuelve el lienzo liso — nunca una imagen rota ni datos inventados."""
    points = _parse_gcode_xy(filepath)
    if len(points) < 2:
        return Image.new("RGB", THUMB_SIZE, BG_COLOR)

    dense = len(points) > DENSE_POINT_THRESHOLD
    render_size = DENSE_RENDER_SIZE if dense else THUMB_SIZE
    line_width = 1 if dense else 3

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    margin = round(48 * render_size[0] / THUMB_SIZE[0])
    scale = min((render_size[0] - 2 * margin) / span_x, (render_size[1] - 2 * margin) / span_y)

    def to_px(pt):
        px = margin + (pt[0] - min_x) * scale
        py = render_size[1] - margin - (pt[1] - min_y) * scale  # invierte Y: la imagen crece hacia abajo
        return (px, py)

    img = Image.new("RGB", render_size, BG_COLOR)
    draw = ImageDraw.Draw(img)
    color = COLOR_BY_KIND.get(kind, COLOR_BY_KIND["cnc"])
    prev_px = to_px((points[0][0], points[0][1]))
    for point_x, point_y, is_cut in points[1:]:
        px = to_px((point_x, point_y))
        if is_cut:
            draw.line([prev_px, px], fill=color, width=line_width)
        prev_px = px

    if dense:
        img = img.resize(THUMB_SIZE, Image.LANCZOS)
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
