"""Authorization Policy de NOPAL (ADR-006) — infraestructura, sin enforcement.

Qué es esto
-----------
Una política única que responde a la pregunta "¿puede este principal hacer
esta acción sobre este recurso?", independiente del canal (panel,
TUNA-Screen, IA, plugins) y del driver (Klipper, Marlin, GRBL…):

    authorize(principal, action, resource) -> AuthorizationResult (ALLOW / DENY)

- **Principal**: quién pide. Un usuario humano (`admin` u `operador`), un
  dispositivo TUNA-Screen, un accesorio de firmware o un anónimo. Los
  dispositivos TUNA-Screen NO son un tercer rol humano: son un principal
  propio con perfil fijo `operador` y un **scope** (D3-Q5, D3-Q12).
- **Action**: qué se pide, de un vocabulario único y cerrado (`Action`).
- **Resource**: sobre qué (una máquina, la biblioteca, una conversación…).
- **Scope**: conjunto de recursos sobre los que un dispositivo TUNA-Screen
  puede actuar. Cada entrada es la clave canónica `"<kind>:<id>"` de un
  recurso (`Resource.key`), p. ej. `printer:klipper:7125` — para máquinas el
  id es el normalizado `driver:raw_id` del modelo de TUNA-Screen. Se compara
  por igualdad exacta de `(kind, id)`: `printer:01` y `laser:01` son recursos
  distintos. Se valida al construir el `Principal` y se guarda como
  `frozenset[str]`; un `str`, `bytes`, `None`, una entrada vacía, que no sea
  texto o con un tipo de recurso desconocido se rechaza con error (no se
  "limpia"). El almacenamiento real del scope no existe todavía: aquí solo se
  recibe como dato.

Policy vs. enforcement
----------------------
Este módulo solo **decide**; no ejecuta nada ni conoce routers, drivers ni
servicios (solo usa la biblioteca estándar). Aplicar la decisión
(enforcement) — traducir DENY a 401/403, filtrar listados por scope,
bloquear la llamada al driver — es trabajo de cada canal y **todavía no está
conectado**: `require_auth`, `require_role`, `require_device_token` y
`ai_actions.Action.role` siguen siendo los que mandan.

TARGET vs. CURRENT
------------------
La tabla `POLICY` implementa la matriz **TARGET** de ADR-006 (SDD §18.6–18.7,
incluidos C-1…C-6). El comportamiento real de NOPAL sigue siendo la matriz
**CURRENT** (SDD §18.3) hasta que cada canal migre (SDD §18.10). Ejemplo:
TARGET dice `set_temperature → operador`, pero `/api/system/temperature-target`
sigue exigiendo admin hasta su migración.

Fail-closed
-----------
Todo lo que la política no reconoce se deniega: acción desconocida, rol
desconocido, principal sin rol, dispositivo sin recurso o con recurso fuera
de scope, conversación sin propietario. Un scope mal formado ni siquiera
permite construir el `Principal` (`TypeError`/`ValueError`): quien lo
construya — la futura capa de enforcement — debe tratar ese error como DENY.
La tabla `POLICY` es de solo lectura (`MappingProxyType`).

Vocabulario canónico y nombres existentes
-----------------------------------------
Las acciones de máquina usan los nombres que ya existen en
`tunascreen_service` (ADR-006 parte de ese vocabulario). Mapeo de nombres
que el código o la documentación usan para el mismo concepto:

    pause_job / control_print(pause)   -> Action.PAUSE        ("pause")
    resume_job / control_print(resume) -> Action.RESUME       ("resume")
    cancel_job / control_print(cancel) -> Action.CANCEL       ("cancel")
    jog                                -> Action.MOVE         ("move")
    preheat_machine (IA), temperature-target (panel)
                                       -> Action.SET_TEMPERATURE
    queue_file (IA), print/start, job/start (panel)
                                       -> Action.START_JOB
    assign_spool (IA), active-spool (Spoolman), materials/active (TUNA)
                                       -> Action.ASSIGN_ACTIVE_SPOOL
    run_arbitrary_macro                -> Action.RUN_MACRO    ("run_macro", C-1)
    /printer/restart                   -> Action.RESTART_KLIPPER (C-2)

`authorize()` solo acepta el nombre canónico: los alias de arriba son
documentación para la migración, no sinónimos válidos.
"""

from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, FrozenSet, Iterable, Mapping, Optional, Union


class PrincipalKind(str, Enum):
    ANONYMOUS = "anonymous"
    USER = "user"
    TUNA_DEVICE = "tuna_device"
    ACCESSORY = "accessory"


class Role(str, Enum):
    """Los dos únicos roles de NOPAL (D3-Q12). Los valores coinciden con
    `auth_service.ROLES` — el operador se llama `operador` internamente."""

    ADMIN = "admin"
    OPERATOR = "operador"

    @classmethod
    def parse(cls, value: Optional[str]) -> Optional["Role"]:
        """Rol a partir del valor guardado; None si no es un rol válido
        (y entonces la política deniega)."""
        for role in cls:
            if role.value == value:
                return role
        return None


class ResourceKind(str, Enum):
    MACHINE = "machine"
    PRINTER = "printer"
    LASER = "laser"
    CNC = "cnc"
    LIBRARY = "library"
    SD = "sd"
    PLUGIN = "plugin"
    CONVERSATION = "conversation"
    SYSTEM = "system"


@dataclass(frozen=True)
class Resource:
    """Sobre qué se pide la acción. `key` (`"<kind>:<id>"`) es lo que se
    compara contra el scope de un dispositivo; `owner_id` solo aplica a
    recursos con propietario (conversaciones de IA, D3-Q8)."""

    kind: ResourceKind
    id: Optional[str] = None
    owner_id: Optional[str] = None

    def __post_init__(self):
        if not isinstance(self.kind, ResourceKind):
            raise TypeError("Resource.kind debe ser un ResourceKind")

    @property
    def key(self) -> Optional[str]:
        """Clave canónica `kind:id` (None si el recurso no tiene id)."""
        return f"{self.kind.value}:{self.id}" if self.id else None


_RESOURCE_KIND_VALUES = frozenset(kind.value for kind in ResourceKind)


def _normalize_scope(scope: Any) -> FrozenSet[str]:
    """Valida el scope y lo devuelve como `frozenset[str]` de claves
    `kind:id`. Rechaza (sin intentar corregir) todo lo que no sea una
    colección de claves válidas: un `str` suelto se iteraría por caracteres o
    se compararía por subcadena, que es justo el bypass que esto evita."""
    if scope is None or isinstance(scope, (str, bytes, bytearray)):
        raise TypeError("El scope debe ser una colección de claves 'kind:id', no un texto suelto ni None")
    try:
        entries = list(scope)
    except TypeError as exc:
        raise TypeError("El scope debe ser una colección de claves 'kind:id'") from exc
    normalized = set()
    for entry in entries:
        if not isinstance(entry, str):
            raise TypeError("Cada entrada del scope debe ser texto")
        kind, sep, resource_id = entry.partition(":")
        if not entry.strip() or not sep or kind not in _RESOURCE_KIND_VALUES or not resource_id.strip():
            raise ValueError(f"Entrada de scope inválida: {entry!r} (se espera '<kind>:<id>')")
        normalized.add(entry)
    return frozenset(normalized)


@dataclass(frozen=True)
class Principal:
    """Quién pide la acción. Usar los constructores de clase en vez de armar
    combinaciones a mano (p. ej. un dispositivo siempre es `operador`).

    Todo camino de construcción — constructores de clase o directo — valida
    y normaliza el scope en `__post_init__`. Solo un dispositivo puede tener
    scope: los usuarios no están limitados por scope."""

    kind: PrincipalKind
    id: Optional[str] = None
    role: Optional[Role] = None
    scope: FrozenSet[str] = field(default_factory=frozenset)

    def __post_init__(self):
        if not isinstance(self.kind, PrincipalKind):
            raise TypeError("Principal.kind debe ser un PrincipalKind")
        scope = _normalize_scope(self.scope)
        if scope and self.kind is not PrincipalKind.TUNA_DEVICE:
            raise ValueError("Solo un dispositivo TUNA-Screen puede tener scope")
        object.__setattr__(self, "scope", scope)

    @classmethod
    def anonymous(cls) -> "Principal":
        return cls(kind=PrincipalKind.ANONYMOUS)

    @classmethod
    def user(cls, user_id: str, role: Union[Role, str, None]) -> "Principal":
        parsed = role if isinstance(role, Role) else Role.parse(role)
        return cls(kind=PrincipalKind.USER, id=user_id, role=parsed)

    @classmethod
    def tuna_device(cls, device_id: str, scope: Iterable[str]) -> "Principal":
        # Perfil fijo operador + scope (D3-Q5). No es un rol humano. El scope
        # es obligatorio y se valida en __post_init__.
        return cls(kind=PrincipalKind.TUNA_DEVICE, id=device_id, role=Role.OPERATOR, scope=scope)

    @classmethod
    def accessory(cls, accessory_id: Optional[str] = None) -> "Principal":
        return cls(kind=PrincipalKind.ACCESSORY, id=accessory_id)


class Action(str, Enum):
    """Vocabulario único de acciones. Ver el mapeo de nombres existentes en
    el docstring del módulo."""

    # Máquinas — operación normal (nombres de tunascreen_service)
    VIEW_STATUS = "view_status"
    START_JOB = "start_job"
    PAUSE = "pause"
    RESUME = "resume"
    CANCEL = "cancel"
    HOME = "home"
    MOVE = "move"
    EXTRUDE = "extrude"
    SET_TEMPERATURE = "set_temperature"
    SET_FAN = "set_fan"
    SET_SPEED_FACTOR = "set_speed_factor"
    SET_FLOW_FACTOR = "set_flow_factor"
    SET_Z_OFFSET = "set_z_offset"
    SET_AIR_ASSIST = "set_air_assist"
    SET_COOLANT = "set_coolant"
    SET_WORK_ZERO = "set_work_zero"
    ASSIGN_ACTIVE_SPOOL = "assign_active_spool"

    # Máquinas — privilegiadas
    SEND_CONSOLE_COMMAND = "send_console_command"
    RUN_MACRO = "run_macro"
    SET_LASER_POWER = "set_laser_power"
    SET_SPINDLE = "set_spindle"
    PRINTER_CONFIG = "printer_config"
    GRBL_SETTINGS = "grbl_settings"
    FIRMWARE_RESTART = "firmware_restart"
    RESTART_KLIPPER = "restart_klipper"

    # Biblioteca y SD
    DELETE_LIBRARY_FILE = "delete_library_file"
    DELETE_LIBRARY_FOLDER = "delete_library_folder"
    DELETE_SD_FILE = "delete_sd_file"

    # Plugins
    USE_PLUGIN = "use_plugin"
    CONFIGURE_PLUGIN = "configure_plugin"

    # Logs, IA y conversaciones
    READ_LOGS = "read_logs"
    USE_AI = "use_ai"
    CONFIGURE_AI = "configure_ai"
    READ_CONVERSATION = "read_conversation"
    RENAME_CONVERSATION = "rename_conversation"
    DELETE_CONVERSATION = "delete_conversation"
    CLEAR_ALL_CONVERSATIONS = "clear_all_conversations"

    # Administración
    MANAGE_USERS = "manage_users"
    SYSTEM_UPDATE = "system_update"
    SYSTEM_CONTROL = "system_control"
    BACKUP_EXPORT = "backup_export"
    BACKUP_IMPORT = "backup_import"


@dataclass(frozen=True)
class Rule:
    """Requisito de una acción.

    `min_role`: rol mínimo de un usuario (admin cubre todo lo de operador).
    `device_allowed`: si un dispositivo TUNA-Screen puede ejecutarla (solo
    tiene sentido para acciones de nivel operador, y siempre dentro de scope).
    `owner_only`: el recurso debe pertenecer al principal, sin excepción para
    admin (D3-Q8: ser admin no da acceso al contenido privado).
    """

    min_role: Role
    device_allowed: bool = False
    owner_only: bool = False


_OP = Role.OPERATOR
_ADMIN = Role.ADMIN

# Matriz TARGET de ADR-006 (SDD §18.6–18.7). Es la única fuente de verdad de
# la política; no hay entradas por canal ni por driver.
POLICY: Mapping[Action, Rule] = MappingProxyType({
    # Operación normal: operador y dispositivos dentro de su scope.
    Action.VIEW_STATUS: Rule(_OP, device_allowed=True),
    Action.START_JOB: Rule(_OP, device_allowed=True),
    Action.PAUSE: Rule(_OP, device_allowed=True),
    Action.RESUME: Rule(_OP, device_allowed=True),
    Action.CANCEL: Rule(_OP, device_allowed=True),
    Action.HOME: Rule(_OP, device_allowed=True),
    Action.MOVE: Rule(_OP, device_allowed=True),
    Action.EXTRUDE: Rule(_OP, device_allowed=True),
    Action.SET_TEMPERATURE: Rule(_OP, device_allowed=True),  # D3-Q1
    Action.SET_FAN: Rule(_OP, device_allowed=True),
    Action.SET_SPEED_FACTOR: Rule(_OP, device_allowed=True),
    Action.SET_FLOW_FACTOR: Rule(_OP, device_allowed=True),
    Action.SET_Z_OFFSET: Rule(_OP, device_allowed=True),
    Action.SET_AIR_ASSIST: Rule(_OP, device_allowed=True),
    Action.SET_COOLANT: Rule(_OP, device_allowed=True),
    # set_work_zero (G10 L20) fija el cero de trabajo para el trabajo en curso:
    # es preparación del trabajo, no configuración persistente de la máquina
    # (eso es grbl_settings / printer_config, Admin).
    Action.SET_WORK_ZERO: Rule(_OP, device_allowed=True),
    Action.ASSIGN_ACTIVE_SPOOL: Rule(_OP, device_allowed=True),  # C-3
    # Privilegiadas: solo admin, nunca un dispositivo.
    Action.SEND_CONSOLE_COMMAND: Rule(_ADMIN),  # D3-Q2
    Action.RUN_MACRO: Rule(_ADMIN),  # C-1
    Action.SET_LASER_POWER: Rule(_ADMIN),  # D3-Q3
    Action.SET_SPINDLE: Rule(_ADMIN),  # D3-Q3
    Action.PRINTER_CONFIG: Rule(_ADMIN),  # D3-Q4
    Action.GRBL_SETTINGS: Rule(_ADMIN),  # D3-Q4
    Action.FIRMWARE_RESTART: Rule(_ADMIN),  # D3-Q4
    Action.RESTART_KLIPPER: Rule(_ADMIN),  # C-2
    # Biblioteca: operador; SD: admin (D3-Q7).
    Action.DELETE_LIBRARY_FILE: Rule(_OP, device_allowed=True),
    Action.DELETE_LIBRARY_FOLDER: Rule(_OP, device_allowed=True),
    Action.DELETE_SD_FILE: Rule(_ADMIN),
    # Plugins: usar = operador, configurar = admin (D3-Q9).
    Action.USE_PLUGIN: Rule(_OP, device_allowed=True),
    Action.CONFIGURE_PLUGIN: Rule(_ADMIN),
    # Logs: operador, nunca un dispositivo (D3-Q11, C-5). Incluye el
    # diagnóstico cuando forma parte del mismo canal de información
    # operacional (versión, estado del sistema); secretos y credenciales nunca.
    Action.READ_LOGS: Rule(_OP),
    # IA: usarla es de operador; los dispositivos no tienen conversaciones.
    Action.USE_AI: Rule(_OP),
    Action.CONFIGURE_AI: Rule(_ADMIN),
    Action.READ_CONVERSATION: Rule(_OP, owner_only=True),  # D3-Q8
    Action.RENAME_CONVERSATION: Rule(_OP, owner_only=True),  # D3-Q8
    Action.DELETE_CONVERSATION: Rule(_OP, owner_only=True),  # D3-Q8
    Action.CLEAR_ALL_CONVERSATIONS: Rule(_ADMIN),  # C-4: almacenamiento, no lectura
    # Administración.
    Action.MANAGE_USERS: Rule(_ADMIN),
    Action.SYSTEM_UPDATE: Rule(_ADMIN),
    Action.SYSTEM_CONTROL: Rule(_ADMIN),
    Action.BACKUP_EXPORT: Rule(_ADMIN),
    Action.BACKUP_IMPORT: Rule(_ADMIN),
})

_ROLE_RANK = {Role.OPERATOR: 1, Role.ADMIN: 2}


class Decision(str, Enum):
    ALLOW = "allow"
    DENY = "deny"


class Reason(str, Enum):
    """Por qué se decidió así. Uso interno (logs, tests); la capa HTTP futura
    decide qué mostrar — no se expone automáticamente al usuario."""

    ALLOWED = "allowed"
    UNKNOWN_ACTION = "unknown_action"
    ANONYMOUS = "anonymous"
    NO_ROLE = "no_role"
    INSUFFICIENT_ROLE = "insufficient_role"
    DEVICE_NOT_ALLOWED = "device_not_allowed"
    NO_RESOURCE = "no_resource"
    OUT_OF_SCOPE = "out_of_scope"
    NOT_OWNER = "not_owner"
    PRINCIPAL_NOT_SUPPORTED = "principal_not_supported"


@dataclass(frozen=True)
class AuthorizationResult:
    decision: Decision
    reason: Reason
    action: Optional[Action] = None
    resource: Optional[Resource] = None
    required_role: Optional[Role] = None

    @property
    def allowed(self) -> bool:
        return self.decision is Decision.ALLOW

    def __bool__(self) -> bool:
        return self.allowed


def _deny(reason: Reason, action=None, resource=None, rule: Optional[Rule] = None) -> AuthorizationResult:
    return AuthorizationResult(
        Decision.DENY, reason, action, resource, rule.min_role if rule else None,
    )


def _parse_action(action: Union[Action, str]) -> Optional[Action]:
    if isinstance(action, Action):
        return action
    try:
        return Action(action)
    except ValueError:
        return None


def authorize(
    principal: Principal,
    action: Union[Action, str],
    resource: Optional[Resource] = None,
) -> AuthorizationResult:
    """Decide ALLOW / DENY según la matriz TARGET. Fail-closed: cualquier
    caso no contemplado se deniega."""
    parsed = _parse_action(action)
    rule = POLICY.get(parsed) if parsed is not None else None
    if rule is None:
        return _deny(Reason.UNKNOWN_ACTION, parsed, resource)

    if principal.kind is PrincipalKind.ANONYMOUS:
        return _deny(Reason.ANONYMOUS, parsed, resource, rule)

    if principal.kind is PrincipalKind.ACCESSORY:
        # Ninguna acción de la política está asignada a accesorios; su
        # endpoint propio (aviso de clúster) se autentica aparte.
        return _deny(Reason.PRINCIPAL_NOT_SUPPORTED, parsed, resource, rule)

    if principal.kind not in (PrincipalKind.USER, PrincipalKind.TUNA_DEVICE):
        return _deny(Reason.PRINCIPAL_NOT_SUPPORTED, parsed, resource, rule)

    if not isinstance(principal.role, Role):
        return _deny(Reason.NO_ROLE, parsed, resource, rule)

    if _ROLE_RANK[principal.role] < _ROLE_RANK[rule.min_role]:
        return _deny(Reason.INSUFFICIENT_ROLE, parsed, resource, rule)

    if principal.kind is PrincipalKind.TUNA_DEVICE:
        if not rule.device_allowed or principal.role is not Role.OPERATOR:
            return _deny(Reason.DEVICE_NOT_ALLOWED, parsed, resource, rule)
        if resource is None or resource.key is None:
            return _deny(Reason.NO_RESOURCE, parsed, resource, rule)
        # Igualdad exacta de la clave kind:id contra un frozenset validado:
        # sin subcadenas ni colisiones entre tipos de recurso.
        if resource.key not in principal.scope:
            return _deny(Reason.OUT_OF_SCOPE, parsed, resource, rule)

    if rule.owner_only:
        if resource is None or not resource.owner_id or resource.owner_id != principal.id:
            return _deny(Reason.NOT_OWNER, parsed, resource, rule)

    return AuthorizationResult(Decision.ALLOW, Reason.ALLOWED, parsed, resource, rule.min_role)
