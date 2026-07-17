"""Macros y escenas de accesorios.

Un preset con nombre que aplica varias acciones (encender/apagar un
accesorio, o fijar el color de una tira LED) sobre accesorios YA
registrados, de un solo golpe. Persistido en JSON, mismo patrón atómico
que accessory_registry.json y activity_log.py — nada de esto ejecuta
código arbitrario, solo reutiliza accessory_service contra drivers reales.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

from backend.services import accessory_service
from backend.services.activity_log import log_event

SCENES_PATH = Path("data/accessories/scenes.json")
_lock = Lock()


def _read() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(SCENES_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _write(scenes: List[Dict[str, Any]]) -> None:
    SCENES_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = SCENES_PATH.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(scenes, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(SCENES_PATH)


def get_scenes() -> List[Dict[str, Any]]:
    return _read()


def create_scene(name: str, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """actions: lista de {"accessory_id": str, "on": bool} para relés, o
    {"accessory_id": str, "color": [r, g, b]} para tiras LED."""
    if not name:
        raise ValueError("La escena necesita un nombre")
    if not actions:
        raise ValueError("La escena necesita al menos una acción")
    for action in actions:
        if not action.get("accessory_id"):
            raise ValueError("Cada acción necesita un accessory_id")
        if "color" not in action and "on" not in action:
            raise ValueError("Cada acción necesita 'on' o 'color'")

    with _lock:
        scenes = _read()
        scene = {
            "id": uuid.uuid4().hex[:12],
            "name": name,
            "actions": actions,
            "created_at": time.time(),
        }
        scenes.append(scene)
        _write(scenes)
    return scene


def delete_scene(scene_id: str) -> bool:
    with _lock:
        scenes = _read()
        filtered = [s for s in scenes if s.get("id") != scene_id]
        changed = len(filtered) != len(scenes)
        if changed:
            _write(filtered)
    return changed


async def run_scene(scene_id: str) -> Optional[bool]:
    scene = next((s for s in _read() if s.get("id") == scene_id), None)
    if scene is None:
        return None

    ok = True
    for action in scene.get("actions", []):
        accessory_id = action.get("accessory_id")
        if not accessory_id:
            continue
        if "color" in action:
            red, green, blue = action["color"]
            result = await accessory_service.set_accessory_led_color(accessory_id, red, green, blue)
        else:
            result = await accessory_service.set_accessory_power(accessory_id, bool(action.get("on")))
        ok = ok and bool(result)

    log_event(f"scene:{scene['id']}", scene["name"], "scene_run", {"actions": len(scene.get("actions", []))})
    return ok
