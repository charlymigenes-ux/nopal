"""Consola unificada: las impresoras Marlin (por `device`) usan los mismos
endpoints /api/console/* que las Klipper (por `port`)."""

import pytest

import backend.api.console as console_api
from backend.services import marlin_printer_service as marlin

DEVICE = "/dev/ttyUSB7"
UID = "mch_0123456789abcdef"
ENTRY = {"id": UID, "device": DEVICE, "name": "ET4", "baud": 250000, "transport": "usb_serial"}


@pytest.fixture
def marlin_sent(monkeypatch):
    """Impresora Marlin registrada y puerto simulado: nada llega a hardware."""
    log = []
    monkeypatch.setattr(marlin, "get_registered_printers", lambda: [ENTRY])
    monkeypatch.setattr(marlin, "ensure_listener", lambda device: None)

    async def fake_send(device, command):
        log.append(("send", device, command))
        return True

    async def fake_wait(device, command, timeout=30.0):
        log.append(("wait", device, command))
        return True

    monkeypatch.setattr(marlin, "send_console_command", fake_send)
    monkeypatch.setattr(marlin, "send_line_and_wait", fake_wait)
    marlin._console_buffers.pop(DEVICE, None)
    yield log
    marlin._console_buffers.pop(DEVICE, None)


def test_command_goes_to_marlin_and_is_logged(client, as_admin, marlin_sent):
    res = client.post("/api/console/command", data={"device": DEVICE, "command": "M115"})
    assert res.status_code == 200
    assert marlin_sent == [("send", DEVICE, "M115")]
    messages = client.get("/api/console/messages", params={"device": DEVICE}).json()["messages"]
    assert [(m["message"], m.get("type")) for m in messages] == [("M115", "command")]
    # El historial se guarda por el id interno, no por la ruta USB.
    assert client.get("/api/console/history", params={"device": DEVICE}).json()["history"] == ["M115"]


def test_history_key_is_the_internal_id(marlin_sent):
    assert console_api.resolve_target(None, DEVICE).history_key == f"marlin:{UID}"


def test_unregistered_device_is_404(client, as_admin, marlin_sent):
    assert client.get("/api/console/messages", params={"device": "/dev/ttyUSB9"}).status_code == 404


def test_port_and_device_together_or_neither_is_422(client, as_admin, marlin_sent):
    assert client.get("/api/console/messages", params={"port": 7125, "device": DEVICE}).status_code == 422
    assert client.get("/api/console/messages").status_code == 422


def test_operator_cannot_send_to_marlin(client, as_operator, marlin_sent):
    res = client.post("/api/console/command", data={"device": DEVICE, "command": "M104 S200"})
    assert res.status_code == 403
    assert marlin_sent == []


def test_macro_runs_line_by_line_waiting_for_ok(client, as_admin, marlin_sent):
    macro = {"name": "Home y subir", "commands": ["G28", "G1 Z50 F600"], "icon": "home"}
    macro_id = client.post("/api/console/macros", json=macro).json()["macro"]["id"]
    run = client.post(f"/api/console/macros/{macro_id}/run", json={"device": DEVICE})
    assert run.json()["sent"] == 2
    assert marlin_sent == [("wait", DEVICE, "G28"), ("wait", DEVICE, "G1 Z50 F600")]


def test_run_file_stops_and_reports_when_a_line_fails(client, as_admin, marlin_sent, monkeypatch):
    async def fail_second(device, command, timeout=30.0):
        marlin_sent.append(("wait", device, command))
        return command != "G1 X10"

    monkeypatch.setattr(marlin, "send_line_and_wait", fail_second)
    res = client.post(
        "/api/console/run-file", data={"device": DEVICE},
        files={"file": ("t.gcode", b"G28\nG1 X10\nG1 X20\n")},
    )
    assert res.status_code == 502
    assert "1 de 3" in res.json()["detail"]
    assert [c[2] for c in marlin_sent] == ["G28", "G1 X10"]


def test_export_log_uses_marlin_buffer(client, as_admin, marlin_sent):
    client.post("/api/console/command", data={"device": DEVICE, "command": "M115"})
    res = client.get("/api/console/log/export", params={"device": DEVICE})
    assert res.status_code == 200
    assert "> M115" in res.text
    assert "consola-dev_ttyUSB7-" in res.headers["content-disposition"]
