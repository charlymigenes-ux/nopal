"""Imagen -> trazos -> G-code de plotter para la CNC con lápiz (eje Z).

Regresión de fondo: el G-code de láser (M4, M8, S) hace que la CNC en perfil
plotter responda error:20 y aborte el trabajo en la línea 3; el de plotter no
debe llevar nunca esos comandos."""

import io
import math
import re

import pytest
from PIL import Image, ImageDraw

from backend import utils
from backend.services import plotter_service as plotter


def _png(draw, size=(300, 300), background=255):
    img = Image.new("L", size, background)
    draw(ImageDraw.Draw(img))
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def _circle(d):
    d.ellipse((20, 20, 280, 280), outline=0, width=5)


def _cross(d):
    d.line((20, 150, 280, 150), fill=0, width=4)
    d.line((150, 20, 150, 280), fill=0, width=4)


class TestTracing:
    def test_thick_circle_becomes_one_centerline_not_two_edges(self):
        paths = plotter.trace(_png(_circle), 80, 80)
        # una circunferencia de 80 mm mide ~251 mm; sus dos bordes serían ~500 mm
        assert 230 <= sum(plotter._length(p) for p in paths) <= 270

    def test_fits_the_requested_box_from_the_origin(self):
        paths = plotter.trace(_png(_circle), 80, 80)
        xs = [x for p in paths for x, _ in p]
        ys = [y for p in paths for _, y in p]
        assert min(xs) == pytest.approx(0, abs=1e-6) and min(ys) == pytest.approx(0, abs=1e-6)
        assert max(xs) == pytest.approx(80, abs=0.01) and max(ys) == pytest.approx(80, abs=0.01)

    def test_keeps_the_aspect_ratio(self):
        info = plotter.stats(plotter.trace(_png(lambda d: d.rectangle((10, 10, 290, 90), outline=0, width=4),
                                                size=(300, 100)), 80, 80), 1500, 3000)
        assert info["width_mm"] == pytest.approx(80, abs=0.01) and info["height_mm"] < 80

    def test_y_axis_is_flipped_so_the_top_of_the_image_is_the_top_of_the_drawing(self):
        paths = plotter.trace(_png(lambda d: d.line((20, 20, 280, 20), fill=0, width=4)
                                   or d.line((20, 20, 20, 280), fill=0, width=4)), 80, 80)
        # el corte vertical queda a lo largo de x=0 y el horizontal arriba (y=80)
        ys_at_top = [y for p in paths for x, y in p if y > 79]
        assert ys_at_top

    def test_cross_has_few_strokes_and_every_point_is_inside_the_box(self):
        paths = plotter.trace(_png(_cross), 80, 80)
        assert len(paths) <= 12
        assert all(-1e-6 <= x <= 80.01 and -1e-6 <= y <= 80.01 for p in paths for x, y in p)

    def test_invert_traces_white_on_black(self):
        img = _png(lambda d: d.ellipse((20, 20, 280, 280), outline=255, width=5), background=0)
        paths = plotter.trace(img, 80, 80, invert=True)
        assert 230 <= sum(plotter._length(p) for p in paths) <= 270

    def test_blank_or_broken_images_give_a_clear_error(self):
        with pytest.raises(plotter.PlotterError, match="ningún trazo"):
            plotter.trace(_png(lambda d: None), 80, 80)
        with pytest.raises(plotter.PlotterError, match="leer la imagen"):
            plotter.trace(b"no soy una imagen", 80, 80)
        with pytest.raises(plotter.PlotterError, match="ninguna imagen"):
            plotter.trace(b"", 80, 80)

    def test_transparent_png_is_read_over_white(self):
        img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse((10, 10, 190, 190), outline=(0, 0, 0, 255), width=4)
        out = io.BytesIO()
        img.save(out, "PNG")
        assert plotter.trace(out.getvalue(), 80, 80)


class TestOrdering:
    def test_nearest_first_and_reverses_a_stroke_when_it_helps(self):
        far, near = [(50.0, 50.0), (60.0, 50.0)], [(10.0, 0.0), (1.0, 0.0)]
        out = plotter.order_paths([far, near])
        assert out[0][0] == (1.0, 0.0) and out[1][0] == (50.0, 50.0)


class TestGcode:
    PATHS = [[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], [(20.0, 20.0), (30.0, 20.0)]]

    def text(self):
        return plotter.to_gcode(self.PATHS, 3, 0, 1500, 500, 3000, "prueba")

    def test_is_plotter_gcode_without_laser_or_coolant_commands(self):
        text = self.text()
        assert not re.search(r"\bM\d+", text)                 # ni M3/M4/M5/M8
        assert not re.search(r"\bS\d", text)                  # ni potencia
        assert text.split("\n")[4:7] == ["G21", "G90", "G17"]
        assert "G0 Z3" in text and "G1 Z0 F500" in text

    def test_pen_goes_up_between_strokes_and_at_the_end(self):
        lines = self.text().splitlines()
        assert lines[-2:] == ["G0 Z3", "G0 X0 Y0 F3000"]
        assert lines.count("G1 Z0 F500") == 2

    def test_a_stroke_starting_where_the_pen_is_does_not_lift_it(self):
        text = plotter.to_gcode([[(0.0, 0.0), (5.0, 0.0)], [(5.2, 0.0), (9.0, 0.0)]], 3, 0, 1500, 500, 3000)
        assert text.count("G1 Z0 F500") == 1

    def test_only_absolute_millimetre_moves(self):
        text = self.text()
        assert "G91" not in text and "G20" not in text

    def test_stats(self):
        info = plotter.stats(self.PATHS, 1500, 3000)
        assert info["strokes"] == 2 and info["drawn_mm"] == pytest.approx(30, abs=0.1)
        assert info["travel_mm"] > 0 and info["minutes"] > 0


@pytest.fixture
def gcode_root(tmp_path, monkeypatch):
    root = tmp_path / "uploads" / "gcode"
    root.mkdir(parents=True)
    monkeypatch.setattr(utils, "GCODE_ROOT", str(root))
    return root


def _post(client, route, image, **data):
    return client.post(route, files={"file": ("m.png", image, "image/png")}, data=data)


class TestApi:
    def test_preview_returns_paths_in_mm_and_stats(self, client, as_operator):
        r = _post(client, "/api/plotter/preview", _png(_circle), width_mm=80, height_mm=80)
        body = r.json()
        assert r.status_code == 200 and body["paths"] and body["stats"]["width_mm"] == pytest.approx(80, abs=0.01)
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

    def test_name_cannot_escape_the_drawings_folder(self, client, as_operator, gcode_root):
        r = _post(client, "/api/plotter/generate", _png(_circle), name="../../etc/passwd")
        assert r.status_code == 200
        assert (gcode_root / "etcpasswd.gc").exists()
        assert not list(gcode_root.parent.parent.glob("etc*"))

    @pytest.mark.parametrize("data", [{"width_mm": 1}, {"height_mm": 99999}, {"threshold": 0}, {"detail": 50},
                                      {"pen_up_z": 0, "pen_down_z": 0}, {"feed": 1}, {"pen_up_z": 900}])
    def test_rejects_out_of_range_values(self, client, as_operator, gcode_root, data):
        assert _post(client, "/api/plotter/generate", _png(_circle), **data).status_code == 400

    def test_bad_image_is_a_400_with_a_readable_message(self, client, as_operator, gcode_root):
        r = _post(client, "/api/plotter/preview", b"nada")
        assert r.status_code == 400 and "imagen" in r.json()["detail"]

    def test_requires_a_session(self, client):
        assert _post(client, "/api/plotter/preview", _png(_circle)).status_code in (401, 403)
