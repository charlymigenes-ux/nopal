"""Bloque seguro de enforcement de Marlin (ADR-006): rutas donde CURRENT ==
TARGET (operador y admin permitidos), migradas sin cambio visible.

- POST /api/marlin-printers/jog          → move
- GET  /api/marlin-printers/status       → view_status
- GET  /api/marlin-printers/temperatures → view_status
- GET  /api/marlin-printers/print/status → view_status
"""

import pytest

import backend.api.marlin_printers as marlin_printers_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

DEVICE = "/dev/ttyUSB0"
STATUS = {"state": "idle", "position": {"X": 0.0}}
TEMPS = {"heaters": [{"name": "extruder", "temperature": 25.0, "target": 0.0}]}
JOB = {"active": False}

# (método, ruta, datos, servicio en el router, acción, valor del servicio, respuesta 200 esperada)
ROUTES = [
    ("post", "/api/marlin-printers/jog",
     {"device": DEVICE, "axis": "X", "distance": "10", "feed": "1200"},
     "jog", Action.MOVE, True, {"success": True}),
    ("get", "/api/marlin-printers/status", {"device": DEVICE},
     "get_status", Action.VIEW_STATUS, STATUS, {"connected": True, "device": DEVICE, "firmware": "marlin", **STATUS}),
    ("get", "/api/marlin-printers/temperatures", {"device": DEVICE},
     "get_temperature_snapshot", Action.VIEW_STATUS, TEMPS, TEMPS),
    ("get", "/api/marlin-printers/print/status", {"device": DEVICE},
     "get_job_status", Action.VIEW_STATUS, JOB, JOB),
]
IDS = ["jog", "status", "temperatures", "print_status"]


def _request(client, method, url, data):
    if method == "get":
        return client.get(url, params=data)
    return client.post(url, data=data)


def _fake_service(name, value, log):
    async def fake(*args, **kwargs):
        log.append(("service", name, args))
        return value
    return fake


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def spy(monkeypatch):
    """Registra, en orden, la consulta a la política y la llamada al servicio."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    return log


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


@pytest.mark.parametrize("method, url, data, service, action, value, expected", ROUTES, ids=IDS)
class TestMarlinSafeBlock:
    def test_anonymous_rejected_and_service_not_called(self, client, spy, monkeypatch, method, url, data, service, action, value, expected):
        monkeypatch.setattr(marlin_printers_api, service, _fake_service(service, value, spy))

        response = _request(client, method, url, data)

        assert response.status_code == 401  # require_auth, igual que antes
        assert _service_calls(spy) == []

    def test_operator_allowed(self, client, spy, monkeypatch, as_operator, method, url, data, service, action, value, expected):
        monkeypatch.setattr(marlin_printers_api, service, _fake_service(service, value, spy))

        response = _request(client, method, url, data)

        assert response.status_code == 200
        assert response.json() == expected
        assert len(_service_calls(spy)) == 1

    def test_admin_allowed(self, client, spy, monkeypatch, as_admin, method, url, data, service, action, value, expected):
        monkeypatch.setattr(marlin_printers_api, service, _fake_service(service, value, spy))

        response = _request(client, method, url, data)

        assert response.status_code == 200
        assert response.json() == expected
        assert len(_service_calls(spy)) == 1

    def test_policy_called_with_principal_action_and_resource(self, client, spy, monkeypatch, act_as, method, url, data, service, action, value, expected):
        monkeypatch.setattr(marlin_printers_api, service, _fake_service(service, value, spy))
        act_as("operador", user_id="u-oper")

        _request(client, method, url, data)

        kind, principal, called_action, resource, result = spy[0]
        assert kind == "authorize"
        assert principal.id == "u-oper" and principal.role is Role.OPERATOR
        assert called_action is action
        assert resource.key == f"printer:marlin:{DEVICE}"
        assert result.decision is Decision.ALLOW

    def test_policy_checked_before_service(self, client, spy, monkeypatch, as_admin, method, url, data, service, action, value, expected):
        monkeypatch.setattr(marlin_printers_api, service, _fake_service(service, value, spy))

        _request(client, method, url, data)

        assert [entry[0] for entry in spy] == ["authorize", "service"]

    def test_unknown_role_denied_before_service(self, client, spy, monkeypatch, act_as, method, url, data, service, action, value, expected):
        monkeypatch.setattr(marlin_printers_api, service, _fake_service(service, value, spy))
        act_as("operator")  # no es un rol de NOPAL (el interno es "operador")

        response = _request(client, method, url, data)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(spy) == []
        assert spy[-1][4].reason is Reason.NO_ROLE

    def test_policy_deny_blocks_service(self, client, monkeypatch, as_admin, method, url, data, service, action, value, expected):
        log = []
        monkeypatch.setattr(marlin_printers_api, service, _fake_service(service, value, log))
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, a, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, a, resource),
        )

        response = _request(client, method, url, data)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert log == []


class TestExistingResponsesUnchanged:
    def test_jog_failure_still_502(self, client, monkeypatch, as_operator):
        async def failing_jog(device, axis, distance, feed):
            return False
        monkeypatch.setattr(marlin_printers_api, "jog", failing_jog)

        response = client.post("/api/marlin-printers/jog", data=ROUTES[0][2])

        assert response.status_code == 502
        assert response.json()["detail"] == "No se pudo mover el eje"

    def test_status_disconnected_unchanged(self, client, monkeypatch, as_operator):
        async def no_status(device, timeout=4.0):
            return None
        monkeypatch.setattr(marlin_printers_api, "get_status", no_status)

        response = client.get("/api/marlin-printers/status", params={"device": DEVICE})

        assert response.status_code == 200
        assert response.json() == {"connected": False, "device": DEVICE}
