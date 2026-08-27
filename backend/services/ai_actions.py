"""Acciones físicas de NOPAL Intelligence — registro SEPARADO del de lectura.

`ai_tools.py` es de solo lectura por contrato y así se queda. Todo lo que
toca el taller vive acá, con tres candados que no son negociables:

1. **Interruptor propio.** Las acciones están apagadas por omisión
   (`actions_enabled`). Una instalación con la IA encendida sigue siendo de
   solo consulta hasta que alguien decida lo contrario a mano.

2. **La IA nunca escala privilegios.** Cada acción declara el rol que exige,
   copiado del endpoint equivalente del panel. Si un operador no puede
   precalentar desde la interfaz (`require_role("admin")` en
   `backend/api/status.py`), tampoco puede lograrlo pidiéndoselo a la IA.

3. **Niveles de riesgo.** Las de riesgo `low` se ejecutan directo; las de
   riesgo `confirm` NO se ejecutan: devuelven una acción pendiente que la
   persona tiene que confirmar. Calentar una boquilla a 200 °C sin nadie
   enfrente no es lo mismo que prender un relé.

Lo que no está y no va a estar
------------------------------
**Arrancar el láser o el CNC.** Fue una condición explícita desde el primer
día y no depende de ningún nivel de riesgo: no existe la herramienta. Mover
ejes y hacer home tampoco están en esta primera versión.

Hay un test que recorre el registro y falla si alguien agrega algo que
encienda láser o CNC.
"""

import inspect
import logging
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# Las acciones pendientes viven en memoria a propósito: una confirmación no
# debe sobrevivir a un reinicio del panel. Si NOPAL se reinició, el contexto
# en el que la persona iba a confirmar ya no existe.
PENDING_TTL_SECONDS = 300
_pending: Dict[str, Dict[str, Any]] = {}


class ActionError(RuntimeError):
    """Falla al ejecutar una acción. El router la traduce a un 4xx."""


class Action:
    """Una acción sobre el taller.

    `risk`: "low" se ejecuta directo, "confirm" exige confirmación humana.
    `role`: "admin" o "any" — debe coincidir con el endpoint equivalente del
    panel, para que la IA no sea una puerta trasera de permisos.
    """

    def __init__(
        self,
        name: str,
        description: str,
        handler: Callable,
        parameters: Optional[Dict[str, Any]] = None,
        risk: str = "confirm",
        role: str = "admin",
    ):
        self.name = name
        self.description = description
        self.handler = handler
        self.parameters = parameters or {"type": "object", "properties": {}, "required": []}
        self.risk = risk
        self.role = role

    def to_openai_schema(self) -> Dict[str, Any]:
        aviso = "" if self.risk == "low" else " Requiere confirmación de la persona antes de ejecutarse."
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description + aviso,
                "parameters": self.parameters,
            },
        }


# --------------------------------------------------------------------------
# Implementaciones
# --------------------------------------------------------------------------

async def _resolve_machine(machine_id: str) -> Dict[str, Any]:
    from backend.services.ai_tools import _collect_machines, _resolve_machine as resolver

    machines = await _collect_machines()
    machine = resolver(machines, machine_id)
    if machine is None:
        raise ActionError(
            f"No encuentro la máquina '{machine_id}'. "
            f"Las registradas son: {', '.join(m['name'] or m['id'] for m in machines)}"
        )
    return machine


async def set_accessory_power(accessory_id: str, on: bool) -> Dict[str, Any]:
    """Enciende o apaga un accesorio (relé, tira LED, ventilador)."""
    from backend.services.plugin_loader_service import get_loaded_plugin_module

    module = get_loaded_plugin_module("arduino-accessories", "services.accessory_service")
    if module is None:
        raise ActionError("El plugin de Automatización de Taller no está instalado")

    ok = await module.set_accessory_power(accessory_id, bool(on))
    if ok is None:
        raise ActionError(f"No existe el accesorio '{accessory_id}'")
    if not ok:
        raise ActionError(f"El accesorio '{accessory_id}' no confirmó el cambio")
    return {"ok": True, "accessory_id": accessory_id, "on": bool(on)}


async def create_scene(name: str, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Crea una escena de accesorios nueva a partir de los que ya existen.

    `actions` usa el mismo formato que el editor del panel: cada entrada
    lleva un `accessory_id` y luego `on` (bool) para un relé, o `color`
    ([r,g,b]) para iluminación.
    """
    from backend.services.plugin_loader_service import get_loaded_plugin_module

    escenas = get_loaded_plugin_module("arduino-accessories", "services.accessory_scenes")
    accesorios_mod = get_loaded_plugin_module("arduino-accessories", "services.accessory_service")
    if escenas is None or accesorios_mod is None:
        raise ActionError("El plugin de Automatización de Taller no está instalado")

    crear = getattr(escenas, "create_scene", None)
    if crear is None:
        raise ActionError("Esta versión del plugin no permite crear escenas desde la IA")

    nombre = str(name or "").strip()
    if not nombre:
        raise ActionError("La escena necesita un nombre")
    if not actions:
        raise ActionError("La escena necesita al menos una acción")

    # Se validan los accessory_id contra los reales ANTES de crear: el
    # modelo puede alucinar un id, y una escena guardada apuntando a un
    # accesorio inexistente falla recién al ejecutarse, lejos de acá.
    registrados = {a.get("id"): a for a in accesorios_mod.get_accessories()}
    for accion in actions:
        accessory_id = accion.get("accessory_id")
        if accessory_id not in registrados:
            conocidos = ", ".join(
                f"{a.get('name')} ({a.get('id')})" for a in registrados.values()
            ) or "ninguno"
            raise ActionError(
                f"No existe el accesorio '{accessory_id}'. Los registrados son: {conocidos}"
            )
        if "on" not in accion and "color" not in accion:
            raise ActionError(
                f"La acción sobre '{registrados[accessory_id].get('name')}' necesita 'on' o 'color'"
            )

    resultado = crear(nombre, "normal", list(actions))
    if inspect.isawaitable(resultado):
        resultado = await resultado

    detalle = []
    for accion in actions:
        etiqueta = registrados[accion["accessory_id"]].get("name")
        if "color" in accion:
            detalle.append(f"{etiqueta} en color {tuple(accion['color'])}")
        else:
            detalle.append(f"{etiqueta} {'encendido' if accion.get('on') else 'apagado'}")

    return {
        "ok": True,
        "scene": resultado,
        "summary": f"Escena «{nombre}» creada con {len(actions)} acción(es): " + "; ".join(detalle),
    }


async def activate_scene(scene_id: str) -> Dict[str, Any]:
    """Activa una escena de accesorios ya guardada."""
    from backend.services.plugin_loader_service import get_loaded_plugin_module

    module = get_loaded_plugin_module("arduino-accessories", "services.accessory_scenes")
    if module is None:
        raise ActionError("El plugin de Automatización de Taller no está instalado")

    # El plugin la llama run_scene (async). Se aceptan los otros nombres por
    # si una versión distinta del plugin los usa, pero run_scene es el real.
    ejecutar = (getattr(module, "run_scene", None)
                or getattr(module, "apply_scene", None)
                or getattr(module, "activate_scene", None))
    if ejecutar is None:
        raise ActionError("Esta versión del plugin no permite activar escenas desde la IA")

    resultado = ejecutar(scene_id)
    if inspect.isawaitable(resultado):
        resultado = await resultado
    if resultado is None:
        # Se nombra la otra fuente a propósito: el error típico es pedir
        # una "escena" que en realidad es un anuncio o una alerta de la
        # Matriz LED, que es otro plugin con otros ids.
        raise ActionError(
            f"No existe la escena de accesorios '{scene_id}'. Si te referías a la Matriz LED, "
            "sus anuncios, reglas y alertas por máquina se consultan con get_led_matrix.")
    if resultado is False:
        raise ActionError(f"La escena '{scene_id}' no se pudo aplicar completa")
    return {"ok": True, "scene_id": scene_id}


async def send_matrix_announcement(announcement_id: str) -> Dict[str, Any]:
    """Muestra un anuncio guardado en la Matriz LED."""
    from backend.services.plugin_loader_service import get_loaded_plugin_module

    module = get_loaded_plugin_module("matriz-led", "services.screen_service")
    if module is None:
        raise ActionError("El plugin de Matriz LED no está instalado")

    enviar = getattr(module, "send_announcement", None)
    if enviar is None:
        raise ActionError("Esta versión del plugin no permite enviar anuncios desde la IA")

    resultado = enviar(announcement_id, source="ai")
    if inspect.isawaitable(resultado):
        resultado = await resultado
    if resultado is False or resultado is None:
        raise ActionError(f"No existe el anuncio '{announcement_id}' o no se pudo enviar")
    return {"ok": True, "announcement_id": announcement_id}


async def set_machine_alerts(machine_id: str, enabled: bool) -> Dict[str, Any]:
    """Prende o apaga las alertas de la Matriz LED para una máquina.

    No "activa" nada visible al instante: deja armado que la pantalla muestre
    el anuncio correspondiente cuando esa máquina cambie de estado. Si la
    máquina no tiene ningún anuncio asignado a ningún estado, prenderlas no
    hace nada -- y eso se dice, en vez de reportar un éxito que el usuario no
    va a ver en la pantalla.
    """
    from backend.services.plugin_loader_service import get_loaded_plugin_module

    module = get_loaded_plugin_module("matriz-led", "services.screen_service")
    if module is None:
        raise ActionError("El plugin de Matriz LED no está instalado")

    leer = getattr(module, "get_machine_alerts", None)
    guardar = getattr(module, "save_machine_alerts", None)
    if leer is None or guardar is None:
        raise ActionError("Esta versión del plugin no permite cambiar las alertas por máquina")

    machine = await _resolve_machine(machine_id)
    actual = leer(machine["id"]) or {}
    por_estado = {k: v for k, v in (actual.get("state_announcements") or {}).items() if v}

    # save_machine_alerts reescribe la entrada completa: si no se le
    # devuelven los anuncios ya configurados, prender las alertas los
    # borraría todos.
    guardar(machine["id"], {"enabled": bool(enabled), "state_announcements": por_estado})

    resultado = {
        "ok": True,
        "machine": machine.get("name"),
        "machine_id": machine["id"],
        "enabled": bool(enabled),
        "configured_states": sorted(por_estado),
    }
    if enabled and not por_estado:
        resultado["warning"] = (
            "Las alertas quedaron prendidas, pero esta máquina no tiene ningún anuncio asignado "
            "a ningún estado, así que la matriz no va a mostrar nada. Eso se configura en el "
            "panel del plugin Matriz LED."
        )
    return resultado


async def run_matrix_rule(rule_id: str) -> Dict[str, Any]:
    """Dispara ahora una regla de la Matriz LED (muestra su anuncio)."""
    from backend.services.plugin_loader_service import get_loaded_plugin_module

    module = get_loaded_plugin_module("matriz-led", "services.screen_service")
    if module is None:
        raise ActionError("El plugin de Matriz LED no está instalado")

    ejecutar = getattr(module, "run_rule", None)
    if ejecutar is None:
        raise ActionError("Esta versión del plugin no permite disparar reglas desde la IA")

    try:
        resultado = ejecutar(rule_id)
    except ValueError as exc:
        raise ActionError(f"No existe la regla '{rule_id}': {exc}")
    if inspect.isawaitable(resultado):
        resultado = await resultado
    return {"ok": True, "rule_id": rule_id}


async def queue_file(machine_id: str, path: str) -> Dict[str, Any]:
    """Manda un archivo de la biblioteca a la cola de una máquina.

    Hay dos colas distintas y no se pueden unificar: la de Moonraker vive en
    la impresora Klipper, y la de láser/CNC vive en NOPAL (laser_service).
    Encolar NO arranca el trabajo en ninguna de las dos -- mandar a la cola y
    ponerse a cortar son decisiones distintas, y en el láser esa distinción
    es una regla del proyecto, no una preferencia.
    """
    from backend.services.klipper_service import send_gcode_to_printer

    machine = await _resolve_machine(machine_id)

    if machine["kind"] in ("laser", "cnc"):
        from backend.services.laser_service import add_to_queue
        from backend.utils import safe_section_path

        # Se comprueba que el archivo exista antes de encolarlo: una cola con
        # una ruta inventada falla recién al intentar cortar, que es el peor
        # momento posible para enterarse.
        if not os.path.isfile(safe_section_path("gcode", path)):
            raise ActionError(
                f"No existe '{path}' en la biblioteca. Usa get_library para ver las rutas reales.")
        entrada = add_to_queue(path, os.path.basename(path), machine["kind"])
        return {"ok": True, "machine": machine["name"], "path": path,
                "queue": machine["kind"], "queued_id": entrada.get("id")}

    if machine["brand"] != "klipper":
        raise ActionError(
            f"{machine['name']} no tiene cola en NOPAL. Solo las impresoras Klipper (por "
            "Moonraker) y el láser/CNC tienen cola.")

    port = int(str(machine["id"]).split(":", 1)[1])
    # mode="queue" encola en vez de imprimir de inmediato: mandar a la cola y
    # arrancar una impresión son decisiones distintas.
    resultado = send_gcode_to_printer(port, path, mode="queue", section="gcode")
    if not resultado or resultado.get("error"):
        raise ActionError(resultado.get("error") if resultado else "No se pudo encolar el archivo")
    return {"ok": True, "machine": machine["name"], "path": path, "queue": "moonraker"}


async def preheat_machine(machine_id: str, nozzle: Optional[float] = None,
                          bed: Optional[float] = None) -> Dict[str, Any]:
    """Fija temperaturas objetivo. Riesgo medio: calienta sin nadie enfrente."""
    from backend.services.klipper_service import set_heater_target

    machine = await _resolve_machine(machine_id)
    if machine["brand"] != "klipper":
        raise ActionError(f"Solo puedo precalentar impresoras Klipper; {machine['name']} no lo es")
    if nozzle is None and bed is None:
        raise ActionError("Falta decir a qué temperatura: boquilla, cama o ambas")

    port = int(str(machine["id"]).split(":", 1)[1])
    aplicado = {}
    for heater, valor in (("extruder", nozzle), ("heater_bed", bed)):
        if valor is None:
            continue
        if not 0 <= float(valor) <= 350:
            raise ActionError(f"{valor} °C está fuera del rango razonable (0-350)")
        if not set_heater_target(port, heater, float(valor)):
            raise ActionError(f"La impresora no aceptó la temperatura para {heater}")
        aplicado[heater] = float(valor)

    return {"ok": True, "machine": machine["name"], "targets": aplicado}


async def control_print(machine_id: str, action: str) -> Dict[str, Any]:
    """Pausa, reanuda o cancela la impresión en curso."""
    from backend.services.klipper_service import (
        cancel_printer_print, pause_printer_print, resume_printer_print,
    )

    acciones = {"pause": pause_printer_print, "resume": resume_printer_print, "cancel": cancel_printer_print}
    if action not in acciones:
        raise ActionError(f"Acción inválida: usa una de {', '.join(acciones)}")

    machine = await _resolve_machine(machine_id)
    if machine["brand"] != "klipper":
        raise ActionError(f"{machine['name']} no es una impresora Klipper")

    port = int(str(machine["id"]).split(":", 1)[1])
    if not acciones[action](port):
        raise ActionError(f"La impresora no aceptó la orden de {action}")
    return {"ok": True, "machine": machine["name"], "action": action}


async def assign_spool(machine_id: str, spool_id: int) -> Dict[str, Any]:
    """Cambia qué carrete de Spoolman tiene cargado una impresora Klipper.

    A diferencia de preheat_machine/control_print no le pide a la impresora
    que HAGA nada (sin G-code, sin calor, sin movimiento) -- solo actualiza
    qué carrete muestra la ficha, e intenta sincronizarlo con el carrete
    "activo" del componente [spoolman] de Moonraker si está configurado
    (mismo comportamiento que set_active_spool_endpoint en
    plugins/spoolman/backend/router.py, que es lo que copia el rol admin
    de acá). Si Moonraker no tiene [spoolman] configurado, la asignación en
    NOPAL se guarda igual -- perder esa sincronización no es motivo para
    fallar la acción.
    """
    from backend.services.klipper_service import MoonrakerClient
    from backend.services.plugin_loader_service import get_loaded_plugin_module

    machine = await _resolve_machine(machine_id)
    if machine["brand"] != "klipper":
        raise ActionError(
            f"Solo se puede vincular material a impresoras Klipper; {machine['name']} no lo es "
            "(por ahora el plugin de Materiales solo vincula por puerto de Moonraker).")

    config_module = get_loaded_plugin_module("spoolman", "services.config_service")
    link_module = get_loaded_plugin_module("spoolman", "services.spool_link_service")
    if config_module is None or link_module is None:
        raise ActionError("El plugin de Materiales (Spoolman) no está instalado o no está cargado")

    client = config_module.get_client()
    if client is None:
        raise ActionError("El plugin de Materiales no tiene un servidor Spoolman configurado")

    spool = client.get_spool(spool_id)
    if spool is None:
        raise ActionError(
            f"No existe el carrete {spool_id} en Spoolman. Usa get_material_status para ver los reales.")

    port = int(str(machine["id"]).split(":", 1)[1])
    sincronizado = MoonrakerClient(port).set_spoolman_active_spool(spool_id)
    link_module.set_link(port, spool_id)
    filamento = spool.get("filament") or {}
    return {
        "ok": True,
        "machine": machine["name"],
        "spool_id": spool_id,
        "material": filamento.get("material"),
        "label": filamento.get("name") or filamento.get("material"),
        "moonraker_synced": sincronizado,
    }


# --------------------------------------------------------------------------
# Registro
# --------------------------------------------------------------------------

_MACHINE_PARAM = {
    "machine_id": {"type": "string", "description": "Id o nombre de la máquina."},
}

ACTIONS: Dict[str, Action] = {
    action.name: action
    for action in [
        Action(
            "set_accessory_power",
            "Enciende o apaga un accesorio del taller (relé, tira LED, ventilador). "
            "Usa get_accessories primero para saber los ids.",
            set_accessory_power,
            {
                "type": "object",
                "properties": {
                    "accessory_id": {"type": "string", "description": "Id del accesorio."},
                    "on": {"type": "boolean", "description": "true para encender, false para apagar."},
                },
                "required": ["accessory_id", "on"],
            },
            risk="low",
            # El panel lo permite a cualquier usuario autenticado
            # (accessory_power_endpoint usa require_auth).
            role="any",
        ),
        Action(
            "activate_scene",
            "Activa una escena de ACCESORIOS (tiras LED, relés, ventiladores). NO tiene nada que ver "
            "con la Matriz LED: para mostrar algo en la matriz usa send_matrix_announcement.",
            activate_scene,
            {
                "type": "object",
                "properties": {"scene_id": {"type": "string", "description": "Id de la escena."}},
                "required": ["scene_id"],
            },
            risk="low",
            role="any",
        ),
        Action(
            "create_scene",
            "Crea una escena de ACCESORIOS nueva (por ejemplo 'Ciclo de ventilación' o 'Modo "
            "noche') combinando relés y luces del taller. Consulta antes los accesorios "
            "disponibles para usar sus id reales; no inventes ninguno.",
            create_scene,
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Nombre visible de la escena."},
                    "actions": {
                        "type": "array",
                        "description": (
                            "Acciones de la escena. Cada una lleva accessory_id y luego 'on' "
                            "(booleano) para un relé, o 'color' ([r,g,b]) para iluminación."
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "accessory_id": {"type": "string"},
                                "on": {"type": "boolean"},
                                "color": {
                                    "type": "array",
                                    "items": {"type": "integer"},
                                    "minItems": 3,
                                    "maxItems": 3,
                                },
                            },
                            "required": ["accessory_id"],
                        },
                    },
                },
                "required": ["name", "actions"],
            },
            risk="confirm",
            role="admin",
        ),
        Action(
            "send_matrix_announcement",
            "Muestra un anuncio guardado en la Matriz LED. Es un plugin distinto al de accesorios: "
            "esto NO enciende tiras LED ni relés. Usa get_led_matrix para conocer los ids.",
            send_matrix_announcement,
            {
                "type": "object",
                "properties": {"announcement_id": {"type": "string", "description": "Id del anuncio."}},
                "required": ["announcement_id"],
            },
            risk="low",
            role="any",
        ),
        Action(
            "set_machine_alerts",
            "Prende o apaga las ALERTAS POR MÁQUINA de la Matriz LED. No muestra nada al "
            "instante: deja armado que la pantalla avise cuando esa máquina cambie de estado. "
            "Usa get_led_matrix para ver cuáles hay y cómo están; nunca inventes ids.",
            set_machine_alerts,
            {
                "type": "object",
                "properties": {
                    **_MACHINE_PARAM,
                    "enabled": {"type": "boolean", "description": "true para prenderlas, false para apagarlas."},
                },
                "required": ["machine_id", "enabled"],
            },
            risk="low",
            role="any",
        ),
        Action(
            "run_matrix_rule",
            "Dispara ahora una regla de la Matriz LED, mostrando su anuncio. Los ids salen de "
            "get_led_matrix. No confundir con las escenas de accesorios (activate_scene).",
            run_matrix_rule,
            {
                "type": "object",
                "properties": {"rule_id": {"type": "string", "description": "Id de la regla."}},
                "required": ["rule_id"],
            },
            risk="low",
            role="any",
        ),
        Action(
            "queue_file",
            "Manda un archivo de la biblioteca a la cola de una máquina: impresoras Klipper "
            "(cola de Moonraker) y láser/CNC (cola de NOPAL). ENCOLA, no arranca el trabajo. "
            "Usa get_library para obtener la ruta exacta; nunca inventes rutas.",
            queue_file,
            {
                "type": "object",
                "properties": {
                    **_MACHINE_PARAM,
                    "path": {"type": "string", "description": "Ruta del archivo tal como la devuelve get_library."},
                },
                "required": ["machine_id", "path"],
            },
            risk="low",
            role="any",
        ),
        Action(
            "preheat_machine",
            "Fija la temperatura objetivo de la boquilla y/o la cama de una impresora Klipper.",
            preheat_machine,
            {
                "type": "object",
                "properties": {
                    **_MACHINE_PARAM,
                    "nozzle": {"type": "number", "description": "Temperatura de la boquilla en °C."},
                    "bed": {"type": "number", "description": "Temperatura de la cama en °C."},
                },
                "required": ["machine_id"],
            },
            risk="confirm",
            # Copiado de set_temperature_target_endpoint en backend/api/status.py,
            # que es admin-only: la IA no puede ser más permisiva que el panel.
            role="admin",
        ),
        Action(
            "control_print",
            "Pausa, reanuda o cancela la impresión en curso de una impresora Klipper.",
            control_print,
            {
                "type": "object",
                "properties": {
                    **_MACHINE_PARAM,
                    "action": {"type": "string", "enum": ["pause", "resume", "cancel"]},
                },
                "required": ["machine_id", "action"],
            },
            risk="confirm",
            role="any",
        ),
        Action(
            "assign_spool",
            "Cambia qué carrete de Spoolman tiene cargado una impresora Klipper. No manda nada a "
            "la máquina, es un cambio de inventario. Usa get_material_status para conocer los ids "
            "reales de los carretes; nunca inventes uno.",
            assign_spool,
            {
                "type": "object",
                "properties": {
                    **_MACHINE_PARAM,
                    "spool_id": {"type": "integer", "description": "Id del carrete en Spoolman, de get_material_status."},
                },
                "required": ["machine_id", "spool_id"],
            },
            risk="low",
            # Copiado de set_active_spool_endpoint en el plugin de Materiales,
            # que es admin-only: la IA no puede ser más permisiva que el panel.
            role="admin",
        ),
    ]
}


def get_actions(role: str) -> List[Action]:
    """Las acciones que ese rol puede ejecutar. Un operador nunca ve en el
    catálogo lo que no podría hacer en el panel."""
    return [a for a in ACTIONS.values() if a.role == "any" or a.role == role]


def get_actions_schema(role: str) -> List[Dict[str, Any]]:
    return [a.to_openai_schema() for a in get_actions(role)]


def _purge_expired() -> None:
    limite = time.time() - PENDING_TTL_SECONDS
    for key in [k for k, v in _pending.items() if v["created_at"] < limite]:
        _pending.pop(key, None)


def stage_action(name: str, arguments: Dict[str, Any], username: str) -> Dict[str, Any]:
    """Deja una acción de riesgo esperando confirmación humana."""
    _purge_expired()
    token = uuid.uuid4().hex[:12]
    _pending[token] = {
        "id": token,
        "action": name,
        "arguments": arguments,
        "username": username,
        "created_at": time.time(),
    }
    accion = ACTIONS[name]
    return {"id": token, "action": name, "arguments": arguments, "description": accion.description}


async def execute(name: str, arguments: Dict[str, Any], role: str) -> Dict[str, Any]:
    """Ejecuta una acción ya autorizada. No comprueba el nivel de riesgo:
    quien llama decide si venía de una confirmación."""
    accion = ACTIONS.get(name)
    if accion is None:
        raise ActionError(f"No existe la acción '{name}'")
    if accion.role != "any" and accion.role != role:
        raise ActionError("Tu cuenta no tiene permiso para esta acción")

    permitidos = set((accion.parameters.get("properties") or {}).keys())
    filtrados = {k: v for k, v in (arguments or {}).items() if k in permitidos}
    faltan = [k for k in accion.parameters.get("required", []) if k not in filtrados]
    if faltan:
        raise ActionError(f"Faltan datos: {', '.join(faltan)}")

    logger.info(f"[IA] acción {name}({filtrados}) ejecutada por rol={role}")
    return await accion.handler(**filtrados)


async def confirm(token: str, role: str, username: str) -> Dict[str, Any]:
    """Ejecuta una acción pendiente. Solo la puede confirmar quien la pidió."""
    _purge_expired()
    pendiente = _pending.get(token)
    if pendiente is None:
        raise ActionError("Esa confirmación ya venció o no existe")
    if pendiente["username"] != username:
        raise ActionError("Solo quien pidió la acción puede confirmarla")

    _pending.pop(token, None)  # de un solo uso, incluso si la ejecución falla
    return await execute(pendiente["action"], pendiente["arguments"], role)


def cancel(token: str) -> bool:
    return _pending.pop(token, None) is not None
