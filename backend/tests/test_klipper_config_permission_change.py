"""Segundo cambio real de permisos de ADR-006 (CURRENT → TARGET), panel de
Klipper:

- POST /api/printers/{port}/config-files/content → printer_config:  operador → ADMIN
- POST /api/printers/{port}/restart              → restart_klipper: operador → ADMIN

Son cambios funcionales deliberados: el operador deja de poder modificar
printer.cfg y de reiniciar Klipper desde el panel.
"""

import pytest

import backend.api.printers as printers_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

PORT = 7125
CONFIG_URL = f"/api/printers/{PORT}/config-files/content"
RESTART_URL = f"/api/printers/{PORT}/restart"
CONFIG_FORM = {"path": "printer.cfg", "content": "[printer]\nkinematics: corexy\n"}

# (ruta, datos, servicio en el router, acción)
ROUTES = [
    (CONFIG_URL, CONFIG_FORM, "save_printer_config_file", Action.PRINTER_CONFIG),
    (RESTART_URL, None, "restart_printer_klipper", Action.RESTART_KLIPPER),
]
IDS = ["printer_config", "restart_klipper"]


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política, la validación de la ruta
    del archivo y las llamadas a los servicios (sin Moonraker real: ni se
    escribe printer.cfg ni se reinicia nada)."""
    log = []
    real_authorize = auth_deps.authorize
    real_is_safe = printers_api.is_safe_config_path

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    def spy_is_safe(path):
        log.append(("validate", path))
        return real_is_safe(path)

    def fake_save(port, path, content):
        log.append(("service", "save_printer_config_file", port, path, content))
        return True

    def fake_restart(port):
        log.append(("service", "restart_printer_klipper", port))
        return True

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(printers_api, "is_safe_config_path", spy_is_safe)
    monkeypatch.setattr(printers_api, "save_printer_config_file", fake_save)
    monkeypatch.setattr(printers_api, "restart_printer_klipper", fake_restart)
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
class TestKlipperConfigPermissionChange:
    def test_anonymous_rejected(self, client, calls, url, form, service, action):
        response = client.post(url, data=form)

        assert response.status_code == 401
        assert _service_calls(calls) == []

    def test_operator_now_denied_before_service(self, client, calls, as_operator, url, form, service, action):
        response = client.post(url, data=form)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][0] == "authorize"
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
        assert calls[0][0] == "authorize" and calls[-1][0] == "service"

    def test_policy_deny_blocks_service(self, client, calls, as_admin, monkeypatch, url, form, service, action):
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, a, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, a, resource),
        )

        response = client.post(url, data=form)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []


class TestPrinterConfigSpecifics:
    def test_operator_cannot_modify_printer_cfg_even_with_valid_payload(self, client, calls, as_operator):
        """El servicio de escritura nunca se llama para un operador, y la
        autorización ocurre antes incluso de validar la ruta del archivo."""
        for path in ("printer.cfg", "macros.cfg", "printer_data/config/printer.cfg"):
            response = client.post(CONFIG_URL, data={"path": path, "content": "[gcode_macro X]\ngcode: M104 S250\n"})
            assert response.status_code == 403, path
        assert _service_calls(calls) == []
        assert [entry[0] for entry in calls if entry[0] != "authorize"] == []

    def test_admin_order_is_authorize_validate_write(self, client, calls, as_admin):
        client.post(CONFIG_URL, data=CONFIG_FORM)

        assert [entry[0] for entry in calls] == ["authorize", "validate", "service"]
        assert _service_calls(calls) == [("service", "save_printer_config_file", PORT, "printer.cfg", CONFIG_FORM["content"])]

    def test_admin_existing_errors_unchanged(self, client, calls, as_admin, monkeypatch):
        invalid = client.post(CONFIG_URL, data={"path": "../../etc/passwd", "content": "x"})
        assert invalid.status_code == 400 and invalid.json()["detail"] == "Ruta inválida"

        monkeypatch.setattr(printers_api, "save_printer_config_file", lambda port, path, content: False)
        failed = client.post(CONFIG_URL, data=CONFIG_FORM)
        assert failed.status_code == 400 and failed.json()["detail"] == "No se pudo guardar el archivo"


class TestRestartSpecifics:
    def test_admin_existing_error_unchanged(self, client, calls, as_admin, monkeypatch):
        monkeypatch.setattr(printers_api, "restart_printer_klipper", lambda port: False)

        response = client.post(RESTART_URL)

        assert response.status_code == 400
        assert response.json()["detail"] == "No se pudo reiniciar Klipper"

    def test_operator_cannot_restart(self, client, calls, as_operator):
        response = client.post(RESTART_URL)

        assert response.status_code == 403
        assert _service_calls(calls) == []
