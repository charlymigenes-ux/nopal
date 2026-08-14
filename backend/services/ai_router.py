"""Elección local del modelo según lo que se está preguntando.

Por qué existe
--------------
Un proveedor pone sus límites POR MODELO, no por cuenta. Mandar todo al
modelo más grande desperdicia dos cosas a la vez: la cuota diaria del
grande (con Groq, 1.000 peticiones/día contra 14.400 del chico) y la
capacidad del chico, que queda sin usar. Repartir según la dificultad de
la pregunta suma los dos cupos y deja el modelo caro para cuando de verdad
hace falta.

La clasificación es LOCAL, por reglas
-------------------------------------
Preguntarle a una IA cuál IA usar costaría una petición y unos cientos de
tokens por consulta — justo lo que se intenta ahorrar. Acá se decide con
palabras clave sobre el texto de la pregunta, sin salir a la red.

El precio de esa decisión es que las reglas se equivocan a veces. Por eso
el orden importa y el último caso es siempre `fast`: equivocarse hacia el
modelo chico cuesta una respuesta más pobre; equivocarse hacia el grande
cuesta cuota que no se recupera.

Qué NO decide el router
-----------------------
Ni el número de herramientas ni el tamaño del contexto: no se conocen
antes de llamar al modelo, se descubren cuando el modelo pide la primera
herramienta. Se clasifica con lo único disponible de antemano: la pregunta
y su conversación.

Un modelo por pregunta, no por vuelta
-------------------------------------
El ciclo de herramientas reenvía todo el historial (incluidos los
`tool_calls` ya emitidos) en cada vuelta. Cambiar de modelo a media
conversación obligaría a que el nuevo se haga cargo de llamadas que no
hizo, así que la elección se toma una vez y vale para toda la respuesta.

Sirve para cualquier proveedor, no solo para Groq
-------------------------------------------------
El router no sabe de proveedores: recibe una tabla nivel -> modelo y la
usa. Esa tabla se guarda en cada IA del registro (`tier_models`), así que
una instalación puede tener niveles con Groq, otra con OpenRouter y otra
con tres modelos de Ollama corriendo en la misma máquina.

Los nombres concretos no se escriben acá salvo como sugerencia:
`KNOWN_TIER_MODELS` reúne los que se conocen de proveedores conocidos, y
`suggest_tier_models()` solo propone los que el endpoint DE VERDAD ofrece
en su `/v1/models`. Nunca se rellena a ciegas un nombre que el servidor no
tenga: fallaría en la primera pregunta y el usuario no sabría por qué.

Un nivel sin modelo configurado cae al modelo único de siempre, así que
activar el modo automático a medias nunca deja a NOPAL sin poder contestar.
"""

import logging
import re
import unicodedata
from typing import Any, Dict, List, NamedTuple, Optional

logger = logging.getLogger(__name__)

# Niveles, de más barato a más caro. El orden de esta tupla es el que usa
# la interfaz para pintarlos.
TIERS = ("fast", "medium", "reasoning", "vision", "agent")

VALID_MODEL_MODES = ("fixed", "auto")

# Candidatos conocidos por nivel, en orden de preferencia y mezclando
# proveedores a propósito: la sugerencia se cruza contra los modelos que el
# endpoint reporta de verdad, así que un nombre que ese proveedor no tenga
# simplemente no se ofrece. Equivocarse acá no puede romper nada.
#
# Nota sobre lo multietapa: el candidato natural sería groq/compound-mini,
# pero rechaza el envío de herramientas ("`tool calling` is not supported
# with this model") y una consulta del taller sin acceso a los datos del
# taller no sirve de nada. Por eso el nivel agente comparte candidatos con
# razonamiento y lo que cambia es el número de vueltas de herramientas.
KNOWN_TIER_MODELS: Dict[str, tuple] = {
    "fast": (
        "llama-3.1-8b-instant",           # Groq
        "gpt-4o-mini", "gpt-4.1-mini",    # OpenAI
        "claude-haiku-4-5-20251001",      # Anthropic
    ),
    "medium": (
        "openai/gpt-oss-20b",
        "gpt-4.1", "gpt-4o",
        "claude-sonnet-4-5",
    ),
    "reasoning": (
        "openai/gpt-oss-120b",
        "o3", "gpt-4.1",
        "claude-sonnet-4-5",
    ),
    "vision": (
        "qwen/qwen3.6-27b",
        "gpt-4o", "gpt-4.1",
    ),
    "agent": (
        "openai/gpt-oss-120b",
        "gpt-4.1",
        "claude-sonnet-4-5",
    ),
}

# Pistas para proveedores que nadie puede conocer de antemano (Ollama, LM
# Studio, llama.cpp: los modelos son los que cada quien haya bajado). Se
# usan solo si ningún candidato conocido está disponible.
_VISION_NAME_HINTS = ("vision", "llava", "-vl", "vl-", "multimodal", "moondream")
_PARAM_SIZE_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*b(?![a-z])")

# A qué recurrir cuando el modelo elegido falla (cuota, caída, error del
# proveedor). Siempre termina en algo más chico y más disponible.
FALLBACK_CHAINS: Dict[str, List[str]] = {
    "fast": ["fast", "medium"],
    "medium": ["medium", "fast"],
    "reasoning": ["reasoning", "medium", "fast"],
    "agent": ["agent", "reasoning", "medium"],
    # Visión no cae a ningún lado: un modelo de texto "describiendo" una
    # foto que nunca vio inventaría lo que hay en la imagen, y eso es peor
    # que decir que no se pudo.
    "vision": ["vision"],
}

# El nivel rápido va con el catálogo compacto de herramientas: el esquema
# completo son ~1.500 tokens en CADA llamada, y el modelo chico es
# justamente el que menos margen de tokens por minuto tiene. Un nivel
# puede recortar el catálogo, nunca ampliarlo más allá de lo configurado.
TIER_TOOL_PROFILE: Dict[str, str] = {"fast": "compact"}

# Lo multietapa necesita encadenar varias herramientas antes de contestar;
# con el tope normal se quedaría a medias y contestaría con lo que alcanzó.
AGENT_MIN_ITERATIONS = 6


class Route(NamedTuple):
    """La decisión: qué nivel, con qué modelo y por qué."""

    tier: str
    model: str
    reason: str
    tool_profile: str
    max_tool_iterations: int
    # Modelos a los que recurrir, en orden, si el primero falla.
    fallback_models: List[str]


def _normalize(texto: str) -> str:
    """Minúsculas y sin acentos: en el taller nadie escribe 'por qué' con
    tilde de manera consistente, y 'camara' debe encontrar 'cámara'."""
    sin_acentos = unicodedata.normalize("NFKD", (texto or "").lower())
    return "".join(c for c in sin_acentos if not unicodedata.combining(c))


def _contiene(texto: str, palabras) -> Optional[str]:
    """Primera palabra de la lista presente como palabra completa.

    Con límites de palabra a propósito: 'falla' no debe dispararse dentro
    de 'pantalla', ni 'error' dentro de un nombre de archivo.
    """
    for palabra in palabras:
        if re.search(rf"(?<!\w){re.escape(palabra)}(?!\w)", texto):
            return palabra
    return None


# Nombrar una imagen ya implica querer verla: no hay forma de preguntar
# por "esta foto" sin que haya una foto.
IMAGE_NOUNS = ("imagen", "imagenes", "foto", "fotos", "fotografia", "snapshot", "captura")

# La cámara, en cambio, es ambigua: "¿está conectada la cámara de la ET4?"
# es una pregunta de estado que las herramientas de siempre contestan
# perfecto. Solo cuenta como visual si además se pide MIRAR.
CAMERA_NOUNS = ("camara", "camaras", "webcam", "webcams")
LOOK_VERBS = (
    "mira", "mirar", "observa", "observar", "observas", "describe",
    "describir", "analiza", "analizar", "revisa", "revisar", "checa",
    "ve", "viendo", "se ve", "se mira", "aparece",
)

# Verbos de tarea. Tres o más en una misma petición es lo que distingue
# "revisa el taller, analiza los problemas y priorizalos" de una pregunta.
ACTION_VERBS = (
    "revisa", "revisar", "analiza", "analizar", "identifica", "identificar",
    "consulta", "consultar", "resume", "resumir", "prioriza", "priorizar",
    "dime", "dame", "muestra", "mostrar", "verifica", "verificar",
    "comprueba", "atender", "atiende", "recomienda", "compara",
)

MULTI_STEP_HINTS = ("prioriza", "priorizar", "priorizado", "prioridad", "primero", "paso a paso")
SCOPE_HINTS = ("todo", "toda", "todos", "todas", "completo", "completa", "general")

# Diagnóstico: algo salió mal y hay que explicar por qué.
DIAGNOSTIC_HINTS = (
    "por que", "porque", "causa", "causas", "causo", "motivo",
    "diagnostica", "diagnosticar", "diagnostico",
    "error", "errores", "fallo", "fallo", "falla", "fallas", "fallaron",
    "problema", "problemas", "detuvo", "detenida", "detenido", "parada",
    "desconecto", "desconexion", "perdio", "alarma", "alarmas",
    "analiza", "analizar", "investiga", "investigar", "revisar por que",
    "que ocurrio", "que paso", "que sucedio", "atasco", "atorada",
    "runaway", "timeout", "log", "logs", "traceback", "excepcion",
)

# Interpretación moderada: hay que cruzar o resumir varios datos, pero no
# hay nada roto que explicar.
MEDIUM_HINTS = (
    "compara", "comparar", "comparacion", "diferencia", "diferencias",
    "resume", "resumen", "resumir", "recomienda", "recomiendame",
    "recomendacion", "recomiendas", "sugiere", "sugerencia", "evalua",
    "cual conviene", "cual me conviene", "mejor opcion", "turno",
    "ultimas horas", "ultima hora", "historial", "tendencia", "cuales",
)

# Lo que el catálogo compacto NO cubre. Ese catálogo son seis herramientas:
# estado del taller, máquinas, estado de una máquina, errores, Klipper y
# plugins. Todo lo demás -- escenas, anuncios de la matriz, accesorios,
# cámaras, materiales, biblioteca, cola -- solo existe en el completo.
#
# Sin esta lista, "¿qué alertas por máquina hay?" se clasifica como consulta
# simple, va al nivel rápido con el catálogo compacto, y el modelo se queda
# sin ninguna herramienta que pueda contestarla: justo la situación en la que
# un LLM rellena el hueco inventando. Pasó en el taller con la Matriz LED.
#
# El modelo chico igual sirve para esto: lo que hay que ampliar es lo que
# puede consultar, no quién contesta.
NON_CORE_HINTS = (
    "escena", "escenas", "anuncio", "anuncios", "matriz", "pantalla",
    "led", "leds", "tira", "tiras", "rele", "reles", "relevador",
    "ventilador", "ventiladores", "accesorio", "accesorios",
    "alerta", "alertas", "regla", "reglas", "automatizacion", "automatizaciones",
    "camara", "camaras", "webcam", "filamento", "filamentos", "material",
    "materiales", "spool", "spools", "spoolman", "carrete", "carretes",
    "bobina", "bobinas", "inventario",
    "biblioteca", "archivo", "archivos", "modelo 3d", "gcode", "g-code",
    "cola", "encolar", "plugin", "plugins", "sensor", "sensores",
    "temperatura", "temperaturas", "grbl", "laser", "cnc", "avance", "progreso",
)

# Señal de que la respuesta cruza varias máquinas aunque no lo pida
# explícitamente ("las tres impresoras", "todas las maquinas").
MULTI_MACHINE_HINTS = (
    "todas las maquinas", "todas las impresoras", "las tres", "las dos",
    "cada maquina", "cada impresora", "todos los laser", "todas mis",
)


def classify(question: str, has_image: bool = False) -> tuple:
    """Devuelve (nivel, motivo) mirando solo el texto de la pregunta.

    El orden de las reglas ES la especificación: visión gana sobre todo,
    porque sin ver la imagen ningún otro nivel puede contestar; lo
    multietapa gana sobre diagnóstico, porque "revisa todo y analiza los
    problemas" también contiene palabras de diagnóstico y no queremos que
    se resuelva en una sola vuelta.
    """
    texto = _normalize(question)

    if has_image:
        return "vision", "image_attached"
    if _contiene(texto, IMAGE_NOUNS):
        return "vision", "visual_request"
    if _contiene(texto, CAMERA_NOUNS) and _contiene(texto, LOOK_VERBS):
        return "vision", "visual_request"

    verbos = sum(1 for v in ACTION_VERBS if _contiene(texto, (v,)))
    if verbos >= 3 or (_contiene(texto, MULTI_STEP_HINTS) and _contiene(texto, SCOPE_HINTS)):
        return "agent", "multi_step_request"

    palabra = _contiene(texto, DIAGNOSTIC_HINTS)
    if palabra:
        return "reasoning", "diagnostic_request"

    if _contiene(texto, MEDIUM_HINTS):
        return "medium", "comparison_or_summary"
    if _contiene(texto, MULTI_MACHINE_HINTS):
        return "medium", "multi_machine_context"

    return "fast", "simple_lookup"


def _model_size(model_id: str) -> Optional[float]:
    """Miles de millones de parámetros según el nombre ('qwen2.5:7b' -> 7).

    Es una pista, no un dato: sirve para ordenar de chico a grande los
    modelos de un servidor local, donde nadie puede saber de antemano qué
    bajó el usuario.
    """
    encontrados = _PARAM_SIZE_RE.findall(_normalize(model_id))
    return max(float(x) for x in encontrados) if encontrados else None


def suggest_tier_models(available: List[str]) -> Dict[str, str]:
    """Propone un modelo por nivel entre los que el servidor OFRECE.

    Nunca inventa: si el endpoint no reporta modelos (hay proveedores que
    no exponen /v1/models de forma utilizable) devuelve un diccionario
    vacío y el usuario los escribe a mano. Un nombre sugerido a ciegas
    fallaría recién en la primera pregunta, sin explicación visible.
    """
    disponibles = [str(m) for m in (available or []) if str(m).strip()]
    if not disponibles:
        return {}

    sugerencias: Dict[str, str] = {}
    for tier, candidatos in KNOWN_TIER_MODELS.items():
        elegido = next((c for c in candidatos if c in disponibles), None)
        if elegido:
            sugerencias[tier] = elegido

    # Servidor local: los nombres conocidos no aparecen, así que se ordena
    # por tamaño y se reparte el más chico a lo rápido y el más grande a lo
    # que requiere razonar.
    con_tamano = sorted(
        ((m, _model_size(m)) for m in disponibles if _model_size(m) is not None),
        key=lambda par: par[1],
    )
    if con_tamano:
        sugerencias.setdefault("fast", con_tamano[0][0])
        sugerencias.setdefault("medium", con_tamano[len(con_tamano) // 2][0])
        sugerencias.setdefault("reasoning", con_tamano[-1][0])
        sugerencias.setdefault("agent", con_tamano[-1][0])

    visual = next(
        (m for m in disponibles if any(h in _normalize(m) for h in _VISION_NAME_HINTS)), None)
    if visual:
        sugerencias.setdefault("vision", visual)

    return sugerencias


def _tier_model(tier: str, config: Dict[str, Any]) -> str:
    """Modelo configurado para un nivel, con el modelo único como respaldo.

    Que un nivel sin configurar caiga al modelo de siempre es lo que hace
    que activar el modo automático a medias no rompa nada.
    """
    tabla = config.get("tier_models") or {}
    valor = tabla.get(tier) if isinstance(tabla, dict) else None
    return str(valor).strip() if valor and str(valor).strip() else str(config.get("model") or "")


def route(question: str, config: Dict[str, Any], has_image: bool = False) -> Optional[Route]:
    """La ruta para esta pregunta, o None si el modo automático está apagado.

    None significa literalmente "que todo siga como antes": quien llama usa
    el modelo configurado y no cambia ningún otro parámetro.
    """
    if (config.get("model_mode") or "fixed") != "auto":
        return None

    tier, reason = classify(question, has_image)
    modelo = _tier_model(tier, config)

    # El perfil de herramientas del nivel solo puede recortar. Si el
    # usuario ya eligió el catálogo compacto para todo, el nivel de
    # razonamiento no se lo amplía por su cuenta.
    perfil_config = config.get("tool_profile") or "full"
    perfil = "compact" if perfil_config == "compact" else TIER_TOOL_PROFILE.get(tier, "full")
    # ...salvo que la pregunta sea sobre algo que el catálogo compacto no
    # incluye. Recortar herramientas ahorra tokens; recortar justo la que
    # hacía falta produce una respuesta inventada, que cuesta mucho más.
    if (perfil == "compact" and perfil_config != "compact"
            and _contiene(_normalize(question), NON_CORE_HINTS)):
        perfil = "full"

    vueltas = int(config.get("max_tool_iterations") or 4)
    if tier == "agent":
        vueltas = min(10, max(vueltas, AGENT_MIN_ITERATIONS))

    # Se descartan los repetidos: con varios niveles apuntando al mismo
    # modelo (o sin configurar), reintentar contra el mismo que acaba de
    # fallar solo gasta otra petición de la cuota.
    cadena: List[str] = []
    for siguiente in FALLBACK_CHAINS.get(tier, [tier]):
        candidato = _tier_model(siguiente, config)
        if candidato and candidato != modelo and candidato not in cadena:
            cadena.append(candidato)

    return Route(
        tier=tier,
        model=modelo,
        reason=reason,
        tool_profile=perfil,
        max_tool_iterations=vueltas,
        fallback_models=cadena,
    )
