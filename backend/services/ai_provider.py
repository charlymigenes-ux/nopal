"""Proveedores de IA para NOPAL Intelligence.

`AIProvider` es la frontera: el resto de NOPAL solo conoce esta interfaz,
nunca un modelo ni un servicio concreto. Hoy la única implementación es
`OpenAICompatibleProvider`, que habla el protocolo `/v1/chat/completions`
estilo OpenAI.

Por qué una sola clase y no tres
--------------------------------
El diseño conceptual distinguía LocalOpenAICompatibleProvider /
LANOpenAICompatibleProvider / CloudProvider. En la práctica los tres
hablan exactamente el mismo protocolo por el mismo cable: lo único que
cambia entre ellos es la `base_url` y si hace falta una API key. Tres
subclases idénticas serían tres lugares donde arreglar el mismo bug, así
que la distinción vive en la configuración (`base_url` +
`allow_public_endpoint`, ver ai_config_service.py) y no en la jerarquía de
clases.

La clase base abstracta sí se mantiene, porque un proveedor con un
protocolo de verdad distinto (uno que no sea OpenAI-compatible) sí
justificaría una implementación aparte, y podrá agregarse sin tocar el
resto de NOPAL.

httpx se importa perezosamente
------------------------------
Una instalación de NOPAL sin IA no debería fallar por una dependencia que
no usa. Si httpx no está disponible se devuelve un error claro en vez de
romper el arranque de la app.
"""

import json
import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from backend.services import ai_config_service

logger = logging.getLogger(__name__)


class AIProviderError(RuntimeError):
    """Falla al hablar con el servidor de IA (red, timeout, respuesta
    inválida). El router la traduce a un 502/503 con mensaje mostrable."""


class AIProvider(ABC):
    """Interfaz mínima que NOPAL le pide a cualquier motor de IA."""

    @abstractmethod
    async def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Manda una conversación y devuelve el `message` de la respuesta
        (el dict con `content` y, si hubo, `tool_calls`)."""

    @abstractmethod
    async def test_connection(self) -> Dict[str, Any]:
        """Comprueba que el servidor responde. Nunca levanta excepción:
        devuelve `{"ok": bool, ...}` para que la UI muestre el resultado."""


def _load_httpx():
    try:
        import httpx  # noqa: PLC0415 -- import perezoso a propósito, ver docstring
    except ImportError as exc:
        raise AIProviderError(
            "Falta la librería httpx, necesaria para la capa de IA. "
            "Instálala con: pip install httpx"
        ) from exc
    return httpx


class OpenAICompatibleProvider(AIProvider):
    """Cliente de cualquier servidor con API estilo OpenAI.

    Probado contra el contrato de `/v1/chat/completions` y `/v1/models`,
    que es lo que exponen llama.cpp (`llama-server`), vLLM, LM Studio y
    Ollama por su capa de compatibilidad.
    """

    def __init__(self, config: Dict[str, Any]):
        self.base_url = str(config.get("base_url") or "").rstrip("/")
        self.model = config.get("model") or ""
        self.api_key = config.get("api_key") or ""
        self.timeout_s = float(config.get("timeout_s") or 60)
        self.max_tokens = int(config.get("max_tokens") or 512)
        self.temperature = float(config.get("temperature") or 0.2)

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        # Muchos servidores locales ignoran la autorización, pero mandarla
        # no molesta y es obligatoria para los que sí la piden.
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        httpx = _load_httpx()

        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        url = f"{self.base_url}/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(url, headers=self._headers(), json=payload)
        except httpx.TimeoutException as exc:
            raise AIProviderError(
                f"El servidor de IA no respondió en {self.timeout_s:.0f} s. "
                "En hardware modesto puede hacer falta subir el tiempo de espera."
            ) from exc
        except httpx.HTTPError as exc:
            raise AIProviderError(f"No se pudo contactar al servidor de IA en {self.base_url}: {exc}") from exc

        if response.status_code == 400 and tools:
            # Señal habitual de que el modelo/servidor no soporta function
            # calling. Se distingue del resto de los 400 para que el ciclo
            # del agente pueda reintentar sin herramientas (modo "auto").
            raise ToolsUnsupportedError(_error_detail(response))

        if response.status_code >= 400:
            raise AIProviderError(f"El servidor de IA respondió {response.status_code}: {_error_detail(response)}")

        try:
            data = response.json()
            return data["choices"][0]["message"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise AIProviderError(
                "El servidor respondió algo que no es una respuesta de chat estilo OpenAI. "
                f"Revisa que la dirección termine en /v1 ({self.base_url})."
            ) from exc

    async def _probe_chat(self, httpx_module) -> Optional[Dict[str, Any]]:
        """Prueba de respaldo: una petición de chat mínima (1 token).

        No todos los proveedores exponen `/v1/models` de forma utilizable —
        Anthropic, por ejemplo, atiende `/v1/chat/completions` por su capa
        de compatibilidad con OpenAI pero enruta `/v1/models` por otra vía
        de autenticación. Sin este respaldo, "Probar conexión" diría que
        falla en servidores donde preguntar sí funciona.
        """
        try:
            async with httpx_module.AsyncClient(timeout=min(self.timeout_s, 30)) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json={
                        "model": self.model,
                        "messages": [{"role": "user", "content": "ok"}],
                        "max_tokens": 1,
                    },
                )
        except Exception as exc:
            return {"ok": False, "error": f"No se pudo contactar a {self.base_url}: {exc}"}

        if response.status_code >= 400:
            return {"ok": False, "error": f"El servidor respondió {response.status_code}: {_error_detail(response)}"}
        # Respondió una generación: la conexión y la clave sirven. No se
        # puede listar modelos, así que se confía en el que puso el usuario.
        return {"ok": True, "base_url": self.base_url, "models": [], "configured_model": self.model}

    async def test_connection(self) -> Dict[str, Any]:
        """Pide `/v1/models` y, si eso no sirve, cae a una petición de chat
        mínima. Devuelve qué modelos ofrece el servidor para que la UI pueda
        avisar si el modelo configurado no está entre ellos (causa muy común
        de fallo silencioso)."""
        try:
            httpx = _load_httpx()
        except AIProviderError as exc:
            return {"ok": False, "error": str(exc)}

        if not self.base_url:
            return {"ok": False, "error": "No hay una dirección de servidor de IA configurada"}

        url = f"{self.base_url}/models"
        try:
            async with httpx.AsyncClient(timeout=min(self.timeout_s, 15)) as client:
                response = await client.get(url, headers=self._headers())
        except Exception:
            return await self._probe_chat(httpx)

        if response.status_code >= 400:
            return await self._probe_chat(httpx)

        try:
            models = [entry.get("id") for entry in response.json().get("data", []) if entry.get("id")]
        except (json.JSONDecodeError, AttributeError, TypeError):
            return await self._probe_chat(httpx)

        result: Dict[str, Any] = {
            "ok": True,
            "base_url": self.base_url,
            "models": models,
            "configured_model": self.model,
        }
        if self.model and models and self.model not in models:
            result["warning"] = (
                f"El servidor respondió, pero no ofrece el modelo '{self.model}'. "
                f"Disponibles: {', '.join(models[:5])}"
            )
        elif not self.model:
            result["warning"] = "El servidor responde, pero todavía no elegiste un modelo."
        return result


class ToolsUnsupportedError(AIProviderError):
    """El servidor rechazó el pedido por el campo `tools`. En modo "auto"
    el agente reintenta sin function calling (ver ai_agent.py)."""


def _error_detail(response: Any) -> str:
    """Extrae el mensaje de error del cuerpo, sea JSON estilo OpenAI o
    texto plano, y lo recorta para no volcar un HTML entero al log."""
    try:
        body = response.json()
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])[:300]
            if isinstance(error, str):
                return error[:300]
        return json.dumps(body)[:300]
    except Exception:
        return (response.text or "")[:300]


PROVIDERS = {
    "openai-compatible": OpenAICompatibleProvider,
}


def get_provider(config: Optional[Dict[str, Any]] = None) -> AIProvider:
    """Construye el proveedor según la configuración vigente."""
    config = config or ai_config_service.get_config()
    provider_id = config.get("provider") or "openai-compatible"
    provider_class = PROVIDERS.get(provider_id)
    if provider_class is None:
        raise AIProviderError(
            f"Proveedor de IA desconocido: '{provider_id}'. Disponibles: {', '.join(sorted(PROVIDERS))}"
        )
    return provider_class(config)
