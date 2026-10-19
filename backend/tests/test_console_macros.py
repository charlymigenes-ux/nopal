"""Macros/plantillas propias, historial, log y archivo de la Consola."""

import pytest

import backend.api.console as console_api
from backend.services import console_service as svc

PORT = 7125


@pytest.fixture
def sent(monkeypatch):
    log = []
    monkeypatch.setattr(console_api, "send_console_command", lambda port, command: log.append((port, command)) or True)
    return log


MACRO = {"name": "Home y subir", "commands": ["G28", "G1 Z50 F600"], "icon": "home"}
TEMPLATE = {
    "name": "Calentar", "commands": ["M104 S{{t}}"],
    "params": [{"key": "t", "label": "Temp", "type": "number", "default": 200, "min": 0, "max": 300}],
}


def test_macro_crud_and_run(client, as_admin, sent):
    created = client.post("/api/console/macros", json=MACRO)
    assert created.status_code == 201
    macro_id = created.json()["macro"]["id"]
    assert [m["id"] for m in client.get("/api/console/macros").json()["macros"]] == [macro_id]

    run = client.post(f"/api/console/macros/{macro_id}/run", json={"port": PORT})
    assert run.json()["sent"] == 2
    assert sent == [(PORT, "G28\nG1 Z50 F600")]

    assert client.put(f"/api/console/macros/{macro_id}", json={**MACRO, "name": "Otro"}).json()["macro"]["name"] == "Otro"
    assert client.delete(f"/api/console/macros/{macro_id}").status_code == 200
    assert client.delete(f"/api/console/macros/{macro_id}").status_code == 404


def test_operator_can_read_but_not_write_or_run(client, as_operator, sent):
    assert client.get("/api/console/macros").status_code == 200
    assert client.get("/api/console/templates").status_code == 200
    assert client.post("/api/console/macros", json=MACRO).status_code == 403
    assert client.post("/api/console/templates/builtin-print-pla/run", json={"port": PORT}).status_code == 403
    assert client.post("/api/console/run-file", data={"port": PORT}, files={"file": ("a.gcode", b"G28")}).status_code == 403
    assert sent == []


def test_template_render_and_range_validation(client, as_admin, sent):
    template_id = client.post("/api/console/templates", json=TEMPLATE).json()["template"]["id"]
    ok = client.post(f"/api/console/templates/{template_id}/run", json={"port": PORT, "params": {"t": "215"}})
    assert ok.json()["commands"] == ["M104 S215"]
    bad = client.post(f"/api/console/templates/{template_id}/run", json={"port": PORT, "params": {"t": 999}})
    assert bad.status_code == 422 and "entre 0 y 300" in bad.json()["detail"]
    assert len(sent) == 1


def test_builtin_templates_are_read_only_and_render_with_defaults(client, as_admin, sent):
    templates = client.get("/api/console/templates").json()["templates"]
    assert templates and all(t["builtin"] for t in templates)
    assert client.delete("/api/console/templates/builtin-print-pla").status_code == 403
    run = client.post("/api/console/templates/builtin-print-pla/run", json={"port": PORT})
    assert "M104 S210" in run.json()["commands"]


@pytest.mark.parametrize("payload", [
    {"name": "", "commands": ["G28"]},
    {"name": "x", "commands": []},
    {"name": "x", "commands": ["G28\nM112"]},
    {"name": "x", "commands": ["M104 S{{t}}"]},          # marcador en una macro
    {"name": "x", "commands": ["G28"], "icon": "nope"},
])
def test_invalid_macro_is_422(client, as_admin, payload):
    assert client.post("/api/console/macros", json=payload).status_code == 422


def test_template_param_must_match_placeholders(client, as_admin):
    unused = {**TEMPLATE, "commands": ["G28"]}
    assert client.post("/api/console/templates", json=unused).status_code == 422
    undefined = {**TEMPLATE, "params": []}
    assert client.post("/api/console/templates", json=undefined).status_code == 422


def test_text_param_cannot_inject_a_second_line():
    item = {"commands": ["M117 {{msg}}"], "params": [{"key": "msg", "label": "Mensaje", "type": "text", "default": ""}]}
    with pytest.raises(svc.ConsoleError):
        svc.render_commands(item, {"msg": "hola\nM112"})
    with pytest.raises(svc.ConsoleError):
        svc.render_commands(item, {"msg": "hola;M112"})


def test_history_records_dedupes_and_clears(client, as_admin, sent):
    for command in ("M115", "G28", "M115"):
        client.post("/api/console/command", data={"port": PORT, "command": command})
    assert client.get("/api/console/history", params={"port": PORT}).json()["history"] == ["M115", "G28"]
    assert client.get("/api/console/history", params={"port": 9999}).json()["history"] == []
    client.delete("/api/console/history", params={"port": PORT})
    assert client.get("/api/console/history", params={"port": PORT}).json()["history"] == []


def test_log_export_is_plain_text_attachment(client, as_admin, monkeypatch):
    monkeypatch.setattr(console_api, "get_console_messages", lambda port, count: [
        {"time": 1700000000, "type": "command", "message": "M115"},
        {"time": 1700000001, "type": "response", "message": "ok"},
    ])
    response = client.get("/api/console/log/export", params={"port": PORT})
    assert response.headers["content-type"].startswith("text/plain")
    assert "attachment" in response.headers["content-disposition"]
    lines = response.text.splitlines()
    assert lines[0].endswith("> M115") and lines[1].endswith("  ok")


def test_run_file_skips_comments_and_enforces_limits(client, as_admin, sent):
    body = b"; calibracion\nG28 ; home\n\n(comentario)\nG1 Z10\n"
    response = client.post("/api/console/run-file", data={"port": PORT}, files={"file": ("t.gcode", body)})
    assert response.json() == {"success": True, "sent": 2, "skipped": 3}
    assert sent == [(PORT, "G28\nG1 Z10")]

    too_long = ("G1 X1\n" * 501).encode()
    assert client.post("/api/console/run-file", data={"port": PORT}, files={"file": ("l.gcode", too_long)}).status_code == 413
    assert client.post("/api/console/run-file", data={"port": PORT}, files={"file": ("b.bin", b"\xff\xfe")}).status_code == 422
    assert client.post("/api/console/run-file", data={"port": PORT}, files={"file": ("c.gcode", b"; solo comentario")}).status_code == 422


def test_failed_send_reports_partial_progress(client, as_admin, monkeypatch):
    calls = iter([True, False])
    monkeypatch.setattr(console_api, "send_console_command", lambda port, command: next(calls))
    body = ("G1 X1\n" * 25).encode()
    response = client.post("/api/console/run-file", data={"port": PORT}, files={"file": ("t.gcode", body)})
    assert response.status_code == 502 and "20 de 25" in response.json()["detail"]


def test_corrupt_store_is_set_aside(tmp_path):
    with open(svc.MACROS_PATH, "w", encoding="utf-8") as handle:
        handle.write("{no es json")
    assert svc.list_macros() == []
    assert list(tmp_path.glob("console_macros.json.corrupt-*.bak"))
