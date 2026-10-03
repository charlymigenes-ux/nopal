"""Tercer cambio real de permisos de ADR-006 (CURRENT → TARGET), panel de
Klipper: POST /api/printers/{port}/firmware-restart → firmware_restart,
operador → ADMIN. Cambio funcional deliberado: el operador deja de poder
reiniciar el firmware del MCU desde el panel.
"""

import pytest

import backend.api.printers as printers_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

PORT = 7125
URL = f"/api/printers/{PORT}/firmware-restart"


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política y la llamada al servicio
    de firmware restart (simulado: nunca se reinicia nada real)."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    def fake_firmware_restart(port):
        log.append(("service", port))
        return True

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(printers_api, "firmware_restart_printer", fake_firmware_restart)
    return log


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


def test_anonymous_rejected(client, calls):
    response = client.post(URL)

    assert response.status_code == 401
    assert _service_calls(calls) == []


def test_operator_now_denied_and_never_reaches_service(client, calls, as_operator):
    response = client.post(URL)

    assert response.status_code == 403
    assert response.json()["detail"] == "Permiso insuficiente"
    assert _service_calls(calls) == []
    assert [entry[0] for entry in calls] == ["authorize"]
    assert calls[0][4].reason is Reason.INSUFFICIENT_ROLE


def test_admin_allowed(client, calls, as_admin):
    response = client.post(URL)

    assert response.status_code == 200
    assert response.json() == {"success": True}
    assert _service_calls(calls) == [("service", PORT)]


def test_admin_existing_error_unchanged(client, calls, as_admin, monkeypatch):
    monkeypatch.setattr(printers_api, "firmware_restart_printer", lambda port: False)

    response = client.post(URL)

    assert response.status_code == 400
    assert response.json()["detail"] == "No se pudo reiniciar el firmware"


def test_policy_called_with_principal_action_and_resource(client, calls, act_as):
    act_as("admin", user_id="u-admin")

    client.post(URL)

    kind, principal, action, resource, result = calls[0]
    assert kind == "authorize"
    assert principal.id == "u-admin" and principal.role is Role.ADMIN
    assert action is Action.FIRMWARE_RESTART
    assert resource.key == f"printer:klipper:{PORT}"
    assert result.decision is Decision.ALLOW
    assert [entry[0] for entry in calls] == ["authorize", "service"]


def test_policy_deny_blocks_service(client, calls, as_admin, monkeypatch):
    monkeypatch.setattr(
        auth_deps, "authorize",
        lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
    )

    response = client.post(URL)

    assert response.status_code == 403
    assert response.json()["detail"] == "Permiso insuficiente"
    assert _service_calls(calls) == []
