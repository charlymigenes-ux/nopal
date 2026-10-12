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


# ── Ganchos de ciclo de vida (on_startup / on_shutdown) ──

HOOKS_ROUTER = """from fastapi import APIRouter
router = APIRouter()
CALLS = []

@router.get('/api/{pid}/ping')
def ping():
    return {{}}
{hooks}
"""


import pytest


@pytest.fixture(autouse=True)
def _forget_lifecycle_modules():
    """Que los plugins de prueba no queden registrados para el apagado real
    de la sesión de tests (uno de ellos tarda 10 s a propósito)."""
    yield
    loader._lifecycle_modules.clear()


def _plugin_with_hooks(plugin_id, hooks):
    _write_plugin(plugin_id, {"router.py": HOOKS_ROUTER.format(pid=plugin_id, hooks=hooks)})


def _module(plugin_id):
    return loader._entry_module(plugin_id, {"backend": {"entry": "backend/router.py"}})


class TestLifecycleHooks:
    async def test_async_and_sync_hooks_run_in_order(self):
        _plugin_with_hooks("hook-a", "async def on_startup():\n    CALLS.append('start')\n"
                                     "async def on_shutdown():\n    CALLS.append('stop')\n")
        _plugin_with_hooks("hook-b", "def on_startup():\n    CALLS.append('start')\n")
        _mark_installed(**{"hook-a": True, "hook-b": True})
        loader.load_installed_plugin_routers(FastAPI())

        await loader.run_plugin_startup_hooks()
        await loader.run_plugin_shutdown_hooks()

        assert _module("hook-a").CALLS == ["start", "stop"]
        assert _module("hook-b").CALLS == ["start"]

    async def test_failing_hook_does_not_stop_the_others(self, caplog):
        _plugin_with_hooks("hook-bad", "def on_startup():\n    raise RuntimeError('boom')\n")
        _plugin_with_hooks("hook-good", "def on_startup():\n    CALLS.append('start')\n")
        _mark_installed(**{"hook-bad": True, "hook-good": True})
        loader.load_installed_plugin_routers(FastAPI())

        await loader.run_plugin_startup_hooks()

        assert _module("hook-good").CALLS == ["start"]
        assert "[hook-bad] on_startup() falló" in caplog.text

    async def test_slow_hook_is_cut(self, monkeypatch, caplog):
        monkeypatch.setattr(loader, "HOOK_TIMEOUT_S", 0.05)
        _plugin_with_hooks("hook-slow", "import asyncio\nasync def on_shutdown():\n    await asyncio.sleep(10)\n")
        _mark_installed(**{"hook-slow": True})
        loader.load_installed_plugin_routers(FastAPI())

        await loader.run_plugin_shutdown_hooks()

        assert "[hook-slow] on_shutdown() tardó" in caplog.text

    def test_plugin_without_hooks_is_not_tracked_and_reload_resets(self):
        _plugin_with_hooks("hook-none", "")
        _mark_installed(**{"hook-none": True})
        loader.load_installed_plugin_routers(FastAPI())
        assert loader._lifecycle_modules == []

        _plugin_with_hooks("hook-one", "def on_startup():\n    pass\n")
        _mark_installed(**{"hook-none": True, "hook-one": True})
        loader.load_installed_plugin_routers(FastAPI())
        loader.load_installed_plugin_routers(FastAPI())
        assert [pid for pid, _ in loader._lifecycle_modules] == ["hook-one"]

    def test_disabled_plugin_hooks_never_run(self):
        _plugin_with_hooks("hook-off", "def on_startup():\n    CALLS.append('start')\n")
        _mark_installed(**{"hook-off": False})
        loader.load_installed_plugin_routers(FastAPI())
        assert loader._lifecycle_modules == []


def test_main_wires_the_hooks():
    """main.py llama los ganchos al arrancar (tras cargar los routers) y al detenerse."""
    from pathlib import Path

    source = (Path(loader.__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    start = source.index("load_installed_plugin_routers(app)")
    assert source.index("run_plugin_startup_hooks()") > start
    assert "await plugin_loader_service.run_plugin_shutdown_hooks()" in source
