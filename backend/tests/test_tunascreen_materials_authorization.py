"""TUNA-Screen: asignar la bobina activa con Authorization Policy (ADR-006).

POST /api/tunascreen/materials/active → assign_active_spool (operador). El
permiso funcional no cambia: un dispositivo emparejado puede asignarla. El
scope sigue siendo transitorio (el recurso pedido), igual que en
dispatch_action, hasta que exista su persistencia.
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
    Action, AuthorizationResult, Decision, PrincipalKind, Reason, ResourceKind, Role,
)

URL = "/api/tunascreen/materials/active"


@pytest.fixture(autouse=True)
def workshop(monkeypatch):
    """Una Klipper en línea; ninguna otra máquina ni red real. Registra, en
    orden, la consulta a la política y la llamada al servicio de material."""
    log = []
    monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
        "name": "ET4-AC", "port": 7125, "status": "online",
        "data": {"extruder": {}, "heater_bed": {}}, "job": {},
    }])
    for module in (bambu_service, elegoo_service, flashforge_service, marlin_printer_service):
        monkeypatch.setattr(module, "get_registered_printers_with_status", lambda: [])

    async def no_lasers():
        return []

    monkeypatch.setattr(laser_service, "get_registered_lasers_status", no_lasers)

    real_authorize = tunascreen_service.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        log.append(("authorize", principal, action, resource, result))
        return result

    async def fake_set_active_material(machine_id, spool_id):
        log.append(("service", machine_id, spool_id))
        return {"success": True, "machine_id": machine_id, "spool_id": spool_id}

    monkeypatch.setattr(tunascreen_service, "authorize", spy_authorize)
    monkeypatch.setattr(tunascreen_service, "set_active_material", fake_set_active_material)
    return log


@pytest.fixture
def token():
    code = tunascreen_service.generate_pairing_code()["code"]
    return tunascreen_service.confirm_pairing(code, "Tablet de prueba")["token"]


def _post(client, payload, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(URL, json=payload, headers=headers)


def _service_calls(log):
    return [entry for entry in log if entry[0] == "service"]


def test_anonymous_rejected_and_service_not_called(client, workshop):
    response = _post(client, {"machine_id": "klipper:7125", "spool_id": 9})

    assert response.status_code == 401
    assert workshop == []


def test_invalid_token_rejected(client, workshop):
    response = _post(client, {"machine_id": "klipper:7125", "spool_id": 9}, token="token-falso")

    assert response.status_code == 401
    assert workshop == []


def test_device_can_assign_spool(client, workshop, token):
    response = _post(client, {"machine_id": "klipper:7125", "spool_id": 9}, token)

    assert response.status_code == 200
    assert response.json() == {"success": True, "machine_id": "klipper:7125", "spool_id": 9}
    assert _service_calls(workshop) == [("service", "klipper:7125", 9)]


def test_device_can_clear_spool(client, workshop, token):
    response = _post(client, {"machine_id": "klipper:7125", "spool_id": None}, token)

    assert response.status_code == 200
    assert _service_calls(workshop) == [("service", "klipper:7125", None)]


def test_principal_action_resource_and_order(client, workshop, token):
    _post(client, {"machine_id": "klipper:7125", "spool_id": 9, "role": "admin"}, token)

    kind, principal, action, resource, result = workshop[0]
    assert kind == "authorize"
    assert principal.kind is PrincipalKind.TUNA_DEVICE and principal.role is Role.OPERATOR
    assert action is Action.ASSIGN_ACTIVE_SPOOL
    assert resource.kind is ResourceKind.PRINTER and resource.key == "printer:klipper:7125"
    assert result.decision is Decision.ALLOW
    assert [entry[0] for entry in workshop] == ["authorize", "service"]


def test_policy_deny_blocks_service(client, workshop, token, monkeypatch):
    monkeypatch.setattr(
        tunascreen_service, "authorize",
        lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.OUT_OF_SCOPE, action, resource),
    )

    response = _post(client, {"machine_id": "klipper:7125", "spool_id": 9}, token)

    assert response.status_code == 403
    assert response.json() == {"detail": "Permiso insuficiente"}
    assert _service_calls(workshop) == []


def test_unknown_machine_keeps_service_decision(client, workshop, token):
    """Si la máquina no está en el modelo normalizado, el recurso queda como
    `machine:<id>` y el servicio decide como antes (no exige que esté en línea)."""
    response = _post(client, {"machine_id": "klipper:9999", "spool_id": 3}, token)

    assert response.status_code == 200
    assert workshop[0][3].key == "machine:klipper:9999"
    assert _service_calls(workshop) == [("service", "klipper:9999", 3)]


def test_missing_machine_id_denied_without_service(client, workshop, token):
    """Sin máquina no hay recurso que autorizar: fail-closed (403)."""
    response = _post(client, {"spool_id": 3}, token)

    assert response.status_code == 403
    assert _service_calls(workshop) == []


def test_service_errors_unchanged(client, workshop, token, monkeypatch):
    async def not_configured(machine_id, spool_id):
        raise ValueError("Spoolman no está configurado")

    monkeypatch.setattr(tunascreen_service, "set_active_material", not_configured)

    response = _post(client, {"machine_id": "klipper:7125", "spool_id": 9}, token)

    assert response.status_code == 400
    assert response.json() == {"detail": "Spoolman no está configurado"}
