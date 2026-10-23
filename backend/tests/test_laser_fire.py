"""Disparo de prueba ("Encender láser").

Con el modo láser de GRBL ($32=1) un M3 suelto no emite: hace falta un G1.
Todo va con la placa simulada, nada llega a una máquina real.
"""

import pytest

import backend.api.laser as laser_api
import backend.services.laser_service as laser_service
from backend.auth_deps import require_auth
from backend.main import app

HOST = "192.168.0.61"


@pytest.fixture
def sent(monkeypatch):
    log = []

    def fake_send(host, command, **kwargs):
        log.append(command)
        return True

    async def ready(host):
        return None

    async def no_wait(seconds):
        return None

    monkeypatch.setattr(laser_service, "send_raw_command", fake_send)
    monkeypatch.setattr(laser_service.asyncio, "sleep", no_wait)
    monkeypatch.setattr(laser_api, "ensure_listener_ready", ready)
    monkeypatch.setattr(laser_api, "job_active", lambda host: False)
    monkeypatch.setattr(laser_service, "_firmware_for_host", lambda host: "fluidnc")
    monkeypatch.setattr(laser_api, "get_registered_lasers", lambda: [{"host": HOST, "kind": "laser"}])
    return log


@pytest.fixture
def act_as():
    def _set(role):
        app.dependency_overrides[require_auth] = lambda: {"user_id": "u-1", "username": "u-1", "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def test_encender_manda_un_g1_diminuto_y_lento_con_la_potencia(client, act_as, sent):
    act_as("admin")
    response = client.post("/api/laser/fire", data={"host": HOST, "power_s": "250"})

    assert response.status_code == 200
    assert sent == ["G91", "G1 X0.300 F1 S250 M3", "G90"]
    assert response.json()["duration_s"] == pytest.approx(18.0)


def test_apagar_pausa_y_reinicia_en_ese_orden(client, act_as, sent):
    act_as("admin")
    response = client.post("/api/laser/fire/stop", data={"host": HOST})

    assert response.status_code == 200
    assert sent == ["!", "\x18"]


def test_un_operador_no_puede_encender_pero_si_apagar(client, act_as, sent):
    act_as("operador")

    assert client.post("/api/laser/fire", data={"host": HOST, "power_s": "100"}).status_code == 403
    assert sent == []
    assert client.post("/api/laser/fire/stop", data={"host": HOST}).status_code == 200
    assert sent == ["!", "\x18"]


def test_con_un_trabajo_en_curso_no_enciende_ni_apaga(client, act_as, sent, monkeypatch):
    """El reinicio suave de apagar abortaría el trabajo: se rechaza antes."""
    act_as("admin")
    monkeypatch.setattr(laser_api, "job_active", lambda host: True)

    assert client.post("/api/laser/fire", data={"host": HOST, "power_s": "100"}).status_code == 409
    assert client.post("/api/laser/fire/stop", data={"host": HOST}).status_code == 409
    assert sent == []


@pytest.mark.parametrize("power", ["0", "-5", "10001"])
def test_potencia_fuera_de_rango(client, act_as, sent, power):
    act_as("admin")
    assert client.post("/api/laser/fire", data={"host": HOST, "power_s": power}).status_code == 400
    assert sent == []


def test_si_la_placa_rechaza_una_linea_no_se_deja_en_relativo(client, act_as, monkeypatch):
    act_as("admin")
    log = []

    def flaky(host, command, **kwargs):
        log.append(command)
        return command != "G1 X0.300 F1 S100 M3"

    async def ready(host):
        return None

    monkeypatch.setattr(laser_service, "send_raw_command", flaky)
    monkeypatch.setattr(laser_api, "ensure_listener_ready", ready)
    monkeypatch.setattr(laser_api, "job_active", lambda host: False)
    monkeypatch.setattr(laser_service, "_firmware_for_host", lambda host: "fluidnc")
    monkeypatch.setattr(laser_api, "get_registered_lasers", lambda: [{"host": HOST, "kind": "laser"}])

    assert client.post("/api/laser/fire", data={"host": HOST, "power_s": "100"}).status_code == 502
    assert log[-1] == "G90"


def test_marlin_conserva_m3_y_m5(client, act_as, sent, monkeypatch):
    act_as("admin")
    monkeypatch.setattr(laser_service, "_firmware_for_host", lambda host: "marlin")

    on = client.post("/api/laser/fire", data={"host": HOST, "power_s": "100"})
    assert on.json()["duration_s"] == 0
    client.post("/api/laser/fire/stop", data={"host": HOST})
    assert sent == ["M3 S100", "M5"]
