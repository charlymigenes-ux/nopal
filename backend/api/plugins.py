"""Galería y registro local de plugins de NOPAL.

El catálogo está separado de la instalación principal. En esta primera fase
solo se registran paquetes aprobados por NOPAL; no se ejecuta ni descarga
código arbitrario desde Internet.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException

from backend.auth_deps import require_auth


router = APIRouter(prefix="/api/plugins", tags=["plugins"])

PLUGIN_DATA_DIR = Path(os.getenv("NOPAL_PLUGIN_DATA_DIR", "data/plugins"))
INSTALLED_FILE = PLUGIN_DATA_DIR / "installed.json"
_state_lock = Lock()

CATALOG = (
    {
        "id": "shape-creator",
        "name": "Creador de formas",
        "version": "1.1.1",
        "publisher": "NOPAL Labs",
        "category": "Diseño",
        "description": "Crea rectángulos, círculos, polígonos y formas paramétricas listas para láser o CNC.",
        "long_description": "Genera geometría básica con medidas exactas, esquinas configurables y exportación preparada para los flujos de trabajo de NOPAL.",
        "icon": "shapes",
        "accent": "#a855f7",
        "compatibility": ["Láser", "CNC"],
        "permissions": ["Guardar archivos en la biblioteca"],
        "size": "1.8 MB",
        "featured": True,
        "availability": "available",
        "frontend": {
            "style": "/static/plugins/shape-creator/shape-creator.css",
            "script": "/static/plugins/shape-creator/shape-creator.js",
            "section": "shape-creator",
        },
    },
    {
        "id": "gcode-optimizer",
        "name": "Optimizador G-Code",
        "version": "0.9.0",
        "publisher": "NOPAL Labs",
        "category": "Producción",
        "description": "Analiza recorridos y propone ajustes para reducir movimientos innecesarios.",
        "long_description": "Optimización asistida de trayectorias, velocidades y orden de operaciones.",
        "icon": "route",
        "accent": "#22c55e",
        "compatibility": ["Impresión 3D", "Láser", "CNC"],
        "permissions": ["Leer archivos G-Code"],
        "size": "2.4 MB",
        "featured": False,
        "availability": "coming_soon",
    },
    {
        "id": "svg-toolkit",
        "name": "Herramientas SVG",
        "version": "0.8.0",
        "publisher": "NOPAL Labs",
        "category": "Diseño",
        "description": "Limpia, une y simplifica trazos SVG antes de enviarlos a producción.",
        "long_description": "Utilidades para preparar vectores y detectar contornos abiertos o duplicados.",
        "icon": "vector",
        "accent": "#06b6d4",
        "compatibility": ["Láser", "CNC"],
        "permissions": ["Leer y guardar archivos SVG"],
        "size": "1.2 MB",
        "featured": False,
        "availability": "coming_soon",
    },
    {
        "id": "font-library",
        "name": "Biblioteca de tipografías",
        "version": "0.1.0",
        "publisher": "NOPAL Labs",
        "category": "Diseño",
        "description": "Explora, previsualiza y aplica tipografías preparadas para corte, grabado y CNC.",
        "long_description": "Gestiona una colección de fuentes, comprueba su legibilidad y convierte texto a trayectos listos para producción.",
        "icon": "type",
        "accent": "#ec4899",
        "compatibility": ["Láser", "CNC"],
        "permissions": ["Leer y guardar tipografías"],
        "size": "Por definir",
        "featured": False,
        "availability": "coming_soon",
    },
    {
        "id": "material-library",
        "name": "Biblioteca de materiales",
        "version": "0.7.0",
        "publisher": "Comunidad NOPAL",
        "category": "Utilidades",
        "description": "Perfiles compartidos de potencia, velocidad y profundidad por material.",
        "long_description": "Colección local de parámetros probados con historial y notas por máquina.",
        "icon": "layers",
        "accent": "#f59e0b",
        "compatibility": ["Láser", "CNC"],
        "permissions": ["Leer la configuración de dispositivos"],
        "size": "860 KB",
        "featured": False,
        "availability": "coming_soon",
    },
)


def _read_installed() -> dict[str, dict]:
    try:
        payload = json.loads(INSTALLED_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write_installed(installed: dict[str, dict]) -> None:
    PLUGIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary = INSTALLED_FILE.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(installed, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(INSTALLED_FILE)


def _catalog_item(plugin_id: str) -> dict:
    item = next((plugin for plugin in CATALOG if plugin["id"] == plugin_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Plugin no encontrado")
    return item


def _serialize_catalog() -> list[dict]:
    installed = _read_installed()
    return [
        {
            **plugin,
            "installed": plugin["id"] in installed,
            "installed_at": installed.get(plugin["id"], {}).get("installed_at"),
            "enabled": installed.get(plugin["id"], {}).get("enabled", False),
        }
        for plugin in CATALOG
    ]


@router.get("")
def list_plugins(_user: dict = Depends(require_auth)):
    plugins = _serialize_catalog()
    return {
        "plugins": plugins,
        "categories": sorted({plugin["category"] for plugin in plugins}),
        "installed_count": sum(1 for plugin in plugins if plugin["installed"]),
    }


@router.post("/{plugin_id}/install")
def install_plugin(plugin_id: str, _user: dict = Depends(require_auth)):
    plugin = _catalog_item(plugin_id)
    if plugin["availability"] != "available":
        raise HTTPException(status_code=409, detail="Este plugin todavía no está disponible")

    with _state_lock:
        installed = _read_installed()
        installed[plugin_id] = {
            "version": plugin["version"],
            "enabled": True,
            "installed_at": datetime.now(timezone.utc).isoformat(),
        }
        _write_installed(installed)
    return {"ok": True, "plugin": next(item for item in _serialize_catalog() if item["id"] == plugin_id)}


@router.delete("/{plugin_id}")
def uninstall_plugin(plugin_id: str, _user: dict = Depends(require_auth)):
    _catalog_item(plugin_id)
    with _state_lock:
        installed = _read_installed()
        if plugin_id not in installed:
            raise HTTPException(status_code=404, detail="El plugin no está instalado")
        installed.pop(plugin_id)
        _write_installed(installed)
    return {"ok": True, "plugin_id": plugin_id}
