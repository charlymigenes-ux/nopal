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
