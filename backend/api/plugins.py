"""Galería y registro de plugins de NOPAL.

El catálogo (backend/plugin_catalog.json) es curado por NOPAL: cada entrada
"available" apunta a un repo de git propio (`repo_url`). Instalar clona ese
repo de verdad (ver backend/services/plugin_installer_service.py) -- ya no
es solo un flag como antes. Los datos de versión/entry-points de un plugin
YA instalado se leen de su propio manifest (`nopal-plugin.json`, recién
clonado en plugins/<id>/), no del catálogo curado -- este último solo trae
metadata descriptiva para la galería (nombre, ícono, precio, etc.).

Plugins pagos (`pricing.type == "paid"`) todavía no se pueden instalar: el
servidor de licencias que los habilitaría (repos privados + Gumroad) es una
iniciativa aparte que no existe todavía -- se rechaza con un mensaje claro
en vez de simular que funciona.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services import plugin_installer_service as installer

router = APIRouter(prefix="/api/plugins", tags=["plugins"])

CATALOG_PATH = Path(__file__).resolve().parent.parent / "plugin_catalog.json"
_state_lock = Lock()


def _load_catalog() -> list[dict]:
    try:
        with open(CATALOG_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _catalog_item(plugin_id: str) -> dict:
    item = next((plugin for plugin in _load_catalog() if plugin["id"] == plugin_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Plugin no encontrado")
    return item


def _plugin_static_url(plugin_id: str, relative_path: str | None) -> str | None:
    if not relative_path:
        return None
    return f"/plugins-static/{plugin_id}/{relative_path}"


def _serialize_catalog() -> list[dict]:
    """Mergea el catálogo curado con el estado real de instalación. Para un
    plugin ya instalado, la versión y los entry points de frontend vienen
    de su propio manifest (la fuente de verdad real, recién clonada), no
    del catálogo -- que solo aporta la metadata descriptiva."""
    installed = installer.read_installed_state()
    result = []
    for plugin in _load_catalog():
        plugin_id = plugin["id"]
        state = installed.get(plugin_id)
        entry = dict(plugin)
        entry["installed"] = plugin_id in installed
        entry["installed_at"] = state.get("installed_at") if state else None
        entry["enabled"] = state.get("enabled", False) if state else False
        # "version" queda como la instalada de verdad (ver docstring); esta
        # se guarda aparte, SIN pisar, para que el frontend pueda comparar
        # las dos y mostrar "Actualizar" cuando el catálogo declaró una
        # versión distinta a la que hay clonada.
        entry["catalog_version"] = plugin.get("version")
        if entry["installed"]:
            manifest = installer.read_manifest(plugin_id)
            if manifest:
                entry["version"] = manifest.get("version", entry.get("version"))
                frontend = manifest.get("frontend")
                if frontend:
                    entry["frontend"] = {
                        "section": frontend.get("section"),
                        "script": _plugin_static_url(plugin_id, frontend.get("script")),
                        "style": _plugin_static_url(plugin_id, frontend.get("style")),
                    }
        result.append(entry)
    return result


@router.get("")
def list_plugins(_user: dict = Depends(require_auth)):
    plugins = _serialize_catalog()
    return {
        "plugins": plugins,
        "categories": sorted({plugin["category"] for plugin in plugins}),
        "installed_count": sum(1 for plugin in plugins if plugin["installed"]),
    }


@router.post("/{plugin_id}/install")
def install_plugin(plugin_id: str, _user: dict = Depends(require_role("admin"))):
    plugin = _catalog_item(plugin_id)
    if plugin["availability"] != "available":
        raise HTTPException(status_code=409, detail="Este plugin todavía no está disponible")
    pricing = plugin.get("pricing") or {"type": "free"}
    if pricing.get("type") != "free":
        raise HTTPException(
            status_code=501,
            detail="Los plugins pagos todavía no están disponibles (falta el servidor de licencias)",
        )
    if not plugin.get("repo_url"):
        raise HTTPException(status_code=500, detail="Este plugin no tiene un repositorio configurado")

    with _state_lock:
        installed = installer.read_installed_state()
        if plugin_id in installed:
            raise HTTPException(status_code=409, detail="El plugin ya está instalado")
        result = installer.clone(plugin_id, plugin["repo_url"])
        if not result["success"]:
            raise HTTPException(status_code=502, detail=result["error"])
        installed[plugin_id] = {
            "version": result["manifest"].get("version", plugin.get("version")),
            "enabled": True,
            "installed_at": datetime.now(timezone.utc).isoformat(),
        }
        installer.write_installed_state(installed)
    return {"ok": True, "plugin": next(item for item in _serialize_catalog() if item["id"] == plugin_id)}


@router.post("/{plugin_id}/update")
def update_plugin(plugin_id: str, _user: dict = Depends(require_role("admin"))):
    with _state_lock:
        installed = installer.read_installed_state()
        if plugin_id not in installed:
            raise HTTPException(status_code=404, detail="El plugin no está instalado")
        result = installer.update(plugin_id)
        if not result["success"]:
            raise HTTPException(status_code=502, detail=result["error"])
        if result["updated"]:
            installed[plugin_id]["version"] = result["manifest"].get("version", installed[plugin_id].get("version"))
            installer.write_installed_state(installed)
    return {
        "ok": True,
        "updated": result["updated"],
        "commits": result.get("commits", []),
        "backend_changed": result.get("backend_changed", False),
    }


@router.delete("/{plugin_id}")
def uninstall_plugin(plugin_id: str, _user: dict = Depends(require_role("admin"))):
    _catalog_item(plugin_id)
    with _state_lock:
        installed = installer.read_installed_state()
        if plugin_id not in installed:
            raise HTTPException(status_code=404, detail="El plugin no está instalado")
        installed.pop(plugin_id)
        installer.write_installed_state(installed)
        installer.remove(plugin_id)
    return {"ok": True, "plugin_id": plugin_id}
