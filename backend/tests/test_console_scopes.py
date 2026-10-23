"""Macros y plantillas propias por tipo de máquina: impresora, láser o CNC."""

import pytest

from backend.services import console_service as svc
from backend.services import laser_service as laser

HOST = "192.168.0.98"
LASER = {"id": "mch_bbbbbbbbbbbbbbbb", "host": HOST, "name": "Láser 55", "kind": "laser"}


def _make(client, name, commands, scopes=None):
    body = {"name": name, "commands": commands, "icon": "bolt"}
    if scopes is not None:
        body["scopes"] = scopes
    res = client.post("/api/console/macros", json=body)
    assert res.status_code == 201, res.text
    return res.json()["macro"]


def _names(client, scope=None):
    params = {"scope": scope} if scope else {}
    return {m["name"] for m in client.get("/api/console/macros", params=params).json()["macros"]}


def test_macros_are_listed_only_for_their_machine_type(client, as_admin):
    _make(client, "Home 3D", ["G28"], ["printer"])
    _make(client, "Home láser", ["$H"], ["laser"])
    _make(client, "Home CNC", ["$H"], ["cnc"])
    _make(client, "Home GRBL", ["$H"], ["laser", "cnc"])
    assert _names(client, "printer") == {"Home 3D"}
    assert _names(client, "laser") == {"Home láser", "Home GRBL"}
    assert _names(client, "cnc") == {"Home CNC", "Home GRBL"}
    assert _names(client) == {"Home 3D", "Home láser", "Home CNC", "Home GRBL"}


def test_without_scopes_a_new_macro_is_for_printers(client, as_admin):
    assert _make(client, "G28", ["G28"])["scopes"] == ["printer"]


@pytest.mark.parametrize("scopes", [[], ["plotter"], "printer", ["printer", "x"]])
def test_invalid_scopes_are_rejected(client, as_admin, scopes):
    res = client.post("/api/console/macros", json={"name": "X", "commands": ["G28"], "icon": "bolt", "scopes": scopes})
    assert res.status_code == 422


def test_invalid_scope_filter_is_422(client, as_admin):
    assert client.get("/api/console/macros", params={"scope": "plotter"}).status_code == 422


def test_legacy_items_without_scopes_are_classified_by_their_commands():
    assert svc.infer_scopes({"commands": ["G28"]}) == ["printer"]
    assert svc.infer_scopes({"commands": ["FIRMWARE_RESTART"]}) == ["printer"]
    assert svc.infer_scopes({"commands": ["$H"]}) == ["laser", "cnc"]
    assert svc.infer_scopes({"commands": ["G0 X0", "M5"]}) == ["laser", "cnc"]


def test_legacy_file_is_read_without_rewriting_it(client, as_admin):
    svc._write_json(svc.MACROS_PATH, {"macros": [
        {"id": "a1", "name": "Reinicia FW", "icon": "power", "commands": ["FIRMWARE_RESTART"]},
        {"id": "a2", "name": "Home", "icon": "home", "commands": ["$H"]},
    ], "templates": []})
    assert _names(client, "printer") == {"Reinicia FW"}
    assert _names(client, "cnc") == {"Home"}
    assert "scopes" not in svc._read_json(svc.MACROS_PATH, {})["macros"][0]


def test_builtin_templates_are_for_printers(client, as_admin):
    assert client.get("/api/console/templates", params={"scope": "printer"}).json()["templates"]
    assert client.get("/api/console/templates", params={"scope": "laser"}).json()["templates"] == []


def test_editing_a_macro_can_change_its_scopes(client, as_admin):
    macro = _make(client, "Home", ["$H"], ["laser"])
    res = client.put(f"/api/console/macros/{macro['id']}", json={**macro, "scopes": ["cnc"]})
    assert res.json()["macro"]["scopes"] == ["cnc"]
    assert _names(client, "laser") == set()


def test_macro_cannot_run_on_a_machine_outside_its_scope(client, as_admin, monkeypatch):
    sent = []

    async def fake_wait(host, command, timeout=60.0):
        sent.append(command)
        return True

    monkeypatch.setattr(laser, "get_registered_lasers", lambda: [LASER])
    monkeypatch.setattr(laser, "job_active", lambda host: False)
    monkeypatch.setattr(laser, "send_line_and_wait", fake_wait)
    monkeypatch.setattr(laser, "ensure_listener", lambda host: None)

    printer_only = _make(client, "G28", ["G28"], ["printer"])
    assert client.post(f"/api/console/macros/{printer_only['id']}/run", json={"host": HOST}).status_code == 422
    laser_macro = _make(client, "Home", ["$H"], ["laser"])
    assert client.post(f"/api/console/macros/{laser_macro['id']}/run", json={"host": HOST}).status_code == 200
    assert sent == ["$H"]
