"""POST /api/laser/command: ruta genérica de acciones mixtas (ADR-006).

El comando se descompone en las acciones que contiene y se autorizan todas
antes de enviarlo. Operación normal (move, home, cero de trabajo, palpado,
air assist, refrigerante, overrides de avance) sigue siendo de operador;
potencia/husillo (M3/M4/M5, palabra S) y settings `$…=…` son de admin; lo no
reconocido es consola (admin). `$X` y los overrides de potencia quedan NOT
COVERED (solo sesión, sin cambio de permisos).
"""

import pytest

import backend.api.laser as laser_api
import backend.auth_deps as auth_deps
from backend.auth_deps import require_auth
from backend.main import app
from backend.services.authorization_policy import Action, AuthorizationResult, Decision, Reason, ResourceKind
from backend.services.laser_command_classifier import classify_laser_command

URL = "/api/laser/command"
HOST = "192.168.0.61"
CNC_HOST = "192.168.0.72"
L, C = ResourceKind.LASER, ResourceKind.CNC

# Comandos que el panel manda hoy por esta ruta (app.js) y su acción esperada.
FRONTEND_OPERATOR_COMMANDS = {
    "G90 G21 G0 X10.00 Y20.00 F3000": {Action.MOVE},
    "G92 X0 Y0": {Action.SET_WORK_ZERO},
    "G54": {Action.SET_WORK_ZERO},
    "\x18": {Action.CANCEL},
    "G38.2 Z-10 F100": {Action.MOVE},
    "G10 L20 P0 X1.000 Y2.000": {Action.SET_WORK_ZERO},
    "G10 L20 P0 Z0.000": {Action.SET_WORK_ZERO},
    "$H": {Action.HOME},
    chr(0x91): {Action.SET_SPEED_FACTOR},
    chr(0x94): {Action.SET_SPEED_FACTOR},
    "M8": {Action.SET_AIR_ASSIST},
    "M9": {Action.SET_AIR_ASSIST},
}

# Formas de colar potencia/husillo o settings que GRBL sí ejecutaría.
OPERATOR_BYPASS_ATTEMPTS = [
    "M3", "M3 S1000", "m3 s1000", "M 3 S 1000", "M03S1000", "M3.0 S1", "M4 S500", "M5", "S500",
    "G0 X10 M3 S1000",              # potencia en el mismo bloque que un movimiento
    "G0 X10\nM3 S1000",             # segunda línea en la misma petición
    "G0 X10\rM4 S1",                # retorno de carro como separador
    "(nota)M3 S1000",               # comentario delante
    "G0 X1 (nota) M4 S1",           # comentario en medio
    "$J=G91 X10 F1000 S1000",       # palabra S dentro de un jog
    "G1 X10 F500 S800",             # movimiento con potencia
    "$32=0", "$30=1000", "$110 = 9000", "$RST=*", "$N0=M3 S1000",
    "M106", "G28.1", "%", "T1 M6",  # no reconocidos → consola (admin)
    "G0 X1" + chr(0xC0),            # byte realtime desconocido
]


class TestClassifier:
    @pytest.mark.parametrize("command, expected", FRONTEND_OPERATOR_COMMANDS.items())
    def test_frontend_commands_map_to_operator_actions(self, command, expected):
        assert classify_laser_command(command, L).actions == frozenset(expected)

    def test_power_and_coolant_depend_on_machine_kind(self):
        assert classify_laser_command("M3 S1000", L).actions == {Action.SET_LASER_POWER}
        assert classify_laser_command("M3 S1000", C).actions == {Action.SET_SPINDLE}
        assert classify_laser_command("M8", L).actions == {Action.SET_AIR_ASSIST}
        assert classify_laser_command("M8", C).actions == {Action.SET_COOLANT}

    def test_mixed_request_contains_every_action(self):
        assert classify_laser_command("G0 X10\nM3 S1000", L).actions == {Action.MOVE, Action.SET_LASER_POWER}

    def test_realtime_byte_inside_a_line_is_detected(self):
        assert classify_laser_command("G0 X1?", L).actions == {Action.MOVE, Action.VIEW_STATUS}

    def test_settings_and_unknown_commands(self):
        assert classify_laser_command("$32=0", L).actions == {Action.GRBL_SETTINGS}
        assert classify_laser_command("M106", L).actions == {Action.SEND_CONSOLE_COMMAND}
        assert classify_laser_command("G4 P1", L).actions == {Action.SEND_CONSOLE_COMMAND}

    def test_comments_are_ignored_like_grbl(self):
        """GRBL descarta los comentarios: un M3 comentado no se ejecuta."""
        assert classify_laser_command("G0 X1 (M3 S1000)", L).actions == {Action.MOVE}
        assert classify_laser_command("G0 X1 ; M3 S1000", L).actions == {Action.MOVE}

    def test_not_covered_parts(self):
        unlock = classify_laser_command("$X", L)
        assert unlock.actions == frozenset() and unlock.uncovered == ("$X",)
        override = classify_laser_command(chr(0x9A), C)
        assert override.actions == frozenset() and override.uncovered == ("0x9A",)

    def test_empty_command_is_view_only(self):
        assert classify_laser_command("", L).actions == {Action.VIEW_STATUS}


@pytest.fixture
def calls(monkeypatch):
    """Registra, en orden, las consultas a la política y el envío del comando
    (simulado: nada llega a una placa real)."""
    log = []
    real_authorize = auth_deps.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    async def ready(host):
        return None

    def fake_send_raw_command(host, command):
        log.append(("service", host, command))
        return True

    monkeypatch.setattr(auth_deps, "authorize", spy_authorize)
    monkeypatch.setattr(laser_api, "ensure_listener_ready", ready)
    monkeypatch.setattr(laser_api, "send_raw_command", fake_send_raw_command)
    monkeypatch.setattr(laser_api, "job_active", lambda host: False)
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


def _send(client, command, host=HOST):
    return client.post(URL, data={"command": command, "host": host})


class TestEndpoint:
    def test_anonymous_rejected(self, client, calls):
        response = _send(client, "$H")

        assert response.status_code == 401
        assert _service_calls(calls) == []

    @pytest.mark.parametrize("command", list(FRONTEND_OPERATOR_COMMANDS) + ["$X", chr(0x9A)])
    def test_operator_keeps_normal_operations(self, client, calls, as_operator, command):
        response = _send(client, command)

        assert response.status_code == 200
        assert response.json() == {"success": True}
        assert _service_calls(calls) == [("service", HOST, command)]

    @pytest.mark.parametrize("command", OPERATOR_BYPASS_ATTEMPTS)
    def test_operator_cannot_bypass_through_generic_command(self, client, calls, as_operator, command):
        response = _send(client, command)

        assert response.status_code == 403
        assert response.json()["detail"] == "Permiso insuficiente"
        assert _service_calls(calls) == []

    def test_operator_cannot_start_cnc_spindle(self, client, calls, as_operator):
        response = _send(client, "M3 S12000", host=CNC_HOST)

        assert response.status_code == 403
        assert any(entry[2] is Action.SET_SPINDLE for entry in calls if entry[0] == "authorize")
        assert _service_calls(calls) == []

    @pytest.mark.parametrize("command", ["M3 S1000", "M4 S500", "M5", "$32=0", "G0 X10\nM3 S1000", "M106"])
    def test_admin_allowed_for_privileged_commands(self, client, calls, as_admin, command):
        response = _send(client, command)

        assert response.status_code == 200
        assert _service_calls(calls) == [("service", HOST, command)]

    def test_every_action_authorized_before_sending(self, client, calls, as_admin):
        _send(client, "G0 X10\nM3 S1000")

        kinds = [entry[0] for entry in calls]
        assert kinds == ["authorize", "authorize", "service"]
        assert {entry[2] for entry in calls if entry[0] == "authorize"} == {Action.MOVE, Action.SET_LASER_POWER}
        assert all(entry[3].key == f"laser:laser:{HOST}" for entry in calls if entry[0] == "authorize")

    def test_mixed_request_denied_if_any_part_is_denied(self, client, calls, as_operator):
        response = _send(client, "G0 X10\nM3 S1000")

        assert response.status_code == 403
        assert _service_calls(calls) == []
        denied = [entry for entry in calls if entry[0] == "authorize" and not entry[4].allowed]
        assert denied and denied[0][2] is Action.SET_LASER_POWER
        assert denied[0][4].reason is Reason.INSUFFICIENT_ROLE

    def test_policy_deny_blocks_service(self, client, calls, as_admin, monkeypatch):
        monkeypatch.setattr(
            auth_deps, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )

        response = _send(client, "$H")

        assert response.status_code == 403
        assert _service_calls(calls) == []

    def test_operator_denied_before_job_active_check(self, client, calls, as_operator, monkeypatch):
        monkeypatch.setattr(laser_api, "job_active", lambda host: True)

        response = _send(client, "M3 S1000")

        assert response.status_code == 403

    def test_existing_admin_responses_unchanged(self, client, calls, as_admin, monkeypatch):
        monkeypatch.setattr(laser_api, "job_active", lambda host: True)
        busy = _send(client, "$H")
        assert busy.status_code == 409

        monkeypatch.setattr(laser_api, "job_active", lambda host: False)
        monkeypatch.setattr(laser_api, "send_raw_command", lambda host, command: False)
        failed = _send(client, "$H")
        assert failed.status_code == 502 and failed.json()["detail"] == "No se pudo enviar el comando"
