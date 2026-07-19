import json
import subprocess

import pytest

import backend.services.plugin_installer_service as installer


def _git(args, cwd):
    subprocess.run(["git"] + args, cwd=str(cwd), check=True, capture_output=True, text=True)


@pytest.fixture
def origin_repo(tmp_path):
    """Repo git real y local (sin red) que sirve de "origin" del plugin de
    prueba -- clonar/actualizar contra un repo real da mucha más confianza
    que mockear subprocess.run a ciegas, y no depende de conexión a
    Internet ni de que exista todavía un repo real en GitHub."""
    origin = tmp_path / "origin.git"
    origin.mkdir()
    _git(["init", "-q", "-b", "main"], origin)
    _git(["config", "user.email", "test@nopal.local"], origin)
    _git(["config", "user.name", "NOPAL Test"], origin)
    manifest = {
        "schema_version": 1, "id": "sample-plugin", "name": "Sample", "version": "1.0.0",
        "publisher": "Test", "category": "Test", "description": "...",
        "frontend": {"script": "frontend/sample.js", "style": "frontend/sample.css", "section": "sample-plugin"},
    }
    (origin / "nopal-plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    (origin / "frontend").mkdir()
    (origin / "frontend" / "sample.js").write_text("// sample", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-q", "-m", "initial"], origin)
    return origin


class TestClone:
    def test_clone_success_reads_manifest(self, origin_repo):
        result = installer.clone("sample-plugin", str(origin_repo))
        assert result["success"] is True
        assert result["manifest"]["id"] == "sample-plugin"
        assert (installer.PLUGINS_DIR / "sample-plugin" / "nopal-plugin.json").is_file()

    def test_clone_refuses_to_overwrite_existing(self, origin_repo):
        installer.clone("sample-plugin", str(origin_repo))
        result = installer.clone("sample-plugin", str(origin_repo))
        assert result["success"] is False

    def test_clone_invalid_url_fails_cleanly(self, tmp_path):
        result = installer.clone("nope", str(tmp_path / "does-not-exist"))
        assert result["success"] is False
        assert not (installer.PLUGINS_DIR / "nope").exists()

    def test_clone_without_manifest_is_rejected_and_cleaned_up(self, tmp_path):
        origin = tmp_path / "no-manifest.git"
        origin.mkdir()
        _git(["init", "-q", "-b", "main"], origin)
        _git(["config", "user.email", "test@nopal.local"], origin)
        _git(["config", "user.name", "NOPAL Test"], origin)
        (origin / "README.md").write_text("no manifest here", encoding="utf-8")
        _git(["add", "."], origin)
        _git(["commit", "-q", "-m", "initial"], origin)

        result = installer.clone("no-manifest", str(origin))
        assert result["success"] is False
        assert not (installer.PLUGINS_DIR / "no-manifest").exists()


class TestUpdate:
    def test_update_pulls_new_commit(self, origin_repo):
        installer.clone("sample-plugin", str(origin_repo))

        (origin_repo / "nopal-plugin.json").write_text(
            json.dumps({**json.loads((origin_repo / "nopal-plugin.json").read_text()), "version": "1.1.0"}),
            encoding="utf-8",
        )
        _git(["add", "."], origin_repo)
        _git(["commit", "-q", "-m", "bump version"], origin_repo)

        result = installer.update("sample-plugin")
        assert result["success"] is True
        assert result["updated"] is True
        assert result["manifest"]["version"] == "1.1.0"
        assert len(result["commits"]) == 1

    def test_update_with_nothing_new_reports_not_updated(self, origin_repo):
        installer.clone("sample-plugin", str(origin_repo))
        result = installer.update("sample-plugin")
        assert result["success"] is True
        assert result["updated"] is False

    def test_update_not_installed_fails(self):
        result = installer.update("never-installed")
        assert result["success"] is False

    def test_update_flags_backend_changed_when_backend_files_touched(self, tmp_path):
        origin = tmp_path / "with-backend.git"
        origin.mkdir()
        _git(["init", "-q", "-b", "main"], origin)
        _git(["config", "user.email", "test@nopal.local"], origin)
        _git(["config", "user.name", "NOPAL Test"], origin)
        manifest = {"schema_version": 1, "id": "with-backend", "name": "X", "version": "1.0.0",
                    "backend": {"entry": "backend/router.py"}}
        (origin / "nopal-plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
        (origin / "backend").mkdir()
        (origin / "backend" / "router.py").write_text("router = None\n", encoding="utf-8")
        _git(["add", "."], origin)
        _git(["commit", "-q", "-m", "initial"], origin)

        installer.clone("with-backend", str(origin))
        (origin / "backend" / "router.py").write_text("router = 'changed'\n", encoding="utf-8")
        _git(["add", "."], origin)
        _git(["commit", "-q", "-m", "change backend"], origin)

        result = installer.update("with-backend")
        assert result["backend_changed"] is True


class TestRemove:
    def test_remove_deletes_folder(self, origin_repo):
        installer.clone("sample-plugin", str(origin_repo))
        assert installer.remove("sample-plugin") is True
        assert not (installer.PLUGINS_DIR / "sample-plugin").exists()

    def test_remove_not_installed_returns_false(self):
        assert installer.remove("never-installed") is False


class TestInstalledStatePersistence:
    def test_write_then_read_roundtrip(self):
        installer.write_installed_state({"sample-plugin": {"version": "1.0.0", "enabled": True, "installed_at": "now"}})
        assert installer.read_installed_state() == {"sample-plugin": {"version": "1.0.0", "enabled": True, "installed_at": "now"}}

    def test_read_missing_file_returns_empty_dict(self):
        assert installer.read_installed_state() == {}
