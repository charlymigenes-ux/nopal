"""Imagen -> trazos -> G-code de plotter (lápiz) para la CNC.

Una CNC configurada como "plotter" (perfil de laser_service) dibuja con un
lápiz que se sube y se baja con el eje Z. Su G-code no lleva M4/M8/S (eso es de
láser: el firmware responde error:20), solo movimientos G0/G1 con Z arriba para
desplazarse y Z abajo para dibujar.

Aquí no hay dependencias nuevas: el trazado usa solo Pillow y Python puro.
1. La imagen se pasa a blanco y negro (lo oscuro es tinta).
2. Se adelgaza cada línea hasta un solo píxel de ancho (Zhang-Suen), para que el
   lápiz recorra el centro de la línea y no dibuje sus dos bordes.
3. Ese esqueleto se recorre como trazos, se simplifica (Ramer-Douglas-Peucker)
   y se escala a las medidas pedidas en mm, con el origen abajo a la izquierda.
4. Los trazos se ordenan por cercanía para reducir los desplazamientos en vacío.

Es pura lógica sin E/S (salvo abrir la imagen): la API vive en backend/api/plotter.py.
"""

from __future__ import annotations

import io
import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PIL import Image

Point = Tuple[float, float]
Path = List[Point]

MAX_TRACE_SIDE_PX = 600        # la imagen se reduce a esto antes de trazar (rapidez y menos ruido)
MAX_INPUT_PIXELS = 40_000_000  # tope de la imagen que se acepta abrir
MAX_POINTS = 200_000           # tope de puntos del dibujo ya simplificado
MIN_STROKE_MM = 0.6            # trazos más cortos que esto son ruido del adelgazado
JOIN_MM = 0.6              # si el siguiente trazo empieza tan cerca, el lápiz sigue abajo (une los cortes de los cruces)


class PlotterError(ValueError):
    """Entrada inválida; el mensaje se muestra tal cual al usuario."""


# ------------------------------------------------------------------ imagen -> píxeles de tinta
def load_ink(data: bytes, threshold: int = 128, invert: bool = False) -> Tuple[bytearray, int, int]:
    """(rejilla, ancho, alto): 1 donde hay tinta. Se deja 1 px libre alrededor."""
    if not data:
        raise PlotterError("No llegó ninguna imagen")
    try:
        Image.MAX_IMAGE_PIXELS = MAX_INPUT_PIXELS
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        raise PlotterError("No se pudo leer la imagen (usa PNG, JPG, BMP o GIF)")
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        base = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        img = Image.alpha_composite(base, rgba)
    gray = img.convert("L")
    scale = MAX_TRACE_SIDE_PX / max(gray.size)
    if scale < 1:
        gray = gray.resize((max(1, round(gray.width * scale)), max(1, round(gray.height * scale))), Image.LANCZOS)
    width, height = gray.width + 2, gray.height + 2
    grid = bytearray(width * height)
    pixels = gray.load()
    for y in range(gray.height):
        row = (y + 1) * width + 1
        for x in range(gray.width):
            dark = pixels[x, y] < threshold
            if dark != invert:
                grid[row + x] = 1
    return grid, width, height


# ------------------------------------------------------------------ adelgazado (Zhang-Suen)
def thin(grid: bytearray, width: int, height: int) -> bytearray:
    """Esqueleto de 1 px de ancho. Trabaja sobre una copia."""
    g = bytearray(grid)
    # vecinos en el orden P2..P9 del algoritmo (arriba y en sentido horario)
    offs = (-width, -width + 1, 1, width + 1, width, width - 1, -1, -width - 1)
    points = [i for i in range(width + 1, width * (height - 1)) if g[i]]
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            doomed = []
            for i in points:
                p2, p3, p4, p5, p6, p7, p8, p9 = (g[i + o] for o in offs)
                neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
                if neighbours < 2 or neighbours > 6:
                    continue
                seq = (p2, p3, p4, p5, p6, p7, p8, p9, p2)
                transitions = sum(1 for k in range(8) if seq[k] == 0 and seq[k + 1] == 1)
                if transitions != 1:
                    continue
                if step == 0:
                    if p2 * p4 * p6 or p4 * p6 * p8:
                        continue
                elif p2 * p4 * p8 or p2 * p6 * p8:
                    continue
                doomed.append(i)
            if doomed:
                changed = True
                for i in doomed:
                    g[i] = 0
                points = [i for i in points if g[i]]
    return g


def _touching(a: int, b: int) -> bool:
    """¿Dos casillas del anillo de 8 vecinos (0 = arriba, en sentido horario) se tocan entre sí?"""
    d = (a - b) % 8
    return d in (1, 7) or (d in (2, 6) and a % 2 == 0)       # contiguas, o dos vecinos ortogonales en diagonal


def _connected(cells: List[int]) -> bool:
    todo, seen = set(cells[1:]), [cells[0]]
    while seen:
        cur = seen.pop()
        for other in [c for c in todo if _touching(cur, c)]:
            todo.discard(other)
            seen.append(other)
    return not todo


def tidy(skel: bytearray, width: int, height: int) -> bytearray:
    """Quita los píxeles sobrantes que el adelgazado deja en las esquinas de las
    escaleras: aquellos con 2 o más vecinos que ya se tocan entre sí (quitarlo
    no desconecta nada). Sin esto casi todo píxel parecería un cruce y los
    trazos saldrían hechos pedacitos."""
    g = bytearray(skel)
    offs = (-width, -width + 1, 1, width + 1, width, width - 1, -1, -width - 1)
    pts = [i for i in range(width + 1, width * (height - 1)) if g[i]]
    changed = True
    while changed:
        changed = False
        for i in pts:
            if not g[i]:
                continue
            cells = [k for k, o in enumerate(offs) if g[i + o]]
            if len(cells) >= 2 and _connected(cells):
                g[i] = 0
                changed = True
    return g


# ------------------------------------------------------------------ esqueleto -> trazos
def skeleton_paths(skel: bytearray, width: int, height: int) -> List[Path]:
    """Trazos (listas de puntos en píxeles) que recorren el esqueleto."""
    nbrs = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))
    pix = [i for i in range(width * height) if skel[i]]
    adj: Dict[int, List[int]] = {}
    for i in pix:
        x, y = i % width, i // width
        adj[i] = [(y + dy) * width + x + dx for dx, dy in nbrs if 0 <= x + dx < width and 0 <= y + dy < height
                  and skel[(y + dy) * width + x + dx]]
    used = set()

    def edge(a: int, b: int) -> Tuple[int, int]:
        return (a, b) if a < b else (b, a)

    def walk(start: int, nxt: int) -> List[int]:
        trail = [start, nxt]
        used.add(edge(start, nxt))
        prev, cur = start, nxt
        while len(adj[cur]) == 2:
            options = [n for n in adj[cur] if n != prev and edge(cur, n) not in used]
            if not options:
                break
            prev, cur = cur, options[0]
            used.add(edge(prev, cur))
            trail.append(cur)
            if cur == start:
                break
        return trail

    trails: List[List[int]] = []
    for i in pix:                                  # desde extremos y cruces
        if len(adj[i]) != 2:
            for n in adj[i]:
                if edge(i, n) not in used:
                    trails.append(walk(i, n))
    for i in pix:                                  # lo que queda son ciclos cerrados
        for n in adj[i]:
            if edge(i, n) not in used:
                trails.append(walk(i, n))
    return [[(t % width, t // width) for t in trail] for trail in trails]


def _simplify(path: Path, eps: float) -> Path:
    """Ramer-Douglas-Peucker iterativo (sin recursión: los trazos pueden ser largos)."""
    if len(path) < 3:
        return path
    keep = [False] * len(path)
    keep[0] = keep[-1] = True
    stack = [(0, len(path) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = path[a], path[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        far, far_d = -1, eps
        for k in range(a + 1, b):
            px, py = path[k]
            d = (math.hypot(px - ax, py - ay) if norm == 0
                 else abs(dy * (px - ax) - dx * (py - ay)) / norm)
            if d > far_d:
                far, far_d = k, d
        if far != -1:
            keep[far] = True
            stack += [(a, far), (far, b)]
    return [p for p, k in zip(path, keep) if k]


# ------------------------------------------------------------------ medidas, orden y G-code
def _length(path: Path) -> float:
    return sum(math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]) for k in range(len(path) - 1))


def fit_to_mm(paths: Sequence[Path], width_mm: float, height_mm: float) -> List[Path]:
    """Escala los trazos para que el dibujo quepa en width x height mm sin
    deformarse, con el origen (0, 0) abajo a la izquierda (el eje Y de la
    imagen va hacia abajo; el de la máquina, hacia arriba)."""
    pts = [p for path in paths for p in path]
    if not pts:
        raise PlotterError("No se encontró ningún trazo en la imagen (prueba con otro umbral o 'invertir')")
    min_x, max_x = min(p[0] for p in pts), max(p[0] for p in pts)
    min_y, max_y = min(p[1] for p in pts), max(p[1] for p in pts)
    span_x, span_y = max(max_x - min_x, 1e-9), max(max_y - min_y, 1e-9)
    scale = min(width_mm / span_x, height_mm / span_y)
    return [[((x - min_x) * scale, (max_y - y) * scale) for x, y in path] for path in paths]


def order_paths(paths: Sequence[Path]) -> List[Path]:
    """Vecino más cercano desde (0, 0), girando un trazo si conviene entrar por su final."""
    pending = [list(p) for p in paths if len(p) >= 2]
    out: List[Path] = []
    here: Point = (0.0, 0.0)
    while pending:
        best, best_d, flip = 0, float("inf"), False
        for k, path in enumerate(pending):
            for rev, end in ((False, path[0]), (True, path[-1])):
                d = (end[0] - here[0]) ** 2 + (end[1] - here[1]) ** 2
                if d < best_d:
                    best, best_d, flip = k, d, rev
        path = pending.pop(best)
        if flip:
            path.reverse()
        out.append(path)
        here = path[-1]
    return out


def trace(data: bytes, width_mm: float, height_mm: float, threshold: int = 128, invert: bool = False,
          detail: float = 0.7) -> List[Path]:
    """Trazos ya en mm y ordenados, a partir de los bytes de una imagen."""
    grid, w, h = load_ink(data, threshold, invert)
    skel = tidy(thin(grid, w, h), w, h)
    raw = [_simplify(p, detail) for p in skeleton_paths(skel, w, h)]
    raw = [p for p in raw if len(p) >= 2]
    paths = fit_to_mm(raw, width_mm, height_mm)
    paths = [p for p in paths if _length(p) >= MIN_STROKE_MM]
    if not paths:
        raise PlotterError("Los trazos de la imagen son demasiado pequeños o no hay tinta")
    if sum(len(p) for p in paths) > MAX_POINTS:
        raise PlotterError("El dibujo es demasiado detallado; baja el nivel de detalle o usa una imagen más simple")
    return order_paths(paths)


def stats(paths: Sequence[Path], feed: float, travel_feed: float) -> Dict[str, Any]:
    drawn = sum(_length(p) for p in paths)
    travel, here = 0.0, (0.0, 0.0)
    for p in paths:
        travel += math.hypot(p[0][0] - here[0], p[0][1] - here[1])
        here = p[-1]
    travel += math.hypot(here[0], here[1])
    minutes = drawn / max(feed, 1) + travel / max(travel_feed, 1) + len(paths) * 0.01
    xs = [x for p in paths for x, _ in p]
    ys = [y for p in paths for _, y in p]
    return {"strokes": len(paths), "points": sum(len(p) for p in paths), "drawn_mm": round(drawn, 1),
            "travel_mm": round(travel, 1), "minutes": round(minutes, 1),
            "width_mm": round(max(xs) - min(xs), 2), "height_mm": round(max(ys) - min(ys), 2)}


def to_gcode(paths: Sequence[Path], pen_up_z: float, pen_down_z: float, feed: float, plunge_feed: float,
             travel_feed: float, title: str = "") -> str:
    """G-code de plotter: absoluto, en mm, lápiz con Z. Sin M3/M4/M5/M8 ni S."""
    def f(v: float) -> str:
        return f"{v:.3f}".rstrip("0").rstrip(".") or "0"

    info = stats(paths, feed, travel_feed)
    lines = ["; NOPAL plotter (lápiz con eje Z)"]
    if title:
        lines.append(f"; {title}")
    lines += [f"; Trazos: {info['strokes']}  Puntos: {info['points']}  Tamaño: {f(info['width_mm'])} x {f(info['height_mm'])} mm",
              f"; Lápiz arriba Z{f(pen_up_z)}  abajo Z{f(pen_down_z)}  Dibujo F{f(feed)}  Bajada F{f(plunge_feed)}",
              "G21", "G90", "G17", f"G0 Z{f(pen_up_z)}"]
    here: Optional[Point] = None
    drawing = False
    for path in paths:
        start = path[0]
        if here is not None and drawing and math.hypot(start[0] - here[0], start[1] - here[1]) <= JOIN_MM:
            pass                                    # el siguiente trazo continúa donde quedó el lápiz
        else:
            if drawing:
                lines.append(f"G0 Z{f(pen_up_z)}")
            lines.append(f"G0 X{f(start[0])} Y{f(start[1])} F{f(travel_feed)}")
            lines.append(f"G1 Z{f(pen_down_z)} F{f(plunge_feed)}")
            drawing = True
            lines.append(f"G1 F{f(feed)}")
        for x, y in path[1:]:
            lines.append(f"G1 X{f(x)} Y{f(y)}")
        here = path[-1]
    lines += [f"G0 Z{f(pen_up_z)}", f"G0 X0 Y0 F{f(travel_feed)}"]
    return "\n".join(lines) + "\n"
