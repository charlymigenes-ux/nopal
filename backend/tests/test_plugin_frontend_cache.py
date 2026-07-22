from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_plugin_frontend_assets_are_versioned_from_manifest():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    assert "versionedPluginAssetUrl(plugin.frontend.style, plugin.version)" in javascript
    assert "versionedPluginAssetUrl(plugin.frontend.script, plugin.version)" in javascript


def test_core_app_cachebuster_is_updated():
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    assert '/static/js/app.js?v=210' in html


def test_plugin_update_requires_a_newer_catalog_version_and_actions_fit_card():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "backend/static/css/style.css").read_text(encoding="utf-8")
    catalog = (ROOT / "backend/plugin_catalog.json").read_text(encoding="utf-8")
    assert "if (catalogPart > installedPart) return true" in javascript
    assert "if (catalogPart < installedPart) return false" in javascript
    assert "plugin-card-actions${pluginUpdateAvailable(plugin) ? ' has-update' : ''}" in javascript
    assert ".plugin-card-actions.has-update { width: 100%; }" in stylesheet
    assert '"id": "arduino-accessories"' in catalog
    assert '"version": "2.4.0"' in catalog
