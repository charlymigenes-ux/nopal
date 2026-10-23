"""Render 2D compartido del G-code (galería, lista, mosaico y sección Láser)."""
import json
import os
import time

import pytest

from backend.services import gcode_render_service as render
from backend.utils import get_section_root

SAMPLE = "\n".join([
    "G21", "G90", "M4", "G0 X0 Y0",
    "G1 X10 Y0 S800 F1000", "G1 X10 Y20", "G1 X0 Y20 S400", "G1 X0 Y0", "M5", "",
])


@pytest.fixture
def gcode_file(tmp_path, monkeypatch):
    monkeypatch.setattr(render, "RENDER_ROOT", str(tmp_path / "cache"))
    rel = "pruebas-render/cuadro.gc"
    path = os.path.join(get_section_root("gcode"), rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(SAMPLE)
    yield rel
    os.remove(path)
    os.rmdir(os.path.dirname(path))


def test_limites_y_proporcion_salen_del_trazo(gcode_file):
    png, meta = render.ensure_render(gcode_file)
    assert os.path.isfile(png)
    assert meta["bounds"] == {"minX": 0.0, "minY": 0.0, "maxX": 10.0, "maxY": 20.0}
    assert meta["height_px"] == render.LONG_SIDE
    assert meta["width_px"] == render.LONG_SIDE // 2


def test_no_se_regenera_si_el_archivo_no_cambio(gcode_file):
    png, _ = render.ensure_render(gcode_file)
    first = os.path.getmtime(png)
    time.sleep(0.05)
    render.ensure_render(gcode_file)
    assert os.path.getmtime(png) == first


def test_se_regenera_si_el_archivo_cambia(gcode_file):
    png, _ = render.ensure_render(gcode_file)
    source = os.path.join(get_section_root("gcode"), gcode_file)
    with open(source, "a") as handle:
        handle.write("G1 X30 Y20 S500\n")
    os.utime(source, (time.time() + 5, time.time() + 5))
    _, meta = render.ensure_render(gcode_file)
    assert meta["bounds"]["maxX"] == 30.0


def test_archivo_sin_trayectoria_da_lienzo_liso(tmp_path):
    vacio = tmp_path / "vacio.gc"
    vacio.write_text("; nada\nM5\n")
    image, bounds = render.render_gcode(str(vacio))
    assert bounds is None
    assert image.getextrema() == ((8, 8), (20, 20), (16, 16))


def test_archivo_inexistente_lanza_filenotfound():
    with pytest.raises(FileNotFoundError):
        render.ensure_render("no-existe/nada.gc")


def test_el_avance_sube_mientras_renderiza_y_cierra_en_listo(gcode_file):
    assert render.get_progress(gcode_file) == {"status": "none", "percent": 0}

    visto = []
    original = render._set_progress

    def espiar(rel, status, percent):
        visto.append((status, percent))
        original(rel, status, percent)

    render._set_progress = espiar
    try:
        render.ensure_render(gcode_file)
    finally:
        render._set_progress = original

    assert visto and all(estado == "rendering" for estado, _ in visto)
    assert [p for _, p in visto] == sorted(p for _, p in visto)  # nunca retrocede
    assert render.get_progress(gcode_file) == {"status": "done", "percent": 100}


def test_un_render_pendiente_se_reporta_en_cola(gcode_file):
    render._set_progress(gcode_file, "queued", 0)
    try:
        assert render.get_progress(gcode_file) == {"status": "queued", "percent": 0}
    finally:
        render._progress.pop(gcode_file, None)
