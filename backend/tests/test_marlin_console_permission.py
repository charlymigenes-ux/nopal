"""Cambio real de permisos de ADR-006 (CURRENT → TARGET), panel de Marlin:
POST /api/marlin-printers/console → send_console_command, operador → ADMIN.

Cierra el bypass de consola del panel de Marlin: el operador fija temperatura
por su ruta dedicada (set_temperature, operador) pero ya no puede enviar
M104/M140 ni M3/M4 por consola.
"""

import pytest

import backend.api.marlin_printers as marlin_printers_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

URL = "/api/marlin-printers/console"
DEVICE = "/dev/ttyUSB0"
FORM = {"device": DEVICE, "command": "M115"}


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política y el envío de comandos
    (simulado: nada llega a una impresora real)."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    async def fake_send_console_command(device, command):
        log.append(("service", device, command))
        return True

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(marlin_printers_api, "send_console_command", fake_send_console_command)
    return log


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


class TestMarlinConsolePermission:
    def test_anonymous_rejected(self, client, calls):
        response = client.post(URL, data=FORM)

        assert response.status_code == 401
        assert _service_calls(calls) == []

    def test_operator_now_denied_before_service(self, client, calls, as_operator):
        response = client.post(URL, data=FORM)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][4].reason is Reason.INSUFFICIENT_ROLE

    def test_admin_allowed(self, client, calls, as_admin):
        response = client.post(URL, data=FORM)

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", DEVICE, "M115")]

    def test_admin_existing_error_unchanged(self, client, calls, as_admin, monkeypatch):
        async def failing(device, command):
            return False
        monkeypatch.setattr(marlin_printers_api, "send_console_command", failing)

        response = client.post(URL, data=FORM)

        assert response.status_code == 502
        assert response.json()["detail"] == "No se pudo enviar el comando"

    def test_policy_called_with_principal_action_and_resource(self, client, calls, act_as):
        act_as("admin", user_id="u-admin")

        client.post(URL, data=FORM)

        kind, principal, action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.id == "u-admin" and principal.role is Role.ADMIN
        assert action is Action.SEND_CONSOLE_COMMAND
        assert resource.key == f"printer:marlin:{DEVICE}"
        assert result.decision is Decision.ALLOW
        assert [entry[0] for entry in calls] == ["authorize", "service"]

    def test_policy_deny_blocks_service(self, client, calls, as_admin, monkeypatch):
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )

        response = client.post(URL, data=FORM)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []


class TestMarlinConsoleBypass:
    """El operador no puede usar la consola para saltarse otras reglas."""

    @pytest.mark.parametrize("command", ["M104 S250", "M140 S110", "M104 T1 S240", "M109 S250", "M190 S100"])
    def test_operator_cannot_heat_through_console(self, client, calls, as_operator, command):
        response = client.post(URL, data={"device": DEVICE, "command": command})

        assert response.status_code == 403
        assert _service_calls(calls) == []

    @pytest.mark.parametrize("command", ["M3 S1000", "M4 S500", "M5"])
    def test_operator_cannot_drive_laser_or_spindle_through_console(self, client, calls, as_operator, command):
        """La consola reenvía la línea tal cual, así que también podría mandar
        M3/M4; quedan cubiertos por la misma regla (consola = admin)."""
        response = client.post(URL, data={"device": DEVICE, "command": command})

        assert response.status_code == 403
        assert _service_calls(calls) == []

    def test_operator_still_sets_temperature_through_dedicated_route(self, client, monkeypatch, as_operator):
        sent = []
        monkeypatch.setattr(marlin_printers_api, "set_heater_target", lambda device, heater, target: sent.append((heater, target)) or True)

        response = client.post("/api/marlin-printers/temperature-target", data={"device": DEVICE, "heater": "extruder", "target": "210"})

        assert response.status_code == 200
        assert sent == [("extruder", 210.0)]
