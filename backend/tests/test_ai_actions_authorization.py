"""Canal IA con Authorization Policy (ADR-006).

Cada acción física de NOPAL Intelligence declara la acción canónica de la
política; `ai_actions.execute` construye `Principal.user(user_id, rol)` con
el usuario autenticado real, el recurso real (máquina o plugin) y consulta
la política ANTES del servicio. `Action.role` ya no autoriza: se deriva de la
política solo para el listado.

Cambios de permiso (ADR-006): `preheat_machine` (set_temperature, D3-Q1) y
`assign_spool` (assign_active_spool, C-3) pasan de admin a operador;
`set_machine_alerts` (configure_plugin, D3-Q9) pasa de cualquier usuario a
admin. El resto: solo enforcement (CURRENT = TARGET).

El riesgo (`risk="confirm"`) sigue separado: la política decide si puede; la
confirmación, si la persona lo aprobó.
"""

import pytest

from backend.services import ai_actions, ai_agent
from backend.services.authorization_policy import (
    Action as PolicyAction, AuthorizationResult, Decision, PrincipalKind, Reason, ResourceKind, Role,
)

LASER_HOST = "192.168.0.61"
CNC_HOST = "192.168.0.63"

# Mismo formato que ai_tools._collect_machines (sin red).
MACHINES = {
    "ET4": {"id": "klipper:7125", "name": "ET4", "kind": "printer", "brand": "klipper"},
    "i3": {"id": "marlin:/dev/ttyUSB0", "name": "i3", "kind": "printer", "brand": "marlin"},
    "TTS": {"id": f"laser:{LASER_HOST}", "name": "TTS", "kind": "laser", "brand": "grbl"},
    "CNC": {"id": f"cnc:{CNC_HOST}", "name": "CNC", "kind": "cnc", "brand": "grbl"},
}

# (acción IA, argumentos, acción de la política, clave del recurso)
OPERATOR_CASES = [
    ("set_accessory_power", {"accessory_id": "acc01", "on": True}, PolicyAction.USE_PLUGIN, "plugin:arduino-accessories"),
    ("activate_scene", {"scene_id": "scene01"}, PolicyAction.USE_PLUGIN, "plugin:arduino-accessories"),
    ("send_matrix_announcement", {"announcement_id": "a1"}, PolicyAction.USE_PLUGIN, "plugin:matriz-led"),
    ("run_matrix_rule", {"rule_id": "r1"}, PolicyAction.USE_PLUGIN, "plugin:matriz-led"),
    ("queue_file", {"machine_id": "ET4", "path": "a.gcode"}, PolicyAction.START_JOB, "printer:klipper:7125"),
    ("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, PolicyAction.SET_TEMPERATURE, "printer:klipper:7125"),
    ("control_print", {"machine_id": "ET4", "action": "pause"}, PolicyAction.PAUSE, "printer:klipper:7125"),
    ("control_print", {"machine_id": "ET4", "action": "resume"}, PolicyAction.RESUME, "printer:klipper:7125"),
    ("control_print", {"machine_id": "ET4", "action": "cancel"}, PolicyAction.CANCEL, "printer:klipper:7125"),
    ("assign_spool", {"machine_id": "ET4", "spool_id": 3}, PolicyAction.ASSIGN_ACTIVE_SPOOL, "printer:klipper:7125"),
]
ADMIN_CASES = [
    ("create_scene", {"name": "Ventilar", "actions": []}, PolicyAction.CONFIGURE_PLUGIN, "plugin:arduino-accessories"),
    ("update_scene", {"scene_id": "scene01", "name": "Ventilar"}, PolicyAction.CONFIGURE_PLUGIN, "plugin:arduino-accessories"),
    # Persiste la configuración de alertas de la Matriz LED (D3-Q9).
    ("set_machine_alerts", {"machine_id": "ET4", "enabled": True}, PolicyAction.CONFIGURE_PLUGIN, "plugin:matriz-led"),
]


def _ids(cases):
    return [f"{name}-{policy.value}" for name, _, policy, _ in cases]


@pytest.fixture
def log(monkeypatch):
    """Registra, en orden, cada consulta a la política y cada llamada al
    servicio. Los servicios son simulados: nada llega a hardware real."""
    entries = []
    real_authorize = ai_actions.authorize

    def spy_authorize(principal, action, resource=None):
        result = real_authorize(principal, action, resource)
        entries.append(("authorize", principal, action, resource, result))
        return result

    async def resolve(machine_id):
        entries.append(("resolve", machine_id))
        if machine_id not in MACHINES:
            raise ai_actions.ActionError(f"No encuentro la máquina '{machine_id}'.")
        return MACHINES[machine_id]

    def fake_handler(name):
        async def handler(**kwargs):
            entries.append(("service", name, kwargs))
            return {"ok": True, "action": name}
        return handler

    monkeypatch.setattr(ai_actions, "authorize", spy_authorize)
    monkeypatch.setattr(ai_actions, "_resolve_machine", resolve)
    for name, accion in ai_actions.ACTIONS.items():
        monkeypatch.setattr(accion, "handler", fake_handler(name))
    return entries


def _of(entries, kind):
    return [entry for entry in entries if entry[0] == kind]


class TestOperatorActions:
    @pytest.mark.parametrize("name, args, policy, key", OPERATOR_CASES, ids=_ids(OPERATOR_CASES))
    async def test_operator_allowed(self, log, name, args, policy, key):
        result = await ai_actions.execute(name, args, "operador", "u-op")

        assert result == {"ok": True, "action": name}
        assert len(_of(log, "service")) == 1

    @pytest.mark.parametrize("name, args, policy, key", OPERATOR_CASES, ids=_ids(OPERATOR_CASES))
    async def test_admin_allowed(self, log, name, args, policy, key):
        await ai_actions.execute(name, args, "admin", "u-admin")

        assert len(_of(log, "service")) == 1

    @pytest.mark.parametrize("name, args, policy, key", OPERATOR_CASES, ids=_ids(OPERATOR_CASES))
    async def test_principal_action_resource_and_order(self, log, name, args, policy, key):
        await ai_actions.execute(name, args, "operador", "u-op")

        _, principal, action, resource, result = _of(log, "authorize")[0]
        assert principal.kind is PrincipalKind.USER
        assert principal.id == "u-op" and principal.role is Role.OPERATOR
        assert action is policy
        assert resource.key == key
        assert result.decision is Decision.ALLOW
        assert [entry[0] for entry in log if entry[0] != "resolve"] == ["authorize", "service"]


class TestAdminActions:
    @pytest.mark.parametrize("name, args, policy, key", ADMIN_CASES, ids=_ids(ADMIN_CASES))
    async def test_operator_denied_without_service(self, log, name, args, policy, key):
        with pytest.raises(ai_actions.ActionError) as excinfo:
            await ai_actions.execute(name, args, "operador", "u-op")

        assert str(excinfo.value) == ai_actions.PERMISSION_DENIED
        assert _of(log, "service") == []
        _, _, action, resource, result = _of(log, "authorize")[0]
        assert action is policy and resource.key == key
        assert result.reason is Reason.INSUFFICIENT_ROLE

    @pytest.mark.parametrize("name, args, policy, key", ADMIN_CASES, ids=_ids(ADMIN_CASES))
    async def test_admin_allowed(self, log, name, args, policy, key):
        await ai_actions.execute(name, args, "admin", "u-admin")

        assert len(_of(log, "service")) == 1


class TestDenyAndPrincipal:
    @pytest.mark.parametrize("role", ["", None, "superadmin", "operator"])
    async def test_without_valid_role_denied(self, log, role):
        """Sin rol válido (los reales son `admin` y `operador`) no hay
        permiso, ni siquiera para acciones de operador."""
        with pytest.raises(ai_actions.ActionError, match="permiso"):
            await ai_actions.execute("set_accessory_power", {"accessory_id": "acc01", "on": True}, role, "u-x")
        assert _of(log, "service") == []

    async def test_forced_deny_blocks_service_and_hides_internals(self, log, monkeypatch):
        monkeypatch.setattr(
            ai_actions, "authorize",
            lambda principal, action, resource=None: AuthorizationResult(Decision.DENY, Reason.INSUFFICIENT_ROLE, action, resource),
        )

        with pytest.raises(ai_actions.ActionError) as excinfo:
            await ai_actions.execute("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "admin", "u-admin")

        message = str(excinfo.value)
        assert message == "Tu cuenta no tiene permiso para esta acción"
        for internal in ("insufficient_role", "set_temperature", "printer:", "klipper:7125", "admin"):
            assert internal not in message
        assert _of(log, "service") == []

    async def test_tool_arguments_cannot_elevate(self, log):
        args = {"name": "x", "actions": [], "role": "admin", "user_id": "root", "machine": {}}
        with pytest.raises(ai_actions.ActionError, match="permiso"):
            await ai_actions.execute("create_scene", args, "operador", "u-op")

        principal = _of(log, "authorize")[0][1]
        assert principal.role is Role.OPERATOR and principal.id == "u-op"
        assert _of(log, "service") == []


class TestResources:
    @pytest.mark.parametrize("machine, kind, key", [
        ("ET4", ResourceKind.PRINTER, "printer:klipper:7125"),
        ("i3", ResourceKind.PRINTER, "printer:marlin:/dev/ttyUSB0"),
        ("TTS", ResourceKind.LASER, f"laser:laser:{LASER_HOST}"),
        ("CNC", ResourceKind.CNC, f"cnc:laser:{CNC_HOST}"),
    ])
    async def test_machine_resource_matches_panel_keys(self, log, machine, kind, key):
        await ai_actions.execute("queue_file", {"machine_id": machine, "path": "a.gcode"}, "operador", "u-op")

        resource = _of(log, "authorize")[0][3]
        assert resource.kind is kind and resource.key == key

    async def test_service_receives_resolved_machine(self, log):
        """La máquina se resuelve una sola vez (antes de autorizar) y el
        servicio la recibe ya resuelta."""
        await ai_actions.execute("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "operador", "u-op")

        assert _of(log, "resolve") == [("resolve", "ET4")]
        assert _of(log, "service")[0][2]["machine"] == MACHINES["ET4"]

    async def test_unknown_machine_keeps_previous_error_without_authorize(self, log):
        with pytest.raises(ai_actions.ActionError, match="No encuentro la máquina"):
            await ai_actions.execute("preheat_machine", {"machine_id": "nada", "nozzle": 200}, "operador", "u-op")

        assert _of(log, "authorize") == [] and _of(log, "service") == []

    async def test_missing_data_keeps_previous_error(self, log):
        with pytest.raises(ai_actions.ActionError, match="Faltan datos"):
            await ai_actions.execute("preheat_machine", {}, "admin", "u-admin")

        assert _of(log, "authorize") == [] and _of(log, "service") == []


class TestControlPrint:
    async def test_invalid_subaction_requires_all_and_keeps_validation_error(self, monkeypatch, log):
        """Si no se puede elegir la acción de la política se exigen todas
        (fail-closed); el servicio real conserva su error de validación."""
        monkeypatch.setattr(ai_actions.ACTIONS["control_print"], "handler", ai_actions.control_print)

        with pytest.raises(ai_actions.ActionError, match="Acción inválida"):
            await ai_actions.execute("control_print", {"machine_id": "ET4", "action": "explode"}, "operador", "u-op")

        actions = [entry[2] for entry in _of(log, "authorize")]
        assert actions == [PolicyAction.PAUSE, PolicyAction.RESUME, PolicyAction.CANCEL]


class TestPermissionChanges:
    """Cambios reales de permiso de ADR-006. Antes `Action.role="admin"`
    rechazaba al operador con "Tu cuenta no tiene permiso para esta acción"."""

    async def test_operator_can_preheat_now(self, monkeypatch):
        """preheat_machine → set_temperature (D3-Q1): operador antes DENY,
        ahora ALLOW. Usa el servicio real con el driver simulado."""
        import backend.services.klipper_service as klipper_service

        calls = []

        async def resolve(machine_id):
            return MACHINES["ET4"]

        monkeypatch.setattr(ai_actions, "_resolve_machine", resolve)
        monkeypatch.setattr(klipper_service, "set_heater_target", lambda port, heater, value: calls.append((port, heater, value)) or True)

        result = await ai_actions.execute("preheat_machine", {"machine_id": "ET4", "nozzle": 200, "bed": 60}, "operador", "u-op")

        assert result == {"ok": True, "machine": "ET4", "targets": {"extruder": 200.0, "heater_bed": 60.0}}
        assert calls == [(7125, "extruder", 200.0), (7125, "heater_bed", 60.0)]

    async def test_admin_can_still_preheat(self, log):
        await ai_actions.execute("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "admin", "u-admin")
        assert len(_of(log, "service")) == 1

    async def test_operator_can_assign_spool_now(self, log):
        """assign_spool → assign_active_spool (C-3): operador antes DENY,
        ahora ALLOW."""
        result = await ai_actions.execute("assign_spool", {"machine_id": "ET4", "spool_id": 3}, "operador", "u-op")

        assert result["ok"] is True
        assert _of(log, "service")[0][2]["spool_id"] == 3

    async def test_admin_can_still_assign_spool(self, log):
        await ai_actions.execute("assign_spool", {"machine_id": "ET4", "spool_id": 3}, "admin", "u-admin")
        assert len(_of(log, "service")) == 1

    @pytest.fixture
    def matrix_plugin(self, monkeypatch):
        """Plugin Matriz LED simulado; registra cada escritura de configuración."""
        from types import SimpleNamespace
        import backend.services.plugin_loader_service as plugin_loader_service

        saved = []

        async def resolve(machine_id):
            return MACHINES["ET4"]

        module = SimpleNamespace(
            get_machine_alerts=lambda machine_id: {"state_announcements": {"printing": "a1"}},
            save_machine_alerts=lambda machine_id, payload: saved.append((machine_id, payload)),
        )
        monkeypatch.setattr(ai_actions, "_resolve_machine", resolve)
        monkeypatch.setattr(plugin_loader_service, "get_loaded_plugin_module",
                            lambda plugin_id, name: module if plugin_id == "matriz-led" else None)
        return saved

    async def test_operator_cannot_set_machine_alerts_now(self, matrix_plugin, monkeypatch):
        """set_machine_alerts → configure_plugin (D3-Q9): guarda configuración
        persistente de la Matriz LED. Operador antes ALLOW (`role="any"`),
        ahora DENY; la configuración no se toca."""
        calls = []
        real_authorize = ai_actions.authorize
        monkeypatch.setattr(ai_actions, "authorize",
                            lambda p, a, r=None: calls.append(a) or real_authorize(p, a, r))

        with pytest.raises(ai_actions.ActionError, match="permiso"):
            await ai_actions.execute("set_machine_alerts", {"machine_id": "ET4", "enabled": True}, "operador", "u-op")

        assert calls == [PolicyAction.CONFIGURE_PLUGIN]
        assert matrix_plugin == []

    async def test_admin_can_set_machine_alerts(self, matrix_plugin):
        result = await ai_actions.execute("set_machine_alerts", {"machine_id": "ET4", "enabled": True}, "admin", "u-admin")

        assert result["ok"] is True and result["enabled"] is True
        assert matrix_plugin == [("klipper:7125", {"enabled": True, "state_announcements": {"printing": "a1"}})]

    def test_set_machine_alerts_leaves_operator_catalog(self):
        assert "set_machine_alerts" not in {a.name for a in ai_actions.get_actions("operador", "u-op")}
        assert ai_actions.ACTIONS["set_machine_alerts"].role == "admin"

    def test_catalog_offers_them_to_operator(self):
        operador = {a.name for a in ai_actions.get_actions("operador", "u-op")}
        assert {"preheat_machine", "assign_spool"} <= operador


class TestRiskIsNotPermission:
    def test_risk_unchanged(self):
        risks = {name: accion.risk for name, accion in ai_actions.ACTIONS.items()}
        assert risks == {
            "set_accessory_power": "low", "activate_scene": "low",
            "create_scene": "confirm", "update_scene": "confirm",
            "send_matrix_announcement": "low", "set_machine_alerts": "low", "run_matrix_rule": "low",
            "queue_file": "low", "preheat_machine": "confirm", "control_print": "confirm",
            "assign_spool": "low",
        }

    async def test_operator_preheat_still_needs_confirmation(self, log, monkeypatch):
        """Permitido por la política, pero de riesgo `confirm`: queda
        pendiente y el servicio no se ejecuta."""
        monkeypatch.setattr(ai_actions, "_pending", {})
        result, pendiente = await ai_agent._run_action(
            "preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "operador", "ana", True, "u-op")

        assert result["status"] == "pending_confirmation" and pendiente is not None
        assert _of(log, "service") == []

    async def test_denied_request_is_not_staged(self, log, monkeypatch):
        """Primero la política, después la confirmación: un operador no deja
        pendiente una acción de admin."""
        monkeypatch.setattr(ai_actions, "_pending", {})
        result, pendiente = await ai_agent._run_action(
            "create_scene", {"name": "x", "actions": []}, "operador", "ana", True, "u-op")

        assert result == {"error": "action_failed", "detail": ai_actions.PERMISSION_DENIED}
        assert pendiente is None and ai_actions._pending == {}
        assert _of(log, "service") == []

    async def test_confirm_reauthorizes_with_current_role(self, log, monkeypatch):
        """Si a quien pidió la acción lo degradan antes de confirmar, la
        confirmación se rechaza sin ejecutar."""
        monkeypatch.setattr(ai_actions, "_pending", {})
        pendiente = ai_actions.stage_action("create_scene", {"name": "x", "actions": []}, "ana", "u-ana")

        with pytest.raises(ai_actions.ActionError, match="permiso"):
            await ai_actions.confirm(pendiente["id"], "operador", "ana", "u-ana")
        assert _of(log, "service") == []

    async def test_confirmed_action_executes_after_authorize(self, log, monkeypatch):
        monkeypatch.setattr(ai_actions, "_pending", {})
        pendiente = ai_actions.stage_action("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "ana", "u-ana")

        await ai_actions.confirm(pendiente["id"], "operador", "ana", "u-ana")

        assert [entry[0] for entry in log if entry[0] != "resolve"] == ["authorize", "service"]


class TestEndpoints:
    def test_anonymous_rejected(self, client):
        assert client.get("/api/ai/actions").status_code == 401
        assert client.post("/api/ai/ask", json={"question": "hola"}).status_code == 401
        assert client.post("/api/ai/actions/abc/confirm").status_code == 401

    def test_operator_catalog_follows_policy(self, client, as_operator):
        actions = {a["name"]: a for a in client.get("/api/ai/actions").json()["actions"]}

        assert "preheat_machine" in actions and actions["preheat_machine"]["role"] == "any"
        assert "create_scene" not in actions

    def test_admin_catalog_has_everything(self, client, as_admin):
        actions = {a["name"] for a in client.get("/api/ai/actions").json()["actions"]}

        assert actions == set(ai_actions.ACTIONS)

    def test_confirm_endpoint_uses_real_user(self, client, as_operator, monkeypatch):
        """La ruta pasa el usuario autenticado (rol e id) a la política."""
        import backend.services.ai_config_service as ai_config_service

        seen = []

        async def fake_confirm(token, role, username, user_id=None):
            seen.append((role, username, user_id))
            return {"ok": True}

        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"actions_enabled": True})
        monkeypatch.setattr(ai_actions, "confirm", fake_confirm)

        assert client.post("/api/ai/actions/abc/confirm").status_code == 200
        assert seen == [(as_operator["role"], as_operator["username"], as_operator["user_id"])]
