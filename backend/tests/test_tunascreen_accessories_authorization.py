"""TUNA-Screen: accesorios y escenas con Authorization Policy (ADR-006).

POST /api/tunascreen/accessories/{id}/power y
POST /api/tunascreen/accessory-scenes/{id}/run → use_plugin (operador) sobre
Resource(PLUGIN, "arduino-accessories"). El permiso funcional no cambia: un
dispositivo emparejado puede usarlos. El scope sigue siendo transitorio (el
recurso pedido); el scope por accesorio/escena queda para su persistencia.
"""

from types import SimpleNamespace

import pytest

import backend.services.tunascreen_service as tunascreen_service
from backend.services.authorization_policy import (
    Action, AuthorizationResult, Decision, PrincipalKind, Reason, ResourceKind, Role,
)

POWER_URL = "/api/tunascreen/accessories/acc01/power"
SCENE_URL = "/api/tunascreen/accessory-scenes/scene01/run"


@pytest.fixture
def log(monkeypatch):
    """Registra, en orden, la consulta a la política y la llamada al plugin
    (simulado: nada llega a una placa real)."""
    entries = []
    real_authorize = tunascreen_service.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        entries.append(("authorize", principal, action, resource, result))
        return result

    async def set_power(accessory_id, on):
        entries.append(("service", "power", accessory_id, on))
        return True if accessory_id == "acc01" else None

    async def run_scene(scene_id):
        entries.append(("service", "scene", scene_id))
        return True if scene_id == "scene01" else None

    modules = {
        "services.accessory_service": SimpleNamespace(set_accessory_power=set_power),
        "services.accessory_scenes": SimpleNamespace(run_scene=run_scene),
    }
    monkeypatch.setattr(tunascreen_service, "authorize", spy_authorize)
    monkeypatch.setattr(
        tunascreen_service, "get_loaded_plugin_module",
        lambda plugin_id, module: modules.get(module) if plugin_id == "arduino-accessories" else None,
    )
    return entries


@pytest.fixture
def token():
    code = tunascreen_service.generate_pairing_code()["code"]
    return tunascreen_service.confirm_pairing(code, "Tablet de prueba")["token"]


def _power(client, token=None, url=POWER_URL, payload=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(url, json=payload if payload is not None else {"on": True}, headers=headers)


def _scene(client, token=None, url=SCENE_URL):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(url, headers=headers)


def _service_calls(entries):
    return [entry for entry in entries if entry[0] == "service"]


CALLS = {"power": _power, "scene": _scene}


@pytest.mark.parametrize("route", CALLS)
class TestBothRoutes:
    def test_anonymous_rejected(self, client, log, route):
        response = CALLS[route](client)

        assert response.status_code == 401
        assert log == []

    def test_invalid_token_rejected(self, client, log, route):
        response = CALLS[route](client, "token-falso")

        assert response.status_code == 401
        assert log == []

    def test_principal_action_resource_and_order(self, client, log, token, route):
        CALLS[route](client, token)

        kind, principal, action, resource, result = log[0]
        assert kind == "authorize"
        assert principal.kind is PrincipalKind.TUNA_DEVICE and principal.role is Role.OPERATOR
        assert action is Action.USE_PLUGIN
        assert resource.kind is ResourceKind.PLUGIN and resource.id == "arduino-accessories"
        assert resource.key == "plugin:arduino-accessories"
        assert result.decision is Decision.ALLOW
        assert [entry[0] for entry in log] == ["authorize", "service"]

    def test_policy_deny_blocks_service(self, client, log, token, monkeypatch, route):
        monkeypatch.setattr(
            tunascreen_service, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.OUT_OF_SCOPE, action, resource),
        )

        response = CALLS[route](client, token)

        assert response.status_code == 403
        assert response.json() == {"detail": "Permiso insuficiente"}
        assert _service_calls(log) == []

    def test_plugin_unavailable_keeps_400(self, client, log, token, monkeypatch, route):
        monkeypatch.setattr(tunascreen_service, "get_loaded_plugin_module", lambda plugin_id, module: None)

        response = CALLS[route](client, token)

        assert response.status_code == 400
        assert response.json() == {"detail": "El plugin de accesorios no está disponible"}


class TestPower:
    def test_device_can_switch_accessory(self, client, log, token):
        response = _power(client, token, payload={"on": False})

        assert response.status_code == 200
        assert response.json() == {"success": True, "accessory_id": "acc01", "on": False}
        assert _service_calls(log) == [("service", "power", "acc01", False)]

    def test_role_in_payload_cannot_elevate(self, client, log, token):
        _power(client, token, payload={"on": True, "role": "admin", "principal": {"role": "admin"}})

        principal = log[0][1]
        assert principal.role is Role.OPERATOR

    def test_unknown_accessory_keeps_400(self, client, log, token):
        response = _power(client, token, url="/api/tunascreen/accessories/no-existe/power")

        assert response.status_code == 400
        assert response.json() == {"detail": "Accesorio no encontrado"}

    def test_missing_on_keeps_400_without_service(self, client, log, token):
        response = _power(client, token, payload={})

        assert response.status_code == 400
        assert response.json() == {"detail": "Falta el estado 'on'"}
        assert _service_calls(log) == []


class TestScene:
    def test_device_can_run_scene(self, client, log, token):
        response = _scene(client, token)

        assert response.status_code == 200
        assert response.json() == {"success": True, "scene_id": "scene01"}
        assert _service_calls(log) == [("service", "scene", "scene01")]

    def test_unknown_scene_keeps_400(self, client, log, token):
        response = _scene(client, token, url="/api/tunascreen/accessory-scenes/no-existe/run")

        assert response.status_code == 400
        assert response.json() == {"detail": "Escena no encontrada"}

    def test_running_scene_is_not_an_admin_action(self, client, log, token):
        """Ejecutar una escena es use_plugin; configure_plugin (admin) nunca
        se consulta en esta ruta."""
        _scene(client, token)

        assert {entry[2] for entry in log if entry[0] == "authorize"} == {Action.USE_PLUGIN}
