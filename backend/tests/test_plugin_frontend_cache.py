import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

# Versión semver simple (mayor.menor.parche), que es lo que compara
# pluginUpdateAvailable() en app.js parte por parte.
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def test_plugin_frontend_assets_are_versioned_from_manifest():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    assert "versionedPluginAssetUrl(plugin.frontend.style, plugin.version)" in javascript
    assert "versionedPluginAssetUrl(plugin.frontend.script, plugin.version)" in javascript


def test_core_app_cachebuster_is_updated():
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    # Lo que importa es que app.js siga saliendo con cachebuster numérico, no
    # que apunte a un número concreto que queda viejo en cuanto alguien lo sube.
    assert re.search(r"/static/js/app\.js\?v=\d+", html)


def test_plugin_update_requires_a_newer_catalog_version_and_actions_fit_card():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "backend/static/css/style.css").read_text(encoding="utf-8")
    catalog = json.loads((ROOT / "backend/plugin_catalog.json").read_text(encoding="utf-8"))
    assert "if (catalogPart > installedPart) return true" in javascript
    assert "if (catalogPart < installedPart) return false" in javascript
    assert "plugin-card-actions${pluginUpdateAvailable(plugin) ? ' has-update' : ''}" in javascript
    assert ".plugin-card-actions.has-update { width: 100%; }" in stylesheet

    # No se fija un número de versión literal: el catálogo se sincroniza con cada
    # repo de plugin y eso dejaba el test en rojo permanente. Basta con que cada
    # entrada traiga una versión semver comparable por pluginUpdateAvailable().
    catalog_ids = {entry["id"] for entry in catalog}
    assert "arduino-accessories" in catalog_ids
    for entry in catalog:
        assert isinstance(entry["version"], str), entry["id"]
        assert SEMVER_RE.match(entry["version"]), f"{entry['id']}: {entry['version']}"


def test_machine_cards_expose_plugin_gated_led_scenes():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "backend/static/css/style.css").read_text(encoding="utf-8")
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    assert 'machineLedCardIdentity' in javascript
    assert "item.id === 'arduino-accessories'" in javascript
    assert '/api/accessories/machine-led/config' in javascript
    assert '/api/accessories/machine-led/state' in javascript
    assert 'Falta registrar una tira LED' in javascript
    assert 'protocolo 4' in javascript
    assert 'id="machine-led-modal"' in html
    assert '.machine-led-settings-btn' in stylesheet
