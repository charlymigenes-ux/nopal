from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_material_preheat_is_available_for_klipper_and_marlin_cards():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    assert 'id="material-preheat-modal"' in html
    assert "openMaterialPreheatModal({ type: 'klipper'" in javascript
    assert "openMaterialPreheatModal({ type: 'marlin'" in javascript
    assert 'data-marlin-temp-action="preheat"' in javascript
    assert "setMarlinHeaterTarget" in javascript
    assert "material-preset-editor-row" in javascript


def test_material_preheat_assets_use_new_cache_versions():
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    assert '/static/css/style.css?v=271' in html
    assert '/static/js/app.js?v=215' in html
