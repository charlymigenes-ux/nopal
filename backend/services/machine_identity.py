"""Identidad estable de máquinas (Marlin y GRBL/láser/CNC).

Por qué existe
--------------
Marlin y los láseres se identificaban por su dirección de transporte actual
(`/dev/ttyUSBx`, la IP o `usb:/dev/ttyUSBx`). Esa dirección cambia: el kernel
renumera los puertos USB y el DHCP reasigna IPs. Cada cambio rompía todo lo
que había guardado el id viejo (reglas LED, cámaras, alertas, historial) y,
peor, una dirección reutilizada podía hacer que una referencia vieja apuntara
a OTRA máquina física.

Modelo (estrategia A)
---------------------
- Cada entrada de `marlin_printer_registry.json` y `laser_registry.json` lleva
  un id interno inmutable en el campo `id`, asignado por NOPAL:
  `mch_<16 hex>` (mismo estilo que `u_…` de usuarios y `tuna_…` de
  dispositivos). Nunca cambia aunque cambien puerto, IP o ruta.
- Los ids canónicos que ven TUNA-Screen, la IA, la Authorization Policy, las
  cámaras y los plugins son `marlin:<id>` y `laser:<id>` (el láser y la CNC
  comparten el driver `laser`; el tipo va aparte).
- Las anclas sirven SOLO para reencontrar el equipo, nunca son el id:
  `location` USB (topología bus-hub-puerto), `mac` (ARP del servidor) y, como
  dato complementario, `chip_id` de `[ESP420]` (16 bits de la MAC: puede
  repetirse, nunca identifica por sí solo). La IP y la ruta `/dev/…` son datos
  volátiles.

Regla de conflicto (fail-closed)
--------------------------------
Ancla que coincide → mismo id, máquina en línea. Ancla ambigua (dos máquinas
con la misma MAC, una MAC en varias IPs, un Chip ID repetido sin MAC) o que no
coincide (otro equipo en esa IP, otra placa en esa IP) → conflicto o fuera de
línea, visible para el propietario. NUNCA se reasigna sola una máquina a otro
id ni se da de alta una nueva por no reencontrarla.
"""

import logging
import re
import secrets
from collections import Counter
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

UID_PREFIX = "mch_"
_UID_RE = re.compile(r"^mch_[0-9a-f]{16}$")
ARP_PATH = "/proc/net/arp"
_MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")
_NULL_MAC = "00:00:00:00:00:00"

IDENTITY_STABLE = "stable"
IDENTITY_MISSING = "missing"
IDENTITY_CONFLICT = "conflict"

DUPLICATE_UID_CONFLICT = "Id de máquina repetido en el registro — revisar a mano"
DUPLICATE_MAC_CONFLICT = "Otra máquina registrada tiene la misma MAC — revisar a mano"
AMBIGUOUS_MAC_CONFLICT = "La MAC de esta máquina aparece en varias IP — revisar la red"
FOREIGN_MAC_CONFLICT = "Otro equipo responde en esa IP (la MAC no coincide)"
FOREIGN_CHIP_CONFLICT = "La placa en esa IP reporta otro Chip ID"
TAKEN_IP_CONFLICT = "La máquina reapareció en una IP que ya usa otra máquina registrada"

# Conflictos que pone y quita la verificación de red en cada ciclo (los de
# USB los maneja la reconciliación USB de cada servicio).
NETWORK_CONFLICTS = frozenset({
    DUPLICATE_MAC_CONFLICT, AMBIGUOUS_MAC_CONFLICT, FOREIGN_MAC_CONFLICT,
    FOREIGN_CHIP_CONFLICT, TAKEN_IP_CONFLICT,
})


def new_machine_uid() -> str:
    return f"{UID_PREFIX}{secrets.token_hex(8)}"


def is_machine_uid(value: Any) -> bool:
    return isinstance(value, str) and bool(_UID_RE.match(value))


def ensure_uids(entries: List[Dict[str, Any]]) -> bool:
    """Asigna un id a cada entrada que no tenga uno válido (registros de antes
    de la identidad estable). Nunca cambia un id válido existente. Un id
    repetido (solo posible editando el archivo a mano) deja la entrada
    repetida en conflicto en vez de "arreglarla". Devuelve si cambió algo."""
    changed = False
    seen = set()
    for entry in entries:
        uid = entry.get("id")
        if not is_machine_uid(uid):
            entry["id"] = new_machine_uid()
            changed = True
        elif uid in seen:
            if entry.get("conflict") != DUPLICATE_UID_CONFLICT:
                entry["conflict"] = DUPLICATE_UID_CONFLICT
                changed = True
        seen.add(entry["id"])
    return changed


def normalize_mac(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    mac = value.strip().lower().replace("-", ":")
    if not _MAC_RE.match(mac) or mac == _NULL_MAC:
        return None
    return mac


def read_arp_table(path: Optional[str] = None) -> Dict[str, str]:
    """IP → MAC de las entradas completas del ARP del servidor (solo lectura;
    no manda nada a la red). Sin archivo o ilegible: vacío."""
    table: Dict[str, str] = {}
    try:
        with open(path or ARP_PATH, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()[1:]
    except OSError:
        return table
    for line in lines:
        parts = line.split()
        if len(parts) < 4:
            continue
        ip, flags, mac = parts[0], parts[2], normalize_mac(parts[3])
        if mac and flags == "0x2":
            table[ip] = mac
    return table


def _set_conflict(entry: Dict[str, Any], message: Optional[str]) -> bool:
    if entry.get("conflict") == message:
        return False
    entry["conflict"] = message
    return True


def reconcile_network_anchors(
    entries: List[Dict[str, Any]],
    arp: Dict[str, str],
    probes: Dict[str, Optional[Dict[str, Any]]],
    is_network,
    address_field: str = "host",
) -> bool:
    """Verifica y reencuentra por MAC las máquinas de red ancladas, después del
    sondeo de este ciclo (que es lo que llena el ARP del servidor). Modifica
    `entries` en el lugar y devuelve si cambió algo persistible.

    - MAC en la IP guardada (y Chip ID igual si se conoce) → todo bien.
    - MAC en exactamente otra IP libre → mismo id, se actualiza la IP (DHCP).
    - MAC repetida entre máquinas, MAC en varias IPs, otro equipo en la IP,
      otro Chip ID, o la IP nueva ya es de otra máquina → conflicto.
    - MAC ausente del ARP → `anchor_unverified` (fuera de línea este ciclo);
      no es conflicto ni alta nueva.
    Las entradas sin MAC no se tocan (sin ancla: identidad `missing`)."""
    changed = False
    macs = Counter(normalize_mac(e.get("mac")) for e in entries if is_network(e) and normalize_mac(e.get("mac")))
    taken = {e.get(address_field) for e in entries}
    by_mac: Dict[str, List[str]] = {}
    for ip, mac in arp.items():
        by_mac.setdefault(mac, []).append(ip)

    for entry in entries:
        entry.pop("anchor_unverified", None)
        mac = normalize_mac(entry.get("mac"))
        if not is_network(entry) or not mac:
            continue
        current = entry.get(address_field)
        if entry.get("conflict") and entry["conflict"] not in NETWORK_CONFLICTS:
            continue  # conflicto ajeno a la red (p. ej. id repetido): no se toca
        if macs[mac] > 1:
            changed |= _set_conflict(entry, DUPLICATE_MAC_CONFLICT)
            continue
        ips = by_mac.get(mac, [])
        if len(ips) > 1:
            changed |= _set_conflict(entry, AMBIGUOUS_MAC_CONFLICT)
            continue
        if ips == [current]:
            probe = probes.get(current) or {}
            stored_chip, seen_chip = entry.get("chip_id"), probe.get("chip_id")
            if stored_chip and seen_chip and str(stored_chip) != str(seen_chip):
                changed |= _set_conflict(entry, FOREIGN_CHIP_CONFLICT)
            else:
                changed |= _set_conflict(entry, None)
            continue
        if len(ips) == 1:
            new_ip = ips[0]
            if new_ip in taken:
                changed |= _set_conflict(entry, TAKEN_IP_CONFLICT)
                continue
            logger.info(f"[{entry.get('id')}] reencontrada por MAC: {current} -> {new_ip}")
            taken.discard(current)
            taken.add(new_ip)
            entry[address_field] = new_ip
            entry["anchor_unverified"] = True  # se confirma en el siguiente ciclo
            changed |= True
            changed |= _set_conflict(entry, None)
            continue
        if arp.get(current) and arp[current] != mac:
            changed |= _set_conflict(entry, FOREIGN_MAC_CONFLICT)
            continue
        entry["anchor_unverified"] = True
    return changed


def identity_state(entry: Dict[str, Any], entries: List[Dict[str, Any]], kind: str) -> str:
    """`stable` si el id es válido y hay un ancla única y sin conflicto;
    `conflict` si el ancla es ambigua o no coincide; `missing` si no hay ancla
    (todavía no se puede reencontrar el equipo). `kind`: "usb" o "network"."""
    if entry.get("conflict"):
        return IDENTITY_CONFLICT
    if not is_machine_uid(entry.get("id")):
        return IDENTITY_MISSING
    if kind == "usb":
        return IDENTITY_STABLE if entry.get("location") else IDENTITY_MISSING
    mac = normalize_mac(entry.get("mac"))
    if mac:
        same = sum(1 for e in entries if normalize_mac(e.get("mac")) == mac)
        return IDENTITY_CONFLICT if same > 1 else IDENTITY_STABLE
    chip = entry.get("chip_id")
    if chip and sum(1 for e in entries if e.get("chip_id") == chip) > 1:
        # Un Chip ID de 16 bits repetido no distingue placas: ambigua.
        return IDENTITY_CONFLICT
    return IDENTITY_MISSING
