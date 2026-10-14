"""Imagen -> trazos -> G-code de plotter para la CNC con lápiz (eje Z).

Dos regresiones de fondo:
- El G-code de láser (M4, M8, S) hace que la CNC en perfil plotter responda error:20 y aborte
  el trabajo en la línea 3; el de plotter no debe llevar nunca esos comandos.
- La calidad del trazo: el resultado debe ser una versión vectorial limpia del dibujo (curvas
  suaves, esquinas, intersecciones y separaciones entre líneas vecinas conservadas), no un
  esqueleto de píxeles con dientes de sierra, cortes o líneas fundidas.
"""

import io
import math
import re
from collections import deque

import pytest
from PIL import Image, ImageDraw

np = pytest.importorskip("numpy")

from backend import utils
from backend.services import plotter_service as plotter


# ------------------------------------------------------------------ imágenes sintéticas
def _png(draw, size=(400, 400), background=255, mode="L"):
    img = Image.new(mode, size, background)
    draw(ImageDraw.Draw(img))
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def _circle(d, size=400, width=5):
    d.ellipse((30, 30, size - 30, size - 30), outline=0, width=width)


def _square(d):
    d.rectangle((40, 40, 360, 360), outline=0, width=5)


def _curve(d):
    pts = [(30 + i, 200 + 90 * math.sin(i / 55.0)) for i in range(0, 341)]
    d.line(pts, fill=0, width=5, joint="curve")


def _closed_blob(d):
    pts = [(200 + (110 + 22 * math.sin(3 * t)) * math.cos(t), 200 + (110 + 22 * math.sin(3 * t)) * math.sin(t))
           for t in [k * math.pi / 90 for k in range(181)]]
    d.line(pts, fill=0, width=4, joint="curve")


def _grid(d):
    for v in (100, 200, 300):
        d.line((30, v, 370, v), fill=0, width=4)
        d.line((v, 30, v, 370), fill=0, width=4)


def _parallel(d):
    d.line((40, 160, 360, 160), fill=0, width=5)
    d.line((40, 172, 360, 172), fill=0, width=5)           # 12 px entre ejes: queda 7 px de blanco


def _mandala(d, n=480):
    c = n / 2
    for r in (n * 0.47, n * 0.40, n * 0.18):
        d.ellipse((c - r, c - r, c + r, c + r), outline=0, width=4)
    for k in range(12):                                       # pétalos: elipses giradas
        a = k * math.pi / 6
        pts = []
        for t in [i * math.pi / 40 for i in range(81)]:
            x, y = 0.075 * n * math.cos(t), 0.040 * n * math.sin(t)
            cx, cy = c + 0.29 * n * math.cos(a), c + 0.29 * n * math.sin(a)
            pts.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
        d.line(pts, fill=0, width=3, joint="curve")
    for k in range(60):                                       # rayas entre los dos círculos exteriores
        a = k * math.pi / 30
        d.line((c + 0.40 * n * math.cos(a), c + 0.40 * n * math.sin(a),
                c + 0.47 * n * math.cos(a), c + 0.47 * n * math.sin(a)), fill=0, width=2)


# ------------------------------------------------------------------ utilidades de medida
def _length(path):
    return sum(math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]) for k in range(len(path) - 1))


def _closed(path, tol=0.6):
    return math.hypot(path[0][0] - path[-1][0], path[0][1] - path[-1][1]) <= tol


def _max_turn(path):
    """Mayor giro (grados) entre segmentos consecutivos: una curva suave gira poco por segmento."""
    worst = 0.0
    for k in range(1, len(path) - 1):
        a = (path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1])
        b = (path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1])
        na, nb = math.hypot(*a), math.hypot(*b)
        if na < 1e-9 or nb < 1e-9:
            continue
        cos = max(-1.0, min(1.0, (a[0] * b[0] + a[1] * b[1]) / (na * nb)))
        worst = max(worst, math.degrees(math.acos(cos)))
    return worst


def _raster(strokes_px, shape, width):
    img = Image.new("L", (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    for p in strokes_px:
        pts = [(float(x), float(y)) for y, x in p]
        if len(pts) > 1:
            d.line(pts, fill=255, width=width)
    return np.asarray(img) > 0


def _regions(blank, min_area):
    """Regiones blancas (4-conexas) de al menos `min_area` píxeles."""
    h, w = blank.shape
    seen = np.zeros_like(blank, dtype=bool)
    count = 0
    for sy in range(h):
        for sx in range(w):
            if not blank[sy, sx] or seen[sy, sx]:
                continue
            q, area = deque([(sy, sx)]), 0
            seen[sy, sx] = True
            while q:
                y, x = q.popleft()
                area += 1
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= ny < h and 0 <= nx < w and blank[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            count += area >= min_area
    return count


def _quality(data):
    """(recall, precisión, regiones de la imagen, regiones del dibujo) en píxeles de trabajo."""
    strokes, info = plotter.vectorize(data)
    gray = plotter.load_gray(data)
    mask, up = plotter.ink_mask(gray, info["threshold"], info["invert"])
    half = mask.sum() / max(plotter.thin(mask).sum(), 1) / 2
    r = int(round(half + 1.5))
    recall = float((mask & _raster(strokes, mask.shape, 2 * r + 1)).sum() / mask.sum())
    near_ink = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(__import__("PIL.ImageFilter", fromlist=["x"]).MaxFilter(3))) > 0
    line = _raster(strokes, mask.shape, 1)
    precision = float((line & near_ink).sum() / max(line.sum(), 1))
    area = 25 * (up / 2) ** 2 / 4
    original = _regions(~mask[::2, ::2], area)                    # a media resolución: igual de fiel y 4 veces más rápido
    drawn = _regions(~_raster(strokes, mask.shape, int(2 * half) + 1)[::2, ::2], area)
    return recall, precision, original, drawn


# ------------------------------------------------------------------ 1-4: formas básicas
class TestBasicShapes:
    def test_circle_is_one_closed_smooth_stroke_on_the_circle(self):
        paths = plotter.trace(_png(_circle), 80, 80)
        assert len(paths) == 1 and _closed(paths[0])
        center = (40.0, 40.0)
        radii = [math.hypot(x - center[0], y - center[1]) for x, y in paths[0]]
        assert max(abs(r - 40.0) for r in radii) < 0.25               # circunferencia, no un polígono pixelado
        assert _length(paths[0]) == pytest.approx(2 * math.pi * 40, rel=0.02)
        assert _max_turn(paths[0]) < 15                               # sin dientes de sierra

    def test_square_keeps_its_four_corners_and_straight_sides(self):
        paths = plotter.trace(_png(_square), 80, 80)
        assert len(paths) == 1 and _closed(paths[0])
        path = paths[0]
        assert len(path) <= 14                                        # lados rectos = pocos puntos
        for corner in ((0, 0), (80, 0), (80, 80), (0, 80)):
            assert min(math.hypot(x - corner[0], y - corner[1]) for x, y in path) < 0.6      # esquinas vivas
        assert all(min(x, 80 - x, y, 80 - y) < 0.25 for x, y in path)                       # sobre el borde

    def test_open_curve_is_one_stroke_with_no_sawtooth(self):
        paths = plotter.trace(_png(_curve), 80, 80)
        assert len(paths) == 1 and not _closed(paths[0])
        assert _max_turn(paths[0]) < 15
        assert len(paths[0]) < 200                                    # curva suave con pocos puntos, no cientos de píxeles

    def test_closed_line_stays_closed(self):
        paths = plotter.trace(_png(_closed_blob), 80, 80)
        assert len(paths) == 1 and _closed(paths[0])
        assert _max_turn(paths[0]) < 20


# ------------------------------------------------------------------ 5: mandala
class TestMandala:
    def test_recognizable_and_faithful(self):
        data = _png(_mandala, (480, 480))
        recall, precision, original, drawn = _quality(data)
        assert recall >= 0.95 and precision >= 0.97
        assert original >= 70 and drawn == original                   # misma cantidad de regiones: nada se fundió ni se cortó

    def test_stroke_budget_and_no_junk(self):
        paths = plotter.trace(_png(_mandala, (480, 480)), 80, 80)
        assert 12 <= len(paths) <= 240
        assert all(_length(p) >= plotter.MIN_STROKE_MM for p in paths)
        assert sum(len(p) for p in paths) < 6000
        assert all(_max_turn(p) < 60 for p in paths if len(p) > 4)


# ------------------------------------------------------------------ 6-7: intersecciones y líneas cercanas
class TestIntersectionsAndCloseLines:
    def test_grid_strokes_continue_through_the_crossings(self):
        paths = plotter.trace(_png(_grid), 80, 80)
        assert len(paths) <= 8                                        # 6 líneas rectas, no un pedacito por cruce
        assert sum(_length(p) for p in paths) == pytest.approx(6 * 80 * 340 / 340 * 1.0, rel=0.04) or \
            sum(_length(p) for p in paths) > 6 * 70

    def test_close_parallel_lines_stay_two_separate_lines(self):
        paths = plotter.trace(_png(_parallel), 80, 80)
        assert len(paths) == 2
        ys = sorted(sum(y for _, y in p) / len(p) for p in paths)
        assert ys[1] - ys[0] == pytest.approx(12 * 80 / 330, abs=0.25)           # la separación original (12 px) se respeta

    def test_dense_hatching_is_not_fused(self):
        def hatch(d):
            for k in range(20):
                d.line((40, 40 + k * 16, 360, 40 + k * 16), fill=0, width=4)
        assert len(plotter.trace(_png(hatch), 80, 80)) == 20


# ------------------------------------------------------------------ 8-10: ruido, invertida, transparente
class TestRobustness:
    def test_noisy_image_still_gives_a_clean_circle(self):
        rng = np.random.default_rng(7)
        img = Image.open(io.BytesIO(_png(_circle)))
        a = np.asarray(img, dtype=np.float64) + rng.normal(0, 25, (400, 400))
        for _ in range(60):                                           # motas sueltas
            y, x = rng.integers(60, 340, 2)
            a[y:y + 2, x:x + 2] = 0
        out = io.BytesIO()
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(out, "PNG")
        paths = plotter.trace(out.getvalue(), 80, 80)
        big = [p for p in paths if _length(p) > 100]
        assert len(big) == 1 and _length(big[0]) == pytest.approx(2 * math.pi * 40, rel=0.05)
        assert all(_length(p) >= plotter.MIN_STROKE_MM for p in paths)          # sin rayones
        assert len(paths) <= 3

    def test_inverted_image_gives_the_same_drawing(self):
        normal = plotter.trace(_png(_circle), 80, 80)
        inverted = plotter.trace(_png(lambda d: d.ellipse((30, 30, 370, 370), outline=255, width=5), background=0), 80, 80)
        assert len(inverted) == 1 and _length(inverted[0]) == pytest.approx(_length(normal[0]), rel=0.03)

    def test_transparent_background_is_read_over_white(self):
        def draw(d):
            d.ellipse((30, 30, 370, 370), outline=(0, 0, 0, 255), width=5)
        paths = plotter.trace(_png(draw, background=(0, 0, 0, 0), mode="RGBA"), 80, 80)
        assert len(paths) == 1 and _length(paths[0]) == pytest.approx(2 * math.pi * 40, rel=0.03)

    def test_a_framed_drawing_is_not_mistaken_for_an_inverted_one(self):
        def draw(d):
            d.rectangle((2, 2, 397, 397), outline=0, width=4)
            _circle(d)
        assert len(plotter.trace(_png(draw), 80, 80)) == 2

    def test_photo_is_rejected_with_a_clear_notice(self):
        rng = np.random.default_rng(3)
        x = np.linspace(0, 6, 300)
        photo = 128 + 70 * np.sin(x[None, :] * 3) * np.cos(x[:, None] * 2) + rng.normal(0, 18, (300, 300))
        out = io.BytesIO()
        Image.fromarray(np.clip(photo, 0, 255).astype(np.uint8)).save(out, "PNG")
        with pytest.raises(plotter.PlotterError, match="fotografía"):
            plotter.trace(out.getvalue(), 80, 80)

    def test_blank_or_broken_images_give_a_clear_error(self):
        with pytest.raises(plotter.PlotterError, match="ningún trazo"):
            plotter.trace(_png(lambda d: None), 80, 80)
        with pytest.raises(plotter.PlotterError, match="leer la imagen"):
            plotter.trace(b"no soy una imagen", 80, 80)
        with pytest.raises(plotter.PlotterError, match="ninguna imagen"):
            plotter.trace(b"", 80, 80)

    def test_filled_shapes_are_reported(self):
        paths, notes = plotter.trace_ex(_png(lambda d: d.ellipse((60, 60, 340, 340), fill=0)), 80, 80)
        assert paths and any("rellenas" in n for n in notes)

    def test_any_size_fits_the_requested_box_from_the_origin(self):
        data = _png(_circle)
        for w, h in ((80, 80), (150, 60), (30, 200)):
            paths = plotter.trace(data, w, h)
            xs = [x for p in paths for x, _ in p]
            ys = [y for p in paths for _, y in p]
            assert min(xs) == pytest.approx(0, abs=0.1) and min(ys) == pytest.approx(0, abs=0.1)
            assert max(xs) <= w + 1e-6 and max(ys) <= h + 1e-6
            assert max(xs) >= w - 0.1 or max(ys) >= h - 0.1                  # llena la caja por el lado que manda
            assert all(math.isfinite(v) for p in paths for pt in p for v in pt)


class TestFineTuning:
    """Los dos ajustes opcionales de la pantalla (suavidad y limpieza) y la precisión."""

    def test_more_smoothing_gives_a_smoother_line_without_losing_the_shape(self):
        data = _png(_mandala, (480, 480))
        base = plotter.trace(data, 80, 80)
        smooth = plotter.trace(data, 80, 80, smoothing=2.5)
        assert sum(map(len, smooth)) <= sum(map(len, base))
        assert abs(len(smooth) - len(base)) <= 3

    def test_less_smoothing_stays_closer_to_the_pixels(self):
        data = _png(_circle)
        rough = plotter.trace(data, 80, 80, smoothing=0.3)[0]
        smooth = plotter.trace(data, 80, 80, smoothing=1.0)[0]
        assert max(abs(math.hypot(x - 40, y - 40) - 40) for x, y in smooth) <= \
            max(abs(math.hypot(x - 40, y - 40) - 40) for x, y in rough) + 0.05

    def test_cleanup_removes_tiny_details_and_zero_keeps_them(self):
        def dotted(d):
            _circle(d)
            for k in range(30):                                    # puntitos sueltos
                d.ellipse((60 + 10 * k % 300, 150 + (k * 37) % 120, 64 + 10 * k % 300, 154 + (k * 37) % 120), fill=0)
        data = _png(dotted)
        normal = plotter.trace(data, 80, 80)
        cleaner = plotter.trace(data, 80, 80, cleanup=4)
        keep_all = plotter.trace(data, 80, 80, cleanup=0)
        assert len(cleaner) <= len(normal) <= len(keep_all)
        assert len(cleaner) == 1                                  # solo queda el círculo

    def test_precision_changes_the_number_of_points(self):
        data = _png(_circle)
        fine = plotter.trace(data, 80, 80, detail=0.2)[0]
        coarse = plotter.trace(data, 80, 80, detail=4)[0]
        assert len(fine) > len(coarse)


class TestOrdering:
    def test_nearest_first_and_reverses_a_stroke_when_it_helps(self):
        far, near = [(50.0, 50.0), (60.0, 50.0)], [(10.0, 0.0), (1.0, 0.0)]
        out = plotter.order_paths([far, near])
        assert out[0][0] == (1.0, 0.0) and out[1][0] == (50.0, 50.0)


# ------------------------------------------------------------------ G-code
class TestGcode:
    PATHS = [[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], [(20.0, 20.0), (30.0, 20.0)]]

    def text(self):
        return plotter.to_gcode(self.PATHS, 3, 0, 1500, 500, 2000, "prueba")

    def test_is_plotter_gcode_without_laser_or_coolant_commands(self):
        text = self.text()
        assert not re.search(r"\bM\d+", text)                 # ni M3/M4/M5/M8
        assert not re.search(r"\bS\d", text)                  # ni potencia
        assert text.split("\n")[4:7] == ["G21", "G90", "G17"]
        assert "G0 Z3" in text and "G1 Z0 F500" in text

    def test_pen_goes_up_between_strokes_and_at_the_end(self):
        lines = self.text().splitlines()
        assert lines[-2:] == ["G0 Z3", "G0 X0 Y0 F2000"]
        assert lines.count("G1 Z0 F500") == 2

    def test_a_stroke_starting_where_the_pen_is_does_not_lift_it(self):
        text = plotter.to_gcode([[(0.0, 0.0), (5.0, 0.0)], [(5.2, 0.0), (9.0, 0.0)]], 3, 0, 1500, 500, 2000)
        assert text.count("G1 Z0 F500") == 1

    def test_only_absolute_millimetre_moves(self):
        text = self.text()
        assert "G91" not in text and "G20" not in text

    def test_stats(self):
        info = plotter.stats(self.PATHS, 1500, 2000)
        assert info["strokes"] == 2 and info["drawn_mm"] == pytest.approx(30, abs=0.1)
        assert info["travel_mm"] > 0 and info["minutes"] > 0

    def test_preview_and_gcode_are_the_same_geometry(self):
        """Lo que la vista previa dibuja es exactamente lo que el plotter recorre."""
        paths = plotter.trace(_png(_mandala, (480, 480)), 80, 80)
        lines = plotter.to_gcode(paths, 3, 0, 1500, 500, 2000).splitlines()
        drawn, current, down = [], None, False
        x = y = 0.0
        for line in lines:
            if line.startswith("G0 Z"):
                down = False
            elif line.startswith("G1 Z"):
                down = True
                current = [(x, y)]
                drawn.append(current)
            else:
                m = re.match(r"G([01]) (?:X(-?[\d.]+) Y(-?[\d.]+))", line) or re.match(r"G(1) X(-?[\d.]+) Y(-?[\d.]+)", line)
                if m:
                    x, y = float(m.group(2)), float(m.group(3))
                    if m.group(1) == "1" and down:
                        current.append((x, y))
        # sin los levantamientos evitados, los trazos del G-code son los de la vista previa, en el mismo orden
        flat_preview = [pt for p in paths for pt in p]
        flat_gcode = [pt for p in drawn for pt in p]
        assert len(flat_gcode) >= len(flat_preview) - len(paths)
        preview_set = {(round(px, 3), round(py, 3)) for px, py in flat_preview}
        assert all((round(gx, 3), round(gy, 3)) in preview_set for gx, gy in flat_gcode)
        assert all(math.isfinite(v) and -1e-6 <= v <= 80.01 for pt in flat_gcode for v in pt)
        z_values = {m.group(1) for line in lines for m in [re.search(r"Z(-?[\d.]+)", line)] if m}
        assert z_values == {"3", "0"}


# ------------------------------------------------------------------ API
@pytest.fixture
def gcode_root(tmp_path, monkeypatch):
    root = tmp_path / "uploads" / "gcode"
    root.mkdir(parents=True)
    monkeypatch.setattr(utils, "GCODE_ROOT", str(root))
    return root


def _post(client, route, image, **data):
    return client.post(route, files={"file": ("m.png", image, "image/png")}, data=data)


class TestApi:
    def test_preview_returns_paths_in_mm_stats_and_notes(self, client, as_operator):
        r = _post(client, "/api/plotter/preview", _png(_circle), width_mm=80, height_mm=80)
        body = r.json()
        assert r.status_code == 200 and body["paths"] and body["stats"]["width_mm"] == pytest.approx(80, abs=0.1)
        assert body["notes"] == []
        assert all(0 <= x <= 80.01 and 0 <= y <= 80.01 for p in body["paths"] for x, y in p)

    def test_generate_saves_plotter_gcode_in_the_library(self, client, as_operator, gcode_root):
        r = _post(client, "/api/plotter/generate", _png(_circle), name="mandala", width_mm=80, height_mm=80,
                  pen_up_z=3, pen_down_z=0)
        body = r.json()
        assert r.status_code == 200 and body["filename"] == "mandala.gc"
        text = (gcode_root / "mandala.gc").read_text(encoding="utf-8")
        assert not re.search(r"\bM\d+", text) and "G1 Z0" in text
        again = _post(client, "/api/plotter/generate", _png(_circle), name="mandala").json()
        assert again["filename"] == "mandala-2.gc"                      # no pisa el archivo anterior

    def test_name_cannot_escape_the_library(self, client, as_operator, gcode_root):
        r = _post(client, "/api/plotter/generate", _png(_circle), name="../../etc/passwd")
        assert r.status_code == 200
        assert (gcode_root / "etcpasswd.gc").exists()
        assert not list(gcode_root.parent.parent.glob("etc*"))

    @pytest.mark.parametrize("data", [{"width_mm": 1}, {"height_mm": 99999}, {"threshold": 300}, {"detail": 50},
                                      {"pen_up_z": 0, "pen_down_z": 0}, {"feed": 1}, {"pen_up_z": 900},
                                      {"invert": "quizá"}, {"smoothing": 9}, {"cleanup": 99}])
    def test_rejects_out_of_range_values(self, client, as_operator, gcode_root, data):
        assert _post(client, "/api/plotter/generate", _png(_circle), **data).status_code == 400

    def test_bad_image_is_a_400_with_a_readable_message(self, client, as_operator, gcode_root):
        r = _post(client, "/api/plotter/preview", b"nada")
        assert r.status_code == 400 and "imagen" in r.json()["detail"]

    def test_everything_is_automatic_by_default(self, client, as_operator):
        r = _post(client, "/api/plotter/preview", _png(lambda d: d.ellipse((30, 30, 370, 370), outline=255, width=5), background=0))
        assert r.status_code == 200 and len(r.json()["paths"]) == 1

    def test_photo_gets_the_notice_not_thousands_of_lines(self, client, as_operator):
        rng = np.random.default_rng(3)
        x = np.linspace(0, 6, 300)
        photo = 128 + 70 * np.sin(x[None, :] * 3) * np.cos(x[:, None] * 2) + rng.normal(0, 18, (300, 300))
        out = io.BytesIO()
        Image.fromarray(np.clip(photo, 0, 255).astype(np.uint8)).save(out, "PNG")
        r = _post(client, "/api/plotter/preview", out.getvalue())
        assert r.status_code == 400 and "fotografía" in r.json()["detail"]

    def test_requires_a_session(self, client):
        assert _post(client, "/api/plotter/preview", _png(_circle)).status_code in (401, 403)
