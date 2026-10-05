"""Migración única a la identidad estable de máquinas (ver machine_identity).

Una pasada que:

1. Asigna el id interno (`mch_…`) a cada Marlin y láser/CNC registrados y
   captura las anclas de red que falten (MAC del ARP del servidor; `chip_id`
   de [ESP420] solo si se pide, porque es una consulta a la placa).
2. Reescribe las referencias guardadas por dirección (`marlin:/dev/ttyUSBx`,
   `laser:<ip>`, `laser:usb:/dev/…`, `cnc:<ip>`, claves de scope de
   TUNA-Screen) a su id interno, usando la dirección ACTUAL del registro como
   única correspondencia válida.
3. Las referencias sin contraparte (direcciones que hoy no son de ninguna
   máquina registrada) se descartan: nunca se reapuntan solas a otra máquina.
   En configuración (reglas LED, alertas, scope) se borra la entrada; en
   registros históricos (bitácora, historial, anuncios, cámaras) se borra
   solo el vínculo y se conserva el resto.
4. Antes de escribir cada archivo que cambie, lo copia a
   `backups/machine-identity-<fecha>/<ruta original>` (ignorado por git).

Idempotente: una segunda corrida no cambia nada. Por omisión NO escribe
(simulación); el script `scripts/migrate_machine_identity.py` la ejecuta.
"""

import copy
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from backend.services import machine_identity

MARLIN_REGISTRY = "marlin_printer_registry.json"
LASER_REGISTRY = "laser_registry.json"
TUNASCREEN_REGISTRY = "tunascreen_devices.json"
CAMERA_REGISTRY = "camera_registry.json"
LASER_HISTORY = "laser_history.json"
MACHINE_ALERTS = "data/plugins/matriz-led/machine_alerts.json"
ANNOUNCEMENTS = "data/plugins/matriz-led/announcements.json"
MACHINE_LED_RULES = "data/accessories/machine_led_rules.json"
ACTIVITY_LOG = "data/accessories/activity_log.json"

# Tipos de máquina con dirección inestable (los demás no se tocan).
_ADDRESS_TYPES = ("marlin", "laser", "cnc")


class _Resolver:
    """Dirección actual → id interno, a partir de los registros ya migrados."""

    def __init__(self, marlin: List[Dict[str, Any]], lasers: List[Dict[str, Any]]):
        self.marlin = {e.get("device"): e["id"] for e in marlin if e.get("device")}
        self.lasers = {e.get("host"): e["id"] for e in lasers if e.get("host")}
        self.uids = {e["id"] for e in marlin} | {e["id"] for e in lasers}

    def uid(self, machine_type: str, address: Any) -> Optional[str]:
        """Id interno para `address` de ese tipo; un id interno ya migrado se
        acepta solo si existe. None = sin contraparte."""
        if not isinstance(address, str) or not address:
            return None
        if machine_identity.is_machine_uid(address):
            return address if address in self.uids else None
        table = self.marlin if machine_type == "marlin" else self.lasers
        return table.get(address)

    def canonical(self, reference: Any) -> Tuple[bool, Optional[str]]:
        """Para `<tipo>:<dirección>`: (aplica, nueva referencia o None si no
        tiene contraparte). Referencias de otros tipos no aplican."""
        if not isinstance(reference, str) or ":" not in reference:
            return False, None
        machine_type, _, address = reference.partition(":")
        if machine_type not in _ADDRESS_TYPES:
            return False, None
        uid = self.uid(machine_type, address)
        return True, (f"{machine_type}:{uid}" if uid else None)

    def scope_key(self, key: Any) -> Tuple[bool, Optional[str]]:
        """Claves de scope de TUNA-Screen: `printer:marlin:<dir>`,
        `laser:laser:<dir>`, `cnc:laser:<dir>`."""
        if not isinstance(key, str):
            return False, None
        kind, _, rest = key.partition(":")
        driver, _, address = rest.partition(":")
        if (kind, driver) == ("printer", "marlin"):
            uid = self.uid("marlin", address)
        elif kind in ("laser", "cnc") and driver == "laser":
            uid = self.uid("laser", address)
        else:
            return False, None
        return True, (f"{kind}:{driver}:{uid}" if uid else None)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _migrate_registries(
    marlin: List[Dict[str, Any]], lasers: List[Dict[str, Any]],
    arp: Dict[str, str], esp420: Optional[Callable[[str], Dict[str, Any]]], report: Dict[str, Any],
) -> None:
    machine_identity.ensure_uids(marlin)
    machine_identity.ensure_uids(lasers)
    for entry in lasers:
        host = str(entry.get("host", ""))
        if host.startswith("usb:") or entry.get("mac"):
            continue
        # Primer anclaje: se confía en que hoy, en esa IP, está esa placa
        # (la misma confianza que ya tenía el registro). Sin MAC en el ARP la
        # máquina queda sin identidad estable, no se inventa nada.
        mac = arp.get(host)
        if mac:
            entry["mac"] = mac
        if esp420 and not entry.get("chip_id"):
            chip = (esp420(host) or {}).get("chip_id")
            if chip:
                entry["chip_id"] = chip
    for entry in marlin:
        is_network = entry.get("transport") == "mks_wifi" or str(entry.get("device", "")).startswith("tcp://")
        state = machine_identity.identity_state(entry, marlin, "network" if is_network else "usb")
        report["machines"].append({"type": "marlin", "id": entry["id"], "name": entry.get("name"),
                                   "address": entry.get("device"), "identity": state})
    for entry in lasers:
        kind = "usb" if str(entry.get("host", "")).startswith("usb:") else "network"
        report["machines"].append({
            "type": entry.get("kind") or "laser", "id": entry["id"], "name": entry.get("name"),
            "address": entry.get("host"), "mac": entry.get("mac"),
            "identity": machine_identity.identity_state(entry, lasers, kind),
        })


def _migrate_dependents(data: Dict[str, Any], resolver: _Resolver, notes: Dict[str, Dict[str, list]]) -> None:
    """Reescribe en el lugar `data[ruta]` (contenidos ya cargados)."""

    def note(path: str, kind: str, value: Any) -> None:
        notes.setdefault(path, {"migrated": [], "discarded": []})[kind].append(value)

    alerts = data.get(MACHINE_ALERTS)
    if isinstance(alerts, dict):
        for key in list(alerts):
            applies, new = resolver.canonical(key)
            if not applies or new == key:
                continue
            value = alerts.pop(key)
            if new:
                alerts[new] = value
                note(MACHINE_ALERTS, "migrated", f"{key} -> {new}")
            else:
                note(MACHINE_ALERTS, "discarded", key)

    for path, field in ((ANNOUNCEMENTS, "machine_id"),):
        items = data.get(path)
        if isinstance(items, list):
            for item in items:
                applies, new = resolver.canonical(item.get(field)) if isinstance(item, dict) else (False, None)
                if applies and new != item[field]:
                    note(path, "migrated" if new else "discarded", f"{item[field]} -> {new}" if new else item[field])
                    item[field] = new

    rules = data.get(MACHINE_LED_RULES)
    if isinstance(rules, list):
        kept, seen = [], set()
        for rule in rules:
            machine_type = rule.get("machine_type") if isinstance(rule, dict) else None
            if machine_type not in _ADDRESS_TYPES:
                kept.append(rule)
                seen.add(rule.get("key") if isinstance(rule, dict) else None)
                continue
            uid = resolver.uid(machine_type, rule.get("machine_id"))
            if not uid:
                note(MACHINE_LED_RULES, "discarded", rule.get("key"))
                continue
            new_key = f"{machine_type}:{uid}"
            if new_key in seen:
                note(MACHINE_LED_RULES, "discarded", f"{rule.get('key')} (repetida)")
                continue
            if rule.get("key") != new_key:
                note(MACHINE_LED_RULES, "migrated", f"{rule.get('key')} -> {new_key}")
            rule["key"], rule["machine_id"] = new_key, uid
            kept.append(rule)
            seen.add(new_key)
        data[MACHINE_LED_RULES] = kept

    log = data.get(ACTIVITY_LOG)
    if isinstance(log, list):
        for event in log:
            detail = event.get("detail") if isinstance(event, dict) else None
            if not isinstance(detail, dict):
                continue
            applies, new = resolver.canonical(detail.get("machine"))
            if applies and new != detail["machine"]:
                note(ACTIVITY_LOG, "migrated" if new else "discarded",
                     f"{detail['machine']} -> {new}" if new else detail["machine"])
                detail["machine"] = new

    cameras = data.get(CAMERA_REGISTRY)
    if isinstance(cameras, list):
        for camera in cameras:
            bound = camera.get("bound_device") if isinstance(camera, dict) else None
            if not isinstance(bound, dict) or bound.get("type") not in _ADDRESS_TYPES:
                continue
            uid = resolver.uid(bound["type"], bound.get("id"))
            if uid == bound.get("id"):
                continue
            if uid:
                note(CAMERA_REGISTRY, "migrated", f"{camera.get('id')}: {bound.get('id')} -> {uid}")
                bound["id"] = uid
            else:
                note(CAMERA_REGISTRY, "discarded", f"{camera.get('id')}: {bound.get('id')}")
                camera["bound_device"] = None

    history = data.get(LASER_HISTORY)
    if isinstance(history, list):
        for job in history:
            if not isinstance(job, dict):
                continue
            uid = resolver.uid("laser", job.get("host"))
            new = f"laser:{uid}" if uid else None
            if not new:
                # Sin contraparte: el trabajo se conserva, sin vínculo a máquina.
                job.pop("machine_id", None)
                note(LASER_HISTORY, "discarded", job.get("host"))
            elif job.get("machine_id") != new:
                job["machine_id"] = new
                note(LASER_HISTORY, "migrated", job.get("host"))

    devices = data.get(TUNASCREEN_REGISTRY)
    if isinstance(devices, list):
        for device in devices:
            scope = device.get("scope") if isinstance(device, dict) else None
            if not isinstance(scope, list):
                continue
            new_scope = []
            for key in scope:
                applies, new = resolver.scope_key(key)
                if not applies:
                    new_scope.append(key)
                elif new:
                    new_scope.append(new)
                    if new != key:
                        note(TUNASCREEN_REGISTRY, "migrated", f"{device.get('device_id')}: {key} -> {new}")
                else:
                    note(TUNASCREEN_REGISTRY, "discarded", f"{device.get('device_id')}: {key}")
            device["scope"] = sorted(set(new_scope))


def _write_atomic(path: Path, content: Any) -> None:
    mode = path.stat().st_mode & 0o777 if path.exists() else None
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.",
                                     suffix=".tmp", delete=False) as handle:
        json.dump(content, handle, indent=2, ensure_ascii=False)
        temp = handle.name
    if mode is not None:
        os.chmod(temp, mode)
    os.replace(temp, path)


def migrate(
    root: Path,
    apply: bool = False,
    arp: Optional[Dict[str, str]] = None,
    esp420: Optional[Callable[[str], Dict[str, Any]]] = None,
    stamp: Optional[str] = None,
) -> Dict[str, Any]:
    """Migra los archivos de estado bajo `root`. Sin `apply` solo informa
    (simulación, nada se escribe). `arp`: tabla IP→MAC (por omisión, la del
    servidor, solo lectura). `esp420`: consulta opcional del Chip ID por IP."""
    root = Path(root)
    stamp = stamp or time.strftime("%Y%m%d-%H%M%S")
    arp = machine_identity.read_arp_table() if arp is None else arp
    paths = [MARLIN_REGISTRY, LASER_REGISTRY, TUNASCREEN_REGISTRY, CAMERA_REGISTRY, LASER_HISTORY,
             MACHINE_ALERTS, ANNOUNCEMENTS, MACHINE_LED_RULES, ACTIVITY_LOG]
    original = {p: _read_json(root / p) for p in paths}
    data = copy.deepcopy(original)
    marlin = data[MARLIN_REGISTRY] if isinstance(data[MARLIN_REGISTRY], list) else []
    lasers = data[LASER_REGISTRY] if isinstance(data[LASER_REGISTRY], list) else []
    marlin[:] = [e for e in marlin if isinstance(e, dict)]
    lasers[:] = [e for e in lasers if isinstance(e, dict)]

    report: Dict[str, Any] = {"applied": apply, "backup_dir": None, "machines": [], "files": {}}
    _migrate_registries(marlin, lasers, arp, esp420, report)
    notes: Dict[str, Dict[str, list]] = {}
    _migrate_dependents(data, _Resolver(marlin, lasers), notes)

    backup_dir = root / "backups" / f"machine-identity-{stamp}"
    for path in paths:
        if original[path] is None or data[path] == original[path]:
            continue
        entry = {"changed": True, **notes.get(path, {"migrated": [], "discarded": []})}
        if apply:
            target = backup_dir / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / path, target)
            entry["backup"] = str(target.relative_to(root))
            _write_atomic(root / path, data[path])
        report["files"][path] = entry
    if apply and report["files"]:
        report["backup_dir"] = str(backup_dir.relative_to(root))
    return report
