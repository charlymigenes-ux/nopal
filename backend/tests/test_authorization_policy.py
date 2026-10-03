"""Authorization Policy (ADR-006): matriz TARGET, fail-closed y scope de
dispositivo. Solo se prueba la decisión; ningún endpoint usa todavía esta
política (el enforcement es una fase posterior)."""

import ast
from pathlib import Path

import pytest

from backend.services import tunascreen_service
from backend.services.authorization_policy import (
    POLICY,
    Action,
    AuthorizationResult,
    Decision,
    Principal,
    PrincipalKind,
    Reason,
    Resource,
    ResourceKind,
    Role,
    Rule,
    authorize,
)

POLICY_MODULE = Path(__file__).resolve().parents[1] / "services" / "authorization_policy.py"

A = Resource(ResourceKind.PRINTER, "klipper:7125")
B = Resource(ResourceKind.PRINTER, "klipper:7126")
LASER = Resource(ResourceKind.LASER, "laser:192.168.0.61")
LIBRARY = Resource(ResourceKind.LIBRARY, "library")

ANON = Principal.anonymous()
OPERATOR = Principal.user("u-oper", "operador")
ADMIN = Principal.user("u-admin", "admin")

OPERATOR_ALLOWED = [
    Action.VIEW_STATUS, Action.START_JOB, Action.PAUSE, Action.RESUME, Action.CANCEL,
    Action.HOME, Action.MOVE, Action.EXTRUDE, Action.SET_TEMPERATURE, Action.SET_FAN,
    Action.SET_SPEED_FACTOR, Action.SET_FLOW_FACTOR, Action.SET_Z_OFFSET, Action.SET_WORK_ZERO,
    Action.ASSIGN_ACTIVE_SPOOL, Action.DELETE_LIBRARY_FILE, Action.DELETE_LIBRARY_FOLDER,
    Action.USE_PLUGIN, Action.READ_LOGS, Action.USE_AI,
]
ADMIN_ONLY = [
    Action.SEND_CONSOLE_COMMAND, Action.RUN_MACRO, Action.SET_LASER_POWER, Action.SET_SPINDLE,
    Action.PRINTER_CONFIG, Action.GRBL_SETTINGS, Action.FIRMWARE_RESTART, Action.RESTART_KLIPPER,
    Action.DELETE_SD_FILE, Action.CONFIGURE_PLUGIN, Action.CONFIGURE_AI, Action.CLEAR_ALL_CONVERSATIONS,
    Action.MANAGE_USERS, Action.SYSTEM_UPDATE, Action.SYSTEM_CONTROL, Action.BACKUP_EXPORT,
    Action.BACKUP_IMPORT,
]
# Acciones de operador que un dispositivo puede ejecutar dentro de su scope.
DEVICE_ACTIONS = [a for a in OPERATOR_ALLOWED if a not in (Action.READ_LOGS, Action.USE_AI)]


def tuna(*scope):
    return Principal.tuna_device("tuna-01", scope)


class TestAnonymous:
    @pytest.mark.parametrize("action", list(Action))
    def test_every_action_denied(self, action):
        result = authorize(ANON, action, A)
        assert not result
        assert result.reason is Reason.ANONYMOUS

    def test_set_temperature_and_start_job_denied(self):
        assert authorize(ANON, Action.SET_TEMPERATURE, A).decision is Decision.DENY
        assert authorize(ANON, Action.START_JOB, A).decision is Decision.DENY


class TestOperator:
    @pytest.mark.parametrize("action", OPERATOR_ALLOWED)
    def test_allowed(self, action):
        result = authorize(OPERATOR, action, A)
        assert result.allowed and result.reason is Reason.ALLOWED

    @pytest.mark.parametrize("action", ADMIN_ONLY)
    def test_admin_only_denied(self, action):
        result = authorize(OPERATOR, action, A)
        assert not result
        assert result.reason is Reason.INSUFFICIENT_ROLE
        assert result.required_role is Role.ADMIN


class TestAdmin:
    @pytest.mark.parametrize("action", OPERATOR_ALLOWED + ADMIN_ONLY)
    def test_allowed(self, action):
        assert authorize(ADMIN, action, A).allowed


class TestTunaDevice:
    def test_device_is_operator_not_a_new_role(self):
        device = tuna(A.key)
        assert device.kind is PrincipalKind.TUNA_DEVICE
        assert device.role is Role.OPERATOR
        assert set(Role) == {Role.ADMIN, Role.OPERATOR}

    def test_set_temperature_in_scope_allowed(self):
        result = authorize(tuna(A.key), Action.SET_TEMPERATURE, A)
        assert result.allowed and result.reason is Reason.ALLOWED

    def test_set_temperature_out_of_scope_denied(self):
        result = authorize(tuna(A.key), Action.SET_TEMPERATURE, B)
        assert not result and result.reason is Reason.OUT_OF_SCOPE

    def test_console_in_scope_denied(self):
        result = authorize(tuna(A.key), Action.SEND_CONSOLE_COMMAND, A)
        assert not result and result.reason is Reason.INSUFFICIENT_ROLE

    def test_laser_power_in_scope_denied(self):
        result = authorize(tuna(LASER.key), Action.SET_LASER_POWER, LASER)
        assert not result and result.reason is Reason.INSUFFICIENT_ROLE

    @pytest.mark.parametrize("action", ADMIN_ONLY)
    def test_admin_actions_denied_even_in_scope(self, action):
        result = authorize(tuna(A.key, LIBRARY.key), action, A)
        assert not result and result.reason is Reason.INSUFFICIENT_ROLE

    @pytest.mark.parametrize("action", ADMIN_ONLY)
    def test_forged_admin_device_still_denied(self, action):
        """Un TUNA_DEVICE armado a mano con role=ADMIN no gana acciones admin."""
        forged = Principal(kind=PrincipalKind.TUNA_DEVICE, id="tuna-x", role=Role.ADMIN, scope={A.key})
        result = authorize(forged, action, A)
        assert not result and result.reason is Reason.DEVICE_NOT_ALLOWED

    @pytest.mark.parametrize("action", [Action.READ_LOGS, Action.USE_AI, Action.READ_CONVERSATION])
    def test_operator_actions_not_for_devices(self, action):
        """Logs (C-5), IA y conversaciones no son para dispositivos."""
        result = authorize(tuna(A.key), action, A)
        assert not result and result.reason is Reason.DEVICE_NOT_ALLOWED

    @pytest.mark.parametrize("action", DEVICE_ACTIONS)
    def test_operator_actions_allowed_in_scope(self, action):
        assert authorize(tuna(A.key, LIBRARY.key), action, A).allowed

    def test_multiple_resources_in_scope(self):
        device = tuna(A.key, LASER.key)
        assert authorize(device, Action.PAUSE, A).allowed
        assert authorize(device, Action.HOME, LASER).allowed
        assert authorize(device, Action.PAUSE, B).reason is Reason.OUT_OF_SCOPE

    @pytest.mark.parametrize("action", DEVICE_ACTIONS)
    def test_empty_scope_denies_everything(self, action):
        result = authorize(tuna(), action, A)
        assert not result and result.reason is Reason.OUT_OF_SCOPE

    def test_unknown_resource_denied(self):
        result = authorize(tuna(A.key), Action.PAUSE, Resource(ResourceKind.PRINTER, "no-existe"))
        assert not result and result.reason is Reason.OUT_OF_SCOPE

    def test_missing_resource_denied(self):
        """Sin recurso no hay scope que evaluar: fail-closed."""
        assert authorize(tuna(A.key), Action.VIEW_STATUS, None).reason is Reason.NO_RESOURCE
        assert authorize(tuna(A.key), Action.VIEW_STATUS, Resource(ResourceKind.PRINTER)).reason is Reason.NO_RESOURCE

    def test_library_delete_according_to_scope(self):
        assert authorize(tuna(LIBRARY.key), Action.DELETE_LIBRARY_FILE, LIBRARY).allowed
        assert authorize(tuna(A.key), Action.DELETE_LIBRARY_FILE, LIBRARY).reason is Reason.OUT_OF_SCOPE

    def test_users_are_not_scope_limited(self):
        assert authorize(OPERATOR, Action.SET_TEMPERATURE, B).allowed


class TestScopeValidation:
    @pytest.mark.parametrize("bad", ["klipper:7125", "printer:klipper:7125", b"printer:01", bytearray(b"x"), None])
    def test_str_bytes_none_rejected(self, bad):
        with pytest.raises(TypeError):
            Principal.tuna_device("tuna-01", bad)

    @pytest.mark.parametrize("bad", [["printer:01", 7], [None], [b"printer:01"]])
    def test_non_string_entries_rejected(self, bad):
        with pytest.raises(TypeError):
            Principal.tuna_device("tuna-01", bad)

    @pytest.mark.parametrize("bad", [[""], ["   "], ["printer:"], ["printer:  "], ["klipper:7125"], ["01"], [":01"]])
    def test_empty_or_malformed_entries_rejected(self, bad):
        with pytest.raises(ValueError):
            Principal.tuna_device("tuna-01", bad)

    def test_direct_construction_validates_too(self):
        """El constructor directo pasa por la misma validación."""
        with pytest.raises(TypeError):
            Principal(kind=PrincipalKind.TUNA_DEVICE, id="t", role=Role.OPERATOR, scope="klipper:7125")

    def test_never_substring_or_character_match(self):
        """Regresión del bypass: scope en texto ya no puede autorizar 'k' ni
        un prefijo del id."""
        with pytest.raises(TypeError):
            Principal(kind=PrincipalKind.TUNA_DEVICE, id="t", role=Role.OPERATOR, scope="klipper:7125")
        device = tuna("printer:klipper:7125")
        for rid in ("k", "klipper:712", "klipper:71250", "7125"):
            result = authorize(device, Action.PAUSE, Resource(ResourceKind.PRINTER, rid))
            assert not result and result.reason is Reason.OUT_OF_SCOPE

    def test_valid_scope_normalized_to_frozenset(self):
        device = Principal.tuna_device("tuna-01", ["printer:01", "printer:01", "laser:02"])
        assert device.scope == frozenset({"printer:01", "laser:02"})
        assert isinstance(device.scope, frozenset)

    def test_id_with_colons_is_supported(self):
        device = tuna("printer:klipper:7125")
        assert authorize(device, Action.SET_TEMPERATURE, A).allowed

    def test_scope_only_for_devices(self):
        with pytest.raises(ValueError):
            Principal(kind=PrincipalKind.USER, id="u", role=Role.OPERATOR, scope={"printer:01"})

    def test_scope_cannot_be_reassigned(self):
        device = tuna(A.key)
        with pytest.raises(AttributeError):
            device.scope = frozenset({B.key})


class TestScopeKindAndId:
    def test_same_id_different_kind_is_a_different_resource(self):
        device = tuna("printer:01")
        assert authorize(device, Action.HOME, Resource(ResourceKind.PRINTER, "01")).allowed
        result = authorize(device, Action.HOME, Resource(ResourceKind.LASER, "01"))
        assert not result and result.reason is Reason.OUT_OF_SCOPE

    def test_machine_and_printer_kinds_do_not_collide(self):
        device = tuna("machine:klipper:7125")
        assert not authorize(device, Action.PAUSE, A)
        assert authorize(device, Action.PAUSE, Resource(ResourceKind.MACHINE, "klipper:7125")).allowed

    def test_resource_key_format(self):
        assert A.key == "printer:klipper:7125"
        assert Resource(ResourceKind.SYSTEM).key is None

    def test_resource_kind_must_be_enum(self):
        with pytest.raises(TypeError):
            Resource("printer", "01")


class TestConversations:
    MINE = Resource(ResourceKind.CONVERSATION, "c1", owner_id="u-oper")
    THEIRS = Resource(ResourceKind.CONVERSATION, "c2", owner_id="u-otro")
    CONVERSATION_ACTIONS = [Action.READ_CONVERSATION, Action.RENAME_CONVERSATION, Action.DELETE_CONVERSATION]

    @pytest.mark.parametrize("action", CONVERSATION_ACTIONS)
    def test_owner_allowed_others_denied(self, action):
        assert authorize(OPERATOR, action, self.MINE).allowed
        assert authorize(OPERATOR, action, self.THEIRS).reason is Reason.NOT_OWNER

    @pytest.mark.parametrize("action", CONVERSATION_ACTIONS)
    def test_admin_has_no_access_to_others(self, action):
        """D3-Q8: ser admin no da acceso al contenido privado (leer, renombrar ni borrar)."""
        result = authorize(ADMIN, action, self.THEIRS)
        assert not result and result.reason is Reason.NOT_OWNER
        own = Resource(ResourceKind.CONVERSATION, "c3", owner_id="u-admin")
        assert authorize(ADMIN, action, own).allowed

    def test_admin_can_clear_all_storage(self):
        """C-4: el borrado masivo es una operación de almacenamiento."""
        assert authorize(ADMIN, Action.CLEAR_ALL_CONVERSATIONS, Resource(ResourceKind.SYSTEM)).allowed
        assert not authorize(OPERATOR, Action.CLEAR_ALL_CONVERSATIONS, Resource(ResourceKind.SYSTEM))

    def test_conversation_without_owner_denied(self):
        result = authorize(OPERATOR, Action.READ_CONVERSATION, Resource(ResourceKind.CONVERSATION, "c9"))
        assert not result and result.reason is Reason.NOT_OWNER


class TestFailClosed:
    @pytest.mark.parametrize("name", ["format_disk", "set_temp", "pause_job", "jog", "", "SET_TEMPERATURE", None, 7])
    def test_unknown_action_denied(self, name):
        for principal in (ANON, OPERATOR, ADMIN, tuna(A.key)):
            result = authorize(principal, name, A)
            assert not result and result.reason is Reason.UNKNOWN_ACTION

    def test_canonical_string_accepted(self):
        assert authorize(OPERATOR, "set_temperature", A).allowed

    @pytest.mark.parametrize("role", ["operator", "root", "", None])
    def test_unknown_role_denied(self, role):
        principal = Principal.user("u-x", role)
        assert principal.role is None
        result = authorize(principal, Action.VIEW_STATUS, A)
        assert not result and result.reason is Reason.NO_ROLE

    def test_accessory_denied(self):
        result = authorize(Principal.accessory("esp32-01"), Action.VIEW_STATUS, A)
        assert not result and result.reason is Reason.PRINCIPAL_NOT_SUPPORTED

    def test_invalid_principal_kind_rejected(self):
        with pytest.raises(TypeError):
            Principal(kind="user", id="u", role=Role.ADMIN)


class TestPolicyIntegrity:
    def test_action_count(self):
        assert len(Action) == 42

    def test_every_action_has_a_rule(self):
        assert set(POLICY) == set(Action)

    def test_policy_is_immutable(self):
        with pytest.raises(TypeError):
            POLICY[Action.SEND_CONSOLE_COMMAND] = Rule(Role.OPERATOR, device_allowed=True)
        with pytest.raises(TypeError):
            del POLICY[Action.PAUSE]
        assert POLICY[Action.SEND_CONSOLE_COMMAND].min_role is Role.ADMIN

    def test_rules_are_immutable(self):
        with pytest.raises(AttributeError):
            POLICY[Action.SEND_CONSOLE_COMMAND].min_role = Role.OPERATOR

    def test_admin_only_actions_never_allowed_for_devices(self):
        for action, rule in POLICY.items():
            if rule.min_role is Role.ADMIN:
                assert not rule.device_allowed, action

    def test_tunascreen_actions_are_in_vocabulary(self):
        """Toda acción que TUNA-Screen declara hoy tiene nombre canónico en la
        política (el vocabulario parte de ahí)."""
        declared = set(tunascreen_service.KLIPPER_ACTIONS + tunascreen_service.MARLIN_ACTIONS
                       + tunascreen_service.LASER_ACTIONS + tunascreen_service.CNC_ACTIONS)
        assert declared <= {a.value for a in Action}

    def test_roles_match_auth_service(self):
        from backend.services.auth_service import ROLES
        assert {r.value for r in Role} == set(ROLES)

    def test_result_is_falsy_on_deny(self):
        result = authorize(ANON, Action.PAUSE, A)
        assert isinstance(result, AuthorizationResult) and bool(result) is False

    def test_policy_module_has_no_nopal_dependencies(self):
        """La política decide; no importa routers, servicios ni drivers. La
        ruta se resuelve desde este archivo, no desde el directorio actual."""
        source = POLICY_MODULE.read_text(encoding="utf-8")
        modules = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                modules.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                modules.add(node.module or "")
        assert not any(m.startswith("backend") for m in modules), modules
