"""Segundo enforcement de la Authorization Policy (ADR-006): pausar, reanudar
y cancelar trabajos de Marlin.

POST /api/marlin-printers/print/{pause,resume,cancel} → pause / resume / cancel.
CURRENT y TARGET coinciden (operador y admin), así que el comportamiento
visible no cambia; los tests verifican además que la política se consulta
antes de tocar el servicio.
"""

import pytest

import backend.api.marlin_printers as marlin_printers_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

DEVICE = "/dev/ttyUSB0"

# (ruta, nombre del servicio en el router, acción canónica, mensaje 409 actual)
OPERATIONS = [
    ("/api/marlin-printers/print/pause", "pause_job", Action.PAUSE, "No hay una impresión en curso para pausar"),
    ("/api/marlin-printers/print/resume", "resume_job", Action.RESUME, "No hay una impresión pausada para reanudar"),
    ("/api/marlin-printers/print/cancel", "cancel_job", Action.CANCEL, "No hay una impresión en curso para cancelar"),
]
IDS = ["pause", "resume", "cancel"]


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política y las llamadas a los
    servicios Marlin (sin hardware)."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    for _, service_name, _, _ in OPERATIONS:
        async def fake_service(device, _name=service_name):
            log.append(("service", _name, device))
            return True
        monkeypatch.setattr(marlin_printers_api, service_name, fake_service)
    return log


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


@pytest.mark.parametrize("url, service_name, action, conflict_detail", OPERATIONS, ids=IDS)
class TestJobControlEnforcement:
    def test_anonymous_rejected_and_service_not_called(self, client, calls, url, service_name, action, conflict_detail):
        response = client.post(url, data={"device": DEVICE})

        assert response.status_code == 401  # require_auth, igual que antes
        assert _service_calls(calls) == []

    def test_operator_allowed(self, client, calls, as_operator, url, service_name, action, conflict_detail):
        response = client.post(url, data={"device": DEVICE})

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", service_name, DEVICE)]

    def test_admin_allowed(self, client, calls, as_admin, url, service_name, action, conflict_detail):
        response = client.post(url, data={"device": DEVICE})

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", service_name, DEVICE)]

    def test_existing_conflict_response_unchanged(self, client, calls, as_operator, monkeypatch, url, service_name, action, conflict_detail):
        async def no_job(device):
            return False
        monkeypatch.setattr(marlin_printers_api, service_name, no_job)

        response = client.post(url, data={"device": DEVICE})

        assert response.status_code == 409
        assert response.json()["detail"] == conflict_detail

    def test_policy_called_with_canonical_action_and_resource(self, client, calls, act_as, url, service_name, action, conflict_detail):
        act_as("operador", user_id="u-oper")

        client.post(url, data={"device": DEVICE})

        kind, principal, called_action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.id == "u-oper" and principal.role is Role.OPERATOR
        assert called_action is action
        assert resource.key == f"printer:marlin:{DEVICE}"
        assert result.decision is Decision.ALLOW

    def test_policy_checked_before_service(self, client, calls, as_admin, url, service_name, action, conflict_detail):
        client.post(url, data={"device": DEVICE})

        assert [entry[0] for entry in calls] == ["authorize", "service"]

    def test_unknown_role_denied_before_service(self, client, calls, act_as, url, service_name, action, conflict_detail):
        act_as("operator")  # no es un rol de NOPAL (el interno es "operador")

        response = client.post(url, data={"device": DEVICE})

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][4].reason is Reason.NO_ROLE

    def test_policy_deny_blocks_service(self, client, as_admin, monkeypatch, url, service_name, action, conflict_detail):
        service_calls = []

        async def recording_service(device):
            service_calls.append(device)
            return True

        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, a, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, a, resource),
        )
        monkeypatch.setattr(marlin_printers_api, service_name, recording_service)

        response = client.post(url, data={"device": DEVICE})

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert service_calls == []
