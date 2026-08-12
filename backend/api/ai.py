"""API de NOPAL Intelligence.

La configuración es admin-only (define a qué servidor externo se le manda
telemetría del taller). Consultar es para cualquier usuario autenticado.

Todos los endpoints funcionan con la IA apagada: responden 503 con un
mensaje claro, nunca un 500 ni un stack trace.
"""

import logging

from fastapi import APIRouter, Body, Depends, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services import ai_agent, ai_config_service, ai_tools
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
        return await get_provider(effective).test_connection()
    except AIProviderError as exc:
        return {"ok": False, "error": str(exc)}


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
        return await ai_agent.ask(payload.get("question", ""))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ai_agent.AIDisabledError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except AIProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
