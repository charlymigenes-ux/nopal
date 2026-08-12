"""API de NOPAL Intelligence.

La configuración es admin-only (define a qué servidor externo se le manda
telemetría del taller). Consultar es para cualquier usuario autenticado.

Todos los endpoints funcionan con la IA apagada: responden 503 con un
mensaje claro, nunca un 500 ni un stack trace.
"""

import logging

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse

from backend.auth_deps import require_auth, require_role
from backend.services import (
    ai_actions,
    ai_agent,
    ai_config_service,
    ai_conversations_service,
    ai_router,
    ai_tools,
)
from backend.services.ai_config_service import AIConfigError
from backend.services.ai_provider import AIProviderError, get_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/status")
async def ai_status_endpoint(user: dict = Depends(require_auth)):
    """Estado resumido para pintar el indicador de la UI. No contacta al
    servidor de IA (eso es /test, que sí cuesta una petición de red)."""
    config = ai_config_service.get_public_config()
    return {
        "enabled": bool(config.get("enabled")),
        "configured": bool(config.get("base_url")),
        "provider": config.get("provider"),
        "base_url": config.get("base_url"),
        "model": config.get("model"),
    }


@router.get("/presets")
async def ai_presets_endpoint(user: dict = Depends(require_role("admin"))):
    """Proveedores conocidos para poblar el selector de la interfaz.

    No son implementaciones distintas: todos hablan el mismo protocolo
    estilo OpenAI. Un preset solo rellena la dirección.

    Se acompaña de `data_sent`, la lista de lo que saldría de la red local
    al elegir un proveedor en la nube. El usuario tiene derecho a verla
    antes de decidir, no después.
    """
    return {
        "presets": ai_config_service.get_provider_presets(),
        "data_sent": [
            "Nombres y modelos de tus máquinas registradas",
            "Su estado de conexión, trabajo actual y avance",
            "Temperaturas, si preguntas por ellas",
            "Mensajes de error de Klipper, Moonraker y GRBL",
            "Líneas del log de NOPAL, si la pregunta lo amerita",
        ],
    }


@router.get("/config")
async def get_ai_config_endpoint(user: dict = Depends(require_role("admin"))):
    """Configuración vigente, sin la API key (solo si está puesta o no)."""
    return ai_config_service.get_public_config()


@router.put("/config")
async def save_ai_config_endpoint(
    config: dict = Body(...),
    user: dict = Depends(require_role("admin")),
):
    try:
        return ai_config_service.save_config(config)
    except AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        logger.exception("No se pudo guardar la configuración de IA")
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la configuración: {exc}")


@router.post("/test")
async def test_ai_connection_endpoint(
    config: dict = Body(default=None),
    user: dict = Depends(require_role("admin")),
):
    """Prueba la conexión contra el servidor de IA.

    Acepta una configuración en el cuerpo para poder probar ANTES de
    guardar (el botón "Probar conexión" del formulario); sin cuerpo, prueba
    la configuración ya guardada.
    """
    try:
        if config:
            candidate = dict(config)
            if candidate.get("api_key") == ai_config_service.API_KEY_UNCHANGED:
                candidate["api_key"] = ai_config_service.get_config().get("api_key", "")
            # Se valida aunque no se guarde: probar no debe ser una puerta
            # trasera para saltarse el bloqueo de endpoints públicos.
            candidate["enabled"] = True
            effective = ai_config_service.validate_config(candidate)
        else:
            effective = ai_config_service.get_config()
            if not effective.get("base_url"):
                raise HTTPException(status_code=400, detail="Todavía no hay un servidor de IA configurado")
    except AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        resultado = await get_provider(effective).test_connection()
    except AIProviderError as exc:
        return {"ok": False, "error": str(exc)}

    # Se aprovecha la lista de modelos que el servidor acaba de reportar para
    # proponer la tabla del modo automático. Solo se sugiere lo que ese
    # servidor OFRECE de verdad, sea Groq, OpenRouter u Ollama: rellenar un
    # nombre inventado fallaría recién en la primera pregunta.
    if resultado.get("ok"):
        resultado["suggested_tier_models"] = ai_router.suggest_tier_models(
            resultado.get("models") or [])
    return resultado


@router.get("/tiers")
async def ai_tiers_endpoint(user: dict = Depends(require_role("admin"))):
    """Niveles del modo automático y cómo se encadenan si uno falla. La UI
    los pinta; los nombres de modelo salen de la configuración, no de acá."""
    return {
        "tiers": list(ai_router.TIERS),
        "modes": list(ai_router.VALID_MODEL_MODES),
        "fallbacks": ai_router.FALLBACK_CHAINS,
    }


@router.get("/providers")
async def list_ai_providers_endpoint(user: dict = Depends(require_role("admin"))):
    """Las IAs guardadas, sin sus claves. Marca cuál está activa."""
    return ai_config_service.list_providers()


@router.post("/providers")
async def create_ai_provider_endpoint(
    provider: dict = Body(...),
    user: dict = Depends(require_role("admin")),
):
    """Agrega una IA al registro. La primera que se agrega queda activa."""
    try:
        return ai_config_service.create_provider(provider)
    except AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/providers/{provider_id}")
async def update_ai_provider_endpoint(
    provider_id: str,
    provider: dict = Body(...),
    user: dict = Depends(require_role("admin")),
):
    try:
        return ai_config_service.update_provider(provider_id, provider)
    except AIConfigError as exc:
        # "ya no existe" es un 404; el resto son datos inválidos.
        status = 404 if "no existe" in str(exc) else 400
        raise HTTPException(status_code=status, detail=str(exc))


@router.delete("/providers/{provider_id}")
async def delete_ai_provider_endpoint(
    provider_id: str,
    user: dict = Depends(require_role("admin")),
):
    """Borrar la IA activa pasa la activación a la primera que quede; si no
    queda ninguna, la capa se apaga sola en vez de apuntar a la nada."""
    try:
        return ai_config_service.delete_provider(provider_id)
    except AIConfigError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/providers/{provider_id}/activate")
async def activate_ai_provider_endpoint(
    provider_id: str,
    user: dict = Depends(require_role("admin")),
):
    try:
        return ai_config_service.set_active_provider(provider_id)
    except AIConfigError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/enabled")
async def set_ai_enabled_endpoint(
    payload: dict = Body(...),
    user: dict = Depends(require_role("admin")),
):
    """Enciende o apaga la capa sin tocar el registro de IAs guardadas."""
    try:
        return ai_config_service.set_enabled(bool(payload.get("enabled")))
    except AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/suggestions")
async def get_ai_suggestions_endpoint(user: dict = Depends(require_auth)):
    """Preguntas rápidas del asistente. Lista vacía = usar las de fábrica,
    que el frontend traduce; las guardadas van tal cual."""
    return {"suggestions": ai_config_service.get_suggestions()}


@router.put("/suggestions")
async def save_ai_suggestions_endpoint(
    payload: dict = Body(...),
    user: dict = Depends(require_role("admin")),
):
    try:
        return {"suggestions": ai_config_service.save_suggestions(payload.get("suggestions"))}
    except AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/tools")
async def list_ai_tools_endpoint(user: dict = Depends(require_auth)):
    """Catálogo de herramientas de solo lectura que se le ofrecen al modelo.

    Sirve de documentación viva y para auditar qué puede consultar la IA.
    """
    return {
        "tools": [
            {"name": tool.name, "description": tool.description, "parameters": tool.parameters}
            for tool in ai_tools.get_exposed_tools()
        ]
    }


@router.post("/tools/{tool_name}")
async def call_ai_tool_endpoint(
    tool_name: str,
    arguments: dict = Body(default=None),
    user: dict = Depends(require_auth),
):
    """Ejecuta una herramienta directamente, sin pasar por el modelo.

    Existe para poder verificar los datos que vería la IA sin depender de
    que haya un servidor de IA conectado, y para depurar una respuesta
    dudosa. Son las mismas funciones de solo lectura, así que no habilita
    nada que el usuario no pudiera ver ya en el panel.
    """
    result = await ai_tools.call_tool(tool_name, arguments or {})
    if isinstance(result, dict) and result.get("error") == "unknown_tool":
        raise HTTPException(status_code=404, detail=f"No existe la herramienta '{tool_name}'")
    return result


@router.get("/conversations")
async def list_conversations_endpoint(user: dict = Depends(require_auth)):
    """Listado sin los mensajes: una conversación larga no tiene por qué
    viajar entera solo para pintar la barra lateral."""
    return ai_conversations_service.list_conversations()


@router.get("/conversations/{conversation_id}")
async def get_conversation_endpoint(conversation_id: str, user: dict = Depends(require_auth)):
    conversacion = ai_conversations_service.get_conversation(conversation_id)
    if conversacion is None:
        raise HTTPException(status_code=404, detail="Esa conversación ya no existe")
    return conversacion


@router.put("/conversations/{conversation_id}")
async def rename_conversation_endpoint(
    conversation_id: str,
    payload: dict = Body(...),
    user: dict = Depends(require_auth),
):
    conversacion = ai_conversations_service.rename_conversation(conversation_id, payload.get("title", ""))
    if conversacion is None:
        raise HTTPException(status_code=404, detail="Esa conversación ya no existe")
    return conversacion


@router.delete("/conversations/{conversation_id}")
async def delete_conversation_endpoint(conversation_id: str, user: dict = Depends(require_auth)):
    if not ai_conversations_service.delete_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Esa conversación ya no existe")
    return ai_conversations_service.list_conversations()


@router.delete("/conversations")
async def clear_conversations_endpoint(user: dict = Depends(require_role("admin"))):
    """Borrar el historial completo es admin-only: afecta lo que vieron
    todos los usuarios, no solo a quien lo pide."""
    return {"deleted": ai_conversations_service.clear_conversations()}


@router.get("/actions")
async def list_ai_actions_endpoint(user: dict = Depends(require_auth)):
    """Acciones que ESTE usuario puede ejecutar por medio de la IA.

    El listado depende del rol a propósito: un operador no debe ver en el
    catálogo lo que no podría hacer en el panel.
    """
    return {
        "enabled": bool(ai_config_service.get_config().get("actions_enabled")),
        "actions": [
            {"name": a.name, "description": a.description, "risk": a.risk, "role": a.role}
            for a in ai_actions.get_actions(user["role"])
        ],
    }


@router.post("/actions/{token}/confirm")
async def confirm_ai_action_endpoint(token: str, user: dict = Depends(require_auth)):
    """Ejecuta una acción de riesgo que quedó esperando confirmación."""
    if not ai_config_service.get_config().get("actions_enabled"):
        raise HTTPException(status_code=403, detail="Las acciones de la IA están desactivadas")
    try:
        return await ai_actions.confirm(token, user["role"], user["username"])
    except ai_actions.ActionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/actions/{token}/cancel")
async def cancel_ai_action_endpoint(token: str, user: dict = Depends(require_auth)):
    return {"cancelled": ai_actions.cancel(token)}


@router.post("/ask")
async def ask_ai_endpoint(
    payload: dict = Body(...),
    user: dict = Depends(require_auth),
):
    """Pregunta en lenguaje natural sobre el taller.

    Devuelve la respuesta y la traza de qué herramientas se consultaron,
    para que el usuario pueda verificar de dónde salió cada dato.
    """
    try:
        return await ai_agent.ask(
            payload.get("question", ""),
            payload.get("conversation_id"),
            role=user["role"],
            username=user["username"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ai_agent.AIDisabledError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except AIProviderError as exc:
        # `detail` sigue siendo el string de siempre; `retry_after` es un
        # campo hermano (mismo patrón que `error_code` en
        # PrinterRegistrationError) para que la UI pueda mostrar el
        # cronómetro sin que nada de lo anterior cambie de forma.
        return JSONResponse(
            status_code=502,
            content={"detail": str(exc), "retry_after": exc.retry_after},
        )
