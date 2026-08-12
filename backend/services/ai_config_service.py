"""Configuración de NOPAL Intelligence — la capa de IA opcional.

NOPAL no depende de ningún modelo ni proveedor concreto: habla contra
cualquier endpoint que exponga la API estilo OpenAI (`/v1/chat/completions`).
Ese endpoint puede ser llama.cpp, vLLM, LM Studio, Ollama (por su capa
`/v1`) o un proveedor de nube — NOPAL no necesita saber qué modelo hay
detrás.

Convención de configuración: igual que `spoolman_config.json` y
`pricing_config.json`, un JSON plano en la raíz del repo (gitignored, es
estado por instalación, no código). Las variables de entorno `NOPAL_AI_*`
pisan lo que haya en el archivo — pensadas para instalaciones headless o
para no dejar la API key escrita en disco.

Con `enabled` en false (el valor por omisión) NOPAL funciona exactamente
igual que antes de que existiera este módulo: los endpoints /api/ai/*
responden 503 y ningún otro módulo del core consulta esta configuración.

Decisión conservadora sobre endpoints públicos: por omisión solo se
permite apuntar a localhost o a la LAN (`allow_public_endpoint` en false).
Mandar telemetría del taller a un servicio de internet tiene que ser una
decisión explícita del usuario, no algo que ocurra por escribir mal una
IP en la configuración.
"""

import ipaddress
import json
import logging
import os
import socket
from typing import Any, Dict, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

CONFIG_PATH = "ai_config.json"

# Valor centinela que el frontend manda de vuelta cuando el usuario NO
# quiso cambiar la API key — así la clave real nunca tiene que viajar al
# navegador solo para poder guardar el resto del formulario.
API_KEY_UNCHANGED = "__unchanged__"

DEFAULT_CONFIG: Dict[str, Any] = {
    "enabled": False,
    # Hoy solo existe un tipo de proveedor real; el campo queda para que
    # agregar otro protocolo (uno que NO sea OpenAI-compatible) no obligue
    # a cambiar el formato del archivo de configuración.
    "provider": "openai-compatible",
    # Sin valor por omisión a propósito: no hay ninguna IP ni puerto que
    # NOPAL pueda adivinar correctamente para todas las instalaciones.
    "base_url": "",
    "model": "",
    "api_key": "",
    "timeout_s": 60,
    "max_tokens": 512,
    # Bajo a propósito: acá se quiere que el modelo reporte datos del
    # taller, no que redacte con creatividad.
    "temperature": 0.2,
    # "auto"   -> intenta function calling nativo y cae a "context" si el
    #             servidor/modelo no lo soporta (modelos chicos suelen no).
    # "native" -> exige function calling.
    # "context" -> nunca usa function calling; NOPAL precarga los datos.
    "tool_mode": "auto",
    # "full"    -> las 11 herramientas (~1260 tokens de esquema).
    # "compact" -> solo las 5 principales (~570 tokens). En un servidor de
    #              IA modesto el esquema domina el tiempo de respuesta,
    #              porque el modelo lo lee entero antes de empezar a
    #              razonar. Ver get_exposed_tools() en ai_tools.py.
    "tool_profile": "full",
    # Tope de vueltas del ciclo herramienta->modelo. En una i3 cada vuelta
    # cuesta segundos reales, así que se mantiene chico.
    "max_tool_iterations": 4,
    "allow_public_endpoint": False,
}

# Atajos para no tener que saberse las direcciones de memoria. NO son
# proveedores distintos a nivel de código: todos hablan el mismo protocolo
# estilo OpenAI y los atiende OpenAICompatibleProvider. Un preset solo
# rellena el formulario.
#
# `cloud: True` marca los que salen a internet. Elegir uno de ésos implica
# activar `allow_public_endpoint` y aceptar que los datos del taller
# (nombres de máquinas, estados, temperaturas, mensajes de error y, si se
# usa get_recent_events, líneas del log) viajan a un tercero. NOPAL no lo
# hace por omisión y nunca lo elige solo.
#
# No se listan modelos: cambian seguido y el propio servidor los reporta
# en /v1/models, que es lo que consulta el botón de probar conexión.
PROVIDER_PRESETS = [
    {
        "id": "local",
        "name": "Servidor local o de la LAN",
        "base_url": "",
        "cloud": False,
        "api_key_required": False,
        "note": "llama.cpp, vLLM, LM Studio u Ollama en tu red. Gratis y sin salir de casa.",
    },
    {
        "id": "ollama",
        "name": "Ollama",
        # Ollama expone su capa compatible con OpenAI en /v1 del 11434. Es
        # el único preset local con dirección precargada porque su puerto
        # sí es fijo por convención, a diferencia de llama.cpp o vLLM.
        "base_url": "http://127.0.0.1:11434/v1",
        "cloud": False,
        "api_key_required": False,
        "note": "Si Ollama corre en otro equipo de la LAN, cambia 127.0.0.1 por su IP.",
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "cloud": True,
        "api_key_required": True,
        "note": "Requiere cuenta de pago en platform.openai.com.",
    },
    {
        "id": "anthropic",
        "name": "Anthropic (Claude)",
        "base_url": "https://api.anthropic.com/v1",
        "cloud": True,
        "api_key_required": True,
        "note": "Vía su capa de compatibilidad con OpenAI. Requiere cuenta de pago.",
    },
    {
        "id": "groq",
        "name": "Groq",
        "base_url": "https://api.groq.com/openai/v1",
        "cloud": True,
        "api_key_required": True,
        "note": "Modelos abiertos servidos muy rápido; tiene nivel gratuito con límites.",
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "cloud": True,
        "api_key_required": True,
        "note": "Pasarela a muchos proveedores; incluye algunos modelos sin costo.",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "cloud": True,
        "api_key_required": True,
        "note": "Requiere cuenta de pago.",
    },
    {
        "id": "custom",
        "name": "Otro (escribir la dirección)",
        "base_url": "",
        "cloud": False,
        "api_key_required": False,
        "note": "Cualquier servidor con API compatible con OpenAI.",
    },
]


def get_provider_presets() -> list:
    """Catálogo para poblar el selector de la interfaz."""
    return [dict(preset) for preset in PROVIDER_PRESETS]


_BOOL_TRUE = {"1", "true", "yes", "on", "si", "sí"}


def _as_bool(value: str) -> bool:
    return value.strip().lower() in _BOOL_TRUE


def _as_int(value: str) -> int:
    return int(float(value))


# Variable de entorno -> (clave de config, conversor). Pisan al archivo.
ENV_OVERRIDES = {
    "NOPAL_AI_ENABLED": ("enabled", _as_bool),
    "NOPAL_AI_PROVIDER": ("provider", str),
    "NOPAL_AI_BASE_URL": ("base_url", str),
    "NOPAL_AI_MODEL": ("model", str),
    "NOPAL_AI_API_KEY": ("api_key", str),
    "NOPAL_AI_TIMEOUT": ("timeout_s", _as_int),
    "NOPAL_AI_MAX_TOKENS": ("max_tokens", _as_int),
    "NOPAL_AI_TEMPERATURE": ("temperature", float),
    "NOPAL_AI_TOOL_MODE": ("tool_mode", str),
    "NOPAL_AI_TOOL_PROFILE": ("tool_profile", str),
    "NOPAL_AI_MAX_TOOL_ITERATIONS": ("max_tool_iterations", _as_int),
    "NOPAL_AI_ALLOW_PUBLIC_ENDPOINT": ("allow_public_endpoint", _as_bool),
}

VALID_TOOL_MODES = ("auto", "native", "context")
VALID_TOOL_PROFILES = ("full", "compact")


class AIConfigError(ValueError):
    """Configuración de IA inválida o insegura. La levanta quien valida,
    la traduce a HTTP 400 el router (ver backend/api/ai.py)."""


def _read_file_config() -> Dict[str, Any]:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError):
        # Mismo criterio que el resto de los registros JSON de NOPAL: un
        # archivo corrupto no debe tumbar el arranque, se ignora y se avisa.
        logger.warning(f"{CONFIG_PATH} ilegible o corrupto, se usan los valores por omisión")
        return {}
    return data if isinstance(data, dict) else {}


def _apply_env_overrides(config: Dict[str, Any]) -> Dict[str, Any]:
    for env_name, (key, convert) in ENV_OVERRIDES.items():
        raw = os.environ.get(env_name)
        if raw is None:
            continue
        try:
            config[key] = convert(raw)
        except (TypeError, ValueError):
            logger.warning(f"{env_name} tiene un valor inválido ({raw!r}), se ignora")
    return config


def get_config() -> Dict[str, Any]:
    """Configuración efectiva: valores por omisión < archivo < entorno.

    Incluye la API key en claro — es para uso interno del backend. Lo que
    se manda al navegador es `get_public_config()`.
    """
    config = dict(DEFAULT_CONFIG)
    config.update({k: v for k, v in _read_file_config().items() if k in DEFAULT_CONFIG})
    return _apply_env_overrides(config)


def get_public_config() -> Dict[str, Any]:
    """Versión para el frontend: sin la API key, solo si está puesta o no.

    También reporta qué claves vienen forzadas por variables de entorno,
    para que la UI pueda mostrarlas como no editables en vez de dejar que
    el usuario "guarde" un cambio que el entorno va a pisar igual.
    """
    config = get_config()
    public = {k: v for k, v in config.items() if k != "api_key"}
    public["api_key_set"] = bool(config.get("api_key"))
    public["env_locked_fields"] = sorted(
        key for env_name, (key, _) in ENV_OVERRIDES.items() if env_name in os.environ
    )
    return public


def _host_is_private(host: str) -> Optional[bool]:
    """True si el host resuelve a loopback/LAN, False si resuelve a una IP
    pública, None si no se puede resolver (sin red, DNS caído, etc.).

    None se trata como "no se pudo comprobar" y no bloquea: negarse a
    guardar una configuración porque el DNS está caído sería peor que el
    riesgo que se intenta evitar.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        return None
    for info in infos:
        address = info[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if not (ip.is_private or ip.is_loopback or ip.is_link_local):
            return False
    return True


def validate_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Valida y normaliza una configuración candidata. Levanta
    AIConfigError con un mensaje mostrable al usuario."""
    validated = dict(DEFAULT_CONFIG)
    validated.update({k: v for k, v in config.items() if k in DEFAULT_CONFIG})

    validated["enabled"] = bool(validated["enabled"])
    validated["allow_public_endpoint"] = bool(validated["allow_public_endpoint"])
    validated["base_url"] = str(validated["base_url"] or "").strip().rstrip("/")
    validated["model"] = str(validated["model"] or "").strip()
    validated["api_key"] = str(validated["api_key"] or "")
    validated["provider"] = str(validated["provider"] or "openai-compatible").strip()

    if validated["tool_mode"] not in VALID_TOOL_MODES:
        raise AIConfigError(f"Modo de herramientas inválido; usa uno de: {', '.join(VALID_TOOL_MODES)}")

    if validated["tool_profile"] not in VALID_TOOL_PROFILES:
        raise AIConfigError(f"Perfil de herramientas inválido; usa uno de: {', '.join(VALID_TOOL_PROFILES)}")

    try:
        validated["timeout_s"] = max(1, int(validated["timeout_s"]))
        validated["max_tokens"] = max(1, int(validated["max_tokens"]))
        validated["max_tool_iterations"] = max(1, min(10, int(validated["max_tool_iterations"])))
        validated["temperature"] = float(validated["temperature"])
    except (TypeError, ValueError):
        raise AIConfigError("Los valores numéricos de la configuración de IA son inválidos")

    if not validated["enabled"]:
        # Con la IA apagada no se exige un endpoint válido: el usuario tiene
        # que poder apagarla y guardar aunque la URL haya quedado a medias.
        return validated

    if not validated["base_url"]:
        raise AIConfigError("Falta la dirección del servidor de IA (por ejemplo http://192.168.0.30:8080/v1)")

    parsed = urlparse(validated["base_url"])
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise AIConfigError("La dirección del servidor de IA debe ser una URL http:// o https:// completa")

    if not validated["allow_public_endpoint"]:
        is_private = _host_is_private(parsed.hostname)
        if is_private is False:
            raise AIConfigError(
                f"{parsed.hostname} no es una dirección de tu red local. NOPAL Intelligence solo "
                "habla con servidores de IA en localhost o en la LAN; si de verdad quieres usar un "
                "proveedor externo, activa explícitamente 'Permitir servidor externo'."
            )

    return validated


def save_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Persiste la configuración validada en `ai_config.json`.

    `api_key` con el valor centinela API_KEY_UNCHANGED conserva la clave ya
    guardada, para que el frontend nunca tenga que recibirla ni reenviarla.
    """
    incoming = dict(config)
    if incoming.get("api_key") == API_KEY_UNCHANGED:
        incoming["api_key"] = _read_file_config().get("api_key", "")

    validated = validate_config(incoming)

    # Lo que se escribe en disco es solo el archivo; las variables de
    # entorno siguen pisándolo al leer (ver get_config).
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump(validated, handle, indent=2, ensure_ascii=False)

    return get_public_config()


def is_enabled() -> bool:
    """Atajo para el resto del core: ¿hay que ofrecer la capa de IA?"""
    config = get_config()
    return bool(config.get("enabled")) and bool(config.get("base_url"))
