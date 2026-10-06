"""Historial de conversaciones de NOPAL Intelligence.

Antes cada pregunta era un disparo suelto: al recargar la página se perdía
todo y el modelo no recordaba nada de lo anterior. Acá se persisten las
conversaciones y se les da CRUD, y el agente puede reenviar los turnos
previos para que "¿y el otro láser?" tenga sentido después de "¿cómo está el
TTS 55 PRO?".

Convención de almacenamiento: un JSON plano en la raíz del repo, gitignored,
igual que `laser_history.json` y los `*_registry.json`. Sin base de datos.

Privacidad (D-9, ADR-006 D3-Q8 / C-4): cada conversación tiene propietario
(`owner_user_id`, el `user_id` del usuario autenticado que la creó; nunca lo
elige el cliente, el modelo ni un payload). Leer, continuar, renombrar y borrar
se autorizan con la Authorization Policy (`read_/rename_/delete_conversation`,
`owner_only`): solo el propietario, sin excepción para Admin. Una conversación
ajena es indistinguible de una inexistente. Las conversaciones antiguas, de
antes de que existiera el propietario, no tienen dueño: nadie las ve ni las
toca, y solo desaparecen con el borrado global (C-4). La garantía es de la
aplicación, no criptográfica: el archivo está en claro en el servidor.

Dos topes que no son cosméticos:

- `MAX_CONVERSATIONS` evita que el archivo crezca sin fin; se aplica POR
  PROPIETARIO (una escritura de un usuario no puede expulsar conversaciones
  de otro) y al pasarse se tiran sus más viejas por fecha de actualización.
  Las conversaciones sin propietario no cuentan para nadie y el recorte no
  las toca.
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

from backend.services.authorization_policy import Action, Principal, Resource, ResourceKind, authorize

logger = logging.getLogger(__name__)

STORE_PATH = "ai_conversations.json"

# Campo de propietario. Ausente en las conversaciones antiguas.
OWNER_FIELD = "owner_user_id"

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


def _trim(conversations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Recorte por propietario: cada uno conserva sus MAX_CONVERSATIONS más
    recientes por fecha de actualización (lo que se usó hace poco, no lo que
    se creó hace poco). Las conversaciones sin propietario se conservan
    todas: no son de nadie, así que ningún recorte de usuario las alcanza."""
    por_dueno: Dict[str, List[Dict[str, Any]]] = {}
    conservadas = []
    for conversacion in conversations:
        dueno = conversacion.get(OWNER_FIELD)
        if dueno:
            por_dueno.setdefault(dueno, []).append(conversacion)
        else:
            conservadas.append(conversacion)
    for propias in por_dueno.values():
        propias.sort(key=lambda c: c.get("updated_at", 0), reverse=True)
        conservadas.extend(propias[:MAX_CONVERSATIONS])
    return sorted(conservadas, key=lambda c: c.get("updated_at", 0), reverse=True)


def _write_all(conversations: List[Dict[str, Any]]) -> None:
    recortadas = _trim(conversations)
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


def _allowed(conversation: Dict[str, Any], action: Action, user_id: Optional[str], role: Optional[str]) -> bool:
    """La Authorization Policy decide: `owner_only` exige que el propietario
    de la conversación sea el usuario autenticado. Sin propietario (antiguas)
    o sin usuario, se deniega."""
    resource = Resource(ResourceKind.CONVERSATION, conversation["id"], owner_id=conversation.get(OWNER_FIELD))
    return bool(authorize(Principal.user(user_id, role), action, resource))


def _find_allowed(
    conversations: List[Dict[str, Any]], conversation_id: Optional[str], action: Action,
    user_id: Optional[str], role: Optional[str],
) -> Optional[Dict[str, Any]]:
    """La conversación si existe Y el usuario puede `action` sobre ella; si
    no, None. Ajena e inexistente dan lo mismo: no se revela cuál de las dos."""
    if not conversation_id:
        return None
    conversacion = next((c for c in conversations if c["id"] == conversation_id), None)
    if conversacion is None or not _allowed(conversacion, action, user_id, role):
        return None
    return conversacion


def list_conversations(user_id: Optional[str]) -> Dict[str, Any]:
    """Solo las del usuario autenticado. No hay vista de "todas" para nadie."""
    propias = [c for c in _read_all() if user_id and c.get(OWNER_FIELD) == user_id]
    propias.sort(key=lambda c: c.get("updated_at", 0), reverse=True)
    return {"count": len(propias), "conversations": [_summary(c) for c in propias]}


def get_conversation(conversation_id: str, user_id: Optional[str], role: Optional[str]) -> Optional[Dict[str, Any]]:
    return _find_allowed(_read_all(), conversation_id, Action.READ_CONVERSATION, user_id, role)


def create_conversation(owner_user_id: str, title: str = "") -> Dict[str, Any]:
    if not owner_user_id:
        raise ValueError("Una conversación necesita propietario")
    ahora = time.time()
    conversacion = {
        "id": uuid.uuid4().hex[:12],
        OWNER_FIELD: owner_user_id,
        "title": _derive_title(title) if title else "Conversación",
        "created_at": ahora,
        "updated_at": ahora,
        "messages": [],
    }
    conversaciones = _read_all()
    conversaciones.append(conversacion)
    _write_all(conversaciones)
    return conversacion


def rename_conversation(conversation_id: str, title: str, user_id: Optional[str],
                        role: Optional[str]) -> Optional[Dict[str, Any]]:
    conversaciones = _read_all()
    conversacion = _find_allowed(conversaciones, conversation_id, Action.RENAME_CONVERSATION, user_id, role)
    if conversacion is None:
        return None
    conversacion["title"] = _derive_title(title)
    conversacion["updated_at"] = time.time()
    _write_all(conversaciones)
    return conversacion


def delete_conversation(conversation_id: str, user_id: Optional[str], role: Optional[str]) -> bool:
    conversaciones = _read_all()
    conversacion = _find_allowed(conversaciones, conversation_id, Action.DELETE_CONVERSATION, user_id, role)
    if conversacion is None:
        return False
    _write_all([c for c in conversaciones if c is not conversacion])
    return True


def clear_conversations() -> int:
    """Borrado global (C-4): operación de almacenamiento solo para admin (la
    autoriza el router). Incluye las conversaciones sin propietario. No
    concede lectura de nada."""
    borradas = len(_read_all())
    _write_all([])
    return borradas


def append_turn(
    conversation_id: Optional[str],
    question: str,
    answer: str,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
    *,
    owner_user_id: str,
    role: Optional[str],
) -> Dict[str, Any]:
    """Agrega el par pregunta/respuesta. Sin `conversation_id`, con uno
    inexistente o con uno ajeno (continuar = `read_conversation`, solo el
    propietario) crea una nueva del usuario y le pone de título la primera
    pregunta, que es lo que el usuario reconoce al buscarla después. Nunca
    escribe en una conversación ajena ni cambia su `updated_at`."""
    if not owner_user_id:
        raise ValueError("Una conversación necesita propietario")
    conversaciones = _read_all()
    conversacion = _find_allowed(conversaciones, conversation_id, Action.READ_CONVERSATION, owner_user_id, role)

    if conversacion is None:
        conversacion = {
            "id": uuid.uuid4().hex[:12],
            OWNER_FIELD: owner_user_id,
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


def recent_turns(conversation_id: Optional[str], user_id: Optional[str], role: Optional[str]) -> List[Dict[str, str]]:
    """Los últimos turnos en la forma que espera la API estilo OpenAI. Solo
    de una conversación propia: una ajena no aporta historial (ni al modelo
    ni a la respuesta).

    Se recortan a HISTORY_TURNS porque el prompt de herramientas ya es caro:
    reenviar la conversación entera volvería inusable un servidor de IA
    modesto a los pocos intercambios.
    """
    if not conversation_id:
        return []
    conversacion = get_conversation(conversation_id, user_id, role)
    if conversacion is None:
        return []
    mensajes = conversacion.get("messages") or []
    return [
        {"role": m["role"], "content": m.get("content") or ""}
        for m in mensajes[-(HISTORY_TURNS * 2):]
        if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
    ]
