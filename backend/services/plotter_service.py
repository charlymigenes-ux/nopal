"""Imagen -> trazos -> G-code de plotter (lápiz) para la CNC.

Una CNC configurada como "plotter" (perfil de laser_service) dibuja con un
lápiz que se sube y se baja con el eje Z. Su G-code no lleva M3/M4/M5/M8/S (eso es
de láser: el firmware responde error:20), solo movimientos G0/G1 con Z arriba
para desplazarse y Z abajo para dibujar.

Vectorizado de line art (dibujos de líneas: mandalas, contornos, logos en blanco
y negro, dibujos para colorear). La meta es una versión vectorial limpia de lo que
una persona espera que dibuje el plotter, no un "esqueleto de píxeles":

1. Se analiza la imagen (fondo, tinta, tonos medios). Una fotografía se rechaza con
   un aviso en vez de convertirla en miles de líneas inútiles.
2. Se amplía a ~1000 px y se binariza con Otsu: así las separaciones de 1-2 px
   entre líneas vecinas no se funden.
3. Se adelgaza cada línea hasta su eje central (Zhang-Suen con tablas) y se limpian
   las esquinas de escalera. El plotter recorre el centro de la línea, no sus dos bordes.
4. El esqueleto se convierte en un grafo (extremos y cruces), se podan los
   espolones cortos y cada arista se suaviza (gaussiano a lo largo del trazo, con
   esquinas reales conservadas y cruces fijos).
5. Las aristas que continúan una a otra en un cruce se unen en un solo trazo.
6. Se escala a mm (origen abajo a la izquierda), se simplifica con una tolerancia de
   0.04 mm (invisible con un lápiz) y se ordena por cercanía.

La única dependencia nueva es numpy (BSD, con ruedas para Debian y Raspberry Pi); el
resto es Pillow y Python puro. Si falta, el servicio avisa en vez de fallar al arrancar.

Es pura lógica sin E/S (salvo abrir la imagen): la API vive en backend/api/plotter.py.
"""

from __future__ import annotations

import hashlib
import io
import math
import threading
from collections import OrderedDict, defaultdict
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PIL import Image

try:  # numpy es opcional al importar: sin él NOPAL arranca y esta función avisa
    import numpy as np
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]

Point = Tuple[float, float]
Path = List[Point]

WORK_SIDE_PX = 1000            # lado mayor de trabajo: la imagen se amplía (hasta 4x) o se reduce a esto
MAX_UP = 4
MAX_INPUT_PIXELS = 40_000_000  # tope de la imagen que se acepta abrir
MAX_POINTS = 200_000           # tope de puntos del dibujo ya simplificado
MIN_STROKE_MM = 0.6            # trazos más cortos que esto son ruido
JOIN_MM = 0.6                  # si el siguiente trazo empieza tan cerca, el lápiz sigue abajo (une los cortes de los cruces)
TOLERANCE_MM = 0.04            # desviación máxima de la simplificación final (invisible con un lápiz)
MIDTONE_PHOTO = 0.30           # más de esta fracción de tonos medios: parece una fotografía
FILLED_WIDTH = 0.025           # ancho medio de la tinta sobre el lado de la imagen: arriba de esto hay áreas rellenas
CACHE_SIZE = 3


class PlotterError(ValueError):
    """Entrada inválida; el mensaje se muestra tal cual al usuario."""


def _need_numpy() -> None:
    if np is None:
        raise PlotterError("Falta la librería numpy en el servidor de NOPAL: instálala con "
                           "'pip install -r requirements.txt' y reinicia NOPAL")


# ------------------------------------------------------------------ imagen y análisis
def load_gray(data: bytes) -> Image.Image:
    """Abre la imagen y la pasa a grises (lo transparente se toma como blanco)."""
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
    return img.convert("L")


def _otsu(gray: "np.ndarray") -> int:
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    levels = np.arange(256)
    w0 = np.cumsum(hist)
    s0 = np.cumsum(hist * levels)
    w1 = total - w0
    with np.errstate(divide="ignore", invalid="ignore"):
        between = w0 * w1 * (s0 / w0 - (s0[-1] - s0) / w1) ** 2
    between[~np.isfinite(between)] = 0
    best = np.flatnonzero(between >= between.max() * (1 - 1e-9))        # imagen de 2 valores: meseta entera
    return int(best[len(best) // 2])


def analyze(gray: Image.Image) -> Dict[str, Any]:
    """Qué tipo de imagen es y cómo binarizarla: umbral de Otsu, si la tinta es la
    parte clara (fondo oscuro) y qué tanto es tono medio (fotografías)."""
    _need_numpy()
    a = np.asarray(gray, dtype=np.uint8)
    threshold = _otsu(a)
    dark = float((a < threshold).mean())
    invert = dark > 0.5                                   # la tinta es la minoría
    midtones = float(((a > 64) & (a < 192)).mean())
    return {"threshold": threshold, "invert": invert, "midtones": midtones,
            "ink_fraction": (1 - dark) if invert else dark, "photo": midtones > MIDTONE_PHOTO}


def ink_mask(gray: Image.Image, threshold: int, invert: bool) -> Tuple["np.ndarray", int]:
    """Máscara booleana de tinta a resolución de trabajo y el factor de ampliación."""
    side = max(gray.size)
    up = 1
    if side > WORK_SIDE_PX * 1.15:
        k = WORK_SIDE_PX / side
        gray = gray.resize((max(1, round(gray.width * k)), max(1, round(gray.height * k))), Image.LANCZOS)
    elif side < WORK_SIDE_PX:
        up = max(1, min(MAX_UP, round(WORK_SIDE_PX / side)))
        if up > 1:
            gray = gray.resize((gray.width * up, gray.height * up), Image.LANCZOS)
    a = np.asarray(gray, dtype=np.uint8)
    return ((a >= threshold) if invert else (a < threshold)), up


# ------------------------------------------------------------------ adelgazado (Zhang-Suen con tablas)
_RING_OFFSETS = ((-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1))   # 0 = arriba, horario


def _build_tables() -> Tuple["np.ndarray", "np.ndarray", "np.ndarray"]:
    """Tablas indexadas por el código de 8 bits del anillo de vecinos (bit k = vecino k):
    borrable en el paso 0 y en el paso 1 de Zhang-Suen, y 'sobrante' de las esquinas de escalera
    (2 o más vecinos que ya se tocan entre sí: quitarlo no desconecta nada)."""
    def touching(a: int, b: int) -> bool:
        d = (a - b) % 8
        return d in (1, 7) or (d in (2, 6) and a % 2 == 0)

    step0 = np.zeros(256, bool)
    step1 = np.zeros(256, bool)
    spare = np.zeros(256, bool)
    for code in range(256):
        r = [(code >> k) & 1 for k in range(8)]
        p2, p3, p4, p5, p6, p7, p8, p9 = r
        seq = r + [r[0]]
        transitions = sum(1 for k in range(8) if seq[k] == 0 and seq[k + 1] == 1)
        if 2 <= sum(r) <= 6 and transitions == 1:
            step0[code] = (p2 * p4 * p6 == 0) and (p4 * p6 * p8 == 0)
            step1[code] = (p2 * p4 * p8 == 0) and (p2 * p6 * p8 == 0)
        cells = [k for k in range(8) if r[k]]
        if len(cells) >= 2:
            todo, seen = set(cells[1:]), [cells[0]]
            while seen:
                cur = seen.pop()
                for other in [c for c in todo if touching(cur, c)]:
                    todo.discard(other)
                    seen.append(other)
            spare[code] = not todo
    return step0, step1, spare


_TABLES: Optional[Tuple["np.ndarray", "np.ndarray", "np.ndarray"]] = None


def _tables():
    global _TABLES
    if _TABLES is None:
        _TABLES = _build_tables()
    return _TABLES


def thin(mask: "np.ndarray") -> "np.ndarray":
    """Esqueleto de 1 px (8-conexo). Solo se revisan los píxeles de frontera."""
    step0, step1, _ = _tables()
    img = np.pad(mask, 2).astype(np.uint8)
    flat = img.reshape(-1)
    w = img.shape[1]
    offs = np.array([dy * w + dx for dy, dx in _RING_OFFSETS], dtype=np.int64)
    weights = (1 << np.arange(8)).astype(np.int64)
    ink = np.flatnonzero(flat)
    cand = ink[flat[ink[:, None] + offs].sum(axis=1) < 8]
    while len(cand):
        removed = False
        for table in (step0, step1):
            kill = table[flat[cand[:, None] + offs] @ weights]
            if kill.any():
                removed = True
                dead = cand[kill]
                flat[dead] = 0
                near = (dead[:, None] + offs).ravel()
                near = near[flat[near] == 1]
                cand = np.unique(np.concatenate([cand[~kill], near]))
        if not removed:
            break
    return img[2:-2, 2:-2].astype(bool)


def _erode(mask: "np.ndarray", times: int) -> "np.ndarray":
    """Erosión con el anillo de 8 vecinos (la tinta pierde `times` píxeles por cada lado)."""
    out = mask
    for _ in range(times):
        p = np.pad(out, 1)
        h, w = out.shape
        keep = out.copy()
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                keep &= p[dy:dy + h, dx:dx + w]
        out = keep
    return out


def tidy(skel: "np.ndarray") -> "np.ndarray":
    """Quita los píxeles sobrantes de las esquinas de escalera que deja el adelgazado
    (si no, casi todo píxel parecería un cruce y los trazos saldrían en pedacitos).
    Los píxeles de una misma paridad no comparten vecinos, así que se borran juntos."""
    spare = _tables()[2]
    img = np.pad(skel, 2).astype(np.uint8)
    changed = True
    while changed:
        changed = False
        for oy in (0, 1):
            for ox in (0, 1):
                ys, xs = np.nonzero(img)
                pick = (ys % 2 == oy) & (xs % 2 == ox)
                ys, xs = ys[pick], xs[pick]
                if not len(ys):
                    continue
                code = np.zeros(len(ys), dtype=np.int64)
                for k, (dy, dx) in enumerate(_RING_OFFSETS):
                    code |= img[ys + dy, xs + dx].astype(np.int64) << k
                kill = spare[code]
                if kill.any():
                    img[ys[kill], xs[kill]] = 0
                    changed = True
    return img[2:-2, 2:-2].astype(bool)


# ------------------------------------------------------------------ esqueleto -> grafo de trazos
Chain = Tuple[int, int, List[Tuple[float, float]]]       # (nodo_a, nodo_b, puntos (y, x))


def skeleton_graph(skel: "np.ndarray") -> Tuple[List[Chain], List[List[Tuple[float, float]]]]:
    """Cadenas de píxeles entre nodos (extremos con 1 vecino y cruces con 3 o más; los cruces
    contiguos se funden en un nodo en su centroide) y los lazos cerrados sin ningún nodo."""
    pad = np.pad(skel, 2)
    ys, xs = np.nonzero(pad)
    pts = set(zip(ys.tolist(), xs.tolist()))
    nbrs = {(y, x): [(y + dy, x + dx) for dy, dx in _RING_OFFSETS if (y + dy, x + dx) in pts] for (y, x) in pts}
    node_px = {p for p, n in nbrs.items() if len(n) != 2}
    cluster: Dict[Tuple[int, int], int] = {}
    centers: Dict[int, Tuple[float, float]] = {}
    for p in sorted(node_px):
        if p in cluster:
            continue
        cid = len(centers)
        stack, members = [p], []
        cluster[p] = cid
        while stack:
            cur = stack.pop()
            members.append(cur)
            for q in nbrs[cur]:
                if q in node_px and q not in cluster:
                    cluster[q] = cid
                    stack.append(q)
        centers[cid] = (sum(m[0] for m in members) / len(members) - 2, sum(m[1] for m in members) / len(members) - 2)

    visited = set()
    chains: List[Chain] = []
    for p in sorted(node_px):
        for q in nbrs[p]:
            if q in node_px or q in visited:
                continue
            trail, prev, cur = [q], p, q
            visited.add(q)
            while True:
                forward = [n for n in nbrs[cur] if n != prev and n not in visited and n not in node_px]
                if not forward:
                    break
                forward.sort(key=lambda n: abs(n[0] - cur[0]) + abs(n[1] - cur[1]))      # ortogonal antes que diagonal
                prev, cur = cur, forward[0]
                visited.add(cur)
                trail.append(cur)
            end = next((n for n in nbrs[cur] if n in node_px and n != p), None)
            if end is None:
                end = next((n for n in nbrs[cur] if n in node_px), p)
            a, b = cluster[p], cluster[end]
            body = [(float(y - 2), float(x - 2)) for y, x in trail]
            chains.append((a, b, [centers[a]] + body + [centers[b]]))
    loops: List[List[Tuple[float, float]]] = []
    for p in sorted(pts):
        if p in visited or p in node_px:
            continue
        trail, cur = [p], p
        visited.add(p)
        while True:
            forward = [n for n in nbrs[cur] if n not in visited]
            if not forward:
                break
            forward.sort(key=lambda n: abs(n[0] - cur[0]) + abs(n[1] - cur[1]))
            cur = forward[0]
            visited.add(cur)
            trail.append(cur)
        trail.append(p)
        loops.append([(float(y - 2), float(x - 2)) for y, x in trail])
    return chains, loops


# ------------------------------------------------------------------ suavizado y simplificación
def _polyline_length(a: "np.ndarray") -> float:
    return float(np.hypot(*np.diff(a, axis=0).T).sum()) if len(a) > 1 else 0.0


def resample(points: Any, step: float = 1.0) -> "np.ndarray":
    """Puntos a separación uniforme (≈1 px) a lo largo del trazo."""
    a = np.asarray(points, dtype=float)
    if len(a) < 2:
        return a
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(a, axis=0).T))])
    if s[-1] < 1e-9:
        return a[:1]
    t = np.linspace(0.0, s[-1], max(2, int(round(s[-1] / step)) + 1))
    return np.stack([np.interp(t, s, a[:, 0]), np.interp(t, s, a[:, 1])], axis=1)


def smooth(a: "np.ndarray", sigma: float, closed: bool = False) -> "np.ndarray":
    """Suavizado gaussiano a lo largo del trazo. Los extremos quedan fijos (reflexión impar:
    conserva su dirección y no encoge el trazo); en un lazo cerrado se da la vuelta."""
    if len(a) < 3 or sigma <= 0:
        return a
    r = int(math.ceil(3 * sigma))
    if closed:
        body = a[:-1]
        reps = r // len(body) + 1
        ring = np.tile(body, (2 * reps + 1, 1))
        mid = reps * len(body)
        pad = ring[mid - r: mid + len(body) + r]
        kernel = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
        kernel /= kernel.sum()
        out = np.stack([np.convolve(pad[:, c], kernel, mode="valid") for c in range(2)], axis=1)
        return np.vstack([out, out[:1]])
    r = min(r, len(a) - 1)
    kernel = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    pad = np.vstack([2 * a[0] - a[1:r + 1][::-1], a, 2 * a[-1] - a[-r - 1:-1][::-1]])
    out = np.stack([np.convolve(pad[:, c], kernel, mode="valid") for c in range(2)], axis=1)
    out[0], out[-1] = a[0], a[-1]
    return out


def smooth_in_corridor(a: "np.ndarray", sigma: float, max_dev: float, closed: bool = False) -> "np.ndarray":
    """Suaviza fuerte (quita los escalones largos de los arcos casi horizontales o verticales) pero
    ningún punto se aleja más de `max_dev` px del esqueleto: el eje real de la línea está a
    medio píxel del esqueleto, así que lo que pase de ahí es forma real que no se debe borrar."""
    out = smooth(a, sigma, closed)
    delta = out - a
    dist = np.hypot(delta[:, 0], delta[:, 1])
    scale = np.where(dist > max_dev, max_dev / np.maximum(dist, 1e-9), 1.0)
    out = a + delta * scale[:, None]
    if not closed:
        out[0], out[-1] = a[0], a[-1]
    else:
        out[-1] = out[0]
    return out


def find_corners(a: "np.ndarray", chord: int, degrees: float = 42.0) -> List[int]:
    """Índices donde el trazo gira de forma brusca: esquinas reales que no se deben redondear."""
    if len(a) < 2 * chord + 3:
        return []
    v1 = a[chord:-chord] - a[:-2 * chord]
    v2 = a[2 * chord:] - a[chord:-chord]
    cos = (v1 * v2).sum(axis=1) / np.maximum(np.hypot(*v1.T) * np.hypot(*v2.T), 1e-9)
    turn = np.degrees(np.arccos(np.clip(cos, -1, 1)))
    cand = np.flatnonzero(turn > degrees)
    if not len(cand):
        return []
    groups = np.split(cand, np.flatnonzero(np.diff(cand) > chord) + 1)
    return [int(g[np.argmax(turn[g])]) + chord for g in groups]


def simplify(a: "np.ndarray", eps: float) -> "np.ndarray":
    """Ramer-Douglas-Peucker iterativo: quita puntos que no cambian la forma más de `eps`."""
    n = len(a)
    if n < 3:
        return a
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        p, d = a[i], a[j] - a[i]
        norm = math.hypot(*d)
        seg = a[i + 1:j]
        dist = (np.hypot(*(seg - p).T) if norm < 1e-12
                else np.abs(d[0] * (seg[:, 1] - p[1]) - d[1] * (seg[:, 0] - p[0])) / norm)
        k = int(np.argmax(dist))
        if dist[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack += [(i, m), (m, j)]
    return a[keep]


def contract_nodes(chains: List[Chain], contract_px: float) -> List[Chain]:
    """Funde los nodos unidos por una arista corta (un cruce grueso, o un agujerito en la tinta, deja
    varios nodos y aristas diminutas) en un solo nodo en su centroide, y descarta las aristas
    que quedan como lazos diminutos sobre ese nodo."""
    parent: Dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    position: Dict[int, Tuple[float, float]] = {}
    for a, b, pts in chains:
        position[a], position[b] = pts[0], pts[-1]
    for a, b, pts in chains:
        if a != b and _polyline_length(np.asarray(pts)) <= contract_px:
            parent[find(a)] = find(b)
    members: Dict[int, List[int]] = defaultdict(list)
    for node in position:
        members[find(node)].append(node)
    center = {root: (sum(position[m][0] for m in ms) / len(ms), sum(position[m][1] for m in ms) / len(ms))
              for root, ms in members.items()}
    out: List[Chain] = []
    for a, b, pts in chains:
        ra, rb = find(a), find(b)
        length = _polyline_length(np.asarray(pts))
        if ra == rb and (a != b) and length <= contract_px:
            continue                                            # la propia arista que se fundió
        if ra == rb and length <= 3 * contract_px:
            continue                                            # lazo diminuto (agujero) sobre el nodo
        out.append((ra, rb, [center[ra]] + list(pts[1:-1]) + [center[rb]]))
    return out


def _smooth_closed(r: "np.ndarray", sigma: float, max_dev: float, chord: int) -> "np.ndarray":
    """Lazo cerrado: se gira para empezar en una esquina (si la hay), se parte ahí y cada tramo
    se suaviza con extremos fijos, para que un cuadrado conserve sus esquinas."""
    ring = r[:-1]
    corners = find_corners(np.vstack([ring, ring, ring]), chord)
    n = len(ring)
    inside = sorted({c - n for c in corners if n <= c < 2 * n})
    if not inside:
        return smooth_in_corridor(r, sigma, max_dev, closed=True)
    start = inside[0]
    rolled = np.vstack([np.roll(ring, -start, axis=0), np.roll(ring, -start, axis=0)[:1]])
    cuts = [0] + [(c - start) % n for c in inside[1:]] + [n]
    cuts = sorted(set(cuts))
    parts = []
    for i in range(len(cuts) - 1):
        seg = rolled[cuts[i]:cuts[i + 1] + 1]
        if len(seg) > 3:
            seg = smooth_in_corridor(seg, sigma, max_dev, closed=False)
        parts.append(seg if i == 0 else seg[1:])
    return np.vstack(parts)


def merge_pass_through(edges: List[list]) -> List[list]:
    """Un nodo que se quedó con solo 2 aristas (tras podar un espolón) ya no es un cruce: se unen
    sus dos aristas en una y se descarta el centroide del nodo, que podía quedar fuera de la línea."""
    edges = list(edges)
    while True:
        incident: Dict[int, List[Tuple[int, int]]] = defaultdict(list)
        for i, e in enumerate(edges):
            incident[e[0]].append((i, 0))
            incident[e[1]].append((i, 1))
        node = next((n for n, lst in incident.items() if len(lst) == 2 and lst[0][0] != lst[1][0]), None)
        if node is None:
            return edges
        (i, end_i), (j, end_j) = incident[node]
        first, second = edges[i], edges[j]
        before = first[2] if end_i == 1 else first[2][::-1]          # termina en el nodo
        after = second[2] if end_j == 0 else second[2][::-1]         # empieza en el nodo
        merged = [first[0] if end_i == 1 else first[1], second[1] if end_j == 0 else second[0],
                  list(before[:-1]) + list(after[1:]), first[3] + second[3]]
        edges = [e for k, e in enumerate(edges) if k not in (i, j)] + [merged]


def smooth_edges(chains: List[Chain], spur_px: float, sigma: float, chord: int,
                 max_dev: float) -> List[Tuple[int, int, "np.ndarray"]]:
    """Poda los espolones cortos (puntas de unos píxeles que deja el adelgazado en las orillas) y
    suaviza cada arista, partiéndola en las esquinas reales."""
    edges = [[a, b, pts, _polyline_length(np.asarray(pts))] for a, b, pts in chains]
    changed = True
    while changed:
        changed = False
        degree: Dict[int, int] = defaultdict(int)
        for a, b, _, _ in edges:
            degree[a] += 1
            degree[b] += 1
        kept = []
        for e in edges:
            a, b, _, length = e
            if (degree[a] == 1) != (degree[b] == 1) and length < spur_px and degree[a] + degree[b] >= 4:
                changed = True
                continue
            kept.append(e)
        edges = kept
    out = []
    for a, b, pts, _ in merge_pass_through(edges):
        r = resample(pts, 1.0)
        closed = a == b and len(r) > 4 and math.hypot(*(r[0] - r[-1])) < 1e-6
        if closed:
            out.append((a, b, _smooth_closed(r, sigma, max_dev, chord)))
            continue
        if len(r) > 3:
            r = smooth(r, sigma * 0.5, False)
        cuts = [0] + find_corners(r, chord) + [len(r) - 1]
        parts = []
        for i in range(len(cuts) - 1):
            seg = r[cuts[i]:cuts[i + 1] + 1]
            if len(seg) > 3:
                seg = smooth_in_corridor(seg, sigma, max_dev, False)
            parts.append(seg if i == 0 else seg[1:])
        out.append((a, b, np.vstack(parts)))
    return out


def join_edges(edges: List[Tuple[int, int, "np.ndarray"]], cos_limit: float = -0.866) -> List["np.ndarray"]:
    """Une, en cada nodo, las aristas que continúan una a otra (dirección casi recta, ≥150°);
    en un nodo de 2 aristas siempre se unen. Así un pétalo o un círculo es UN trazo, no varios."""
    ends: Dict[int, List[Tuple[int, int]]] = defaultdict(list)
    for i, (a, b, _) in enumerate(edges):
        ends[a].append((i, 0))
        ends[b].append((i, 1))

    def direction(i: int, end: int, k: int = 12) -> "np.ndarray":
        pts = edges[i][2]
        v = (pts[min(k, len(pts) - 1)] - pts[0]) if end == 0 else (pts[max(len(pts) - 1 - k, 0)] - pts[-1])
        n = math.hypot(*v)
        return v / n if n > 1e-9 else v

    link: Dict[Tuple[int, int], Tuple[int, int]] = {}
    for node, lst in ends.items():
        if len(lst) == 2 and lst[0][0] != lst[1][0]:
            link[lst[0]], link[lst[1]] = lst[1], lst[0]
        elif len(lst) > 2:
            dirs = {e: direction(*e) for e in lst}
            pairs = sorted(((float(np.dot(dirs[x], dirs[y])), x, y)
                            for ix, x in enumerate(lst) for y in lst[ix + 1:] if x[0] != y[0]), key=lambda t: t[0])
            used = set()
            for c, x, y in pairs:
                if c > cos_limit:
                    break
                if x not in used and y not in used:
                    link[x], link[y] = y, x
                    used |= {x, y}
    done = set()
    strokes: List["np.ndarray"] = []

    def walk(i: int, end: int) -> "np.ndarray":
        out, cur = [], (i, end)
        while True:
            e, en = cur
            done.add(e)
            pts = edges[e][2]
            seg = pts if en == 0 else pts[::-1]
            out.append(seg if not out else seg[1:])
            nxt = link.get((e, 1 - en))
            if nxt is None or nxt[0] in done:
                break
            cur = nxt
        return np.vstack(out)

    for i in range(len(edges)):                  # primero los que tienen un extremo libre
        if i in done:
            continue
        for end in (0, 1):
            if (i, end) not in link:
                strokes.append(walk(i, end))
                break
    for i in range(len(edges)):                  # lo que queda son ciclos
        if i not in done:
            strokes.append(walk(i, 0))
    return strokes


# ------------------------------------------------------------------ trazado completo (con caché)
_cache: "OrderedDict[str, Tuple[List[np.ndarray], Dict[str, Any]]]" = OrderedDict()
_cache_lock = threading.Lock()


def vectorize(data: bytes, threshold: int = 0, invert: Optional[bool] = None, smoothing: float = 1.0,
              cleanup: float = 1.0) -> Tuple[List["np.ndarray"], Dict[str, Any]]:
    """Trazos suaves en píxeles de trabajo (y, x) y los datos del análisis. Se guarda en una caché
    corta: cambiar el tamaño o el lápiz no vuelve a vectorizar la imagen.
    `smoothing` (1 = normal): más alto redondea más las líneas, más bajo las deja más fieles a la imagen.
    `cleanup` (1 = normal): más alto quita más puntas y detalles diminutos; 0 los conserva todos."""
    _need_numpy()
    key = f"{hashlib.sha1(data).hexdigest()}:{threshold}:{invert}:{smoothing:.3f}:{cleanup:.3f}"
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    gray = load_gray(data)
    info = analyze(gray)
    if info["photo"]:
        raise PlotterError("Esta imagen parece una fotografía. Imagen a dibujo funciona con dibujos de líneas "
                           "(mandalas, contornos, logos en blanco y negro, dibujos para colorear)")
    mask, up = ink_mask(gray, threshold or info["threshold"], info["invert"] if invert is None else invert)
    if not mask.any():
        raise PlotterError("No se encontró ningún trazo en la imagen")
    skeleton = tidy(thin(mask))
    notes = []
    width_px = float(mask.sum()) / max(float(skeleton.sum()), 1.0)       # ancho medio de la línea (área / largo)
    if width_px > FILLED_WIDTH * max(mask.shape):
        # Áreas rellenas (un logo, una silueta): el eje de una mancha no sirve; se dibuja su contorno.
        notes.append("La imagen tiene áreas rellenas; se dibuja su contorno")
        mask = mask & ~_erode(mask, 2)
        skeleton = tidy(thin(mask))
        width_px = max(float(mask.sum()) / max(float(skeleton.sum()), 1.0), 2.0)
    chains, loops = skeleton_graph(skeleton)
    sigma = max(4.0, 1.5 * up) * smoothing
    max_dev = 1.0 * smoothing
    chains = contract_nodes(chains, contract_px=max(3.0 * up, 1.5 * width_px))
    edges = smooth_edges(chains, spur_px=max(4.7 * up, 1.2 * width_px) * cleanup, sigma=sigma,
                         chord=max(5, 3 * up), max_dev=max_dev)
    strokes = join_edges(edges)
    strokes += [_smooth_closed(resample(loop, 1.0), sigma, max_dev, max(5, 3 * up))
                for loop in loops if len(loop) > 8 * cleanup]
    if not strokes:
        raise PlotterError("No se encontró ningún trazo en la imagen")
    info = {**info, "cleanup": cleanup, "up": up, "work_px": tuple(mask.shape), "line_width_px": round(width_px, 1), "notes": notes}
    with _cache_lock:
        _cache[key] = (strokes, info)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return strokes, info


def _length(path: Path) -> float:
    return sum(math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]) for k in range(len(path) - 1))


def fit_to_mm(strokes: Sequence["np.ndarray"], width_mm: float, height_mm: float) -> Tuple[List["np.ndarray"], float]:
    """Escala los trazos (y, x en píxeles) para que quepan en width x height mm sin deformarse,
    con el origen (0, 0) abajo a la izquierda (el eje Y de la imagen va hacia abajo; el de la
    máquina, hacia arriba). Devuelve los trazos como (x, y) en mm y los mm por píxel."""
    pts = np.vstack(strokes)
    low, high = pts.min(axis=0), pts.max(axis=0)
    span = np.maximum(high - low, 1e-9)
    scale = min(width_mm / span[1], height_mm / span[0])
    return [np.stack([(p[:, 1] - low[1]) * scale, (high[0] - p[:, 0]) * scale], axis=1) for p in strokes], scale


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


def trace_ex(data: bytes, width_mm: float, height_mm: float, threshold: int = 0, invert: Optional[bool] = None,
             detail: float = 1.0, smoothing: float = 1.0, cleanup: float = 1.0) -> Tuple[List[Path], List[str]]:
    """Trazos ya en mm, simplificados y ordenados, y los avisos de la imagen. `threshold` 0 y
    `invert` None = automático; `detail` multiplica la tolerancia (1 = 0.04 mm; más bajo = más puntos);
    `smoothing` y `cleanup`: ver vectorize()."""
    strokes, info = vectorize(data, int(threshold), invert, smoothing, cleanup)
    mm, scale = fit_to_mm(strokes, width_mm, height_mm)
    eps = max(TOLERANCE_MM * detail, 0.25 * scale)
    min_stroke = MIN_STROKE_MM * max(cleanup, 0.0) if cleanup else 0.1
    paths: List[Path] = []
    for stroke in mm:
        simple = simplify(stroke, eps)
        if len(simple) >= 2 and _length([(float(x), float(y)) for x, y in simple]) >= min_stroke:
            paths.append([(float(x), float(y)) for x, y in simple])
    if not paths:
        raise PlotterError("Los trazos de la imagen son demasiado pequeños o no hay tinta")
    if sum(len(p) for p in paths) > MAX_POINTS:
        raise PlotterError("El dibujo es demasiado detallado; usa una imagen más simple")
    return order_paths(paths), list(info["notes"])


def trace(data: bytes, width_mm: float, height_mm: float, threshold: int = 0, invert: Optional[bool] = None,
          detail: float = 1.0, smoothing: float = 1.0, cleanup: float = 1.0) -> List[Path]:
    return trace_ex(data, width_mm, height_mm, threshold, invert, detail, smoothing, cleanup)[0]


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
