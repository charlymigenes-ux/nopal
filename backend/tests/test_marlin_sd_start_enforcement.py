"""Enforcement de las variantes SD de start_job en Marlin (ADR-006).

- POST /api/marlin-printers/sd/print/start      → start_job (archivo ya en la SD)
- POST /api/marlin-printers/sd/upload-and-print → start_job (sube a la SD y arranca)

CURRENT y TARGET coinciden (operador y admin), así que el comportamiento
visible no cambia. En upload-and-print se autoriza antes de resolver o leer el
archivo y antes de escribir en la SD: una petición denegada no escribe nada.
"""

import pytest

import backend.api.marlin_printers as marlin_printers_api
import backend.auth_deps as auth_deps
from backend import utils
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, Role

DEVICE = "/dev/ttyUSB0"
SD_START = "/api/marlin-printers/sd/print/start"
UPLOAD = "/api/marlin-printers/sd/upload-and-print"
SD_FORM = {"device": DEVICE, "filename": "PIEZA~1.GCO"}
UPLOAD_FORM = {"device": DEVICE, "path": "pieza.gcode", "section": "gcode", "preheat": "true"}
JOB = {"device": DEVICE, "source": "sd", "state": "printing"}

# (ruta, datos, servicio en el router)
ROUTES = [(SD_START, SD_FORM, "start_sd_print"), (UPLOAD, UPLOAD_FORM, "upload_and_start_sd_print")]
IDS = ["sd_print_start", "sd_upload_and_print"]


@pytest.fixture(autouse=True)
def library(tmp_path, monkeypatch):
    """Biblioteca de G-code aislada con un archivo real."""
    gcode_root = tmp_path / "gcode"
    gcode_root.mkdir()
    (gcode_root / "pieza.gcode").write_text("M104 S210\nG28\n", encoding="utf-8")
    monkeypatch.setattr(utils, "GCODE_ROOT", str(gcode_root))
    monkeypatch.setattr(utils, "MODELS_ROOT", str(tmp_path / "models"))
    return gcode_root


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, la consulta a la política, la resolución del
    archivo y las llamadas a los servicios (sin hardware). Los fakes de
    servicio representan también la escritura en la SD."""
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

    async def fake_start_sd_print(device, filename):
        log.append(("service", "start_sd_print", device, filename))
        return dict(JOB)

    async def fake_upload_and_start(device, filename, gcode_text, preheat=True):
        log.append(("service", "upload_and_start_sd_print", device, filename, gcode_text, preheat))
        return dict(JOB)

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(marlin_printers_api, "safe_section_path", spy_safe_section_path)
    monkeypatch.setattr(marlin_printers_api, "start_sd_print", fake_start_sd_print)
    monkeypatch.setattr(marlin_printers_api, "upload_and_start_sd_print", fake_upload_and_start)
    return log


@pytest.fixture
def act_as():
    def _set(role, user_id="u-1"):
        app.dependency_overrides[require_auth] = lambda: {"user_id": user_id, "username": user_id, "role": role}
    yield _set
    app.dependency_overrides.pop(require_auth, None)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


@pytest.mark.parametrize("url, form, service", ROUTES, ids=IDS)
class TestSdStartJobEnforcement:
    def test_anonymous_rejected_and_service_not_called(self, client, calls, url, form, service):
        response = client.post(url, data=form)

        assert response.status_code == 401  # require_auth, igual que antes
        assert _service_calls(calls) == []

    def test_operator_allowed(self, client, calls, as_operator, url, form, service):
        response = client.post(url, data=form)

        assert response.status_code == 200
        assert response.json() == JOB
        assert [entry[1] for entry in _service_calls(calls)] == [service]

    def test_admin_allowed(self, client, calls, as_admin, url, form, service):
        response = client.post(url, data=form)

        assert response.status_code == 200
        assert response.json() == JOB
        assert [entry[1] for entry in _service_calls(calls)] == [service]

    def test_policy_called_with_start_job_and_resource(self, client, calls, act_as, url, form, service):
        act_as("operador", user_id="u-oper")

        client.post(url, data=form)

        kind, principal, action, resource, result = calls[0]
        assert kind == "authorize"
        assert principal.id == "u-oper" and principal.role is Role.OPERATOR
        assert action is Action.START_JOB
        assert resource.key == f"printer:marlin:{DEVICE}"
        assert result.decision is Decision.ALLOW

    def test_policy_checked_first(self, client, calls, as_admin, url, form, service):
        client.post(url, data=form)

        assert calls[0][0] == "authorize"
        assert calls[-1][0] == "service"

    def test_unknown_role_denied_before_service(self, client, calls, act_as, url, form, service):
        act_as("operator")  # no es un rol de NOPAL (el interno es "operador")

        response = client.post(url, data=form)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []
        assert calls[-1][4].reason is Reason.NO_ROLE

    def test_policy_deny_blocks_everything(self, client, calls, as_admin, monkeypatch, url, form, service):
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )

        response = client.post(url, data=form)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert calls == []  # ni archivo resuelto ni servicio llamado


class TestUploadAndPrintSpecifics:
    def test_order_is_authorize_file_then_upload(self, client, calls, as_operator):
        client.post(UPLOAD, data=UPLOAD_FORM)

        assert [entry[0] for entry in calls] == ["authorize", "file", "service"]

    def test_service_receives_library_contents_and_preheat(self, client, calls, as_operator):
        client.post(UPLOAD, data={**UPLOAD_FORM, "preheat": "false"})

        assert _service_calls(calls) == [
            ("service", "upload_and_start_sd_print", DEVICE, "pieza.gcode", "M104 S210\nG28\n", False)
        ]

    def test_denied_request_does_not_write_to_sd(self, client, as_admin, monkeypatch):
        """La escritura en la SD ocurre dentro de upload_and_start_sd_print:
        con DENY ni siquiera se llama."""
        writes = []

        async def recording_upload(*args, **kwargs):
            writes.append(args)
            return dict(JOB)

        monkeypatch.setattr(marlin_printers_api, "upload_and_start_sd_print", recording_upload)
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )

        response = client.post(UPLOAD, data=UPLOAD_FORM)

        assert response.status_code == 403
        assert writes == []

    def test_missing_file_still_404(self, client, calls, as_operator):
        response = client.post(UPLOAD, data={**UPLOAD_FORM, "path": "no-existe.gcode"})

        assert response.status_code == 404
        assert response.json()["detail"] == "Archivo no encontrado"
        assert _service_calls(calls) == []


@pytest.mark.parametrize("url, form, service", ROUTES, ids=IDS)
def test_service_error_still_409(client, as_operator, monkeypatch, url, form, service):
    async def busy(*args, **kwargs):
        raise RuntimeError("Ya hay una impresión desde la SD en curso")
    monkeypatch.setattr(marlin_printers_api, service, busy)

    response = client.post(url, data=form)

    assert response.status_code == 409
    assert response.json()["detail"] == "Ya hay una impresión desde la SD en curso"
