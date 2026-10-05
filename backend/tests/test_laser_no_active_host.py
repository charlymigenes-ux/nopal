"""D4: sin "host láser activo" global.

Antes, NOPAL guardaba en memoria un único láser "seleccionado", compartido por
todas las sesiones, y cualquier ruta sin `host` actuaba sobre él: si otra
sesión cambiaba de máquina, pausar, cancelar o formatear la SD iba a la
máquina equivocada. Ahora cada petición dice a qué máquina va; sin `host` se
rechaza (400) sin tocar ninguna. `/api/laser/host` se retiró.
"""

import pytest

import backend.api.laser as laser_api
import backend.services.laser_service as laser_service

HOST_A, HOST_B = "192.168.0.61", "192.168.0.63"

# (método, ruta, datos obligatorios distintos de host). Todas las rutas que
# antes caían al host global.
ROUTES = [
    ("get", "/api/laser/status", {}),
    ("get", "/api/laser/parser-state", {}),
    ("get", "/api/laser/info", {}),
    ("post", "/api/laser/command", {"command": "$H"}),
    ("post", "/api/laser/jog", {"axis": "X", "distance": "1", "feed": "100"}),
    ("post", "/api/laser/home", {}),
    ("post", "/api/laser/job/start", {"path": "a.gc"}),
    ("post", "/api/laser/job/frame", {"path": "a.gc"}),
    ("get", "/api/laser/job/status", {}),
    ("post", "/api/laser/job/pause", {}),
    ("post", "/api/laser/job/resume", {}),
    ("post", "/api/laser/job/cancel", {}),
    ("get", "/api/laser/console", {}),
    ("post", "/api/laser/console", {"command": "$I"}),
    ("get", "/api/laser/settings", {}),
    ("post", "/api/laser/settings", {"key": "$32", "value": "1"}),
    ("get", "/api/laser/sd/available", {}),
    ("post", "/api/laser/queue/start", {"id": "1"}),
    ("get", "/api/laser/sd/files", {}),
    ("post", "/api/laser/sd/run", {"name": "a.gc"}),
    ("post", "/api/laser/sd/folder", {"name": "nueva"}),
    ("post", "/api/laser/sd/delete", {"name": "a.gc"}),
    ("post", "/api/laser/sd/format", {}),
    ("post", "/api/laser/sd/upload", "file"),
    ("post", "/api/laser/sd/upload-from-library", {"gcode_path": "a.gc"}),
]


def _call(client, method, url, data, host=None):
    if data == "file":
        form = {"host": host} if host else {}
        return client.post(url, data=form, files={"file": ("a.gc", b"G0 X1\n", "text/plain")})
    if method == "get":
        return client.get(url, params={"host": host} if host else {})
    return client.post(url, data={**data, **({"host": host} if host else {})})


@pytest.fixture
def no_machine_touched():
    """Ninguna conexión nueva a una placa (red o USB) durante el test."""
    before = (set(laser_service._listener_tasks), set(laser_service._serial_connections))
    yield
    after = (set(laser_service._listener_tasks), set(laser_service._serial_connections))
    assert after == before


@pytest.mark.parametrize("method, url, data", ROUTES, ids=[f"{m.upper()} {u}" for m, u, _ in ROUTES])
def test_missing_host_is_rejected(client, as_admin, no_machine_touched, method, url, data):
    response = _call(client, method, url, data)

    assert response.status_code == 400
    assert response.json() == {"detail": laser_api.MISSING_HOST_DETAIL}


@pytest.mark.parametrize("host", ["", "   "])
def test_blank_host_is_rejected(client, as_admin, no_machine_touched, host):
    response = client.post("/api/laser/job/cancel", data={"host": host})
    assert response.status_code == 400


def test_active_host_endpoint_is_gone(client, as_admin):
    assert client.get("/api/laser/host").status_code in (404, 405)
    assert client.post("/api/laser/host", data={"host": HOST_A}).status_code in (404, 405)


def test_no_global_host_left_in_the_service():
    for name in ("get_active_host", "set_active_host", "_active_host", "DEFAULT_LASER_HOST"):
        assert not hasattr(laser_service, name), name
        assert not hasattr(laser_api, name), name


def test_requests_for_different_machines_never_mix(client, as_admin, monkeypatch):
    """Lo que hace una sesión con una máquina no cambia a qué máquina va la
    siguiente petición de otra sesión: cada una dice su host."""
    cancelled = []

    async def fake_cancel(host):
        cancelled.append(host)
        return True

    monkeypatch.setattr(laser_api, "cancel_job", fake_cancel)

    assert client.post("/api/laser/job/cancel", data={"host": HOST_B}).status_code == 200
    assert client.post("/api/laser/job/cancel", data={"host": HOST_A}).status_code == 200
    assert client.post("/api/laser/job/cancel", data={}).status_code == 400

    assert cancelled == [HOST_B, HOST_A]


def test_anonymous_still_401_before_host_check(client):
    assert client.post("/api/laser/job/cancel", data={}).status_code == 401
