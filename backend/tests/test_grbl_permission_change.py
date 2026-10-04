"""Cambio real de permisos de ADR-006 (CURRENT → TARGET), panel GRBL/láser/CNC:

- POST /api/laser/console  → send_console_command: operador → ADMIN
- POST /api/laser/settings → grbl_settings:        operador → ADMIN

POST /api/laser/command (ruta genérica de acciones mixtas) se cubre aparte,
en test_laser_command_enforcement.py.
"""

import pytest

import backend.api.laser as laser_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

HOST = "192.168.0.61"
CNC_HOST = "192.168.0.72"
CONSOLE_URL = "/api/laser/console"
SETTINGS_URL = "/api/laser/settings"
CONSOLE_FORM = {"command": "?", "host": HOST}
SETTINGS_FORM = {"key": "$110", "value": "3000", "host": HOST}

# (ruta, datos, servicio en el router, acción)
ROUTES = [
    (CONSOLE_URL, CONSOLE_FORM, "send_console_command", Action.SEND_CONSOLE_COMMAND),
    (SETTINGS_URL, SETTINGS_FORM, "set_grbl_setting", Action.GRBL_SETTINGS),
]
IDS = ["console", "grbl_settings"]


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política y las llamadas a los
    servicios del láser (simulados: nada llega a una placa real)."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    async def fake_send_console_command(host, command):
        log.append(("service", "send_console_command", host, command))
        return True

    async def fake_set_grbl_setting(host, key, value):
        log.append(("service", "set_grbl_setting", host, key, value))
        return {"success": True}

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(laser_api, "send_console_command", fake_send_console_command)
    monkeypatch.setattr(laser_api, "set_grbl_setting", fake_set_grbl_setting)
    monkeypatch.setattr(laser_api, "job_active", lambda host: False)
    monkeypatch.setattr(laser_api, "get_active_host", lambda: HOST)
    monkeypatch.setattr(laser_api, "get_registered_lasers", lambda: [
        {"host": HOST, "kind": "laser"},
        {"host": CNC_HOST, "kind": "cnc"},
    ])
    return log


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


@pytest.mark.parametrize("url, form, service, action", ROUTES, ids=IDS)
class TestGrblPrivilegedRoutes:
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
        assert resource.key == f"laser:laser:{HOST}"
        assert result.decision is Decision.ALLOW
        assert [entry[0] for entry in calls] == ["authorize", "service"]

    def test_cnc_resource_uses_cnc_kind(self, client, calls, as_admin, url, form, service, action):
        client.post(url, data={**form, "host": CNC_HOST})

        assert calls[0][3].key == f"cnc:laser:{CNC_HOST}"

    def test_active_host_used_when_host_omitted(self, client, calls, as_admin, url, form, service, action):
        data = {k: v for k, v in form.items() if k != "host"}

        client.post(url, data=data)

        assert calls[0][3].key == f"laser:laser:{HOST}"

    def test_policy_deny_blocks_service(self, client, calls, as_admin, monkeypatch, url, form, service, action):
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, a, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, a, resource),
        )

        response = client.post(url, data=form)

        assert response.status_code == 403
        assert _service_calls(calls) == []

    def test_operator_denied_even_with_job_active(self, client, calls, as_operator, monkeypatch, url, form, service, action):
        """La autorización ocurre antes del chequeo de trabajo en curso."""
        monkeypatch.setattr(laser_api, "job_active", lambda host: True)

        response = client.post(url, data=form)

        assert response.status_code == 403


class TestExistingAdminResponsesUnchanged:
    def test_console_failure_still_502(self, client, calls, as_admin, monkeypatch):
        async def failing(host, command):
            return False
        monkeypatch.setattr(laser_api, "send_console_command", failing)

        response = client.post(CONSOLE_URL, data=CONSOLE_FORM)

        assert response.status_code == 502
        assert response.json()["detail"] == "No se pudo enviar el comando"

    def test_settings_failure_keeps_service_message(self, client, calls, as_admin, monkeypatch):
        async def failing(host, key, value):
            return {"success": False, "message": "Ajustes no editables en Marlin desde NOPAL"}
        monkeypatch.setattr(laser_api, "set_grbl_setting", failing)

        response = client.post(SETTINGS_URL, data=SETTINGS_FORM)

        assert response.status_code == 502
        assert response.json()["detail"] == "Ajustes no editables en Marlin desde NOPAL"

    def test_job_active_still_409_for_admin(self, client, calls, as_admin, monkeypatch):
        monkeypatch.setattr(laser_api, "job_active", lambda host: True)

        response = client.post(CONSOLE_URL, data=CONSOLE_FORM)

        assert response.status_code == 409
        assert _service_calls(calls) == []


class TestGrblBypass:
    """El operador no puede usar la consola ni los settings para controlar
    potencia/husillo o cambiar la configuración de la placa."""

    @pytest.mark.parametrize("command", ["M3 S1000", "M4 S500", "M5", "M3 S0", "$32=0", "$110=9000", "$RST=*"])
    def test_operator_console_cannot_send_power_spindle_or_settings(self, client, calls, as_operator, command):
        response = client.post(CONSOLE_URL, data={"command": command, "host": HOST})

        assert response.status_code == 403
        assert _service_calls(calls) == []

    @pytest.mark.parametrize("key, value", [("$32", "0"), ("$30", "1000"), ("$130", "800"), ("$20", "0")])
    def test_operator_cannot_change_grbl_settings(self, client, calls, as_operator, key, value):
        response = client.post(SETTINGS_URL, data={"key": key, "value": value, "host": HOST})

        assert response.status_code == 403
        assert _service_calls(calls) == []
