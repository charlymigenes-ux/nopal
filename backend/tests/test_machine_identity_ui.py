"""El panel no debe derivar direcciones del id de máquina ni vincular cámaras
por dirección (identidad estable de máquinas).

Regresión: la lista de dispositivos registrados sacaba el host quitándole
`laser:` al id (`laser:mch_…` → `mch_…`) y lo usaba para editar, desvincular y
consultar estado; las secciones Láser/CNC y el modal Marlin montaban la cámara
con el host o la ruta USB, que ya no coinciden con el vínculo por id interno.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_JS = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")


def test_host_is_never_derived_from_machine_id():
    assert not re.search(r"\.replace\(/\^(laser|marlin|cnc):/", APP_JS)
    assert not re.search(r"id\)?\.split\(['\"]:['\"]\)\[1\]", APP_JS)


def test_machine_cameras_are_mounted_by_internal_id():
    mounts = re.findall(r"NopalCameraCard\?\.mount\([^;]*deviceType: '(laser|cnc|marlin)', deviceId: ([^ }]+)", APP_JS)
    assert {kind for kind, _ in mounts} == {"laser", "cnc", "marlin"}
    for kind, device_id in mounts:
        assert device_id in ("activeId", "activeDevice.id", "entry.id"), (kind, device_id)
