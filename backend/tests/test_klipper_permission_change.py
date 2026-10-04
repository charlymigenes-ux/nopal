"""Primer cambio real de permisos de ADR-006 (CURRENT → TARGET), panel de
Klipper:

- POST /api/system/temperature-target → set_temperature:      admin → OPERADOR
- POST /api/console/command           → send_console_command: operador → ADMIN
- POST /api/macros/run                → run_macro:            operador → ADMIN

Con esto el operador puede fijar temperatura desde el panel, pero ya no tiene
una vía equivalente (consola o macro con M104/M140) para hacerlo de forma
indirecta. TUNA-Screen e IA no están migrados.
"""

import pytest

import backend.api.console as console_api
import backend.api.status as status_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

PORT = 7125
TEMP_URL = "/api/system/temperature-target"
CONSOLE_URL = "/api/console/command"
MACRO_URL = "/api/macros/run"
TEMP_FORM = {"port": str(PORT), "heater": "extruder", "target": "210"}
CONSOLE_FORM = {"port": str(PORT), "command": "M104 S210"}
MACRO_FORM = {"port": str(PORT), "macro": "PREHEAT_PLA"}


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política y las llamadas a los
    servicios de Klipper (sin Moonraker real)."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    def fake_set_heater_target(port, heater, target):
        log.append(("service", "set_heater_target", port, heater, target))
        return True

    def fake_send_console_command(port, command):
        log.append(("service", "send_console_command", port, command))
        return True

    def fake_run_macro(port, macro):
        log.append(("service", "run_macro", port, macro))
        return True

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(status_api, "set_heater_target", fake_set_heater_target)
    monkeypatch.setattr(console_api, "send_console_command", fake_send_console_command)
    monkeypatch.setattr(console_api, "run_macro", fake_run_macro)
    return log


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


def _force_deny(monkeypatch):
    monkeypatch.setattr(
        auth_deps, "authorize",
        lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
    )


class TestSetTemperature:
    """CURRENT era admin; TARGET es operador (D3-Q1)."""

    def test_anonymous_rejected(self, client, calls):
        response = client.post(TEMP_URL, data=TEMP_FORM)

        assert response.status_code == 401
        assert _service_calls(calls) == []

    def test_operator_now_allowed(self, client, calls, as_operator):
        response = client.post(TEMP_URL, data=TEMP_FORM)

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", "set_heater_target", PORT, "extruder", 210.0)]

    def test_admin_allowed(self, client, calls, as_admin):
        response = client.post(TEMP_URL, data=TEMP_FORM)

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert len(_service_calls(calls)) == 1

    def test_service_failure_still_502(self, client, calls, as_operator, monkeypatch):
        monkeypatch.setattr(status_api, "set_heater_target", lambda port, heater, target: False)

        response = client.post(TEMP_URL, data=TEMP_FORM)

        assert response.status_code == 502
        assert response.json()["detail"] == "No se pudo actualizar la temperatura objetivo"

    def test_policy_called_with_principal_action_and_resource(self, client, calls, act_as):
        act_as("operador", user_id="u-oper")

        client.post(TEMP_URL, data=TEMP_FORM)

        kind, principal, action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.id == "u-oper" and principal.role is Role.OPERATOR
        assert action is Action.SET_TEMPERATURE
        assert resource.key == f"printer:klipper:{PORT}"
        assert result.decision is Decision.ALLOW
        assert [entry[0] for entry in calls] == ["authorize", "service"]

    def test_policy_deny_blocks_service(self, client, calls, as_admin, monkeypatch):
        _force_deny(monkeypatch)

        response = client.post(TEMP_URL, data=TEMP_FORM)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []


@pytest.mark.parametrize(
    "url, form, service, action",
    [
        (CONSOLE_URL, CONSOLE_FORM, "send_console_command", Action.SEND_CONSOLE_COMMAND),
        (MACRO_URL, MACRO_FORM, "run_macro", Action.RUN_MACRO),
    ],
    ids=["console", "macro"],
)
class TestPrivilegedKlipperActions:
    """CURRENT era operador; TARGET es admin (D3-Q2, C-1)."""

    def test_anonymous_rejected(self, client, calls, url, form, service, action):
        response = client.post(url, data=form)

        assert response.status_code == 401
        assert _service_calls(calls) == []

    def test_operator_now_denied_before_service(self, client, calls, as_operator, url, form, service, action):
        response = client.post(url, data=form)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][4].reason is Reason.INSUFFICIENT_ROLE

    def test_admin_allowed(self, client, calls, as_admin, url, form, service, action):
        response = client.post(url, data=form)

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert [entry[1] for entry in _service_calls(calls)] == [service]

    def test_policy_called_with_principal_action_and_resource(self, client, calls, act_as, url, form, service, action):
        act_as("admin", user_id="u-admin")

        client.post(url, data=form)

        kind, principal, called_action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.id == "u-admin" and principal.role is Role.ADMIN
        assert called_action is action
        assert resource.key == f"printer:klipper:{PORT}"
        assert result.decision is Decision.ALLOW
        assert [entry[0] for entry in calls] == ["authorize", "service"]

    def test_policy_deny_blocks_service(self, client, calls, as_admin, monkeypatch, url, form, service, action):
        _force_deny(monkeypatch)

        response = client.post(url, data=form)

        assert response.status_code == 403
        assert _service_calls(calls) == []


class TestNoTemperatureBypassForOperator:
    """Dentro del panel de Klipper, el operador fija temperatura por la ruta
    dedicada y ya no tiene una vía equivalente por consola o macro."""

    def test_operator_cannot_send_m104_or_m140_through_console(self, client, calls, as_operator):
        for command in ("M104 S250", "M140 S100", "SET_HEATER_TEMPERATURE HEATER=extruder TARGET=250"):
            response = client.post(CONSOLE_URL, data={"port": str(PORT), "command": command})
            assert response.status_code == 403, command
        assert _service_calls(calls) == []

    def test_operator_cannot_heat_through_macro(self, client, calls, as_operator):
        response = client.post(MACRO_URL, data={"port": str(PORT), "macro": "PREHEAT_PLA"})

        assert response.status_code == 403
        assert _service_calls(calls) == []

    def test_operator_uses_dedicated_temperature_route(self, client, calls, as_operator):
        response = client.post(TEMP_URL, data=TEMP_FORM)

        assert response.status_code == 200
        assert [entry[1] for entry in _service_calls(calls)] == ["set_heater_target"]
