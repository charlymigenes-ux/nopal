"""La impresora Marlin usa la ficha unificada (`deviceCardHtml`) como Klipper
y láser/CNC, para que muestre su cámara vinculada igual que las demás.

Prueba estática: lee app.js como texto (no hay Node en el entorno). Se busca
la forma de las cosas, no el formato exacto, para no romperse con cambios de
espacios o de orden.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_JS = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")


def _function_body(name):
    """Cuerpo de `function name(...) { ... }` contando llaves (sin parsear
    strings: alcanza para las funciones de este archivo que se revisan)."""
    match = re.search(r"(?:async\s+)?function\s+" + re.escape(name) + r"\s*\(", APP_JS)
    assert match, f"no existe la función {name}"
    # La llave del cuerpo es la que sigue al cierre de los parámetros (un
    # parámetro desestructurado también lleva llaves).
    start = re.compile(r"\)\s*\{").search(APP_JS, match.end()).end() - 1
    depth = 0
    for index in range(start, len(APP_JS)):
        if APP_JS[index] == "{":
            depth += 1
        elif APP_JS[index] == "}":
            depth -= 1
            if depth == 0:
                return APP_JS[start:index + 1]
    raise AssertionError(f"función {name} sin cerrar")


def test_marlin_device_model_exists():
    body = _function_body("marlinDeviceModel")
    for field in ("typeLabel", "stateLabel", "metrics", "actions", "cameraSlot", "dataAttr"):
        assert field in body, field


def test_dashboard_renders_marlin_with_unified_card():
    body = _function_body("loadDashboardStandalonePrinters")
    assert re.search(r"deviceCardHtml\(\s*marlinDeviceModel\(", body)
    assert "marlinPrinterCardHtml" not in APP_JS


def test_marlin_camera_key_uses_internal_id_not_device():
    body = _function_body("marlinDeviceModel")
    assert re.search(r"`marlin:\$\{printer\.id\}`", body)
    assert not re.search(r"`marlin:\$\{(printer\.)?device\}`", body)
    assert "accionCamara(" in body
    assert "deviceCameraKeys.has(" in body


def test_marlin_card_keeps_device_and_machine_uid_attributes():
    body = _function_body("marlinDeviceModel")
    assert "data-marlin-device=" in body
    assert "data-machine-uid=" in body


def test_marlin_card_actions_use_existing_marlin_endpoints():
    quick = _function_body("handleMarlinQuickAction")
    assert "/api/marlin-printers/print/" in quick
    temp = _function_body("marlinTemperatureQuickAction")
    assert "setMarlinHeaterTarget" in temp
    assert "openMaterialPreheatModal({ type: 'marlin'" in temp
    bind = _function_body("bindMarlinDeviceCards")
    assert "handleMarlinQuickAction(" in bind
    assert "marlinTemperatureQuickAction(" in bind
    assert "openMarlinPrinterModal(" in bind
