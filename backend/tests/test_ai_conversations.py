"""Historial de conversaciones de NOPAL Intelligence.

El aislamiento de STORE_PATH lo hace la fixture autouse de conftest.py.
"""

import pytest

from backend.services import ai_agent, ai_config_service, ai_conversations_service as conv


def test_empieza_vacio():
    assert conv.list_conversations()["conversations"] == []


def test_preguntar_crea_la_conversacion_y_la_titula():
    """El título sale de la primera pregunta: es lo que el usuario reconoce
    al buscarla después, no una fecha ni un id."""
    c = conv.append_turn(None, "¿Cómo está el taller?", "Todo bien.", [{"tool": "get_workshop_status"}])
    assert c["title"] == "¿Cómo está el taller?"
    assert len(c["messages"]) == 2
    assert conv.list_conversations()["count"] == 1


def test_los_turnos_siguientes_van_a_la_misma():
    primera = conv.append_turn(None, "Uno", "R1")
    conv.append_turn(primera["id"], "Dos", "R2")
    assert conv.list_conversations()["count"] == 1
    assert len(conv.get_conversation(primera["id"])["messages"]) == 4


def test_un_id_inexistente_no_pierde_el_turno():
    """Preferible abrir una conversación nueva a tirar lo que el usuario
    acaba de preguntar."""
    c = conv.append_turn("no-existe", "Hola", "Qué tal")
    assert c["id"] != "no-existe"
    assert conv.list_conversations()["count"] == 1


def test_titulo_largo_se_recorta():
    c = conv.append_turn(None, "x" * 200, "R")
    assert len(c["title"]) <= conv.TITLE_LENGTH
    assert c["title"].endswith("…")


def test_renombrar_y_borrar():
    c = conv.append_turn(None, "Uno", "R")
    assert conv.rename_conversation(c["id"], "Mi diagnóstico")["title"] == "Mi diagnóstico"
    assert conv.rename_conversation("no-existe", "x") is None
    assert conv.delete_conversation(c["id"]) is True
    assert conv.delete_conversation(c["id"]) is False


def test_el_listado_no_arrastra_los_mensajes():
    """Una conversación larga no tiene por qué viajar entera solo para
    pintar la barra lateral."""
    c = conv.append_turn(None, "Uno", "R")
    fila = conv.list_conversations()["conversations"][0]
    assert "messages" not in fila
    assert fila["message_count"] == 2


def test_se_ordenan_por_uso_reciente():
    a = conv.append_turn(None, "Vieja", "R")
    b = conv.append_turn(None, "Nueva", "R")
    conv.append_turn(a["id"], "Retomo la vieja", "R")
    assert conv.list_conversations()["conversations"][0]["id"] == a["id"]


def test_tope_de_conversaciones(monkeypatch):
    monkeypatch.setattr(conv, "MAX_CONVERSATIONS", 3)
    for i in range(6):
        conv.append_turn(None, f"Pregunta {i}", "R")
    assert conv.list_conversations()["count"] == 3


def test_los_turnos_reenviados_al_modelo_van_recortados(monkeypatch):
    """Reenviar la conversación entera volvería inusable un servidor de IA
    modesto a los pocos intercambios."""
    monkeypatch.setattr(conv, "HISTORY_TURNS", 2)
    c = conv.append_turn(None, "P1", "R1")
    for i in range(2, 6):
        conv.append_turn(c["id"], f"P{i}", f"R{i}")
    turnos = conv.recent_turns(c["id"])
    assert len(turnos) == 4                      # 2 turnos = 4 mensajes
    assert turnos[-1]["content"] == "R5"         # se conserva lo reciente
    assert conv.recent_turns(None) == []
    assert conv.recent_turns("no-existe") == []


def test_archivo_corrupto_no_rompe(tmp_path, monkeypatch):
    roto = tmp_path / "roto.json"
    roto.write_text("{no soy json", encoding="utf-8")
    monkeypatch.setattr(conv, "STORE_PATH", str(roto))
    assert conv.list_conversations()["conversations"] == []


async def test_el_agente_recuerda_el_contexto(monkeypatch):
    """La prueba de que es una conversación y no preguntas sueltas: los
    turnos previos llegan al modelo."""
    vistos = {}

    class _Proveedor:
        async def chat(self, messages, tools=None, model=None):
            vistos["messages"] = messages
            return {"role": "assistant", "content": "El otro láser está desconectado."}
        async def test_connection(self):
            return {"ok": True}

    monkeypatch.setattr(ai_agent, "get_provider", lambda config: _Proveedor())
    ai_config_service.save_config({"enabled": True, "base_url": "http://127.0.0.1:8081/v1",
                                   "model": "m", "tool_mode": "context"})

    primera = await ai_agent.ask("¿Cómo está el TTS 55 PRO?")
    assert primera["conversation_id"]

    await ai_agent.ask("¿y el otro láser?", primera["conversation_id"])
    contenidos = [m["content"] for m in vistos["messages"] if m["role"] in ("user", "assistant")]
    assert any("TTS 55 PRO" in c for c in contenidos), "el turno previo no llegó al modelo"


async def test_una_respuesta_fallida_no_ensucia_el_historial(monkeypatch):
    """Una conversación no debe quedar sembrada de errores de red del
    servidor de IA."""
    from backend.services.ai_provider import AIProviderError

    class _Roto:
        async def chat(self, messages, tools=None, model=None):
            raise AIProviderError("se cayó la red")
        async def test_connection(self):
            return {"ok": False}

    monkeypatch.setattr(ai_agent, "get_provider", lambda config: _Roto())
    ai_config_service.save_config({"enabled": True, "base_url": "http://127.0.0.1:8081/v1",
                                   "model": "m", "tool_mode": "context"})
    with pytest.raises(AIProviderError):
        await ai_agent.ask("¿Cómo está el taller?")
    assert conv.list_conversations()["count"] == 0
