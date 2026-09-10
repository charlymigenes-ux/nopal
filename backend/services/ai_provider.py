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

import email.utils
import json
import logging
import re
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from backend.services import ai_config_service

logger = logging.getLogger(__name__)

# Tope de la espera que se le reporta al usuario. Un proveedor puede decir
# "vuelve en 24 h" (cuota diaria agotada); mostrar un cronómetro de 86400 s
# no ayuda a nadie y solo bloquearía el botón de enviar para siempre.
MAX_RETRY_AFTER_SECONDS = 3600


# Etiquetas con las que los modelos de razonamiento envuelven su borrador.
# `think` la usan DeepSeek-R1, QwQ y Qwen3; `thought`/`thinking`, Gemini y
# algunos servidores locales. Se listan explícitamente en vez de barrer
# cualquier <tag> para no comerse contenido legítimo del usuario.
_REASONING_TAGS = ("think", "thought", "thinking", "reasoning", "reflection")

_REASONING_BLOCK = re.compile(
    r"<(?P<tag>" + "|".join(_REASONING_TAGS) + r")\b[^>]*>.*?</(?P=tag)\s*>",
    re.DOTALL | re.IGNORECASE,
)

# Un bloque abierto y nunca cerrado: pasa cuando el borrador se comió el
# presupuesto de max_tokens y la respuesta se cortó a la mitad. Se descarta
# igual -- mostrar medio razonamiento es peor que no mostrar nada.
_REASONING_UNCLOSED = re.compile(
    r"<(?:" + "|".join(_REASONING_TAGS) + r")\b[^>]*>.*\Z",
    re.DOTALL | re.IGNORECASE,
)


def strip_reasoning(text: str) -> str:
    """Quita los bloques de razonamiento y deja solo la respuesta final."""
    if not text or "<" not in text:
        return text

    limpio = _REASONING_BLOCK.sub("", text)
    limpio = _REASONING_UNCLOSED.sub("", limpio)
    return limpio.strip()


class AIProviderError(RuntimeError):
    """Falla al hablar con el servidor de IA (red, timeout, respuesta
    inválida). El router la traduce a un 502/503 con mensaje mostrable.

    `retry_after` son los segundos que el proveedor pide esperar antes de
    volver a intentar (None si no lo dijo o no aplica). Es lo que alimenta
    el cronómetro de la interfaz: un 429 de límite por minuto se resuelve
    solo en segundos, y sin ese dato el usuario solo ve "error" y reintenta
    a ciegas, gastando cuota justo cuando no la tiene.
    """

    def __init__(self, message: str, retry_after: Optional[float] = None):
        super().__init__(message)
        self.retry_after = retry_after


class AIProvider(ABC):
    """Interfaz mínima que NOPAL le pide a cualquier motor de IA."""

    @abstractmethod
    async def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Manda una conversación y devuelve el `message` de la respuesta
        (el dict con `content` y, si hubo, `tool_calls`).

        `model` pisa el modelo configurado solo para esta llamada; es lo
        que usa ai_router para mandar cada pregunta al modelo que le
        corresponde sin tener que construir un proveedor por modelo."""

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
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        httpx = _load_httpx()

        payload: Dict[str, Any] = {
            "model": model or self.model,
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
            detalle = _error_detail(response)
            raise AIProviderError(
                f"El servidor de IA respondió {response.status_code}: {detalle}",
                retry_after=_retry_after_seconds(response, detalle),
            )

        try:
            data = response.json()
            message = data["choices"][0]["message"]
            # El borrador de razonamiento se descarta acá y no más arriba en
            # la cadena: así ningún consumidor (chat, agente, historial) lo
            # ve nunca. Ver strip_reasoning().
            if isinstance(message.get("content"), str):
                message["content"] = strip_reasoning(message["content"])
            return message
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


# "4.5225s", "2m59.56s", "1m", "300ms", "5" (segundos pelados). Es el
# formato que usan las cabeceras x-ratelimit-reset-* y también el texto del
# mensaje de error ("Please try again in 4.5225s").
_DURACION_RE = re.compile(
    r"(?:(?P<h>\d+(?:\.\d+)?)h)?"
    r"(?:(?P<m>\d+(?:\.\d+)?)m(?!s))?"
    r"(?:(?P<s>\d+(?:\.\d+)?)s)?"
    r"(?:(?P<ms>\d+(?:\.\d+)?)ms)?$"
)


def _parse_duration(texto: str) -> Optional[float]:
    """Convierte a segundos una duración estilo `1m20.5s`, `4.52s`, `300ms`
    o un número pelado. Devuelve None si no se entiende."""
    texto = (texto or "").strip().lower()
    if not texto:
        return None
    try:
        return float(texto)  # segundos pelados: el formato de Retry-After
    except ValueError:
        pass
    match = _DURACION_RE.fullmatch(texto)
    if not match or not any(match.groupdict().values()):
        return None
    partes = {k: float(v) for k, v in match.groupdict().items() if v is not None}
    return (
        partes.get("h", 0) * 3600
        + partes.get("m", 0) * 60
        + partes.get("s", 0)
        + partes.get("ms", 0) / 1000
    )


def _retry_after_seconds(response: Any, detail: str = "") -> Optional[float]:
    """Cuántos segundos pide esperar el proveedor antes de reintentar.

    Se busca en tres lugares, del más confiable al menos: la cabecera
    estándar `Retry-After` (segundos o fecha HTTP), las cabeceras
    `x-ratelimit-reset-*` que mandan Groq y OpenAI, y como último recurso el
    propio texto del error ("Please try again in 4.5225s") — Groq manda ese
    dato en el cuerpo aunque las cabeceras vengan con el reset de otra
    cuota. Devuelve None si ninguno dice nada útil.
    """
    # httpx.Headers ya ignora mayúsculas, pero acá se normaliza igual para
    # no depender de qué tipo concreto traiga la respuesta.
    try:
        headers = {str(k).lower(): v for k, v in (response.headers or {}).items()}
    except Exception:
        headers = {}

    crudo = headers.get("retry-after")
    if crudo:
        segundos = _parse_duration(str(crudo))
        if segundos is None:
            # La otra forma válida de Retry-After: una fecha HTTP.
            fecha = email.utils.parsedate_to_datetime(str(crudo))
            if fecha is not None:
                segundos = fecha.timestamp() - time.time()
        if segundos is not None:
            return _acotar(segundos)

    # De las cuotas que reporte el proveedor interesa la que más tarda en
    # reponerse: reintentar cuando se libera la de tokens pero no la de
    # peticiones da otro 429 inmediato.
    esperas = [
        _parse_duration(str(valor))
        for clave, valor in headers.items()
        if clave.startswith("x-ratelimit-reset")
    ]
    esperas = [e for e in esperas if e is not None and e > 0]
    if esperas:
        return _acotar(max(esperas))

    texto = re.search(r"again in ([\dhms.]+)", detail or "", re.IGNORECASE)
    if texto:
        # El punto final de la oración se cuela en la captura ("4.5225s.").
        segundos = _parse_duration(texto.group(1).rstrip("."))
        if segundos is not None:
            return _acotar(segundos)
    return None


def _acotar(segundos: float) -> Optional[float]:
    """Recorta la espera al rango que tiene sentido mostrar en pantalla."""
    if segundos <= 0:
        return None
    return min(round(segundos, 2), float(MAX_RETRY_AFTER_SECONDS))


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
