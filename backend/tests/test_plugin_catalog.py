import json
import subprocess

import pytest

import backend.api.plugins as plugins_api


def _git(args, cwd):
    subprocess.run(["git"] + args, cwd=str(cwd), check=True, capture_output=True, text=True)


@pytest.fixture
def plugin_repo(tmp_path):
    """Repo git real y local con un manifest válido -- mismo criterio que
    test_plugin_installer.py: probar contra un repo de verdad da más
    confianza que mockear el clone."""
    origin = tmp_path / "free-plugin.git"
    origin.mkdir()
    _git(["init", "-q", "-b", "main"], origin)
    _git(["config", "user.email", "test@nopal.local"], origin)
    _git(["config", "user.name", "NOPAL Test"], origin)
    manifest = {
        "schema_version": 1, "id": "free-plugin", "name": "Free Plugin", "version": "1.0.0",
        "frontend": {"script": "frontend/free-plugin.js", "style": "frontend/free-plugin.css", "section": "free-plugin"},
    }
    (origin / "nopal-plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-q", "-m", "initial"], origin)
    return origin


@pytest.fixture
def fixture_catalog(tmp_path, monkeypatch, plugin_repo):
    catalog = [
        {
            "id": "free-plugin", "name": "Free Plugin", "version": "0.9.0", "publisher": "Test",
            "category": "Test", "description": "...", "long_description": "...", "icon": "x",
            "accent": "#000000", "compatibility": [], "permissions": [], "size": "Por definir",
            "featured": False, "availability": "available",
            "pricing": {"type": "free"}, "repo_url": str(plugin_repo),
        },
        {
            "id": "paid-plugin", "name": "Paid Plugin", "version": "1.0.0", "publisher": "Test",
            "category": "Test", "description": "...", "long_description": "...", "icon": "x",
            "accent": "#000000", "compatibility": [], "permissions": [], "size": "Por definir",
            "featured": False, "availability": "available",
            "pricing": {"type": "paid"}, "repo_url": "git@github.com:test/paid-plugin.git",
        },
        {
            "id": "soon-plugin", "name": "Coming Soon", "version": "0.1.0", "publisher": "Test",
            "category": "Otra", "description": "...", "long_description": "...", "icon": "x",
            "accent": "#000000", "compatibility": [], "permissions": [], "size": "Por definir",
            "featured": False, "availability": "coming_soon",
            "pricing": {"type": "free"}, "repo_url": None,
        },
    ]
    catalog_path = tmp_path / "plugin_catalog.json"
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setattr(plugins_api, "CATALOG_PATH", catalog_path)
    return catalog


class TestListPlugins:
    def test_list_requires_only_auth(self, client, as_operator, fixture_catalog):
        response = client.get("/api/plugins")
        assert response.status_code == 200
        body = response.json()
        ids = {p["id"] for p in body["plugins"]}
        assert ids == {"free-plugin", "paid-plugin", "soon-plugin"}
        assert body["installed_count"] == 0

    def test_uninstalled_plugin_has_no_frontend_block(self, client, as_admin, fixture_catalog):
        plugin = next(p for p in client.get("/api/plugins").json()["plugins"] if p["id"] == "free-plugin")
        assert "frontend" not in plugin or plugin.get("frontend") is None
        assert plugin["installed"] is False


class TestInstallPlugin:
    def test_install_free_plugin_clones_and_marks_installed(self, client, as_admin, fixture_catalog):
        response = client.post("/api/plugins/free-plugin/install")
        assert response.status_code == 200
        plugin = response.json()["plugin"]
        assert plugin["installed"] is True
        assert plugin["frontend"]["script"] == "/plugins-static/free-plugin/frontend/free-plugin.js"
        assert plugin["version"] == "1.0.0"  # viene del manifest clonado, no del catálogo (que decía 0.9.0)
        assert plugin["catalog_version"] == "0.9.0"  # se guarda aparte, sin pisar -- así el frontend detecta el drift

    def test_install_requires_admin(self, client, as_operator, fixture_catalog):
        response = client.post("/api/plugins/free-plugin/install")
        assert response.status_code == 403

    def test_install_coming_soon_rejected(self, client, as_admin, fixture_catalog):
        response = client.post("/api/plugins/soon-plugin/install")
        assert response.status_code == 409

    def test_install_paid_plugin_rejected_honestly(self, client, as_admin, fixture_catalog):
        # No hay servidor de licencias todavía -- debe rechazar con un
        # mensaje claro, nunca simular que lo instaló.
        response = client.post("/api/plugins/paid-plugin/install")
        assert response.status_code == 501
        import backend.services.plugin_installer_service as installer
        assert not installer.is_cloned("paid-plugin")

    def test_install_unknown_plugin_404(self, client, as_admin, fixture_catalog):
        response = client.post("/api/plugins/does-not-exist/install")
        assert response.status_code == 404

    def test_install_twice_rejected(self, client, as_admin, fixture_catalog):
        client.post("/api/plugins/free-plugin/install")
        response = client.post("/api/plugins/free-plugin/install")
        assert response.status_code == 409


class TestUninstallPlugin:
    def test_uninstall_removes_clone_and_state(self, client, as_admin, fixture_catalog):
        client.post("/api/plugins/free-plugin/install")
        response = client.delete("/api/plugins/free-plugin")
        assert response.status_code == 200

        import backend.services.plugin_installer_service as installer
        assert not installer.is_cloned("free-plugin")
        listing = client.get("/api/plugins").json()["plugins"]
        assert next(p for p in listing if p["id"] == "free-plugin")["installed"] is False

    def test_uninstall_requires_admin(self, client, as_operator, fixture_catalog):
        response = client.delete("/api/plugins/free-plugin")
        assert response.status_code == 403

    def test_uninstall_not_installed_404(self, client, as_admin, fixture_catalog):
        response = client.delete("/api/plugins/free-plugin")
        assert response.status_code == 404


class TestUpdatePlugin:
    def test_update_not_installed_404(self, client, as_admin, fixture_catalog):
        response = client.post("/api/plugins/free-plugin/update")
        assert response.status_code == 404

    def test_update_installed_plugin_with_no_changes(self, client, as_admin, fixture_catalog):
        client.post("/api/plugins/free-plugin/install")
        response = client.post("/api/plugins/free-plugin/update")
        assert response.status_code == 200
        assert response.json()["updated"] is False
