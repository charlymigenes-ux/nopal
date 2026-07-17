"""Historial de eventos de accesorios NOPAL.

Registro simple persistido en JSON. Solo se escribe una entrada cuando
accessory_service (o accessory_scenes) confirma que una acción tuvo éxito
contra el driver real — no hay eventos sintéticos ni inventados.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

LOG_PATH = Path("data/accessories/activity_log.json")
MAX_ENTRIES = 200
_lock = Lock()


def _read() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(LOG_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _write(entries: List[Dict[str, Any]]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = LOG_PATH.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(LOG_PATH)


def log_event(accessory_id: str, name: str, action: str, detail: Optional[Dict[str, Any]] = None) -> None:
    with _lock:
        entries = _read()
        entries.append({
            "id": uuid.uuid4().hex[:12],
            "accessory_id": accessory_id,
            "name": name,
            "action": action,
            "detail": detail or {},
            "timestamp": time.time(),
        })
        _write(entries[-MAX_ENTRIES:])


def get_recent(limit: int = 20) -> List[Dict[str, Any]]:
    entries = _read()
    return list(reversed(entries))[:limit]
