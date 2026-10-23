"""Consola unificada: los láseres y CNC (por `host`) usan los mismos
endpoints /api/console/* que las impresoras."""

import pytest

from backend.services import laser_service as laser

HOST = "192.168.0.99"
UID = "mch_aaaaaaaaaaaaaaaa"
ENTRY = {"id": UID, "host": HOST, "name": "CNC 3018", "kind": "cnc"}


@pytest.fixture
def laser_sent(monkeypatch):
    """Láser registrado y envío simulado: nada llega a una máquina real."""
    class Log(list):
        busy: dict

    log = Log()
    busy = {"value": False}
    monkeypatch.setattr(laser, "get_registered_lasers", lambda: [ENTRY])
    monkeypatch.setattr(laser, "ensure_listener", lambda host: None)
    monkeypatch.setattr(laser, "job_active", lambda host: busy["value"])

    async def fake_send(host, command):
        log.append(("send", host, command))
        return True

    async def fake_wait(host, command, timeout=60.0):
        log.append(("wait", host, command))
        return True

    monkeypatch.setattr(laser, "send_console_command", fake_send)
    monkeypatch.setattr(laser, "send_line_and_wait", fake_wait)
    laser._console_buffers.pop(HOST, None)
    log.busy = busy
    yield log
    laser._console_buffers.pop(HOST, None)


def test_command_goes_to_laser_and_is_logged(client, as_admin, laser_sent):
    assert client.post("/api/console/command", data={"host": HOST, "command": "$$"}).status_code == 200
    assert laser_sent == [("send", HOST, "$$")]
    messages = client.get("/api/console/messages", params={"host": HOST}).json()["messages"]
    assert [(m["message"], m.get("type")) for m in messages] == [("$$", "command")]
    assert client.get("/api/console/history", params={"host": HOST}).json()["history"] == ["$$"]


def test_history_key_is_the_internal_id(laser_sent):
    from backend.api.console import resolve_target
    assert resolve_target(None, None, HOST).history_key == f"laser:{UID}"


def test_unregistered_host_is_404(client, as_admin, laser_sent):
    assert client.get("/api/console/messages", params={"host": "10.0.0.1"}).status_code == 404


def test_two_machine_selectors_together_is_422(client, as_admin, laser_sent):
    assert client.get("/api/console/messages", params={"host": HOST, "port": 7125}).status_code == 422


def test_operator_cannot_send_to_laser(client, as_operator, laser_sent):
    res = client.post("/api/console/command", data={"host": HOST, "command": "M3 S1000"})
    assert res.status_code == 403
    assert laser_sent == []


def test_command_is_refused_while_a_job_runs(client, as_admin, laser_sent):
    laser_sent.busy["value"] = True
    res = client.post("/api/console/command", data={"host": HOST, "command": "G0 X0"})
    assert res.status_code == 409
    assert laser_sent == []


def test_macro_runs_line_by_line_waiting_for_ok(client, as_admin, laser_sent):
    macro = {"name": "Origen", "commands": ["$H", "G92 X0 Y0"], "icon": "home", "scopes": ["cnc"]}
    macro_id = client.post("/api/console/macros", json=macro).json()["macro"]["id"]
    run = client.post(f"/api/console/macros/{macro_id}/run", json={"host": HOST})
    assert run.json()["sent"] == 2
    assert laser_sent == [("wait", HOST, "$H"), ("wait", HOST, "G92 X0 Y0")]


def test_macro_is_refused_while_a_job_runs(client, as_admin, laser_sent):
    macro_id = client.post("/api/console/macros", json={"name": "M", "commands": ["G0 X0"], "icon": "bolt", "scopes": ["cnc"]}).json()["macro"]["id"]
    laser_sent.busy["value"] = True
    assert client.post(f"/api/console/macros/{macro_id}/run", json={"host": HOST}).status_code == 409
    assert laser_sent == []
