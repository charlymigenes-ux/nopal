"""Acciones físicas de NOPAL Intelligence.

Lo que se verifica acá no es que funcionen, sino que NO puedan hacer de más:
que no arranquen láser ni CNC, que no escalen privilegios y que lo de riesgo
no se ejecute sin confirmación humana.
"""

import pytest

from backend.services import ai_actions


# Verbos que encienden algo que corta o quema. Si alguien agrega una acción
# así, este test falla a propósito: fue una condición explícita del proyecto
# desde el primer día, y no depende de ningún nivel de riesgo.
PROHIBIDAS = ("laser", "láser", "cnc", "spindle", "husillo", "engrave", "grabar", "cut", "cortar")


def test_ninguna_accion_arranca_laser_ni_cnc():
    for accion in ai_actions.ACTIONS.values():
        texto = f"{accion.name} {accion.description}".lower()
        for palabra in ("start_laser", "run_laser", "start_cnc", "laser_on", "spindle_on"):
            assert palabra not in texto, f"'{accion.name}' parece arrancar láser o CNC"


def test_no_hay_acciones_de_movimiento_de_ejes():
    """Home y mover ejes quedan fuera de esta primera versión."""
    for nombre in ai_actions.ACTIONS:
        assert "home" not in nombre and "move" not in nombre and "jog" not in nombre


def test_cada_accion_declara_riesgo_y_rol_validos():
    for accion in ai_actions.ACTIONS.values():
        assert accion.risk in ("low", "confirm"), accion.name
        assert accion.role in ("any", "admin"), accion.name


def test_precalentar_es_admin_como_en_el_panel():
    """set_temperature_target_endpoint es require_role('admin'); la IA no
    puede ser más permisiva que la interfaz."""
    assert ai_actions.ACTIONS["preheat_machine"].role == "admin"
    assert ai_actions.ACTIONS["preheat_machine"].risk == "confirm"


def test_el_catalogo_depende_del_rol():
    """Un operador no debe ver siquiera lo que no podría hacer."""
    admin = {a.name for a in ai_actions.get_actions("admin")}
    operador = {a.name for a in ai_actions.get_actions("operador")}
    assert "preheat_machine" in admin
    assert "preheat_machine" not in operador
    assert operador < admin


async def test_un_operador_no_puede_precalentar_ni_forzandolo():
    """Aunque el modelo pida la acción directamente, el rol se revalida."""
    with pytest.raises(ai_actions.ActionError, match="permiso"):
        await ai_actions.execute("preheat_machine", {"machine_id": "x", "nozzle": 200}, "operador")


async def test_una_accion_inexistente_falla_limpio():
    with pytest.raises(ai_actions.ActionError, match="No existe"):
        await ai_actions.execute("borrar_todo", {}, "admin")


async def test_faltan_datos_obligatorios():
    with pytest.raises(ai_actions.ActionError, match="Faltan datos"):
        await ai_actions.execute("queue_file", {"machine_id": "x"}, "admin")


def test_confirmacion_de_un_solo_uso_y_del_mismo_usuario():
    pendiente = ai_actions.stage_action("preheat_machine", {"machine_id": "x", "nozzle": 200}, "carlos")
    assert pendiente["id"]
    # Otro usuario no puede confirmar lo que pidió alguien más
    import asyncio
    with pytest.raises(ai_actions.ActionError, match="Solo quien pidió"):
        asyncio.get_event_loop().run_until_complete(
            ai_actions.confirm(pendiente["id"], "admin", "otro"))
    assert ai_actions.cancel(pendiente["id"]) is True
    assert ai_actions.cancel(pendiente["id"]) is False


async def test_una_confirmacion_vencida_no_sirve(monkeypatch):
    monkeypatch.setattr(ai_actions, "PENDING_TTL_SECONDS", -1)
    pendiente = ai_actions.stage_action("preheat_machine", {"machine_id": "x"}, "carlos")
    with pytest.raises(ai_actions.ActionError, match="venció"):
        await ai_actions.confirm(pendiente["id"], "admin", "carlos")


async def test_precalentar_rechaza_temperaturas_absurdas(monkeypatch):
    async def _maquina(machine_id):
        return {"id": "klipper:7125", "name": "nopal-i3", "brand": "klipper"}
    monkeypatch.setattr(ai_actions, "_resolve_machine", _maquina)
    with pytest.raises(ai_actions.ActionError, match="fuera del rango"):
        await ai_actions.execute("preheat_machine", {"machine_id": "nopal-i3", "nozzle": 900}, "admin")


async def test_precalentar_exige_alguna_temperatura(monkeypatch):
    async def _maquina(machine_id):
        return {"id": "klipper:7125", "name": "nopal-i3", "brand": "klipper"}
    monkeypatch.setattr(ai_actions, "_resolve_machine", _maquina)
    with pytest.raises(ai_actions.ActionError, match="a qué temperatura"):
        await ai_actions.execute("preheat_machine", {"machine_id": "nopal-i3"}, "admin")


# --------------------------------------------------------------------------
# El interruptor se revalida al ejecutar, no solo al ofrecer
# --------------------------------------------------------------------------

async def test_con_acciones_apagadas_no_se_ejecuta_aunque_el_modelo_la_pida(monkeypatch):
    """No ofrecer una herramienta en el catálogo NO es rechazarla: el modelo
    puede inventarse el nombre. El interruptor tiene que revalidarse en el
    punto de ejecución."""
    from backend.services import ai_agent, ai_config_service

    ejecutada = {"si": False}

    async def _jamas(**kwargs):
        ejecutada["si"] = True
        return {"ok": True}

    monkeypatch.setattr(ai_actions.ACTIONS["set_accessory_power"], "handler", _jamas)

    class _Provocador:
        def __init__(self): self.n = 0
        async def chat(self, messages, tools=None, model=None):
            self.n += 1
            if self.n == 1:
                return {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "c1", "type": "function",
                    "function": {"name": "set_accessory_power",
                                 "arguments": '{"accessory_id": "rele1", "on": true}'}}]}
            return {"role": "assistant", "content": "No pude."}

    monkeypatch.setattr(ai_agent, "get_provider", lambda c: _Provocador())
    ai_config_service.save_config({
        "enabled": True, "base_url": "http://127.0.0.1:8081/v1", "model": "m",
        "tool_mode": "native", "actions_enabled": False,
    })

    await ai_agent.ask("prende el relé 1", role="admin", username="carlos")
    assert ejecutada["si"] is False, "la acción se ejecutó con el interruptor apagado"


async def test_con_acciones_encendidas_la_de_riesgo_bajo_si_corre(monkeypatch):
    from backend.services import ai_agent, ai_config_service

    corrida = {"si": False}

    async def _handler(**kwargs):
        corrida["si"] = True
        return {"ok": True}

    monkeypatch.setattr(ai_actions.ACTIONS["set_accessory_power"], "handler", _handler)

    class _Prov:
        def __init__(self): self.n = 0
        async def chat(self, messages, tools=None, model=None):
            self.n += 1
            if self.n == 1:
                return {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "c1", "type": "function",
                    "function": {"name": "set_accessory_power",
                                 "arguments": '{"accessory_id": "rele1", "on": true}'}}]}
            return {"role": "assistant", "content": "Listo."}

    monkeypatch.setattr(ai_agent, "get_provider", lambda c: _Prov())
    ai_config_service.save_config({
        "enabled": True, "base_url": "http://127.0.0.1:8081/v1", "model": "m",
        "tool_mode": "native", "actions_enabled": True,
    })

    resultado = await ai_agent.ask("prende el relé 1", role="admin", username="carlos")
    assert corrida["si"] is True
    assert resultado.get("pending_action") is None, "riesgo bajo no debe pedir confirmación"


def test_el_prompt_deja_de_decir_solo_lectura_con_acciones_activas():
    """Con acciones encendidas, 'eres de solo lectura' es falso y confundiría
    al modelo; pero la prohibición de láser y CNC tiene que seguir ahí."""
    from backend.services.ai_agent import _system_prompt

    sin_acciones = _system_prompt("full", False)
    con_acciones = _system_prompt("full", True)

    assert "solo lectura" in sin_acciones
    assert "solo lectura" not in con_acciones
    assert "láser ni el CNC" in con_acciones
    assert "pending_confirmation" in con_acciones
    # La regla de no inventar sobrevive en ambos casos
    assert "NUNCA inventes" in sin_acciones and "NUNCA inventes" in con_acciones


# --------------------------------------------------------------------------
# Contrato entre la configuración y el formulario
# --------------------------------------------------------------------------

def test_los_interruptores_de_seguridad_son_editables_en_la_interfaz():
    """Un interruptor de seguridad que existe en la configuración pero no en
    el formulario queda inalcanzable: fue exactamente lo que pasó con
    actions_enabled -- se documentó cómo activarlo y el control no existía.

    Solo se exigen los de seguridad. max_tokens, temperature y
    max_tool_iterations son deliberadamente solo-entorno, y update_provider
    preserva lo que el formulario no manda, así que no se pierden.
    """
    import pathlib

    app_js = pathlib.Path(__file__).resolve().parents[1] / "static/js/app.js"
    fuente = app_js.read_text(encoding="utf-8")
    inicio = fuente.index("function aiReadConfigForm()")
    cuerpo = fuente[inicio:fuente.index("}", fuente.index("return {", inicio))]

    for campo in ("actions_enabled", "allow_public_endpoint"):
        assert campo in cuerpo, f"el formulario no manda '{campo}', queda inalcanzable"


def test_la_accion_de_escena_usa_el_nombre_real_del_plugin():
    """El plugin la llama run_scene. Adivinar apply_scene hacía que activar
    escenas fallara siempre con un mensaje engañoso sobre la versión."""
    import inspect as _inspect
    fuente = _inspect.getsource(ai_actions.activate_scene)
    assert '"run_scene"' in fuente


def test_la_matriz_led_y_los_accesorios_no_se_confunden():
    """Son dos plugins distintos. Sin descripciones que los separen, un
    pedido sobre la matriz terminaba prendiendo tiras LED."""
    escena = ai_actions.ACTIONS["activate_scene"]
    matriz = ai_actions.ACTIONS["send_matrix_announcement"]

    assert "Matriz LED" in escena.description, "la escena de accesorios debe descartar la matriz"
    assert "accesorios" in matriz.description.lower(), "el anuncio de matriz debe descartar los accesorios"
    assert escena.name != matriz.name

    from backend.services import ai_tools
    lectura = ai_tools.TOOLS["get_scenes"].description
    assert "get_led_matrix" in lectura, "get_scenes debe redirigir a la herramienta de la matriz"
