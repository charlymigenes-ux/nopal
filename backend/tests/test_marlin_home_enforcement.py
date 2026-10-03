"""Cuarto enforcement de la Authorization Policy (ADR-006): home de Marlin.

POST /api/marlin-printers/home → home. CURRENT y TARGET coinciden (operador y
admin), así que el comportamiento visible no cambia. `move` (jog) no está
migrado.
"""

import pytest

import backend.api.marlin_printers as marlin_printers_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

URL = "/api/marlin-printers/home"
DEVICE = "/dev/ttyUSB0"


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

    async def fake_home(device, axes=None):
        log.append(("service", device, axes))
        return True

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(marlin_printers_api, "home", fake_home)
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
        response = client.post(URL, data={"device": DEVICE})

        assert response.status_code == 401  # require_auth, igual que antes
        assert _service_calls(calls) == []

    def test_operator_allowed(self, client, calls, as_operator):
        response = client.post(URL, data={"device": DEVICE, "axes": "XY"})

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", DEVICE, "XY")]

    def test_admin_allowed_without_axes(self, client, calls, as_admin):
        response = client.post(URL, data={"device": DEVICE})

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", DEVICE, None)]

    def test_service_failure_still_502(self, client, calls, as_operator, monkeypatch):
        async def failing_home(device, axes=None):
            return False
        monkeypatch.setattr(marlin_printers_api, "home", failing_home)

        response = client.post(URL, data={"device": DEVICE})

        assert response.status_code == 502
        assert response.json()["detail"] == "No se pudo iniciar el home"


class TestPolicyIsConsulted:
    def test_policy_called_with_principal_action_and_resource(self, client, calls, act_as):
        act_as("operador", user_id="u-oper")

        client.post(URL, data={"device": DEVICE})

        kind, principal, action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.id == "u-oper" and principal.role is Role.OPERATOR
        assert action is Action.HOME
        assert resource.key == f"printer:marlin:{DEVICE}"
        assert result.decision is Decision.ALLOW

    def test_policy_checked_before_service(self, client, calls, as_admin):
        client.post(URL, data={"device": DEVICE})

        assert [entry[0] for entry in calls] == ["authorize", "service"]


class TestPolicyDeny:
    def test_unknown_role_denied_before_service(self, client, calls, act_as):
        act_as("operator")  # no es un rol de NOPAL (el interno es "operador")

        response = client.post(URL, data={"device": DEVICE})

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][4].reason is Reason.NO_ROLE

    def test_policy_deny_blocks_service(self, client, as_admin, monkeypatch):
        service_calls = []

        async def recording_home(device, axes=None):
            service_calls.append(device)
            return True

        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )
        monkeypatch.setattr(marlin_printers_api, "home", recording_home)

        response = client.post(URL, data={"device": DEVICE})

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert service_calls == []
