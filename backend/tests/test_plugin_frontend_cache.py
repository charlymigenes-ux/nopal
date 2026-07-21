from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_plugin_frontend_assets_are_versioned_from_manifest():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    assert "versionedPluginAssetUrl(plugin.frontend.style, plugin.version)" in javascript
    assert "versionedPluginAssetUrl(plugin.frontend.script, plugin.version)" in javascript


def test_core_app_cachebuster_is_updated():
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    assert '/static/js/app.js?v=208' in html
