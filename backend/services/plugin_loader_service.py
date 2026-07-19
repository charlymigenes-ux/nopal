"""Carga dinámica del backend de los plugins instalados.

No existía ningún import dinámico en NOPAL antes de esto -- todo router se
importaba a mano en backend/main.py. Acá se registra, en el startup de la
app, el `router` (una `APIRouter()`, misma convención que ya usa todo
backend/api/*.py) que cada plugin instalado declara en su manifest
(`backend.entry`, ej. "backend/router.py"). Un plugin roto (manifest
inválido, entry point ausente, excepción al importar) se salta con un log
de advertencia -- nunca debe tumbar el arranque del resto de NOPAL.
"""

import importlib.util
import logging
import sys
import types
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI

from backend.services import plugin_installer_service as installer

logger = logging.getLogger(__name__)

NAMESPACE_PACKAGE = "nopal_plugins"


def _ensure_namespace_package() -> None:
    """Los imports relativos dentro de un plugin (`from .services.x import
    y`) resuelven el nombre completo `nopal_plugins.<plugin>.services.x` --
    para eso Python necesita poder encontrar CADA nivel de esa cadena en
    sys.modules, no solo el del plugin. `nopal_plugins` en sí no
    corresponde a ninguna carpeta real (es un contenedor virtual que
    agrupa a todos los plugins cargados), así que se registra una sola vez
    como paquete de espacio de nombres vacío (`__path__ = []`, sin
    __init__.py real en disco)."""
    if NAMESPACE_PACKAGE in sys.modules:
        return
    namespace_module = types.ModuleType(NAMESPACE_PACKAGE)
    namespace_module.__path__ = []
    sys.modules[NAMESPACE_PACKAGE] = namespace_module


def _load_plugin_router(plugin_id: str, manifest: dict) -> Optional[Any]:
    entry = (manifest.get("backend") or {}).get("entry")
    if not entry:
        return None  # Plugin sin backend (ej. shape-creator) -- normal, no es un error.

    plugin_root = installer.PLUGINS_DIR / plugin_id
    entry_path = (plugin_root / entry).resolve()
    if installer.PLUGINS_DIR.resolve() not in entry_path.parents or not entry_path.is_file():
        logger.warning(f"[{plugin_id}] backend.entry inválido o fuera de su carpeta ({entry})")
        return None

    backend_dir = entry_path.parent
    package_name = f"{NAMESPACE_PACKAGE}.{plugin_id.replace('-', '_')}"

    try:
        _ensure_namespace_package()
        # Registra la carpeta backend/ del plugin como un paquete Python
        # real (submodule_search_locations), no solo un archivo suelto --
        # así funcionan imports relativos dentro del plugin, ej.
        # "from .services.camera_service import ...", exactamente igual
        # que ya hace el propio NOPAL core (backend/api/*.py importando
        # backend/services/*.py).
        init_file = backend_dir / "__init__.py"
        pkg_spec = importlib.util.spec_from_file_location(
            package_name,
            init_file if init_file.is_file() else entry_path,
            submodule_search_locations=[str(backend_dir)],
        )
        if pkg_spec is None or pkg_spec.loader is None:
            raise ImportError("no se pudo construir el spec del paquete")
        pkg_module = importlib.util.module_from_spec(pkg_spec)
        sys.modules[package_name] = pkg_module
        pkg_spec.loader.exec_module(pkg_module)

        module_name = f"{package_name}.{entry_path.stem}"
        module_spec = importlib.util.spec_from_file_location(module_name, entry_path)
        if module_spec is None or module_spec.loader is None:
            raise ImportError("no se pudo construir el spec del módulo de entrada")
        module = importlib.util.module_from_spec(module_spec)
        module.__package__ = package_name
        sys.modules[module_name] = module
        module_spec.loader.exec_module(module)
    except Exception:
        logger.exception(f"[{plugin_id}] no se pudo cargar el backend del plugin ({entry})")
        return None

    router = getattr(module, "router", None)
    if router is None:
        logger.warning(f"[{plugin_id}] {entry} no define una variable de módulo 'router'")
        return None
    return router


def get_loaded_plugin_module(plugin_id: str, relative_module: str) -> Optional[Any]:
    """Acceso de lectura, best-effort, a un submódulo ya cargado de un
    plugin (ej. relative_module="services.accessory_service") -- para el
    puñado de casos donde NOPAL core quiere agregar una señal opcional que
    depende de un plugin (ej. notificaciones de accesorios Arduino) sin
    volverla una dependencia dura de import. Si el plugin no está
    instalado o no se cargó, devuelve None y quien llama sigue andando sin
    esa señal, en vez de romper el arranque de NOPAL."""
    package_name = f"{NAMESPACE_PACKAGE}.{plugin_id.replace('-', '_')}"
    return sys.modules.get(f"{package_name}.{relative_module}")


def load_installed_plugin_routers(app: FastAPI) -> None:
    """Llamada en el startup de NOPAL (ver backend/main.py) -- registra el
    backend de cada plugin instalado y habilitado que tenga entry point de
    backend en su manifest."""
    installed = installer.read_installed_state()
    for plugin_id, state in installed.items():
        if not state.get("enabled", False):
            continue
        manifest = installer.read_manifest(plugin_id)
        if manifest is None:
            logger.warning(f"[{plugin_id}] instalado pero sin manifest legible en plugins/{plugin_id}/, se omite")
            continue
        router = _load_plugin_router(plugin_id, manifest)
        if router is not None:
            app.include_router(router)
            logger.info(f"[{plugin_id}] backend del plugin cargado")
