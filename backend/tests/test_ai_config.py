"""Configuración de NOPAL Intelligence: valores por omisión, validación,
bloqueo de endpoints públicos y manejo de la API key.

El aislamiento de CONFIG_PATH y de las variables NOPAL_AI_* lo hace la
fixture autouse `isolated_printer_registries` de conftest.py.
"""

import json

import pytest

from backend.services import ai_config_service
from backend.services.ai_config_service import AIConfigError


def test_defaults_dejan_la_ia_apagada():
    """Regla del proyecto: una instalación sin configurar nada tiene que
    comportarse exactamente como NOPAL antes de que existiera la capa."""
    config = ai_config_service.get_config()
    assert config["enabled"] is False
    assert config["base_url"] == ""
    assert ai_config_service.is_enabled() is False


def test_guardar_y_releer_configuracion_de_lan():
    ai_config_service.save_config({
        "enabled": True,
        "base_url": "http://192.168.0.30:8081/v1",
        "model": "qwen2.5-3b-instruct",
    })
    config = ai_config_service.get_config()
    assert config["enabled"] is True
    assert config["base_url"] == "http://192.168.0.30:8081/v1"
    assert config["model"] == "qwen2.5-3b-instruct"
    assert ai_config_service.is_enabled() is True


def test_la_barra_final_se_normaliza():
    """http://host:8081/v1/ y .../v1 tienen que quedar iguales -- si no, se
    arma //chat/completions al concatenar."""
    ai_config_service.save_config({"enabled": True, "base_url": "http://127.0.0.1:8081/v1/", "model": "m"})
    assert ai_config_service.get_config()["base_url"] == "http://127.0.0.1:8081/v1"


def test_endpoint_publico_se_rechaza_por_omision():
    with pytest.raises(AIConfigError, match="red local"):
        ai_config_service.validate_config({
            "enabled": True,
            "base_url": "https://1.1.1.1/v1",
            "model": "gpt-algo",
        })


def test_endpoint_publico_se_acepta_si_el_usuario_lo_habilita():
    """El bloqueo es un seguro contra escribir mal una IP, no una
    prohibición: un proveedor de nube sigue siendo una opción válida."""
    validated = ai_config_service.validate_config({
        "enabled": True,
        "base_url": "https://1.1.1.1/v1",
        "model": "gpt-algo",
        "allow_public_endpoint": True,
    })
    assert validated["base_url"] == "https://1.1.1.1/v1"


def test_url_sin_esquema_se_rechaza():
    with pytest.raises(AIConfigError, match="http"):
        ai_config_service.validate_config({"enabled": True, "base_url": "192.168.0.30:8081/v1", "model": "m"})


def test_se_puede_apagar_sin_url_valida():
    """El usuario tiene que poder desactivar la IA y guardar aunque la
    dirección haya quedado a medio escribir."""
    validated = ai_config_service.validate_config({"enabled": False, "base_url": "no-es-una-url"})
    assert validated["enabled"] is False


def test_tool_mode_invalido_se_rechaza():
    with pytest.raises(AIConfigError, match="Modo de herramientas"):
        ai_config_service.validate_config({"enabled": False, "tool_mode": "magia"})


def test_la_api_key_nunca_sale_en_la_config_publica():
    ai_config_service.save_config({
        "enabled": True,
        "base_url": "http://127.0.0.1:8081/v1",
        "model": "m",
        "api_key": "secreto-real",
    })
    public = ai_config_service.get_public_config()
    assert "api_key" not in public
    assert public["api_key_set"] is True
    assert "secreto-real" not in json.dumps(public)


def test_el_centinela_conserva_la_api_key_guardada():
    """El frontend nunca recibe la clave, así que manda el centinela para
    guardar el resto del formulario sin borrarla."""
    ai_config_service.save_config({
        "enabled": True, "base_url": "http://127.0.0.1:8081/v1", "model": "m", "api_key": "secreto-real",
    })
    ai_config_service.save_config({
        "enabled": True,
        "base_url": "http://127.0.0.1:8081/v1",
        "model": "otro-modelo",
        "api_key": ai_config_service.API_KEY_UNCHANGED,
    })
    config = ai_config_service.get_config()
    assert config["api_key"] == "secreto-real"
    assert config["model"] == "otro-modelo"


def test_las_variables_de_entorno_pisan_al_archivo(monkeypatch):
    ai_config_service.save_config({"enabled": False, "base_url": "http://127.0.0.1:8081/v1"})
    monkeypatch.setenv("NOPAL_AI_ENABLED", "true")
    monkeypatch.setenv("NOPAL_AI_MODEL", "modelo-del-entorno")
    config = ai_config_service.get_config()
    assert config["enabled"] is True
    assert config["model"] == "modelo-del-entorno"
    # Se reportan las claves de configuración (no los nombres de las
    # variables) porque es lo que la UI necesita para marcar como no
    # editable el campo correcto del formulario.
    assert ai_config_service.get_public_config()["env_locked_fields"] == ["enabled", "model"]


def test_archivo_corrupto_no_rompe_el_arranque(tmp_path, monkeypatch):
    """Mismo criterio que el resto de los registros JSON de NOPAL."""
    bad = tmp_path / "roto.json"
    bad.write_text("{esto no es json", encoding="utf-8")
    monkeypatch.setattr(ai_config_service, "CONFIG_PATH", str(bad))
    assert ai_config_service.get_config()["enabled"] is False


# --------------------------------------------------------------------------
# Catálogo de proveedores (local vs. nube)
# --------------------------------------------------------------------------

def test_el_catalogo_ofrece_local_y_nube():
    presets = ai_config_service.get_provider_presets()
    ids = {p["id"] for p in presets}
    assert "local" in ids and "custom" in ids
    assert any(p["cloud"] for p in presets), "debe haber opciones en la nube"
    assert any(not p["cloud"] for p in presets), "lo local no puede desaparecer"


def test_todo_preset_de_nube_declara_que_pide_clave_y_lleva_url():
    for preset in ai_config_service.get_provider_presets():
        if preset["cloud"]:
            assert preset["base_url"].startswith("https://"), preset["id"]
            assert preset["api_key_required"] is True, preset["id"]


def test_los_presets_locales_no_traen_url_precargada():
    """No hay IP ni puerto que NOPAL pueda adivinar para todas las
    instalaciones, así que se dejan en blanco. Ollama es la excepción
    justificada: su puerto es fijo por convención."""
    for preset in ai_config_service.get_provider_presets():
        if not preset["cloud"] and preset["id"] != "ollama":
            assert preset["base_url"] == "", preset["id"]


def test_ollama_apunta_a_localhost_y_no_cuenta_como_nube():
    """Precargar 127.0.0.1 no debe abrir la puerta a endpoints públicos."""
    ollama = next(p for p in ai_config_service.get_provider_presets() if p["id"] == "ollama")
    assert ollama["cloud"] is False
    assert ollama["api_key_required"] is False
    validado = ai_config_service.validate_config({
        "enabled": True, "base_url": ollama["base_url"], "model": "llama3.1:8b",
    })
    assert validado["base_url"] == "http://127.0.0.1:11434/v1"


def test_elegir_nube_sigue_exigiendo_consentimiento_explicito():
    """El preset rellena la dirección, pero NO baja la guardia: mandar
    telemetría del taller afuera sigue siendo una decisión consciente."""
    nube = next(p for p in ai_config_service.get_provider_presets() if p["cloud"])
    with pytest.raises(AIConfigError, match="red local"):
        ai_config_service.validate_config({
            "enabled": True, "base_url": nube["base_url"], "model": "algo", "api_key": "k",
        })
    validado = ai_config_service.validate_config({
        "enabled": True, "base_url": nube["base_url"], "model": "algo", "api_key": "k",
        "allow_public_endpoint": True,
    })
    assert validado["base_url"] == nube["base_url"]


def test_el_catalogo_es_una_copia():
    """Quien lo consuma no debe poder mutar el catálogo del módulo."""
    ai_config_service.get_provider_presets()[0]["base_url"] = "http://pirata/v1"
    assert ai_config_service.get_provider_presets()[0]["base_url"] == ""


# --------------------------------------------------------------------------
# Probar conexión: respaldo cuando /v1/models no sirve
# --------------------------------------------------------------------------

async def test_probar_conexion_cae_a_chat_si_models_falla(monkeypatch):
    """Anthropic atiende /v1/chat/completions por su capa de compatibilidad
    pero enruta /v1/models por otra vía de autenticación. Sin respaldo,
    'Probar conexión' diría que falla donde preguntar sí funciona."""
    import backend.services.ai_provider as ai_provider

    llamadas = []

    class _Respuesta:
        def __init__(self, status): self.status_code = status; self.text = "nope"
        def json(self): return {"error": {"message": "Invalid bearer token"}}

    class _RespuestaOk:
        status_code = 200
        text = ""
        def json(self): return {"choices": [{"message": {"content": "ok"}}]}

    class _Cliente:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            llamadas.append(("GET", url))
            return _Respuesta(401)
        async def post(self, url, headers=None, json=None):
            llamadas.append(("POST", url))
            return _RespuestaOk()

    monkeypatch.setattr(ai_provider, "_load_httpx", lambda: type("m", (), {"AsyncClient": _Cliente}))

    proveedor = ai_provider.OpenAICompatibleProvider({
        "base_url": "https://api.anthropic.com/v1", "model": "claude-opus-5", "api_key": "k",
    })
    resultado = await proveedor.test_connection()

    assert resultado["ok"] is True
    assert [m for m, _ in llamadas] == ["GET", "POST"], "debe intentar /models y luego caer a chat"
    assert llamadas[1][1].endswith("/chat/completions")


async def test_probar_conexion_falla_si_ambos_fallan(monkeypatch):
    import backend.services.ai_provider as ai_provider

    class _Respuesta:
        status_code = 401
        text = "no"
        def json(self): return {"error": {"message": "clave inválida"}}

    class _Cliente:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None): return _Respuesta()
        async def post(self, url, headers=None, json=None): return _Respuesta()

    monkeypatch.setattr(ai_provider, "_load_httpx", lambda: type("m", (), {"AsyncClient": _Cliente}))

    proveedor = ai_provider.OpenAICompatibleProvider({
        "base_url": "https://api.anthropic.com/v1", "model": "m", "api_key": "mala",
    })
    resultado = await proveedor.test_connection()
    assert resultado["ok"] is False
    assert "clave inválida" in resultado["error"]


# --------------------------------------------------------------------------
# Registro de IAs guardadas (CRUD)
# --------------------------------------------------------------------------

LAN = {"name": "El i7 del taller", "base_url": "http://192.168.0.70:8081/v1", "model": "qwen"}
OTRA = {"name": "Ollama", "base_url": "http://127.0.0.1:11434/v1", "model": "llama3.1:8b"}


def test_el_registro_empieza_vacio():
    listado = ai_config_service.list_providers()
    assert listado["providers"] == []
    assert listado["active_id"] is None


def test_la_primera_ia_agregada_queda_activa():
    creada = ai_config_service.create_provider(LAN)
    assert creada["active"] is True
    assert ai_config_service.list_providers()["active_id"] == creada["id"]


def test_la_segunda_no_desplaza_a_la_activa():
    primera = ai_config_service.create_provider(LAN)
    ai_config_service.create_provider(OTRA)
    assert ai_config_service.list_providers()["active_id"] == primera["id"]


def test_activar_cambia_la_config_efectiva():
    """El punto del registro: get_config() debe seguir devolviendo la forma
    plana de siempre, pero apuntando a la IA que el usuario eligió."""
    ai_config_service.create_provider(LAN)
    segunda = ai_config_service.create_provider(OTRA)
    ai_config_service.set_active_provider(segunda["id"])
    assert ai_config_service.get_config()["base_url"] == OTRA["base_url"]
    assert ai_config_service.get_config()["model"] == "llama3.1:8b"


def test_editar_una_ia_conserva_su_clave():
    creada = ai_config_service.create_provider({**LAN, "api_key": "secreto"})
    ai_config_service.update_provider(creada["id"], {"model": "otro-modelo"})
    guardadas = ai_config_service._read_store()["providers"]
    assert guardadas[0]["api_key"] == "secreto"
    assert guardadas[0]["model"] == "otro-modelo"


def test_la_clave_nunca_sale_en_el_listado():
    ai_config_service.create_provider({**LAN, "api_key": "secreto"})
    listado = ai_config_service.list_providers()
    assert "api_key" not in listado["providers"][0]
    assert listado["providers"][0]["api_key_set"] is True
    assert "secreto" not in json.dumps(listado)


def test_borrar_la_activa_pasa_la_activacion_a_la_siguiente():
    primera = ai_config_service.create_provider(LAN)
    segunda = ai_config_service.create_provider(OTRA)
    ai_config_service.delete_provider(primera["id"])
    assert ai_config_service.list_providers()["active_id"] == segunda["id"]


def test_borrar_la_ultima_apaga_la_capa():
    """Quedar encendido apuntando a la nada sería peor que apagarse."""
    creada = ai_config_service.create_provider(LAN)
    ai_config_service.set_enabled(True)
    ai_config_service.delete_provider(creada["id"])
    listado = ai_config_service.list_providers()
    assert listado["providers"] == []
    assert listado["enabled"] is False
    assert ai_config_service.is_enabled() is False


def test_no_se_puede_encender_sin_ninguna_ia():
    with pytest.raises(AIConfigError, match="agrega una IA"):
        ai_config_service.set_enabled(True)


def test_operar_sobre_una_ia_inexistente():
    for accion in (lambda: ai_config_service.update_provider("nope", {}),
                   lambda: ai_config_service.delete_provider("nope"),
                   lambda: ai_config_service.set_active_provider("nope")):
        with pytest.raises(AIConfigError, match="no existe"):
            accion()


def test_se_le_pone_nombre_solo_si_no_lo_traes():
    creada = ai_config_service.create_provider({"base_url": "https://api.anthropic.com/v1",
                                                "model": "claude-haiku-4-5", "api_key": "k",
                                                "allow_public_endpoint": True})
    assert "Anthropic" in creada["name"], creada["name"]


def test_migra_el_formato_plano_anterior(tmp_path, monkeypatch):
    """Una instalación que ya tenía su única IA configurada no puede perderla
    al actualizar."""
    viejo = tmp_path / "ai_config.json"
    viejo.write_text(json.dumps({
        "enabled": True, "provider": "openai-compatible",
        "base_url": "https://api.deepseek.com/v1", "model": "deepseek-v4-flash",
        "api_key": "clave-vieja", "allow_public_endpoint": True,
    }), encoding="utf-8")
    monkeypatch.setattr(ai_config_service, "CONFIG_PATH", str(viejo))

    listado = ai_config_service.list_providers()
    assert len(listado["providers"]) == 1
    assert listado["enabled"] is True
    assert listado["providers"][0]["base_url"] == "https://api.deepseek.com/v1"
    # Y la clave sobrevive la migración aunque no se muestre
    assert ai_config_service.get_config()["api_key"] == "clave-vieja"


def test_tope_de_ias_guardadas():
    for i in range(ai_config_service.MAX_PROVIDERS):
        ai_config_service.create_provider({**LAN, "name": f"IA {i}"})
    with pytest.raises(AIConfigError, match="más de"):
        ai_config_service.create_provider(LAN)


# --------------------------------------------------------------------------
# Preguntas rápidas
# --------------------------------------------------------------------------

def test_sin_guardar_nada_la_lista_va_vacia():
    """Vacío significa 'usa las de fábrica': el frontend las traduce, así que
    siguen cambiando de idioma. Guardar strings fijos las congelaría."""
    assert ai_config_service.get_suggestions() == []


def test_guardar_y_releer_preguntas():
    guardadas = ai_config_service.save_suggestions(["¿Cómo está el taller?", "¿Qué relés hay encendidos?"])
    assert guardadas == ["¿Cómo está el taller?", "¿Qué relés hay encendidos?"]
    assert ai_config_service.get_suggestions() == guardadas


def test_se_limpian_vacias_y_duplicadas():
    guardadas = ai_config_service.save_suggestions(["  Una  ", "", "   ", "Una", "Otra"])
    assert guardadas == ["Una", "Otra"]


def test_tope_y_longitud():
    with pytest.raises(AIConfigError, match="más de"):
        ai_config_service.save_suggestions([f"Pregunta {i}" for i in range(ai_config_service.MAX_SUGGESTIONS + 1)])
    with pytest.raises(AIConfigError, match="caracteres"):
        ai_config_service.save_suggestions(["x" * (ai_config_service.MAX_SUGGESTION_LENGTH + 1)])
    with pytest.raises(AIConfigError, match="lista"):
        ai_config_service.save_suggestions("no soy una lista")


def test_guardar_una_ia_no_borra_las_preguntas():
    """El registro y las preguntas viven en el mismo archivo; escribir uno no
    puede pisar al otro."""
    ai_config_service.save_suggestions(["Mi pregunta"])
    ai_config_service.create_provider({"name": "X", "base_url": "http://127.0.0.1:8081/v1", "model": "m"})
    assert ai_config_service.get_suggestions() == ["Mi pregunta"]


def test_guardar_preguntas_no_borra_las_ias():
    creada = ai_config_service.create_provider({"name": "X", "base_url": "http://127.0.0.1:8081/v1", "model": "m"})
    ai_config_service.save_suggestions(["Mi pregunta"])
    listado = ai_config_service.list_providers()
    assert len(listado["providers"]) == 1
    assert listado["active_id"] == creada["id"]


def test_un_campo_nulo_de_una_version_anterior_no_pisa_el_valor_por_omision():
    """Una entrada escrita antes de que existiera un campo puede traerlo en
    null. Un null pisando el default deja la configuración en un estado que
    no es ni true ni false -- fue exactamente lo que pasó con
    actions_enabled al agregarlo."""
    import json
    creada = ai_config_service.create_provider({
        "name": "Vieja", "base_url": "http://127.0.0.1:8081/v1", "model": "m"})

    # Se simula el archivo escrito por la versión anterior
    with open(ai_config_service.CONFIG_PATH, encoding="utf-8") as f:
        crudo = json.load(f)
    crudo["providers"][0]["actions_enabled"] = None
    with open(ai_config_service.CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(crudo, f)

    assert ai_config_service.get_config()["actions_enabled"] is False
