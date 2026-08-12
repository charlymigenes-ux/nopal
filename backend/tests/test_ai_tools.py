"""Herramientas de solo lectura y ciclo del agente de NOPAL Intelligence.

Lo que más importa acá no es que el modelo redacte bonito, sino que:
  - ninguna herramienta pueda mover hardware,
  - una máquina inexistente devuelva un error estructurado en vez de
    dejar que el modelo invente,
  - la IA apagada deje a NOPAL respondiendo con normalidad.
"""

import pytest

from backend.services import ai_agent, ai_config_service, ai_tools

MAQUINAS = [
    {"id": "klipper:7125", "name": "Voron 2.4", "kind": "printer", "brand": "klipper",
     "online": True, "state": "ready", "job": None, "details": {}},
    {"id": "laser:192.168.0.61", "name": "TTS 55 PRO", "kind": "laser", "brand": "fluidnc",
     "online": False, "state": None, "job": None, "details": {}},
]

_RESUMEN = {
    "system": {"health": "ok", "services_online": 1, "services_total": 2},
    "host": {"cpu_percent": 12.0, "cpu_history": [1, 2, 3]},
    "devices": {"printer": {"online": 1, "total": 1}, "laser": {"online": 0, "total": 1}},
    "jobs": {"active": [], "total_active": 0},
    "alerts": {"error": 0, "warning": 0, "info": 0, "total": 0},
    "power": {"active_watts": 0, "estimated": True},
    "ambient": None,
    "maintenance": None,
}


@pytest.fixture(autouse=True)
def sin_hardware_real(monkeypatch):
    """Corta el acceso a servicios reales desde los tests de IA.

    Sin esto, llamar una herramienta de verdad consulta el Moonraker local,
    sondea la LAN buscando láseres y deja poblada la caché de
    descubrimiento de klipper_service -- que además se filtraba a los tests
    de otros módulos, porque estos archivos corren primero por orden
    alfabético.
    """
    async def _machines():
        return [dict(machine) for machine in MAQUINAS]

    async def _summary():
        return dict(_RESUMEN)

    async def _notifications():
        return {"count": 0, "items": []}

    monkeypatch.setattr(ai_tools, "_collect_machines", _machines)
    monkeypatch.setattr(ai_tools, "get_dashboard_summary", _summary)
    monkeypatch.setattr(ai_tools, "get_notifications", _notifications)


# --------------------------------------------------------------------------
# Contrato de seguridad del catálogo
# --------------------------------------------------------------------------

# Verbos de acción física. Si alguien agrega una herramienta que empiece
# así, este test falla a propósito: las acciones sobre hardware van en un
# registro aparte, con confirmación del usuario, nunca acá.
VERBOS_PROHIBIDOS = (
    "set_", "start_", "stop_", "cancel_", "pause_", "resume_", "home_",
    "move_", "heat_", "run_", "send_", "delete_", "write_", "restart_",
    "reset_", "upload_", "emergency_",
)


def test_ninguna_herramienta_expuesta_puede_actuar_sobre_el_hardware():
    for tool in ai_tools.get_exposed_tools():
        assert tool.name.startswith("get_"), f"'{tool.name}' no es una herramienta de lectura"
        assert not tool.name.startswith(VERBOS_PROHIBIDOS), f"'{tool.name}' parece una acción física"


def test_el_snapshot_de_camara_no_se_le_ofrece_al_modelo():
    """Queda registrado para el futuro multimodal, pero fuera del esquema
    hasta que exista una implementación real."""
    assert "get_camera_snapshot" in ai_tools.TOOLS
    assert ai_tools.TOOLS["get_camera_snapshot"].exposed is False
    assert "get_camera_snapshot" not in [t["function"]["name"] for t in ai_tools.get_tools_schema()]


def test_el_esquema_tiene_la_forma_que_espera_la_api_estilo_openai():
    schema = ai_tools.get_tools_schema()
    assert schema
    for entry in schema:
        assert entry["type"] == "function"
        function = entry["function"]
        assert function["name"] and function["description"]
        assert function["parameters"]["type"] == "object"


async def test_una_herramienta_desconocida_no_levanta_excepcion():
    """El ciclo del agente le pasa este error al modelo para que se corrija
    solo en la vuelta siguiente."""
    result = await ai_tools.call_tool("borrar_todo")
    assert result["error"] == "unknown_tool"
    assert "get_workshop_status" in result["available"]


async def test_faltan_argumentos_obligatorios():
    result = await ai_tools.call_tool("get_machine_status", {})
    assert result["error"] == "missing_arguments"
    assert "machine_id" in result["missing"]


async def test_los_argumentos_de_mas_se_descartan():
    """Un modelo alucinando un parámetro extra no debe llegar al servicio."""
    result = await ai_tools.call_tool("get_machine_status", {"machine_id": "no-existe", "rm": "-rf /"})
    assert result["error"] == "machine_not_found"


async def test_maquina_inexistente_devuelve_las_que_si_existen():
    result = await ai_tools.call_tool("get_machine_status", {"machine_id": "ET4-QUE-NO-EXISTE"})
    assert result["error"] == "machine_not_found"
    assert "known_machines" in result


# --------------------------------------------------------------------------
# Resolución de máquinas
# --------------------------------------------------------------------------

@pytest.mark.parametrize("consulta,esperado", [
    ("klipper:7125", "klipper:7125"),      # id compuesto
    ("Voron 2.4", "klipper:7125"),         # nombre visible
    ("voron 2.4", "klipper:7125"),         # sin distinguir mayúsculas
    ("7125", "klipper:7125"),              # id nativo suelto
    ("192.168.0.61", "laser:192.168.0.61"),
    ("TTS 55 PRO", "laser:192.168.0.61"),
])
def test_resolucion_de_maquina(consulta, esperado):
    """El usuario pregunta por "ET4-WE", no por "elegoo:0a1b2c"."""
    assert ai_tools._resolve_machine(MAQUINAS, consulta)["id"] == esperado


@pytest.mark.parametrize("consulta", ["", "   ", "no-existe", "klipper:9999"])
def test_resolucion_fallida(consulta):
    assert ai_tools._resolve_machine(MAQUINAS, consulta) is None


# --------------------------------------------------------------------------
# Lectura de eventos del log
# --------------------------------------------------------------------------

def test_lectura_de_eventos_del_log(tmp_path, monkeypatch):
    log = tmp_path / "nopal.log"
    log.write_text(
        "2026-08-11 10:00:00 INFO     [backend.main] NOPAL iniciado\n"
        "linea basura que no matchea el formato\n"
        "2026-08-11 10:00:05 ERROR    [backend.services.klipper_service] mcu 'mcu': Unable to connect\n"
        "2026-08-11 10:00:09 WARNING  [backend.services.laser_service] TTS 55 PRO sin responder\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(ai_tools, "LOG_FILE", str(log))

    todos = ai_tools._read_recent_events(30, None)
    assert len(todos) == 3  # la línea basura se ignora
    assert todos[0]["message"] == "NOPAL iniciado"          # orden cronológico
    assert todos[-1]["level"] == "WARNING"

    solo_errores = ai_tools._read_recent_events(30, "ERROR")
    assert len(solo_errores) == 1
    assert "Unable to connect" in solo_errores[0]["message"]

    assert len(ai_tools._read_recent_events(2, None)) == 2   # se respeta el tope


def test_log_inexistente_no_rompe(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_tools, "LOG_FILE", str(tmp_path / "no-existe.log"))
    assert ai_tools._read_recent_events(10, None) == []


# --------------------------------------------------------------------------
# Agente
# --------------------------------------------------------------------------

async def test_preguntar_con_la_ia_apagada_da_un_error_claro():
    """Compatibilidad con instalaciones sin IA: nunca un 500."""
    with pytest.raises(ai_agent.AIDisabledError):
        await ai_agent.ask("¿Cómo está el taller?")


async def test_pregunta_vacia():
    with pytest.raises(ValueError):
        await ai_agent.ask("   ")


async def test_el_prompt_de_sistema_prohibe_inventar_y_actuar():
    prompt = ai_agent.SYSTEM_PROMPT
    assert "NUNCA inventes" in prompt
    assert "solo lectura" in prompt
    assert "láser" in prompt.lower()


class _ProveedorFalso:
    """Servidor de IA simulado. Devuelve los mensajes que se le den, en
    orden, y guarda lo que recibió."""

    def __init__(self, respuestas):
        self.respuestas = list(respuestas)
        self.pedidos = []

    async def chat(self, messages, tools=None, model=None):
        self.pedidos.append({"messages": list(messages), "tools": tools})
        return self.respuestas.pop(0)

    async def test_connection(self):
        return {"ok": True}


async def test_el_ciclo_nativo_ejecuta_la_herramienta_y_responde(monkeypatch):
    """El caso funcional: pregunta -> el modelo pide get_workshop_status ->
    NOPAL la ejecuta -> el modelo redacta con esos datos."""
    proveedor = _ProveedorFalso([
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "get_workshop_status", "arguments": "{}"},
            }],
        },
        {"role": "assistant", "content": "No hay máquinas trabajando y no hay alarmas activas."},
    ])
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)
    ai_config_service.save_config({
        "enabled": True, "base_url": "http://127.0.0.1:8081/v1", "model": "prueba", "tool_mode": "native",
    })

    resultado = await ai_agent.ask("¿Cómo está el taller?")

    assert resultado["mode"] == "native"
    assert resultado["answer"].startswith("No hay máquinas")
    assert [c["tool"] for c in resultado["tool_calls"]] == ["get_workshop_status"]
    # La respuesta trae la traza para que el usuario pueda verificar el dato.
    assert resultado["tool_calls"][0]["ok"] is True
    # El resultado real de la herramienta se le devolvió al modelo.
    assert any(m.get("role") == "tool" for m in proveedor.pedidos[1]["messages"])


async def test_auto_cae_a_modo_contexto_si_el_modelo_no_sabe_tool_calling(monkeypatch):
    """Un modelo de 1B sin function calling igual tiene que poder
    responder con datos reales."""
    from backend.services.ai_provider import ToolsUnsupportedError

    class _SinHerramientas(_ProveedorFalso):
        async def chat(self, messages, tools=None, model=None):
            if tools:
                raise ToolsUnsupportedError("este modelo no soporta tools")
            return await super().chat(messages, tools=None)

    proveedor = _SinHerramientas([{"role": "assistant", "content": "El taller está tranquilo."}])
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)
    ai_config_service.save_config({
        "enabled": True, "base_url": "http://127.0.0.1:8081/v1", "model": "chico", "tool_mode": "auto",
    })

    resultado = await ai_agent.ask("¿Cómo está el taller?")

    assert resultado["mode"] == "context"
    assert resultado["fell_back"] is True
    # Los datos siguen siendo reales: NOPAL los precargó antes de preguntar.
    assert {c["tool"] for c in resultado["tool_calls"]} == set(ai_agent.CONTEXT_MODE_TOOLS)
    assert "datos actuales del taller" in proveedor.pedidos[0]["messages"][1]["content"]


async def test_el_ciclo_se_corta_al_llegar_al_tope_de_vueltas(monkeypatch):
    """Un modelo que pide herramientas para siempre no debe colgar a NOPAL."""
    pide_herramienta = {
        "role": "assistant",
        "content": None,
        "tool_calls": [{"id": "c", "type": "function",
                        "function": {"name": "get_machines", "arguments": "{}"}}],
    }
    proveedor = _ProveedorFalso([pide_herramienta] * 2 + [{"role": "assistant", "content": "Listo."}])
    monkeypatch.setattr(ai_agent, "get_provider", lambda config: proveedor)
    ai_config_service.save_config({
        "enabled": True, "base_url": "http://127.0.0.1:8081/v1", "model": "terco",
        "tool_mode": "native", "max_tool_iterations": 2,
    })

    resultado = await ai_agent.ask("¿Qué máquinas hay?")

    assert resultado["truncated"] is True
    assert len(resultado["tool_calls"]) == 2
    # La última llamada es la de cierre, sin herramientas ofrecidas.
    assert proveedor.pedidos[-1]["tools"] is None


# --------------------------------------------------------------------------
# Perfil compacto de herramientas
# --------------------------------------------------------------------------

def test_el_perfil_compacto_recorta_el_catalogo():
    """El esquema completo son ~1260 tokens que el modelo lee antes de
    razonar; en un servidor de IA modesto eso domina la latencia."""
    completo = ai_tools.get_exposed_tools("full")
    compacto = ai_tools.get_exposed_tools("compact")
    assert 0 < len(compacto) < len(completo)
    assert all(tool.core for tool in compacto)


def test_el_perfil_compacto_conserva_lo_esencial():
    """Sin estas no se pueden responder las preguntas frecuentes del taller
    ni diagnosticar una impresora detenida.

    `get_plugins` entra al núcleo aunque el perfil compacto exista para
    ahorrar tokens: cuesta poco y sin ella el modelo no sabe siquiera que
    NOPAL es extensible, así que niega capacidades que un plugin instalado
    ya resuelve.
    """
    nombres = {tool.name for tool in ai_tools.get_exposed_tools("compact")}
    assert nombres == {
        "get_workshop_status", "get_machines", "get_machine_status",
        "get_recent_errors", "get_klipper_status", "get_plugins",
    }


def test_el_esquema_compacto_pesa_bastante_menos():
    import json
    completo = len(json.dumps(ai_tools.get_tools_schema("full"), ensure_ascii=False))
    compacto = len(json.dumps(ai_tools.get_tools_schema("compact"), ensure_ascii=False))
    assert compacto < completo * 0.6


def test_una_herramienta_fuera_del_perfil_sigue_siendo_ejecutable():
    """El perfil solo decide QUÉ SE LE OFRECE al modelo. Si igual pide una
    herramienta de lectura válida, no hay razón para negarla."""
    assert ai_tools.TOOLS["get_recent_events"].core is False
    assert "get_recent_events" not in {t.name for t in ai_tools.get_exposed_tools("compact")}


def test_el_prompt_compacto_conserva_las_reglas_que_no_se_negocian():
    corto = ai_agent.COMPACT_SYSTEM_PROMPT
    assert len(corto) < len(ai_agent.SYSTEM_PROMPT)
    assert "NUNCA inventes" in corto
    assert "solo lectura" in corto
    assert "láser" in corto.lower()


def test_el_agente_elige_el_prompt_segun_el_perfil():
    assert ai_agent._system_prompt("compact") is ai_agent.COMPACT_SYSTEM_PROMPT
    assert ai_agent._system_prompt("full") is ai_agent.SYSTEM_PROMPT


# --------------------------------------------------------------------------
# Integración con plugins
# --------------------------------------------------------------------------

async def test_la_ia_sabe_que_existen_los_plugins():
    """Sin esto el modelo niega capacidades que un plugin instalado ya
    resuelve, porque ni siquiera sabe que NOPAL es extensible."""
    resultado = await ai_tools.call_tool("get_plugins")
    assert "plugins" in resultado and "count" in resultado


async def test_accesorios_sin_el_plugin_no_rompe(monkeypatch):
    monkeypatch.setattr(ai_tools, "get_loaded_plugin_module", lambda *a: None)
    resultado = await ai_tools.call_tool("get_accessories")
    assert resultado["available"] is False
    assert "Automatización" in resultado["reason"]


async def test_accesorios_distingue_apagado_de_incomunicado(monkeypatch):
    """`on: null` significa que el accesorio no contestó. Reportarlo como
    apagado sería un dato inventado."""
    class _Modulo:
        @staticmethod
        async def get_accessories_status():
            return [
                {"id": "a", "name": "Relé 1", "driver": "arduino", "on": True},
                {"id": "b", "name": "Aro LED", "driver": "arduino", "on": None},
            ]
    monkeypatch.setattr(ai_tools, "get_loaded_plugin_module", lambda *a: _Modulo)

    resultado = await ai_tools.call_tool("get_accessories")
    encendido, mudo = resultado["accessories"]
    assert encendido["on"] is True and encendido["responding"] is True
    assert mudo["on"] is None and mudo["responding"] is False


async def test_camaras_no_devuelven_imagen(monkeypatch):
    """La lista de cámaras es metadato; la imagen sigue reservada para
    get_camera_snapshot y su modelo multimodal futuro."""
    class _Modulo:
        @staticmethod
        def get_cameras():
            return [{"id": "c1", "name": "Taller 1", "bound_device": "klipper:7125",
                     "stream_url": "http://x/stream", "source_url": "rtsp://secreto"}]
    monkeypatch.setattr(ai_tools, "get_loaded_plugin_module", lambda *a: _Modulo)

    resultado = await ai_tools.call_tool("get_cameras")
    camara = resultado["cameras"][0]
    assert camara["bound_device"] == "klipper:7125"
    assert "stream_url" not in camara and "source_url" not in camara


def test_un_plugin_puede_declarar_sus_propias_herramientas(monkeypatch):
    """El punto de extensión: un plugin expone sus datos a la IA sin que el
    core tenga que conocerlo."""
    async def _handler():
        return {"ok": True}
    propia = ai_tools.Tool("get_algo_del_plugin", "Una herramienta de plugin", _handler)
    monkeypatch.setattr("backend.services.plugin_loader_service.get_plugin_ai_tools", lambda: [propia])

    nombres = {t.name for t in ai_tools.get_exposed_tools("full")}
    assert "get_algo_del_plugin" in nombres
    # Y en compacto no, porque las de plugins son justo lo que sobra cuando
    # el servidor de IA es lento.
    assert "get_algo_del_plugin" not in {t.name for t in ai_tools.get_exposed_tools("compact")}


async def test_un_plugin_no_puede_suplantar_una_herramienta_del_core(monkeypatch):
    async def _impostora():
        return {"inventado": True}
    monkeypatch.setattr("backend.services.plugin_loader_service.get_plugin_ai_tools",
                        lambda: [ai_tools.Tool("get_workshop_status", "impostora", _impostora)])
    resultado = await ai_tools.call_tool("get_workshop_status")
    assert "inventado" not in resultado


def test_un_plugin_que_declara_basura_no_tumba_la_capa(monkeypatch):
    monkeypatch.setattr("backend.services.plugin_loader_service.get_plugin_ai_tools",
                        lambda: ["esto no es un Tool", None, 42])
    assert ai_tools.get_exposed_tools("full")  # sigue devolviendo las del core


# --------------------------------------------------------------------------
# Biblioteca y cola
# --------------------------------------------------------------------------

def _biblioteca(tmp_path, monkeypatch, archivos):
    raiz = tmp_path / "gcode"
    raiz.mkdir()
    for nombre in archivos:
        (raiz / nombre).write_text("G0", encoding="utf-8")
    monkeypatch.setattr(ai_tools, "LIBRARY_ROOTS", {"model": str(tmp_path / "models"), "gcode": str(raiz)})
    return raiz


async def test_la_biblioteca_filtra_por_tipo_de_maquina(tmp_path, monkeypatch):
    """La biblioteca guarda todo mezclado en dos carpetas; el filtro por
    máquina es lo que hace útil la respuesta."""
    _biblioteca(tmp_path, monkeypatch, ["corte.lbrn", "pieza.gcode", "fresado.tap", "logo.svg"])

    laser = await ai_tools.call_tool("get_library", {"kind": "laser"})
    assert {f["name"] for f in laser["files"]} == {"corte.lbrn", "pieza.gcode", "logo.svg"}

    cnc = await ai_tools.call_tool("get_library", {"kind": "cnc"})
    assert {f["name"] for f in cnc["files"]} == {"pieza.gcode", "fresado.tap"}


async def test_la_biblioteca_busca_por_nombre(tmp_path, monkeypatch):
    _biblioteca(tmp_path, monkeypatch, ["nopal-cut.gcode", "otra-cosa.gcode"])
    r = await ai_tools.call_tool("get_library", {"kind": "laser", "search": "nopal"})
    assert [f["name"] for f in r["files"]] == ["nopal-cut.gcode"]


async def test_la_biblioteca_devuelve_rutas_relativas(tmp_path, monkeypatch):
    """Deben ser las que aceptan los endpoints de NOPAL, no rutas absolutas
    del disco del servidor."""
    raiz = _biblioteca(tmp_path, monkeypatch, [])
    sub = raiz / "trabajos"; sub.mkdir()
    (sub / "corte.gcode").write_text("G0", encoding="utf-8")
    r = await ai_tools.call_tool("get_library", {"kind": "laser"})
    assert r["files"][0]["path"] == "trabajos/corte.gcode"
    assert not r["files"][0]["path"].startswith("/")


async def test_la_biblioteca_se_recorta_y_lo_avisa(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_tools, "MAX_LIBRARY_FILES", 3)
    _biblioteca(tmp_path, monkeypatch, [f"pieza{i}.gcode" for i in range(10)])
    r = await ai_tools.call_tool("get_library", {"kind": "printer"})
    assert r["count"] == 10 and len(r["files"]) == 3
    assert r["truncated"] is True


async def test_biblioteca_inexistente_no_rompe(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_tools, "LIBRARY_ROOTS", {"model": str(tmp_path / "nada"), "gcode": str(tmp_path / "nada")})
    r = await ai_tools.call_tool("get_library", {"kind": "laser"})
    assert r["count"] == 0 and r["files"] == []
