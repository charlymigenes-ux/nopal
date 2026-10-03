"""Primer enforcement de la Authorization Policy (ADR-006):
POST /api/marlin-printers/temperature-target → set_temperature.

CURRENT y TARGET coinciden (operador y admin pueden fijar temperatura en
Marlin), así que el comportamiento visible no cambia. Los tests verifican
además que la política se consulta antes de tocar el servicio Marlin.
"""

import pytest

import backend.api.marlin_printers as marlin_printers_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, Decision, PrincipalKind, Reason, AuthorizationResult, Role

URL = "/api/marlin-printers/temperature-target"
FORM = {"device": "/dev/ttyUSB0", "heater": "extruder", "target": "210"}


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política y la llamada al servicio
    Marlin (sin hardware)."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    def fake_set_heater_target(device, heater, target):
        log.append(("service", device, heater, target))
        return True

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(marlin_printers_api, "set_heater_target", fake_set_heater_target)
    return log


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


class TestCompatibility:
    def test_anonymous_rejected_and_service_not_called(self, client, calls):
        response = client.post(URL, data=FORM)

        assert response.status_code == 401  # require_auth, igual que antes
        assert _service_calls(calls) == []

    @pytest.mark.parametrize("role", ["operador", "admin"])
    def test_operator_and_admin_allowed(self, client, calls, act_as, role):
        act_as(role)

        response = client.post(URL, data=FORM)

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", "/dev/ttyUSB0", "extruder", 210.0)]

    def test_service_failure_still_502(self, client, calls, act_as, monkeypatch):
        act_as("operador")
        monkeypatch.setattr(marlin_printers_api, "set_heater_target", lambda device, heater, target: False)

        response = client.post(URL, data=FORM)

        assert response.status_code == 502
        assert response.json()["detail"] == "No se pudo actualizar la temperatura objetivo"


class TestPolicyIsConsulted:
    def test_policy_called_with_principal_action_and_resource(self, client, calls, act_as):
        act_as("operador", user_id="u-oper")

        client.post(URL, data=FORM)

        kind, principal, action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.kind is PrincipalKind.USER
        assert principal.id == "u-oper"
        assert principal.role is Role.OPERATOR
        assert action is Action.SET_TEMPERATURE
        assert resource.key == "printer:marlin:/dev/ttyUSB0"
        assert result.decision is Decision.ALLOW

    def test_policy_checked_before_service(self, client, calls, act_as):
        act_as("admin")

        client.post(URL, data=FORM)

        assert [entry[0] for entry in calls] == ["authorize", "service"]


class TestPolicyDeny:
    def test_unknown_role_denied_before_service(self, client, calls, act_as):
        """Un rol que la política no reconoce no llega al servicio."""
        act_as("operator")  # no es un rol de NOPAL (el interno es "operador")

        response = client.post(URL, data=FORM)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][4].reason is Reason.NO_ROLE

    def test_policy_deny_blocks_service(self, client, act_as, monkeypatch):
        """Si la política deniega, la operación no se ejecuta aunque el
        usuario tenga un rol válido."""
        act_as("admin")
        service_calls = []
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )
        monkeypatch.setattr(marlin_printers_api, "set_heater_target", lambda *args: service_calls.append(args) or True)

        response = client.post(URL, data=FORM)

        assert response.status_code == 403
        assert service_calls == []
