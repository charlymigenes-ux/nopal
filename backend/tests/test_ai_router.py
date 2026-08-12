"""Elección local del modelo según la pregunta (ai_router).

Lo que se protege acá es sobre todo el ORDEN de las reglas: casi todas las
preguntas interesantes disparan varias a la vez ("revisa todo y analiza los
problemas" es multietapa Y diagnóstico), y cuál gana es la decisión de
diseño, no un detalle.
"""

import pytest

from backend.services import ai_agent, ai_config_service, ai_router
from backend.services.ai_provider import AIProviderError

# Tabla equivalente a la de una cuenta de Groq, escrita acá para que la
# prueba no dependa de la configuración real de la instalación.
TABLA = {
    "fast": "llama-3.1-8b-instant",
    "medium": "openai/gpt-oss-20b",
    "reasoning": "openai/gpt-oss-120b",
    "vision": "qwen/qwen3.6-27b",
    "agent": "openai/gpt-oss-120b",
}
CONFIG_AUTO = {"model": "modelo-configurado", "model_mode": "auto", "tier_models": TABLA}


@pytest.mark.parametrize(
    "pregunta, tier",
    [
        # --- las cinco pruebas mínimas del encargo ---
        ("¿Cómo está el taller?", "fast"),
        ("Compara las máquinas disponibles.", "medium"),
        ("¿Por qué se detuvo la CNC?", "reasoning"),
        ("Analiza la cámara.", "vision"),
        ("Revisa todo el taller, analiza los problemas y dime qué atender primero.", "agent"),
        # --- el resto de los ejemplos del encargo ---
        ("¿Qué temperatura tiene ET4?", "fast"),
        ("¿Cuánto falta para terminar?", "fast"),
        ("¿Qué máquinas están disponibles?", "fast"),
        ("Compara el estado de las tres impresoras.", "medium"),
        ("Resume todo lo ocurrido durante el turno.", "medium"),
        ("¿Por qué ET4 perdió conexión con Moonraker?", "reasoning"),
        ("Analiza estos errores de Klipper.", "reasoning"),
        ("Mira la cámara y dime si la pieza está bien.", "vision"),
        ("¿Qué observas en esta imagen?", "vision"),
    ],
)
def test_clasificacion(pregunta, tier):
    assert ai_router.classify(pregunta)[0] == tier


def test_sin_acentos_ni_mayusculas():
    """En el taller nadie escribe con tildes de forma consistente."""
    assert ai_router.classify("POR QUE SE DETUVO LA CNC")[0] == "reasoning"
    assert ai_router.classify("por que fallo")[0] == "reasoning"


def test_preguntar_por_la_camara_no_es_analisis_visual():
    """'¿Está conectada la cámara?' es una pregunta de estado que las
    herramientas de siempre contestan bien. Mandarla al camino visual la
    dejaría sin respuesta por nada."""
    assert ai_router.classify("¿Está conectada la cámara de la ET4?")[0] != "vision"
    assert ai_router.classify("¿Cuántas cámaras hay?")[0] != "vision"


def test_una_palabra_no_se_dispara_dentro_de_otra():
    """'falla' no debe encontrarse dentro de 'pantalla'."""
    assert ai_router.classify("¿Qué muestra la pantalla de la impresora?")[0] == "fast"


def test_lo_multietapa_gana_al_diagnostico():
    """Contiene 'analiza' y 'problemas', pero pedir cuatro cosas en una
    frase necesita varias vueltas de herramientas, no un diagnóstico de una
    sola pasada."""
    tier, motivo = ai_router.classify(
        "Revisa todas las máquinas, analiza los problemas y dime qué debo atender primero.")
    assert (tier, motivo) == ("agent", "multi_step_request")


def test_la_imagen_adjunta_gana_sobre_cualquier_texto():
    assert ai_router.classify("¿Por qué se detuvo?", has_image=True) == ("vision", "image_attached")


# --------------------------------------------------------------------------
# Resolución de modelos y respaldos
# --------------------------------------------------------------------------


def test_modo_fijo_no_devuelve_ruta():
    """Es la garantía de compatibilidad: sin modo automático, quien llama no
    recibe nada que pueda cambiar el comportamiento anterior."""
    assert ai_router.route("¿Por qué falló?", {"model": "x", "model_mode": "fixed"}) is None
    assert ai_router.route("¿Por qué falló?", {"model": "x"}) is None


def test_ruta_completa_de_diagnostico():
    ruta = ai_router.route("¿Por qué se detuvo la CNC?", CONFIG_AUTO)
    assert ruta.tier == "reasoning"
    assert ruta.model == "openai/gpt-oss-120b"
    assert ruta.reason == "diagnostic_request"
    assert ruta.fallback_models == ["openai/gpt-oss-20b", "llama-3.1-8b-instant"]


def test_el_nivel_rapido_recorta_el_catalogo_de_herramientas():
    """El esquema completo son ~1.500 tokens en cada llamada y el modelo
    chico es el que menos margen por minuto tiene."""
    assert ai_router.route("¿Cómo está el taller?", CONFIG_AUTO).tool_profile == "compact"
    assert ai_router.route("¿Por qué falló ET4?", CONFIG_AUTO).tool_profile == "full"


@pytest.mark.parametrize("pregunta", [
    "¿Qué alertas por máquina hay?",
    "¿Qué escenas hay?",
    "¿Qué anuncios tiene la matriz?",
    "¿Qué hay en la biblioteca?",
    "¿Cuánto filamento queda?",
    "¿Qué temperatura tiene ET4?",
])
def test_una_consulta_simple_sobre_plugins_conserva_el_catalogo_completo(pregunta):
    """El catálogo compacto son seis herramientas y no incluye escenas,
    anuncios, materiales ni biblioteca. Mandar ahí una pregunta sobre eso
    deja al modelo sin ninguna herramienta que la conteste: exactamente la
    situación en la que se inventa la respuesta. Pasó con la Matriz LED."""
    ruta = ai_router.route(pregunta, CONFIG_AUTO)
    assert ruta.tool_profile == "full", f"{pregunta!r} se quedaría sin herramienta"


def test_el_nivel_rapido_sigue_siendo_el_modelo_chico_aunque_lleve_todo_el_catalogo():
    """Ampliar lo que puede consultar no es lo mismo que escalar de modelo."""
    ruta = ai_router.route("¿Qué escenas hay?", CONFIG_AUTO)
    assert (ruta.tier, ruta.model) == ("fast", "llama-3.1-8b-instant")


def test_el_nivel_no_amplia_el_catalogo_que_el_usuario_recorto():
    """Si el usuario eligió el catálogo compacto para todo, el router no se
    lo amplía por su cuenta."""
    config = dict(CONFIG_AUTO, tool_profile="compact")
    assert ai_router.route("¿Por qué falló ET4?", config).tool_profile == "compact"


def test_lo_multietapa_pide_mas_vueltas():
    normal = ai_router.route("¿Cómo está el taller?", CONFIG_AUTO)
    multi = ai_router.route("Revisa todo, analiza los problemas y dame prioridades.", CONFIG_AUTO)
    assert multi.max_tool_iterations > normal.max_tool_iterations


def test_vision_no_tiene_respaldo():
    """Un modelo de texto 'describiendo' una foto que nunca vio inventaría
    lo que hay en la imagen."""
    assert ai_router.route("Analiza la foto.", CONFIG_AUTO).fallback_models == []


def test_un_nivel_sin_configurar_cae_al_modelo_de_siempre():
    """Configurar el modo automático a medias no puede dejar a NOPAL sin
    poder contestar."""
    ruta = ai_router.route("¿Cómo está el taller?", {
        "model": "modelo-unico", "model_mode": "auto", "tier_models": {"reasoning": "grande"}})
    assert ruta.model == "modelo-unico"


def test_no_se_reintenta_contra_el_mismo_modelo():
    """Con varios niveles apuntando al mismo modelo, reintentar contra el
    que acaba de fallar solo gasta otra petición de la cuota."""
    ruta = ai_router.route("¿Por qué falló?", {
        "model": "unico", "model_mode": "auto", "tier_models": {}})
    assert ruta.fallback_models == []


# --------------------------------------------------------------------------
# Sugerencia de modelos: sirve para cualquier proveedor, no solo Groq
# --------------------------------------------------------------------------


def test_sugerencias_solo_de_lo_que_el_servidor_ofrece():
    sugeridos = ai_router.suggest_tier_models(
        ["llama-3.1-8b-instant", "openai/gpt-oss-20b", "openai/gpt-oss-120b"])
    assert sugeridos["fast"] == "llama-3.1-8b-instant"
    assert sugeridos["reasoning"] == "openai/gpt-oss-120b"
    # No ofrecía ningún modelo visual y no se inventa uno.
    assert "vision" not in sugeridos


def test_sugerencias_para_un_servidor_local():
    """Ollama o LM Studio: los nombres no se pueden conocer de antemano, se
    ordenan por tamaño y se reparte el más chico a lo rápido."""
    sugeridos = ai_router.suggest_tier_models(["qwen2.5:14b", "llama3.2:3b", "llava:7b"])
    assert sugeridos["fast"] == "llama3.2:3b"
    assert sugeridos["reasoning"] == "qwen2.5:14b"
    assert sugeridos["vision"] == "llava:7b"


def test_sin_lista_de_modelos_no_se_sugiere_nada():
    assert ai_router.suggest_tier_models([]) == {}


# --------------------------------------------------------------------------
# Integración con el ciclo del agente
# --------------------------------------------------------------------------


class _ProveedorQueFalla:
    """Falla con los primeros N modelos y contesta con el siguiente."""

    def __init__(self, fallan):
        self.fallan = set(fallan)
        self.intentos = []

    async def chat(self, messages, tools=None, model=None):
        self.intentos.append(model)
        if model in self.fallan:
            raise AIProviderError(f"El servidor de IA respondió 429: sin cuota ({model})")
        return {"content": f"respondido por {model}", "tool_calls": []}

    async def test_connection(self):
        return {"ok": True}


@pytest.fixture
def ia_automatica(monkeypatch):
    """IA encendida, en modo automático, con la tabla de niveles puesta."""
    monkeypatch.setattr(ai_config_service, "get_config", lambda: {
        "enabled": True, "base_url": "http://ia.local/v1", "model": "modelo-configurado",
        "model_mode": "auto", "tier_models": TABLA, "tool_mode": "native",
        "tool_profile": "full", "max_tool_iterations": 4, "actions_enabled": False,
    })


async def test_el_fallback_reintenta_con_el_siguiente_modelo(ia_automatica, monkeypatch):
    proveedor = _ProveedorQueFalla(fallan={"openai/gpt-oss-120b"})
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)

    resultado = await ai_agent.ask("¿Por qué se detuvo la CNC?")

    assert proveedor.intentos == ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
    assert resultado["model"] == "openai/gpt-oss-20b"
    assert resultado["route"]["tier"] == "reasoning"
    assert resultado["route"]["fallback_used"] is True


async def test_si_falla_toda_la_cadena_sube_el_error_del_ultimo(ia_automatica, monkeypatch):
    """Y con él su `retry_after`, que es lo que alimenta el cronómetro."""
    proveedor = _ProveedorQueFalla(fallan=set(TABLA.values()))
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)

    with pytest.raises(AIProviderError):
        await ai_agent.ask("¿Por qué se detuvo la CNC?")
    assert len(proveedor.intentos) == 3


async def test_una_pregunta_simple_va_al_modelo_chico(ia_automatica, monkeypatch):
    proveedor = _ProveedorQueFalla(fallan=set())
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)

    resultado = await ai_agent.ask("¿Cómo está el taller?")

    assert proveedor.intentos == ["llama-3.1-8b-instant"]
    assert resultado["route"] == {
        "tier": "fast", "model": "llama-3.1-8b-instant", "reason": "simple_lookup",
        "tool_profile": "compact", "fallback_used": False,
    }


async def test_lo_visual_no_gasta_una_peticion(ia_automatica, monkeypatch):
    """NOPAL todavía no manda imágenes al modelo. Preguntarle igual haría
    que describiera una foto que nunca vio, y encima costaría cuota."""
    proveedor = _ProveedorQueFalla(fallan=set())
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)

    resultado = await ai_agent.ask("Mira la cámara y dime si la pieza se despegó.")

    assert proveedor.intentos == []
    assert "no está disponible" in resultado["answer"]
    assert resultado["route"]["tier"] == "vision"


async def test_no_se_reintenta_si_ya_se_ejecuto_una_accion_fisica(monkeypatch):
    """Reintentar rehace la pregunta COMPLETA, herramientas incluidas. Con
    una acción ya ejecutada eso encendería el accesorio dos veces, así que
    el error sube tal cual aunque quedaran modelos por probar."""
    from backend.services import ai_actions

    veces = {"ejecutada": 0}

    async def _handler(**kwargs):
        veces["ejecutada"] += 1
        return {"ok": True}

    monkeypatch.setattr(ai_actions.ACTIONS["set_accessory_power"], "handler", _handler)
    monkeypatch.setattr(ai_config_service, "get_config", lambda: {
        "enabled": True, "base_url": "http://ia.local/v1", "model": "modelo-configurado",
        "model_mode": "auto", "tier_models": TABLA, "tool_mode": "native",
        "tool_profile": "full", "max_tool_iterations": 4, "actions_enabled": True,
    })

    class _PrendeYLuegoFalla:
        """Con CADA modelo se comporta igual: primero pide prender el relé y
        recién después se queda sin cuota. Si el reintento existiera, la
        acción volvería a ejecutarse."""

        def __init__(self):
            self.intentos = []

        async def chat(self, messages, tools=None, model=None):
            primera_vez_con_este_modelo = model not in self.intentos
            self.intentos.append(model)
            if primera_vez_con_este_modelo:
                return {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "c1", "type": "function",
                    "function": {"name": "set_accessory_power",
                                 "arguments": '{"accessory_id": "rele1", "on": true}'}}]}
            raise AIProviderError("El servidor de IA respondió 429: sin cuota")

    proveedor = _PrendeYLuegoFalla()
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)

    with pytest.raises(AIProviderError):
        await ai_agent.ask("Revisa todo, prende el relé 1 y dime cómo quedó.",
                           role="admin", username="carlos")

    assert veces["ejecutada"] == 1, "la acción física se repitió al reintentar con otro modelo"


async def test_el_modo_fijo_no_manda_ningun_modelo_por_llamada(monkeypatch):
    """Compatibilidad: con el router apagado, el proveedor recibe model=None
    y usa el modelo configurado, exactamente como antes."""
    monkeypatch.setattr(ai_config_service, "get_config", lambda: {
        "enabled": True, "base_url": "http://ia.local/v1", "model": "modelo-configurado",
        "model_mode": "fixed", "tool_mode": "native", "tool_profile": "full",
        "max_tool_iterations": 4, "actions_enabled": False,
    })
    proveedor = _ProveedorQueFalla(fallan=set())
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)

    resultado = await ai_agent.ask("¿Por qué se detuvo la CNC?")

    assert proveedor.intentos == [None]
    assert resultado["model"] == "modelo-configurado"
    assert "route" not in resultado
