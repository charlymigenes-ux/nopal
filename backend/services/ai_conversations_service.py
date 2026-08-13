"""Historial de conversaciones de NOPAL Intelligence.

Antes cada pregunta era un disparo suelto: al recargar la página se perdía
todo y el modelo no recordaba nada de lo anterior. Acá se persisten las
conversaciones y se les da CRUD, y el agente puede reenviar los turnos
previos para que "¿y el otro láser?" tenga sentido después de "¿cómo está el
TTS 55 PRO?".

Convención de almacenamiento: un JSON plano en la raíz del repo, gitignored,
igual que `laser_history.json` y los `*_registry.json`. Sin base de datos.

Dos topes que no son cosméticos:

- `MAX_CONVERSATIONS` evita que el archivo crezca sin fin; al pasarse se
  tiran las más viejas por fecha de actualización.
- `HISTORY_TURNS` limita cuántos turnos previos se le mandan al modelo. El
  prompt de herramientas ya ronda los 1600 tokens y en un servidor de IA
  modesto cada token extra es tiempo real de espera; reenviar una
  conversación entera la volvería inusable a los pocos turnos.
"""

import json
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

STORE_PATH = "ai_conversations.json"

MAX_CONVERSATIONS = 50
MAX_MESSAGES_PER_CONVERSATION = 200
# Turnos previos (usuario + asistente) que se reenvían al modelo por pregunta.
HISTORY_TURNS = 6
TITLE_LENGTH = 60


def _read_all() -> List[Dict[str, Any]]:
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError):
        # Mismo criterio que el resto de los registros JSON de NOPAL: un
        # archivo corrupto no debe tumbar nada, se ignora y se avisa.
        logger.warning(f"{STORE_PATH} ilegible o corrupto, se empieza vacío")
        return []
    return [c for c in data if isinstance(c, dict) and c.get("id")] if isinstance(data, list) else []


def _write_all(conversations: List[Dict[str, Any]]) -> None:
    # Se recorta por fecha de actualización: lo que se conserva es lo que se
    # usó hace poco, no lo que se creó hace poco.
    ordenadas = sorted(conversations, key=lambda c: c.get("updated_at", 0), reverse=True)
    recortadas = ordenadas[:MAX_CONVERSATIONS]
    tmp = f"{STORE_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(recortadas, handle, indent=2, ensure_ascii=False)
    # Escritura atómica: una interrupción a media escritura dejaría el
    # historial corrupto, que es justo el accidente que ya ocurrió una vez
    # con tunascreen_devices.json.
    os.replace(tmp, STORE_PATH)


def _summary(conversation: Dict[str, Any]) -> Dict[str, Any]:
    """Fila del listado: sin los mensajes, que pueden ser largos."""
    return {
        "id": conversation["id"],
        "title": conversation.get("title") or "",
        "created_at": conversation.get("created_at"),
        "updated_at": conversation.get("updated_at"),
        "message_count": len(conversation.get("messages") or []),
    }


def _derive_title(text: str) -> str:
    limpio = " ".join((text or "").split())
    if len(limpio) <= TITLE_LENGTH:
        return limpio or "Conversación"
    return limpio[:TITLE_LENGTH - 1].rstrip() + "…"


def list_conversations() -> Dict[str, Any]:
    conversaciones = sorted(_read_all(), key=lambda c: c.get("updated_at", 0), reverse=True)
    return {"count": len(conversaciones), "conversations": [_summary(c) for c in conversaciones]}


def get_conversation(conversation_id: str) -> Optional[Dict[str, Any]]:
    return next((c for c in _read_all() if c["id"] == conversation_id), None)


def create_conversation(title: str = "") -> Dict[str, Any]:
    ahora = time.time()
    conversacion = {
        "id": uuid.uuid4().hex[:12],
        "title": _derive_title(title) if title else "Conversación",
        "created_at": ahora,
        "updated_at": ahora,
        "messages": [],
    }
    conversaciones = _read_all()
    conversaciones.append(conversacion)
    _write_all(conversaciones)
    return conversacion


def rename_conversation(conversation_id: str, title: str) -> Optional[Dict[str, Any]]:
    conversaciones = _read_all()
    conversacion = next((c for c in conversaciones if c["id"] == conversation_id), None)
    if conversacion is None:
        return None
    conversacion["title"] = _derive_title(title)
    conversacion["updated_at"] = time.time()
    _write_all(conversaciones)
    return conversacion


def delete_conversation(conversation_id: str) -> bool:
    conversaciones = _read_all()
    quedan = [c for c in conversaciones if c["id"] != conversation_id]
    if len(quedan) == len(conversaciones):
        return False
    _write_all(quedan)
    return True


def clear_conversations() -> int:
    borradas = len(_read_all())
    _write_all([])
    return borradas


def append_turn(
    conversation_id: Optional[str],
    question: str,
    answer: str,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Agrega el par pregunta/respuesta. Sin `conversation_id` crea una nueva
    y le pone de título la primera pregunta, que es lo que el usuario
    reconoce al buscarla después."""
    conversaciones = _read_all()
    conversacion = next((c for c in conversaciones if c["id"] == conversation_id), None)

    if conversacion is None:
        conversacion = {
            "id": uuid.uuid4().hex[:12],
            "title": _derive_title(question),
            "created_at": time.time(),
            "updated_at": time.time(),
            "messages": [],
        }
        conversaciones.append(conversacion)

    ahora = time.time()
    conversacion["messages"].append({"role": "user", "content": question, "at": ahora})
    conversacion["messages"].append({
        "role": "assistant", "content": answer, "at": ahora,
        "tool_calls": [c.get("tool") for c in (tool_calls or [])],
    })
    # Se recorta por el final: en una conversación larga lo que importa es lo
    # reciente, y el tope evita que un hilo solo llene el archivo.
    conversacion["messages"] = conversacion["messages"][-MAX_MESSAGES_PER_CONVERSATION:]
    conversacion["updated_at"] = ahora

    _write_all(conversaciones)
    return conversacion


def recent_turns(conversation_id: Optional[str]) -> List[Dict[str, str]]:
    """Los últimos turnos en la forma que espera la API estilo OpenAI.

    Se recortan a HISTORY_TURNS porque el prompt de herramientas ya es caro:
    reenviar la conversación entera volvería inusable un servidor de IA
    modesto a los pocos intercambios.
    """
    if not conversation_id:
        return []
    conversacion = get_conversation(conversation_id)
    if conversacion is None:
        return []
    mensajes = conversacion.get("messages") or []
    return [
        {"role": m["role"], "content": m.get("content") or ""}
        for m in mensajes[-(HISTORY_TURNS * 2):]
        if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
    ]
