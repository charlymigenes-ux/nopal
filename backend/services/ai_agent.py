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

Un modelo por pregunta
----------------------
Con el modo automático encendido, ai_router elige el modelo según lo que se
preguntó y esa elección vale para TODA la respuesta: el ciclo reenvía el
historial completo en cada vuelta, así que cambiar de modelo a medias
obligaría al nuevo a hacerse cargo de llamadas a herramientas que no hizo.
Si el modelo elegido falla se reintenta la pregunta completa con el
siguiente de la cadena -- salvo que ya se haya ejecutado una acción física,
porque repetir la pregunta repetiría la acción.
"""

import json
import logging
import time
from typing import Any, Dict, List, Optional

from backend.services import (
    ai_actions,
    ai_config_service,
    ai_conversations_service,
    ai_router,
    ai_tools,
)
from backend.services.ai_provider import AIProvider, AIProviderError, ToolsUnsupportedError, get_provider

logger = logging.getLogger(__name__)

# Regla dura del sistema: el modelo reporta lo que las herramientas
# devuelven y nada más. Explícitamente se le prohíbe rellenar huecos, que
# es el modo típico de falla de un LLM sobre datos operativos.
SYSTEM_PROMPT = """Eres NOPAL Intelligence, el asistente del taller maker administrado por NOPAL.

Tu trabajo es responder sobre el estado real del taller usando ÚNICAMENTE los datos que te
entregan las herramientas de NOPAL.

Reglas que no puedes romper:
- NUNCA inventes estados, temperaturas, porcentajes, nombres de máquinas, errores, ids, escenas,
  anuncios, reglas ni alertas. Si un dato no vino de una herramienta, no existe.
- Si te piden una LISTA de algo (escenas, anuncios, reglas, alertas, archivos, máquinas), llama a
  la herramienta correspondiente ANTES de contestar, aunque creas saber la respuesta por lo que se
  habló antes. Si no hay ninguna herramienta que lo devuelva, di que no puedes consultarlo.
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
estados, temperaturas, porcentajes, nombres de máquinas, errores ni ids: si un dato no vino
de una herramienta, no existe. Para dar una lista de algo, consulta primero la herramienta
que la devuelve; nunca la contestes de memoria. Si una herramienta devuelve
{"available": false} o un error, dilo en vez de suponer.

Eres de solo lectura: no puedes iniciar ni cancelar trabajos, mover ejes, calentar, hacer
home ni encender el láser o el CNC. Si te lo piden, di que eso se hace desde el panel.

Responde en español de México, breve y directo, con la conclusión primero y usando los
nombres visibles de las máquinas.
"""


ACTIONS_PROMPT = """
Además de consultar, puedes ejecutar algunas acciones sobre el taller. Reglas:
- Nunca puedes arrancar el láser ni el CNC. No existe esa herramienta y no debes ofrecerla.
- Algunas acciones devuelven {"status": "pending_confirmation"}: eso significa que NO se
  ejecutaron. Dilo con claridad y pide confirmación; nunca reportes como hecho algo que
  quedó pendiente.
- Si una acción devuelve un error de permiso, explica que esa operación la tiene que hacer
  un administrador desde el panel.
- No encadenes acciones que la persona no pidió.
"""


def _system_prompt(profile: str, actions_enabled: bool = False) -> str:
    base = COMPACT_SYSTEM_PROMPT if profile == "compact" else SYSTEM_PROMPT
    if not actions_enabled:
        return base
    # Con acciones activas, la frase "eres de solo lectura" es falsa y
    # confundiría al modelo: se retira y se sustituye por las reglas nuevas.
    sin_solo_lectura = "\n".join(
        linea for linea in base.splitlines()
        if "solo lectura" not in linea and "hacerlas la persona desde el panel" not in linea
        and "eso se hace desde el panel" not in linea
        and not linea.strip().startswith("home ni encender")
    )
    return sin_solo_lectura + ACTIONS_PROMPT


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


async def _run_action(name, arguments, role, username, actions_enabled):
    """Ejecuta o deja pendiente, según el nivel de riesgo.

    Las de riesgo `confirm` NO se ejecutan acá: se devuelve al modelo un
    resultado que dice explícitamente que quedó esperando confirmación, para
    que redacte "¿confirmas?" en vez de dar por hecho que ya pasó.
    """
    # No ofrecer una acción en el catálogo NO es lo mismo que rechazarla: un
    # modelo puede inventarse el nombre, o un prompt malicioso inducirlo. El
    # interruptor se revalida acá, en el punto de ejecución.
    if not actions_enabled:
        return {"error": "actions_disabled",
                "detail": "Las acciones están desactivadas en esta instalación de NOPAL."}, None

    accion = ai_actions.ACTIONS[name]
    try:
        if accion.risk == "confirm":
            pendiente = ai_actions.stage_action(name, arguments or {}, username)
            return {
                "status": "pending_confirmation",
                "message": "La acción NO se ejecutó. Espera la confirmación de la persona.",
                "action": name,
            }, pendiente
        return await ai_actions.execute(name, arguments or {}, role), None
    except ai_actions.ActionError as exc:
        return {"error": "action_failed", "detail": str(exc)}, None


async def _run_native_loop(
    provider: AIProvider,
    question: str,
    config: Dict[str, Any],
    history: Optional[List[Dict[str, str]]] = None,
    role: str = "operador",
    username: str = "",
    route: Optional[ai_router.Route] = None,
    model: Optional[str] = None,
    estado: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """Ciclo con function calling: el modelo pide herramientas hasta que
    tiene con qué contestar (o hasta agotar `max_tool_iterations`).

    `estado` lleva la cuenta de acciones físicas ya ejecutadas, para que
    quien maneja el fallback sepa que reintentar dejó de ser inocuo.
    """
    profile = (route.tool_profile if route else None) or config.get("tool_profile") or "full"
    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": _system_prompt(profile, bool(config.get("actions_enabled")))},
        *(history or []),
        {"role": "user", "content": question},
    ]
    schema = ai_tools.get_tools_schema(profile)
    # Las acciones solo entran al catálogo si están habilitadas Y el rol del
    # usuario las permite: la IA nunca ofrece lo que la persona no podría
    # hacer en el panel.
    if config.get("actions_enabled"):
        schema = schema + ai_actions.get_actions_schema(role)
    pending_action = None
    trace: List[Dict[str, Any]] = []
    max_iterations = route.max_tool_iterations if route else int(config.get("max_tool_iterations") or 4)

    for iteration in range(max_iterations):
        message = await provider.chat(messages, tools=schema, model=model)
        tool_calls = message.get("tool_calls") or []

        if not tool_calls:
            content = (message.get("content") or "").strip()
            if not content and iteration == 0:
                # Ni herramientas ni texto en la primera vuelta: el modelo no
                # está cooperando con el protocolo. Mejor caer a modo contexto
                # que devolverle al usuario una respuesta vacía.
                raise ToolsUnsupportedError("El modelo no pidió herramientas ni devolvió texto")
            return {"answer": content, "tool_calls": trace, "mode": "native",
                    "pending_action": pending_action}

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
            if name in ai_actions.ACTIONS:
                result, pendiente = await _run_action(
                    name, arguments, role, username, bool(config.get("actions_enabled")))
                if pendiente is not None:
                    pending_action = pendiente
                elif estado is not None and not (isinstance(result, dict) and result.get("error")):
                    # Ya se tocó algo físico del taller. A partir de acá,
                    # reintentar la pregunta con otro modelo la repetiría.
                    estado["acciones_ejecutadas"] = estado.get("acciones_ejecutadas", 0) + 1
            else:
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
    final = await provider.chat(messages, model=model)
    return {
        "answer": (final.get("content") or "").strip(),
        "tool_calls": trace,
        "mode": "native",
        "truncated": True,
        "pending_action": pending_action,
    }


async def _run_context_mode(
    provider: AIProvider,
    question: str,
    profile: str = "full",
    history: Optional[List[Dict[str, str]]] = None,
    model: Optional[str] = None,
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
    message = await provider.chat(messages, model=model)
    return {"answer": (message.get("content") or "").strip(), "tool_calls": trace, "mode": "context"}


# Lo que se contesta cuando la pregunta necesita ver una imagen. NOPAL
# todavía no manda imágenes al modelo (get_camera_snapshot está reservada,
# ver ai_tools.py), y mandarle la pregunta a un modelo de texto haría que
# describiera una foto que nunca vio. Decir que no se puede es la única
# respuesta honesta, y de paso no gasta una petición de la cuota.
VISION_UNAVAILABLE_ANSWER = (
    "El análisis visual no está disponible en este momento. Puedo consultarte el estado, "
    "las temperaturas y el avance de las máquinas, pero todavía no puedo ver las cámaras."
)


async def _run_with_model(
    provider: AIProvider,
    question: str,
    config: Dict[str, Any],
    history: Optional[List[Dict[str, str]]],
    role: str,
    username: str,
    route: Optional[ai_router.Route],
    model: Optional[str],
    estado: Dict[str, int],
) -> Dict[str, Any]:
    """Una respuesta completa con un modelo concreto. El reparto entre modo
    nativo y modo contexto es exactamente el de siempre; lo único nuevo es
    que el modelo puede no ser el configurado."""
    tool_mode = config.get("tool_mode") or "auto"
    profile = (route.tool_profile if route else None) or config.get("tool_profile") or "full"

    if tool_mode == "context":
        return await _run_context_mode(provider, question, profile, history, model)
    if tool_mode == "native":
        return await _run_native_loop(
            provider, question, config, history, role, username, route, model, estado)
    try:
        return await _run_native_loop(
            provider, question, config, history, role, username, route, model, estado)
    except ToolsUnsupportedError as exc:
        logger.info(f"[IA] el modelo no soporta function calling ({exc}); se usa modo contexto")
        resultado = await _run_context_mode(provider, question, profile, history, model)
        resultado["fell_back"] = True
        return resultado


async def _run_routed(
    provider: AIProvider,
    question: str,
    config: Dict[str, Any],
    history: Optional[List[Dict[str, str]]],
    role: str,
    username: str,
    route: Optional[ai_router.Route],
) -> Dict[str, Any]:
    """Intenta con el modelo elegido y, si falla, con los de respaldo.

    Reintentar significa rehacer la pregunta completa, herramientas
    incluidas. Es aceptable porque las herramientas son lecturas locales y
    baratas -- pero deja de serlo en cuanto una acción física se ejecutó:
    volver a preguntar volvería a encender el accesorio o a encolar el
    archivo. Por eso, con una acción ya hecha, el error sube tal cual.
    """
    estado: Dict[str, int] = {"acciones_ejecutadas": 0}
    if route is None:
        return await _run_with_model(
            provider, question, config, history, role, username, None, None, estado)

    cadena = [route.model or None, *route.fallback_models]
    for indice, modelo in enumerate(cadena):
        try:
            resultado = await _run_with_model(
                provider, question, config, history, role, username, route, modelo, estado)
            resultado["model"] = modelo or config.get("model")
            return resultado
        except AIProviderError as exc:
            ultimo = indice == len(cadena) - 1
            if ultimo or estado["acciones_ejecutadas"]:
                if estado["acciones_ejecutadas"]:
                    logger.warning(
                        "[NOPAL-AI] no se reintenta con otro modelo: ya se ejecutaron "
                        f"{estado['acciones_ejecutadas']} acciones en esta respuesta"
                    )
                raise
            logger.warning(
                f"[NOPAL-AI] {modelo} falló ({exc}); se reintenta con {cadena[indice + 1]}")

    # Inalcanzable: el bucle siempre devuelve o levanta en la última vuelta.
    raise AIProviderError("No quedó ningún modelo por intentar.")


async def ask(question: str, conversation_id: Optional[str] = None,
              role: str = "operador", username: str = "") -> Dict[str, Any]:
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
    # Turnos previos para que "¿y el otro láser?" tenga sentido. Van
    # recortados: el prompt de herramientas ya es caro (ver HISTORY_TURNS).
    history = ai_conversations_service.recent_turns(conversation_id)
    started = time.monotonic()

    # None = modo de modelo fijo: todo sigue exactamente como antes.
    route = ai_router.route(question, config)

    if route and route.tier == "vision":
        result = {"answer": VISION_UNAVAILABLE_ANSWER, "tool_calls": [], "mode": "vision_unavailable"}
    else:
        result = await _run_routed(provider, question, config, history, role, username, route)

    result["question"] = question
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    result["model"] = (result.get("model") or (route.model if route else None)
                       or config.get("model"))
    if route:
        # Metadatos de ruteo: sin esto, ver que una respuesta salió cara o
        # pobre no daría ninguna pista de por qué. No incluye razonamiento
        # del modelo, solo la decisión local y su motivo.
        result["route"] = {
            "tier": route.tier,
            "model": result["model"],
            "reason": route.reason,
            "tool_profile": route.tool_profile,
            "fallback_used": result.get("model") != route.model,
        }
        logger.info(
            f"[NOPAL-AI] route={route.tier} model={result['model']} intent={route.reason} "
            f"tools={len(result.get('tool_calls') or [])}"
        )

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
