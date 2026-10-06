"""`python_requires` de un plugin: la Galería no lo instala y el cargador no lo
carga si el Python de NOPAL no le alcanza (fail-closed).

Caso real: matriz-led depende de pypixelcolor, que falla al importarse en
Python 3.9; el plugin declara `python_requires: ">=3.10"` en su manifiesto y
en el catálogo. Aquí se usa ">=99.0" para que ningún Python lo cumpla.
"""

import json
import logging
import subprocess

import pytest
from fastapi import FastAPI

import backend.api.plugins as plugins_api
import backend.services.plugin_installer_service as installer
import backend.services.plugin_loader_service as loader

UNREACHABLE = ">=99.0"


def _git(args, cwd):
    subprocess.run(["git"] + args, cwd=str(cwd), check=True, capture_output=True, text=True)


def _repo(tmp_path, python_requires=None):
    origin = tmp_path / "py-plugin.git"
    origin.mkdir()
    _git(["init", "-q", "-b", "main"], origin)
    _git(["config", "user.email", "test@nopal.local"], origin)
    _git(["config", "user.name", "NOPAL Test"], origin)
    manifest = {"schema_version": 1, "id": "py-plugin", "name": "Py Plugin", "version": "1.0.0",
                "frontend": {"script": "frontend/p.js", "style": "frontend/p.css", "section": "py-plugin"}}
    if python_requires:
        manifest["python_requires"] = python_requires
    (origin / "nopal-plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-q", "-m", "initial"], origin)
    return origin


def _catalog(tmp_path, monkeypatch, repo, python_requires=None):
    item = {"id": "py-plugin", "name": "Py Plugin", "version": "1.0.0", "publisher": "Test",
            "category": "Test", "description": "...", "long_description": "...", "icon": "x",
            "accent": "#000000", "compatibility": [], "permissions": [], "size": "Por definir",
            "featured": False, "availability": "available", "pricing": {"type": "free"},
            "repo_url": str(repo)}
    if python_requires:
        item["python_requires"] = python_requires
    path = tmp_path / "plugin_catalog.json"
    path.write_text(json.dumps([item]), encoding="utf-8")
    monkeypatch.setattr(plugins_api, "CATALOG_PATH", path)


# ── La regla ──

@pytest.mark.parametrize("spec, version, ok", [
    (None, (3, 9, 2), True),
    ("", (3, 9, 2), True),
    (">=3.10", (3, 9, 25), False),
    (">=3.10", (3, 10, 0), True),
    (">=3.10", (3, 13, 5), True),
    (" >= 3.9.2 ", (3, 9, 2), True),
    (">=3.9.2", (3, 9, 1), False),
])
def test_requirement(spec, version, ok):
    assert (installer.python_requirement_error(spec, version) is None) is ok


def test_message_names_both_versions():
    message = installer.python_requirement_error(">=3.10", (3, 9, 25))
    assert message == "Este plugin requiere Python 3.10 o superior; NOPAL corre con Python 3.9.25"


@pytest.mark.parametrize("spec", ["~=3.10", "3.10", ">3.9", ">=3", ">=3.10,<4", "python3.10"])
def test_unknown_format_fails_closed(spec):
    assert "no reconoce" in installer.python_requirement_error(spec, (3, 13, 5))


def test_real_catalog_declares_matriz_led():
    catalog = {item["id"]: item for item in plugins_api._load_catalog()}
    assert catalog["matriz-led"]["python_requires"] == ">=3.10"


# ── Galería ──

class TestInstall:
    def test_catalog_requirement_blocks_before_cloning(self, client, as_admin, tmp_path, monkeypatch):
        _catalog(tmp_path, monkeypatch, _repo(tmp_path), python_requires=UNREACHABLE)
        response = client.post("/api/plugins/py-plugin/install")
        assert response.status_code == 409 and "requiere Python 99.0" in response.json()["detail"]
        assert not (installer.PLUGINS_DIR / "py-plugin").exists()
        assert "py-plugin" not in installer.read_installed_state()

    def test_manifest_requirement_blocks_and_leaves_nothing(self, client, as_admin, tmp_path, monkeypatch):
        """El catálogo no lo dice pero el manifiesto clonado sí (fuente de verdad)."""
        _catalog(tmp_path, monkeypatch, _repo(tmp_path, python_requires=UNREACHABLE))
        response = client.post("/api/plugins/py-plugin/install")
        assert response.status_code == 409 and "requiere Python 99.0" in response.json()["detail"]
        assert not (installer.PLUGINS_DIR / "py-plugin").exists()
        assert "py-plugin" not in installer.read_installed_state()

    def test_satisfied_requirement_installs(self, client, as_admin, tmp_path, monkeypatch):
        _catalog(tmp_path, monkeypatch, _repo(tmp_path, python_requires=">=3.9"), python_requires=">=3.9")
        response = client.post("/api/plugins/py-plugin/install")
        assert response.status_code == 200
        assert response.json()["plugin"]["python_error"] is None
        client.delete("/api/plugins/py-plugin")


class TestList:
    def test_reason_shown_and_frontend_withheld(self, client, as_admin, tmp_path, monkeypatch):
        """Instalado antes de declarar el requisito (p. ej. en un equipo con
        3.9): la Galería dice por qué y no inyecta su interfaz."""
        _catalog(tmp_path, monkeypatch, _repo(tmp_path))
        assert client.post("/api/plugins/py-plugin/install").status_code == 200
        manifest_path = installer.PLUGINS_DIR / "py-plugin" / "nopal-plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["python_requires"] = UNREACHABLE
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        try:
            plugin = next(p for p in client.get("/api/plugins").json()["plugins"] if p["id"] == "py-plugin")
            assert "requiere Python 99.0" in plugin["python_error"]
            assert "frontend" not in plugin
        finally:
            client.delete("/api/plugins/py-plugin")

    def test_not_installed_shows_catalog_reason(self, client, as_operator, tmp_path, monkeypatch):
        _catalog(tmp_path, monkeypatch, _repo(tmp_path), python_requires=UNREACHABLE)
        plugin = client.get("/api/plugins").json()["plugins"][0]
        assert plugin["installed"] is False and "requiere Python 99.0" in plugin["python_error"]


# ── Cargador ──

def test_loader_skips_and_warns(caplog):
    root = installer.PLUGINS_DIR / "py-loader"
    (root / "backend").mkdir(parents=True)
    (root / "nopal-plugin.json").write_text(json.dumps({
        "id": "py-loader", "version": "1.0.0", "backend": {"entry": "backend/router.py"},
        "python_requires": UNREACHABLE}), encoding="utf-8")
    (root / "backend" / "router.py").write_text(
        "from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get('/api/py-loader')\ndef f():\n    return {}\n",
        encoding="utf-8")
    installer.write_installed_state({"py-loader": {"version": "1.0.0", "enabled": True, "installed_at": "now"}})
    app = FastAPI()
    before = len(app.routes)

    with caplog.at_level(logging.WARNING, logger=loader.logger.name):
        loader.load_installed_plugin_routers(app)

    assert len(app.routes) == before
    assert "[py-loader] no se carga: Este plugin requiere Python 99.0" in caplog.text
