"""Primer enforcement de TUNA-Screen (ADR-006, enforcement PARCIAL).

dispatch_action trata al dispositivo como Principal(TUNA_DEVICE, operador,
scope) y consulta la Authorization Policy antes de cualquier servicio:

- Acciones de admin (consola, macros, potencia láser/husillo, configuración…):
  denegadas siempre, aunque el recurso esté en el scope.
- Acciones de operador: siguen funcionando. Por decisión del propietario
  (2026-10-03) el scope todavía no se persiste y device_scope() devuelve el
  propio recurso pedido (transitorio), así que no se limita por máquina.
"""

import pytest

import backend.services.bambu_service as bambu_service
import backend.services.elegoo_service as elegoo_service
import backend.services.flashforge_service as flashforge_service
import backend.services.klipper_service as klipper_service
import backend.services.laser_service as laser_service
import backend.services.marlin_printer_service as marlin_printer_service
import backend.services.tunascreen_service as tunascreen_service
from backend.services.authorization_policy import (
    Action, Principal, PrincipalKind, Reason, Resource, ResourceKind, Role, authorize,
)

LASER_HOST = "192.168.0.61"
CNC_HOST = "192.168.0.63"


@pytest.fixture(autouse=True)
def workshop(monkeypatch):
    """Taller simulado (sin red): una Klipper en línea, un láser y una CNC.
    Registra cada llamada a un servicio/driver para comprobar que nada se
    ejecuta cuando la política deniega."""
    log = []
    monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
        "name": "ET4-AC", "port": 7125, "status": "online",
        "data": {"extruder": {}, "heater_bed": {}}, "job": {},
    }])
    monkeypatch.setattr(bambu_service, "get_registered_printers_with_status", lambda: [])
    monkeypatch.setattr(elegoo_service, "get_registered_printers_with_status", lambda: [])
    monkeypatch.setattr(flashforge_service, "get_registered_printers_with_status", lambda: [])
    monkeypatch.setattr(marlin_printer_service, "get_registered_printers_with_status", lambda: [])

    async def lasers():
        return [
            {"host": LASER_HOST, "name": "Láser", "online": True, "kind": "laser"},
            {"host": CNC_HOST, "name": "CNC", "online": True, "kind": "cnc"},
        ]

    async def laser_status(host, timeout=3.0):
        # Misma forma que devuelve laser_service.get_status para una placa GRBL.
        return {"state": "Idle", "x": 0.0, "y": 0.0, "z": 0.0, "feed": 0, "speed": 0}

    async def laser_job(host):
        return None

    monkeypatch.setattr(laser_service, "get_registered_lasers_status", lasers)
    monkeypatch.setattr(laser_service, "get_status", laser_status)
    monkeypatch.setattr(laser_service, "get_job_status", laser_job)

    def record(name, result=True):
        return lambda *args, **kwargs: log.append((name, args)) or result

    monkeypatch.setattr(klipper_service, "send_console_command", record("klipper.send_console_command"))
    monkeypatch.setattr(klipper_service, "run_macro", record("klipper.run_macro"))
    monkeypatch.setattr(klipper_service, "set_heater_target", record("klipper.set_heater_target"))
    monkeypatch.setattr(klipper_service, "pause_printer_print", record("klipper.pause"))
    monkeypatch.setattr(laser_service, "send_raw_command", record("laser.send_raw_command"))
    return log


@pytest.fixture
def token():
    code = tunascreen_service.generate_pairing_code()["code"]
    return tunascreen_service.confirm_pairing(code, "Tablet de prueba")["token"]


def _act(client, token, machine_id, action, params=None, extra=None):
    payload = {"machine_id": machine_id, "action": action, "params": params or {}, **(extra or {})}
    return client.post("/api/tunascreen/action", json=payload, headers={"Authorization": f"Bearer {token}"})


ADMIN_TUNA_ACTIONS = [
    ("klipper:7125", "send_console_command", {"command": "M104 S250"}),
    ("klipper:7125", "run_macro", {"macro": "PREHEAT"}),
    (f"laser:{LASER_HOST}", "set_laser_power", {"on": True, "power": 1000}),
    (f"laser:{CNC_HOST}", "set_spindle", {"on": True, "rpm": 12000}),
]


class TestAdminActionsDenied:
    @pytest.mark.parametrize("machine_id, action, params", ADMIN_TUNA_ACTIONS, ids=[a for _, a, _ in ADMIN_TUNA_ACTIONS])
    def test_admin_action_denied_and_no_driver_call(self, client, token, workshop, machine_id, action, params):
        response = _act(client, token, machine_id, action, params)

        assert response.status_code == 403
        assert response.json() == {"detail": "Permiso insuficiente"}
        assert workshop == []

    def test_role_in_request_cannot_elevate(self, client, token, workshop):
        response = _act(client, token, "klipper:7125", "send_console_command", {"command": "M104 S250"},
                        extra={"role": "admin", "principal": {"role": "admin"}})

        assert response.status_code == 403
        assert workshop == []

    @pytest.mark.parametrize("action", ["printer_config", "grbl_settings", "firmware_restart", "restart_klipper", "delete_sd_file"])
    async def test_other_admin_actions_denied_in_dispatch(self, workshop, action):
        """No son acciones que TUNA-Screen declare, pero si llegan a
        dispatch_action la política las deniega antes de cualquier servicio."""
        with pytest.raises(tunascreen_service.DeviceActionDenied):
            await tunascreen_service.dispatch_action("klipper:7125", action, {}, device={"device_id": "tuna_x"})
        assert workshop == []


class TestOperatorActionsAllowed:
    def test_pause(self, client, token, workshop):
        response = _act(client, token, "klipper:7125", "pause")

        assert response.status_code == 200
        assert response.json() == {"success": True, "action": "pause", "machine_id": "klipper:7125"}
        assert [name for name, _ in workshop] == ["klipper.pause"]

    def test_set_temperature(self, client, token, workshop):
        response = _act(client, token, "klipper:7125", "set_temperature", {"heater": "extruder", "target": 210})

        assert response.status_code == 200
        assert [name for name, _ in workshop] == ["klipper.set_heater_target"]

    @pytest.mark.parametrize("action, params", [
        ("home", {}),
        ("move", {"axis": "X", "distance": 5, "feed": 1200}),
        ("set_fan", {"percent": 50}),
    ])
    def test_klipper_operator_actions(self, client, token, workshop, action, params):
        response = _act(client, token, "klipper:7125", action, params)

        assert response.status_code == 200
        assert [name for name, _ in workshop] == ["klipper.send_console_command"]

    def test_laser_air_assist_allowed(self, client, token, workshop):
        response = _act(client, token, f"laser:{LASER_HOST}", "set_air_assist", {"on": True})

        assert response.status_code == 200
        assert workshop == [("laser.send_raw_command", (LASER_HOST, "M8"))]


class TestOrderAndErrors:
    def test_invalid_token_rejected_before_anything(self, client, workshop):
        response = _act(client, "token-falso", "klipper:7125", "pause")

        assert response.status_code == 401
        assert workshop == []

    def test_authorization_before_service(self, client, token, workshop, monkeypatch):
        calls = []
        real_authorize = tunascreen_service.authorize

        def spy(principal, action, resource=None):
            calls.append(("authorize", principal, action, resource))
            return real_authorize(principal, action, resource)

        monkeypatch.setattr(tunascreen_service, "authorize", spy)

        _act(client, token, "klipper:7125", "pause")

        assert calls[0][0] == "authorize"
        principal, action, resource = calls[0][1:]
        assert principal.kind is PrincipalKind.TUNA_DEVICE and principal.role is Role.OPERATOR
        assert action is Action.PAUSE and resource.key == "printer:klipper:7125"
        assert [name for name, _ in workshop] == ["klipper.pause"]

    def test_unknown_action_keeps_previous_400(self, client, token, workshop):
        response = _act(client, token, "klipper:7125", "format_everything")

        assert response.status_code == 400
        assert response.json()["detail"] == "Acción no soportada para esta máquina"
        assert workshop == []

    def test_unknown_machine_keeps_previous_400(self, client, token, workshop):
        response = _act(client, token, "klipper:9999", "pause")

        assert response.status_code == 400
        assert workshop == []


class TestPrincipalAndResource:
    def test_device_principal_is_always_operator(self):
        resource = Resource(ResourceKind.PRINTER, "klipper:7125")
        forged = {"device_id": "tuna_x", "role": "admin", "scope": ["printer:klipper:7126"]}
        principal = tunascreen_service.principal_for_device(forged, resource)

        assert principal.kind is PrincipalKind.TUNA_DEVICE
        assert principal.role is Role.OPERATOR
        assert principal.id == "tuna_x"

    def test_transitional_scope_is_only_the_requested_resource(self):
        resource = Resource(ResourceKind.PRINTER, "klipper:7125")
        assert tunascreen_service.device_scope({"device_id": "tuna_x"}, resource) == {"printer:klipper:7125"}

    @pytest.mark.parametrize("machine, key", [
        ({"id": "klipper:7125", "type": "printer"}, "printer:klipper:7125"),
        ({"id": "marlin:/dev/ttyUSB0", "type": "printer"}, "printer:marlin:/dev/ttyUSB0"),
        ({"id": f"laser:{LASER_HOST}", "type": "laser"}, f"laser:laser:{LASER_HOST}"),
        ({"id": f"laser:{CNC_HOST}", "type": "cnc"}, f"cnc:laser:{CNC_HOST}"),
    ])
    def test_machine_resource_keys_match_panel(self, machine, key):
        assert tunascreen_service.machine_resource(machine).key == key


class TestScopeSemantics:
    """Semántica de scope que aplicará cuando exista la persistencia (la
    política ya la implementa; hoy el scope transitorio es el recurso)."""

    K7125 = Resource(ResourceKind.PRINTER, "klipper:7125")
    K7126 = Resource(ResourceKind.PRINTER, "klipper:7126")
    LASER = Resource(ResourceKind.LASER, f"laser:{LASER_HOST}")

    def test_in_scope_allowed_out_of_scope_denied(self):
        device = Principal.tuna_device("tuna_x", {self.K7125.key})
        assert authorize(device, Action.SET_TEMPERATURE, self.K7125).allowed
        assert authorize(device, Action.SET_TEMPERATURE, self.K7126).reason is Reason.OUT_OF_SCOPE

    def test_admin_action_denied_even_in_scope(self):
        device = Principal.tuna_device("tuna_x", {self.LASER.key})
        assert not authorize(device, Action.SET_LASER_POWER, self.LASER)

    def test_empty_scope_and_other_resources_denied(self):
        assert not authorize(Principal.tuna_device("tuna_x", ()), Action.PAUSE, self.K7125)
        device = Principal.tuna_device("tuna_x", {self.K7125.key})
        assert not authorize(device, Action.PAUSE, Resource(ResourceKind.PRINTER, "klipper:no-existe"))
        assert not authorize(device, Action.PAUSE, self.LASER)
