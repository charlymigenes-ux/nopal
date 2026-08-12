"""El ciclo de razonamiento de NOPAL Intelligence.

Esto es lo que separa a NOPAL Intelligence de "una ventana de chat pegada":
el modelo no recibe la pregunta a secas, recibe un catálogo de herramientas
de solo lectura de NOPAL (ver ai_tools.py), decide cuáles necesita, NOPAL
las ejecuta contra sus servicios reales, y recién con esos datos en la mano
el modelo redacta la respuesta.

    pregunta -> modelo -> tool_calls -> NOPAL ejecuta -> datos reales
             -> modelo -> respuesta en lenguaje natural

Dos modos, porque los modelos chicos existen
--------------------------------------------
`native`  : function calling de la API estilo OpenAI. Es el camino bueno.
`context` : NOPAL precarga el estado del taller y lo inyecta como contexto
            antes de preguntar. No hay elección de herramientas, pero
            funciona con cualquier modelo, incluso uno de 1B que no sabe
            hacer tool calling. Los datos siguen siendo reales.
`auto`    : intenta `native` y cae a `context` si el servidor lo rechaza.
            Es el valor por omisión, porque en una instalación self-hosted
            no se puede saber de antemano qué modelo puso el usuario.

Cada respuesta viaja con la traza de qué herramientas se llamaron, para que
el usuario pueda verificar de dónde salió cada dato.
"""

import json
import logging
import time
from typing import Any, Dict, List, Optional

from backend.services import ai_config_service, ai_conversations_service, ai_tools
from backend.services.ai_provider import AIProvider, AIProviderError, ToolsUnsupportedError, get_provider

logger = logging.getLogger(__name__)

# Regla dura del sistema: el modelo reporta lo que las herramientas
# devuelven y nada más. Explícitamente se le prohíbe rellenar huecos, que
# es el modo típico de falla de un LLM sobre datos operativos.
SYSTEM_PROMPT = """Eres NOPAL Intelligence, el asistente del taller maker administrado por NOPAL.

Tu trabajo es responder sobre el estado real del taller usando ÚNICAMENTE los datos que te
entregan las herramientas de NOPAL.

Reglas que no puedes romper:
- NUNCA inventes estados, temperaturas, porcentajes, nombres de máquinas ni errores. Si un dato
  no vino de una herramienta, no existe.
- Si una herramienta responde {"available": false} o un error, dilo con naturalidad
  ("NOPAL no está recibiendo temperaturas de esa máquina") en vez de suponer un valor.
- Si te preguntan por una máquina que no aparece en la lista, dilo y menciona las que sí existen.
- Eres de solo lectura. No puedes iniciar, pausar ni cancelar trabajos, mover ejes, calentar,
  hacer home ni encender el láser o el CNC. Si te lo piden, explica que esas acciones tiene que
  hacerlas la persona desde el panel de NOPAL.

Estilo:
- Español de México, directo y breve. Habla como un compañero de taller, no como un reporte.
- Da la conclusión primero. Usa los nombres visibles de las máquinas, no sus ids internos.
- No inventes recomendaciones de seguridad que no te pidieron, pero si ves un error activo,
  menciónalo.
"""

# Versión corta del prompt de sistema (~120 tokens en vez de ~390), para el
# perfil "compact". Conserva íntegras las dos reglas que no se pueden
# perder -- no inventar y no actuar -- y sacrifica los matices de estilo,
# que son los que menos se notan cuando el modelo es chico.
COMPACT_SYSTEM_PROMPT = """Eres NOPAL Intelligence, el asistente de un taller maker.

Responde SOLO con los datos que devuelven las herramientas de NOPAL. NUNCA inventes
estados, temperaturas, porcentajes, nombres de máquinas ni errores: si un dato no vino de
una herramienta, no existe. Si una herramienta devuelve {"available": false} o un error,
dilo en vez de suponer.

Eres de solo lectura: no puedes iniciar ni cancelar trabajos, mover ejes, calentar, hacer
home ni encender el láser o el CNC. Si te lo piden, di que eso se hace desde el panel.

Responde en español de México, breve y directo, con la conclusión primero y usando los
nombres visibles de las máquinas.
"""


def _system_prompt(profile: str) -> str:
    return COMPACT_SYSTEM_PROMPT if profile == "compact" else SYSTEM_PROMPT


# En modo "context" no hay ida y vuelta: se precarga lo que sirve para casi
# cualquier pregunta general del taller. Se mantiene corto a propósito,
# porque cada token extra es tiempo real de CPU en un servidor modesto.
CONTEXT_MODE_TOOLS = ("get_workshop_status", "get_machines", "get_recent_errors")


class AIDisabledError(RuntimeError):
    """La capa de IA está apagada o sin configurar. El router la traduce a
    un 503, para que una instalación sin IA responda algo claro en vez de
    un 500."""


def _tool_result_to_text(result: Any) -> str:
    """Los resultados viajan al modelo como JSON compacto: es el formato
    que mejor entienden los modelos con tool calling y el que menos tokens
    gasta."""
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return json.dumps({"error": "unserializable_result"}, ensure_ascii=False)


async def _run_native_loop(
    provider: AIProvider,
    question: str,
    config: Dict[str, Any],
    history: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Ciclo con function calling: el modelo pide herramientas hasta que
    tiene con qué contestar (o hasta agotar `max_tool_iterations`)."""
    profile = config.get("tool_profile") or "full"
    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": _system_prompt(profile)},
        *(history or []),
        {"role": "user", "content": question},
    ]
    schema = ai_tools.get_tools_schema(profile)
    trace: List[Dict[str, Any]] = []
    max_iterations = int(config.get("max_tool_iterations") or 4)

    for iteration in range(max_iterations):
        message = await provider.chat(messages, tools=schema)
        tool_calls = message.get("tool_calls") or []

        if not tool_calls:
            content = (message.get("content") or "").strip()
            if not content and iteration == 0:
                # Ni herramientas ni texto en la primera vuelta: el modelo no
                # está cooperando con el protocolo. Mejor caer a modo contexto
                # que devolverle al usuario una respuesta vacía.
                raise ToolsUnsupportedError("El modelo no pidió herramientas ni devolvió texto")
            return {"answer": content, "tool_calls": trace, "mode": "native"}

        messages.append(message)

        for call in tool_calls:
            function = call.get("function") or {}
            name = function.get("name") or ""
            raw_args = function.get("arguments") or "{}"
            try:
                arguments = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
            except (json.JSONDecodeError, TypeError, ValueError):
                arguments = {}

            started = time.monotonic()
            result = await ai_tools.call_tool(name, arguments)
            elapsed_ms = round((time.monotonic() - started) * 1000)

            trace.append({
                "tool": name,
                "arguments": arguments,
                "ok": not (isinstance(result, dict) and result.get("error")),
                "elapsed_ms": elapsed_ms,
            })
            logger.info(f"[IA] herramienta {name}({arguments}) -> {elapsed_ms} ms")

            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id") or name,
                "name": name,
                "content": _tool_result_to_text(result),
            })

    # Se agotaron las vueltas: se pide una respuesta final SIN herramientas
    # para no quedarse en un ciclo infinito de llamadas.
    final = await provider.chat(messages)
    return {
        "answer": (final.get("content") or "").strip(),
        "tool_calls": trace,
        "mode": "native",
        "truncated": True,
    }


async def _run_context_mode(
    provider: AIProvider,
    question: str,
    profile: str = "full",
    history: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Sin function calling: NOPAL decide qué datos hacen falta, los
    adjunta y el modelo solo redacta. Funciona con modelos chicos."""
    trace: List[Dict[str, Any]] = []
    context: Dict[str, Any] = {}

    for name in CONTEXT_MODE_TOOLS:
        started = time.monotonic()
        result = await ai_tools.call_tool(name)
        elapsed_ms = round((time.monotonic() - started) * 1000)
        context[name] = result
        trace.append({
            "tool": name,
            "arguments": {},
            "ok": not (isinstance(result, dict) and result.get("error")),
            "elapsed_ms": elapsed_ms,
        })

    messages = [
        {"role": "system", "content": _system_prompt(profile)},
        *(history or []),
        {
            "role": "user",
            "content": (
                "Estos son los datos actuales del taller, obtenidos de NOPAL:\n\n"
                f"{_tool_result_to_text(context)}\n\n"
                f"Con esos datos y nada más, responde: {question}"
            ),
        },
    ]
    message = await provider.chat(messages)
    return {"answer": (message.get("content") or "").strip(), "tool_calls": trace, "mode": "context"}


async def ask(question: str, conversation_id: Optional[str] = None) -> Dict[str, Any]:
    """Punto de entrada de NOPAL Intelligence.

    Levanta AIDisabledError si la capa está apagada y AIProviderError si el
    servidor de IA no responde — el router los traduce a 503 y 502.
    """
    question = (question or "").strip()
    if not question:
        raise ValueError("La pregunta está vacía")

    config = ai_config_service.get_config()
    if not config.get("enabled"):
        raise AIDisabledError("NOPAL Intelligence está desactivado. Actívalo en Configuración > Inteligencia artificial.")
    if not config.get("base_url"):
        raise AIDisabledError("Falta configurar la dirección del servidor de IA.")

    provider = get_provider(config)
    tool_mode = config.get("tool_mode") or "auto"
    profile = config.get("tool_profile") or "full"
    # Turnos previos para que "¿y el otro láser?" tenga sentido. Van
    # recortados: el prompt de herramientas ya es caro (ver HISTORY_TURNS).
    history = ai_conversations_service.recent_turns(conversation_id)
    started = time.monotonic()

    if tool_mode == "context":
        result = await _run_context_mode(provider, question, profile, history)
    elif tool_mode == "native":
        result = await _run_native_loop(provider, question, config, history)
    else:
        try:
            result = await _run_native_loop(provider, question, config, history)
        except ToolsUnsupportedError as exc:
            logger.info(f"[IA] el modelo no soporta function calling ({exc}); se usa modo contexto")
            result = await _run_context_mode(provider, question, profile, history)
            result["fell_back"] = True

    result["question"] = question
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    result["model"] = config.get("model")

    if not result.get("answer"):
        # Un modelo que no contestó nada no debe verse como una respuesta
        # válida vacía en la UI.
        raise AIProviderError("El modelo no devolvió ninguna respuesta.")

    # Se persiste solo lo que salió bien: una conversación no debe quedar
    # sembrada de errores de red del servidor de IA.
    conversacion = ai_conversations_service.append_turn(
        conversation_id, question, result["answer"], result.get("tool_calls"),
    )
    result["conversation_id"] = conversacion["id"]
    result["conversation_title"] = conversacion["title"]
    return result
