import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.services.plugin_installer_service as installer
import backend.services.plugin_loader_service as loader


def _write_plugin(plugin_id: str, backend_files: dict, manifest_extra: dict = None):
    plugin_root = installer.PLUGINS_DIR / plugin_id
    plugin_root.mkdir(parents=True)
    manifest = {
        "schema_version": 1, "id": plugin_id, "name": plugin_id, "version": "1.0.0",
        "backend": {"entry": "backend/router.py"},
    }
    if manifest_extra:
        manifest.update(manifest_extra)
    (plugin_root / "nopal-plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    backend_dir = plugin_root / "backend"
    backend_dir.mkdir()
    (backend_dir / "__init__.py").write_text("", encoding="utf-8")
    for name, content in backend_files.items():
        (backend_dir / name).write_text(content, encoding="utf-8")
    return plugin_root


def _mark_installed(**plugin_ids_enabled):
    installer.write_installed_state({
        plugin_id: {"version": "1.0.0", "enabled": enabled, "installed_at": "now"}
        for plugin_id, enabled in plugin_ids_enabled.items()
    })


class TestLoadInstalledPluginRouters:
    def test_loads_router_with_relative_imports(self):
        # Confirma la pieza más delicada: un plugin de verdad tiene varios
        # archivos bajo backend/ (no solo router.py) e importa entre ellos
        # con imports relativos, igual que ya hace NOPAL core.
        _write_plugin("hello-plugin", {
            "services.py": "GREETING = 'hola desde el plugin'\n",
            "router.py": (
                "from fastapi import APIRouter\n"
                "from .services import GREETING\n"
                "router = APIRouter()\n"
                "@router.get('/api/hello-plugin/ping')\n"
                "def ping():\n"
                "    return {'message': GREETING}\n"
            ),
        })
        _mark_installed(**{"hello-plugin": True})

        app = FastAPI()
        loader.load_installed_plugin_routers(app)
        client = TestClient(app)
        response = client.get("/api/hello-plugin/ping")
        assert response.status_code == 200
        assert response.json() == {"message": "hola desde el plugin"}

    def test_broken_plugin_does_not_crash_the_rest(self):
        _write_plugin("broken-plugin", {"router.py": "raise RuntimeError('boom')\n"})
        _write_plugin("healthy-plugin", {
            "router.py": (
                "from fastapi import APIRouter\n"
                "router = APIRouter()\n"
                "@router.get('/api/healthy-plugin/ping')\n"
                "def ping():\n"
                "    return {'ok': True}\n"
            ),
        })
        _mark_installed(**{"broken-plugin": True, "healthy-plugin": True})

        app = FastAPI()
        loader.load_installed_plugin_routers(app)  # no debe lanzar
        client = TestClient(app)
        assert client.get("/api/healthy-plugin/ping").status_code == 200

    def test_router_missing_attribute_is_skipped(self):
        _write_plugin("no-router-var", {"router.py": "not_router = 1\n"})
        _mark_installed(**{"no-router-var": True})

        app = FastAPI()
        loader.load_installed_plugin_routers(app)  # no debe lanzar

    def test_disabled_plugin_is_not_loaded(self):
        _write_plugin("disabled-plugin", {
            "router.py": (
                "from fastapi import APIRouter\n"
                "router = APIRouter()\n"
                "@router.get('/api/disabled-plugin/ping')\n"
                "def ping():\n"
                "    return {'ok': True}\n"
            ),
        })
        _mark_installed(**{"disabled-plugin": False})

        app = FastAPI()
        loader.load_installed_plugin_routers(app)
        client = TestClient(app)
        assert client.get("/api/disabled-plugin/ping").status_code == 404

    def test_plugin_without_backend_entry_is_skipped_silently(self):
        plugin_root = installer.PLUGINS_DIR / "frontend-only-plugin"
        plugin_root.mkdir(parents=True)
        manifest = {
            "schema_version": 1, "id": "frontend-only-plugin", "name": "X", "version": "1.0.0",
            "frontend": {"script": "frontend/x.js", "style": None, "section": "x"},
        }
        (plugin_root / "nopal-plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
        _mark_installed(**{"frontend-only-plugin": True})

        app = FastAPI()
        loader.load_installed_plugin_routers(app)  # no debe lanzar ni intentar cargar backend

    def test_uninstalled_plugin_not_in_state_is_ignored(self):
        installer.write_installed_state({})
        app = FastAPI()
        loader.load_installed_plugin_routers(app)  # no debe lanzar con estado vacío

    def test_loads_router_with_nested_services_subpackage(self):
        # Caso real: camera-viewer tiene backend/services/ como subpaquete
        # propio, con camera_service.py importando de usb_camera_service.py
        # (hermano dentro de services/) -- confirma que el paquete dinámico
        # soporta anidamiento de verdad, no solo un nivel plano.
        plugin_root = installer.PLUGINS_DIR / "nested-plugin"
        backend_dir = plugin_root / "backend"
        services_dir = backend_dir / "services"
        services_dir.mkdir(parents=True)
        (backend_dir / "__init__.py").write_text("", encoding="utf-8")
        (services_dir / "__init__.py").write_text("", encoding="utf-8")
        (services_dir / "low_level.py").write_text("VALUE = 42\n", encoding="utf-8")
        (services_dir / "high_level.py").write_text(
            "from .low_level import VALUE\n"
            "def doubled():\n"
            "    return VALUE * 2\n",
            encoding="utf-8",
        )
        (backend_dir / "router.py").write_text(
            "from fastapi import APIRouter\n"
            "from .services.high_level import doubled\n"
            "router = APIRouter()\n"
            "@router.get('/api/nested-plugin/value')\n"
            "def value():\n"
            "    return {'value': doubled()}\n",
            encoding="utf-8",
        )
        (plugin_root / "nopal-plugin.json").write_text(json.dumps({
            "schema_version": 1, "id": "nested-plugin", "name": "Nested", "version": "1.0.0",
            "backend": {"entry": "backend/router.py"},
        }), encoding="utf-8")
        _mark_installed(**{"nested-plugin": True})

        app = FastAPI()
        loader.load_installed_plugin_routers(app)
        client = TestClient(app)
        response = client.get("/api/nested-plugin/value")
        assert response.status_code == 200
        assert response.json() == {"value": 84}
