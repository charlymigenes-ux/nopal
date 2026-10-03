"""Tercer enforcement de la Authorization Policy (ADR-006): iniciar un
trabajo de Marlin desde la biblioteca.

POST /api/marlin-printers/print/start → start_job. CURRENT y TARGET coinciden
(operador y admin), así que el comportamiento visible no cambia. Las variantes
de SD, cola y programadas no están migradas.
"""

import pytest

import backend.api.marlin_printers as marlin_printers_api
import backend.auth_deps as auth_deps
from backend import utils
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

URL = "/api/marlin-printers/print/start"
DEVICE = "/dev/ttyUSB0"
FORM = {"device": DEVICE, "path": "pieza.gcode", "section": "gcode"}
JOB = {"device": DEVICE, "filename": "pieza.gcode", "state": "printing"}


@pytest.fixture(autouse=True)
def library(tmp_path, monkeypatch):
    """Biblioteca de G-code aislada con un archivo real."""
    gcode_root = tmp_path / "gcode"
    gcode_root.mkdir()
    (gcode_root / "pieza.gcode").write_text("G28\nG1 X10\n", encoding="utf-8")
    monkeypatch.setattr(utils, "GCODE_ROOT", str(gcode_root))
    monkeypatch.setattr(utils, "MODELS_ROOT", str(tmp_path / "models"))
    return gcode_root


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política, la resolución del
    archivo y la llamada al servicio Marlin (sin hardware)."""
    log = []
    real_authorize = auth_deps.authorize
    real_safe_section_path = marlin_printers_api.safe_section_path

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    def spy_safe_section_path(section, path):
        log.append(("file", section, path))
        return real_safe_section_path(section, path)

    def fake_start_print(device, gcode_text, filename=None):
        log.append(("service", device, gcode_text, filename))
        return dict(JOB)

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(marlin_printers_api, "safe_section_path", spy_safe_section_path)
    monkeypatch.setattr(marlin_printers_api, "start_print", fake_start_print)
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

    def test_operator_allowed(self, client, calls, as_operator):
        response = client.post(URL, data=FORM)

        assert response.status_code == 200
        assert response.json() == JOB
        assert _service_calls(calls) == [("service", DEVICE, "G28\nG1 X10\n", "pieza.gcode")]

    def test_admin_allowed(self, client, calls, as_admin):
        response = client.post(URL, data=FORM)

        assert response.status_code == 200
        assert response.json() == JOB
        assert len(_service_calls(calls)) == 1

    def test_missing_file_still_404(self, client, calls, as_operator):
        response = client.post(URL, data={**FORM, "path": "no-existe.gcode"})

        assert response.status_code == 404
        assert response.json()["detail"] == "Archivo no encontrado"
        assert _service_calls(calls) == []

    def test_service_error_still_409(self, client, calls, as_operator, monkeypatch):
        def busy(device, gcode_text, filename=None):
            raise RuntimeError("La impresora ya está imprimiendo")
        monkeypatch.setattr(marlin_printers_api, "start_print", busy)

        response = client.post(URL, data=FORM)

        assert response.status_code == 409
        assert response.json()["detail"] == "La impresora ya está imprimiendo"


class TestPolicyIsConsulted:
    def test_policy_called_with_principal_action_and_resource(self, client, calls, act_as):
        act_as("operador", user_id="u-oper")

        client.post(URL, data=FORM)

        kind, principal, action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.id == "u-oper" and principal.role is Role.OPERATOR
        assert action is Action.START_JOB
        assert resource.key == f"printer:marlin:{DEVICE}"
        assert result.decision is Decision.ALLOW

    def test_policy_checked_before_file_and_service(self, client, calls, as_admin):
        client.post(URL, data=FORM)

        assert [entry[0] for entry in calls] == ["authorize", "file", "service"]


class TestPolicyDeny:
    def test_unknown_role_denied_before_service(self, client, calls, act_as):
        act_as("operator")  # no es un rol de NOPAL (el interno es "operador")

        response = client.post(URL, data=FORM)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][4].reason is Reason.NO_ROLE

    def test_policy_deny_blocks_file_access_and_service(self, client, calls, as_admin, monkeypatch):
        """Con DENY no se resuelve ni se lee el archivo, ni se llama al servicio."""
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )

        response = client.post(URL, data=FORM)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert calls == []
