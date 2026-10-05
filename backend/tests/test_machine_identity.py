"""Identidad estable de máquinas (estrategia A): id interno inmutable `mch_…`
asignado por NOPAL; location/MAC/Chip ID solo como anclas para reencontrar el
equipo. Ante un ancla ambigua o que no coincide: conflicto o fuera de línea,
nunca reasignación. ARP y [ESP420] simulados (ver conftest: ARP_PATH en tmp).
"""

import json
from pathlib import Path

import pytest

import backend.services.bambu_service as bambu_service
import backend.services.elegoo_service as elegoo_service
import backend.services.flashforge_service as flashforge_service
import backend.services.klipper_service as klipper_service
import backend.services.laser_service as laser_service
import backend.services.machine_identity as machine_identity
import backend.services.machine_identity_migration as migration
import backend.services.marlin_printer_service as marlin_printer_service
import backend.services.plugin_installer_service as plugin_installer_service
import backend.services.tunascreen_service as tunascreen_service
from backend.services.authorization_policy import Principal, Resource, ResourceKind, authorize, Action

MAC_A, MAC_B, MAC_X = "0c:8b:95:1c:0f:9c", "fc:b4:67:88:78:cc", "aa:bb:cc:dd:ee:ff"
UID_M, UID_L, UID_C = "mch_000000000000000a", "mch_000000000000000b", "mch_000000000000000c"


def _write_arp(rows):
    """ARP simulado con el formato real de /proc/net/arp."""
    lines = ["IP address       HW type     Flags       HW address            Mask     Device"]
    for ip, mac, flags in rows:
        lines.append(f"{ip:<16} 0x1         {flags}         {mac}     *        eno1")
    Path(machine_identity.ARP_PATH).write_text("\n".join(lines) + "\n", encoding="utf-8")


@pytest.fixture
def laser_registry(tmp_path, monkeypatch):
    path = tmp_path / "laser_registry.json"
    monkeypatch.setattr(laser_service, "REGISTRY_PATH", str(path))

    def write(entries):
        path.write_text(json.dumps(entries), encoding="utf-8")

    def read():
        return json.loads(path.read_text(encoding="utf-8"))

    return write, read


def _net(host, uid, mac=None, chip=None, **extra):
    entry = {"id": uid, "host": host, "name": host, "transport": "network", "kind": "laser", **extra}
    if mac:
        entry["mac"] = mac
    if chip:
        entry["chip_id"] = chip
    return entry


def _probes(monkeypatch, reachable, chips=None):
    """[ESP420] simulado: responde para los hosts de `reachable`."""
    chips = chips or {}
    monkeypatch.setattr(laser_service, "_probe_host", lambda host, timeout: (
        {"host": host, "hostname": "", "firmware": "FluidNC", "chip_id": chips.get(host, "")}
        if host in reachable else None))


def _status(host):
    return next(e for e in laser_service.get_registered_lasers_with_status() if e["host"] == host)


# ── Id interno ──

class TestInternalId:
    def test_format_and_assignment_is_immutable(self):
        entries = [{"host": "192.168.0.61"}, {"id": UID_L, "host": "192.168.0.87"}]
        assert machine_identity.ensure_uids(entries) is True
        assert machine_identity.is_machine_uid(entries[0]["id"])
        assert entries[1]["id"] == UID_L
        assert machine_identity.ensure_uids(entries) is False  # ya no cambia nada

    def test_repeated_id_is_conflict_not_rewritten(self):
        entries = [{"id": UID_L}, {"id": UID_L}]
        machine_identity.ensure_uids(entries)
        assert [e["id"] for e in entries] == [UID_L, UID_L]
        assert entries[1]["conflict"] == machine_identity.DUPLICATE_UID_CONFLICT

    @pytest.mark.parametrize("value", ["192.168.0.61", "/dev/ttyUSB0", "usb:/dev/ttyUSB0", "mch_123", "MCH_000000000000000A", None])
    def test_addresses_are_not_ids(self, value):
        assert not machine_identity.is_machine_uid(value)

    def test_legacy_registry_gets_id_on_first_read(self, laser_registry):
        write, read = laser_registry
        write([{"host": "192.168.0.61", "name": "TTS", "transport": "network"}])
        uid = laser_service.get_registered_lasers()[0]["id"]
        assert machine_identity.is_machine_uid(uid)
        assert read()[0]["id"] == uid
        assert laser_service.get_registered_lasers()[0]["id"] == uid

    def test_edit_keeps_id(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A)])
        monkeypatch.setattr(laser_service, "capture_network_anchor", lambda host: pytest.fail("no debe recapturar"))
        laser_service.register_laser("192.168.0.61", "Nuevo nombre", "network")
        assert read()[0]["id"] == UID_L and read()[0]["mac"] == MAC_A

    def test_marlin_edit_keeps_id(self, monkeypatch, tmp_path):
        path = tmp_path / "marlin.json"
        monkeypatch.setattr(marlin_printer_service, "REGISTRY_PATH", str(path))
        monkeypatch.setattr(laser_service, "_location_for_device", lambda device: "1-1.6")
        first = marlin_printer_service.register_printer("/dev/ttyUSB0", "ET4")
        second = marlin_printer_service.register_printer("/dev/ttyUSB0", "ET4 Pro")
        assert machine_identity.is_machine_uid(first["id"]) and second["id"] == first["id"]


# ── USB: la ruta cambia, el id no ──

class TestUsbRenumbering:
    def test_marlin_changes_usb_port_keeps_id_and_fixes_path(self, monkeypatch, tmp_path):
        """Regresión del bug: la autocorrección de la ruta reescribía el id."""
        path = tmp_path / "marlin.json"
        path.write_text(json.dumps([{"id": UID_M, "device": "/dev/ttyUSB2", "name": "ET4",
                                     "location": "1-1.6", "transport": "usb_serial"}]), encoding="utf-8")
        monkeypatch.setattr(marlin_printer_service, "REGISTRY_PATH", str(path))
        monkeypatch.setattr(laser_service, "_resolve_usb_location", lambda location: "/dev/ttyUSB0")
        monkeypatch.setattr(marlin_printer_service, "_probe_marlin_sync", lambda device, baud=115200: True)

        entry = marlin_printer_service.get_registered_printers_with_status()[0]

        assert entry["device"] == "/dev/ttyUSB0"
        assert entry["id"] == UID_M
        assert entry["identity"] == "stable"
        assert marlin_printer_service.get_printer_by_uid(UID_M)["device"] == "/dev/ttyUSB0"

    def test_laser_usb_renumbering_keeps_id(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([{"id": UID_L, "host": "usb:/dev/ttyUSB1", "name": "S30", "transport": "usb", "location": "6-2"}])
        monkeypatch.setattr(laser_service, "_resolve_usb_location", lambda location: "/dev/ttyUSB0")
        monkeypatch.setattr(laser_service, "_probe_grbl_sync", lambda device, baud=115200, timeout=2.5: True)

        laser_service.get_registered_lasers_with_status()

        assert read()[0]["host"] == "usb:/dev/ttyUSB0" and read()[0]["id"] == UID_L

    def test_other_board_on_the_port_is_conflict(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([{"id": UID_L, "host": "usb:/dev/ttyUSB1", "name": "S30", "transport": "usb", "location": "6-2"}])
        monkeypatch.setattr(laser_service, "_resolve_usb_location", lambda location: "/dev/ttyUSB0")
        monkeypatch.setattr(laser_service, "_probe_grbl_sync", lambda device, baud=115200, timeout=2.5: False)

        entry = laser_service.get_registered_lasers_with_status()[0]

        assert entry["host"] == "usb:/dev/ttyUSB1" and entry["online"] is False
        assert entry["identity"] == "conflict" and entry["id"] == UID_L


# ── Red: reencuentro por MAC ──

class TestNetworkAnchor:
    def test_matching_anchor_same_id_online(self, laser_registry, monkeypatch):
        write, _ = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A)])
        _probes(monkeypatch, {"192.168.0.61"})
        _write_arp([("192.168.0.61", MAC_A, "0x2")])

        entry = _status("192.168.0.61")

        assert entry["online"] is True and entry["identity"] == "stable" and entry["id"] == UID_L

    def test_dhcp_change_is_refound_by_mac(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A)])
        _probes(monkeypatch, {"192.168.0.66"})
        _write_arp([("192.168.0.66", MAC_A, "0x2")])

        laser_service.get_registered_lasers_with_status()

        assert read()[0]["host"] == "192.168.0.66" and read()[0]["id"] == UID_L
        assert not read()[0].get("conflict") and "anchor_unverified" not in read()[0]

    def test_ambiguous_two_machines_same_mac(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A), _net("192.168.0.62", UID_C, MAC_A)])
        _probes(monkeypatch, {"192.168.0.61", "192.168.0.62"})
        _write_arp([("192.168.0.61", MAC_A, "0x2")])

        entries = laser_service.get_registered_lasers_with_status()

        assert [e["online"] for e in entries] == [False, False]
        assert [e["identity"] for e in entries] == ["conflict", "conflict"]
        assert [e["host"] for e in read()] == ["192.168.0.61", "192.168.0.62"]
        assert [e["id"] for e in read()] == [UID_L, UID_C]

    def test_ambiguous_mac_in_two_ips(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A)])
        _probes(monkeypatch, {"192.168.0.61"})
        _write_arp([("192.168.0.61", MAC_A, "0x2"), ("192.168.0.70", MAC_A, "0x2")])

        entry = _status("192.168.0.61")

        assert entry["online"] is False and entry["identity"] == "conflict"
        assert read()[0]["host"] == "192.168.0.61"

    def test_anchor_mismatch_other_device_in_ip(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A)])
        _probes(monkeypatch, {"192.168.0.61"})
        _write_arp([("192.168.0.61", MAC_X, "0x2")])

        entry = _status("192.168.0.61")

        assert entry["online"] is False and entry["identity"] == "conflict"
        assert read()[0]["conflict"] == machine_identity.FOREIGN_MAC_CONFLICT

    def test_conflict_clears_when_anchor_matches_again(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A, conflict=machine_identity.FOREIGN_MAC_CONFLICT)])
        _probes(monkeypatch, {"192.168.0.61"})
        _write_arp([("192.168.0.61", MAC_A, "0x2")])

        assert _status("192.168.0.61")["online"] is True
        assert not read()[0].get("conflict")

    def test_refound_ip_already_used_is_conflict(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A), _net("192.168.0.66", UID_C, MAC_B)])
        _probes(monkeypatch, {"192.168.0.66"})
        _write_arp([("192.168.0.66", MAC_A, "0x2")])

        laser_service.get_registered_lasers_with_status()

        assert read()[0]["host"] == "192.168.0.61"
        assert read()[0]["conflict"] == machine_identity.TAKEN_IP_CONFLICT

    def test_mac_missing_from_arp_is_offline_not_new(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.63", UID_C, MAC_B)])
        _probes(monkeypatch, {"192.168.0.63"})  # responde, pero sin MAC verificable
        _write_arp([("192.168.0.63", "00:00:00:00:00:00", "0x0")])

        entries = laser_service.get_registered_lasers_with_status()

        assert len(entries) == 1 and entries[0]["online"] is False
        assert entries[0]["identity"] == "stable" and not read()[0].get("conflict")
        assert read()[0]["host"] == "192.168.0.63" and len(read()) == 1

    def test_without_mac_works_as_before_but_identity_missing(self, laser_registry, monkeypatch):
        write, _ = laser_registry
        write([_net("192.168.0.72", UID_C)])
        _probes(monkeypatch, {"192.168.0.72"})

        entry = _status("192.168.0.72")

        assert entry["online"] is True and entry["identity"] == "missing"

    def test_chip_id_collision_is_conflict_never_identity(self, laser_registry, monkeypatch):
        write, _ = laser_registry
        write([_net("192.168.0.63", UID_C, chip="12345"), _net("192.168.0.72", UID_L, chip="12345")])
        _probes(monkeypatch, set())

        entries = laser_service.get_registered_lasers_with_status()

        assert [e["identity"] for e in entries] == ["conflict", "conflict"]

    def test_chip_id_alone_is_never_stable(self, laser_registry, monkeypatch):
        write, _ = laser_registry
        write([_net("192.168.0.63", UID_C, chip="12345")])
        _probes(monkeypatch, set())
        assert laser_service.get_registered_lasers_with_status()[0]["identity"] == "missing"

    def test_other_board_chip_id_in_ip_is_conflict(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A, chip="111")])
        _probes(monkeypatch, {"192.168.0.61"}, chips={"192.168.0.61": "999"})
        _write_arp([("192.168.0.61", MAC_A, "0x2")])

        assert _status("192.168.0.61")["online"] is False
        assert read()[0]["conflict"] == machine_identity.FOREIGN_CHIP_CONFLICT

    def test_anchor_capture_on_register(self, laser_registry, monkeypatch):
        write, read = laser_registry
        write([])
        _probes(monkeypatch, {"192.168.0.87"}, chips={"192.168.0.87": "4242"})
        _write_arp([("192.168.0.87", MAC_B, "0x2")])

        entry = laser_service.register_laser("192.168.0.87", "ATOMSTACK", "network")

        assert entry["mac"] == MAC_B and entry["chip_id"] == "4242"
        assert machine_identity.is_machine_uid(entry["id"])

    def test_arp_parsing_skips_incomplete(self):
        _write_arp([("192.168.0.61", MAC_A, "0x2"), ("192.168.0.63", "00:00:00:00:00:00", "0x0"),
                    ("192.168.0.64", MAC_B, "0x0")])
        assert machine_identity.read_arp_table() == {"192.168.0.61": MAC_A}


# ── Migración con respaldo ──

@pytest.fixture
def workshop_files(tmp_path):
    root = tmp_path / "taller"

    def put(rel, content):
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(content), encoding="utf-8")

    put(migration.MARLIN_REGISTRY, [{"device": "/dev/ttyUSB0", "name": "ET4", "location": "1-1.6", "transport": "usb_serial"}])
    put(migration.LASER_REGISTRY, [
        {"host": "192.168.0.61", "name": "TTS", "transport": "network", "kind": "laser"},
        {"host": "192.168.0.63", "name": "NOPAL-55", "transport": "network", "kind": "cnc"},
    ])
    put(migration.TUNASCREEN_REGISTRY, [{"device_id": "tuna_x", "name": "Tablet", "token_hash": "h",
                                         "scope": ["laser:laser:192.168.0.61", "printer:marlin:/dev/ttyUSB2",
                                                   "printer:klipper:7125", "plugin:spoolman"]}])
    put(migration.CAMERA_REGISTRY, [{"id": "cam1", "bound_device": {"type": "laser", "id": "192.168.0.61"}},
                                    {"id": "cam2", "bound_device": {"type": "laser", "id": "usb:/dev/ttyUSB0"}},
                                    {"id": "cam3", "bound_device": {"type": "klipper", "id": "ET4"}}])
    put(migration.LASER_HISTORY, [{"host": "192.168.0.61", "filename": "a.gc"}, {"host": "usb:/dev/ttyUSB0", "filename": "b.gc"}])
    put(migration.MACHINE_ALERTS, {"laser:192.168.0.61": {"enabled": True}, "laser:usb:/dev/ttyUSB1": {"enabled": True},
                                   "klipper:7125": {"enabled": True}})
    put(migration.ANNOUNCEMENTS, [{"id": "a1", "machine_id": "laser:192.168.0.61"}, {"id": "a2", "machine_id": "laser:usb:/dev/ttyUSB0"}])
    put(migration.MACHINE_LED_RULES, [
        {"key": "marlin:/dev/ttyUSB2", "machine_type": "marlin", "machine_id": "/dev/ttyUSB2"},
        {"key": "marlin:/dev/ttyUSB0", "machine_type": "marlin", "machine_id": "/dev/ttyUSB0"},
        {"key": "cnc:192.168.0.63", "machine_type": "cnc", "machine_id": "192.168.0.63"},
        {"key": "klipper:7125", "machine_type": "klipper", "machine_id": "7125"},
    ])
    put(migration.ACTIVITY_LOG, [{"id": "e1", "detail": {"machine": "laser:192.168.0.61"}},
                                 {"id": "e2", "detail": {"machine": "marlin:/dev/ttyUSB2"}}])
    return root


def _load(root, rel):
    return json.loads((root / rel).read_text(encoding="utf-8"))


class TestMigration:
    def test_simulation_writes_nothing(self, workshop_files):
        before = {p.name: p.read_bytes() for p in workshop_files.rglob("*.json")}
        report = migration.migrate(workshop_files, apply=False, arp={}, stamp="T")
        assert report["files"] and not (workshop_files / "backups").exists()
        assert {p.name: p.read_bytes() for p in workshop_files.rglob("*.json")} == before

    def test_migrates_with_backup_and_discards_orphans(self, workshop_files):
        original_rules = (workshop_files / migration.MACHINE_LED_RULES).read_bytes()
        report = migration.migrate(workshop_files, apply=True, arp={"192.168.0.61": MAC_A}, stamp="T")
        lasers = _load(workshop_files, migration.LASER_REGISTRY)
        uid_tts, uid_cnc = lasers[0]["id"], lasers[1]["id"]
        uid_et4 = _load(workshop_files, migration.MARLIN_REGISTRY)[0]["id"]

        # Respaldo de cada archivo antes de tocarlo, idéntico al original.
        backup = workshop_files / "backups" / "machine-identity-T" / migration.MACHINE_LED_RULES
        assert backup.read_bytes() == original_rules
        assert report["files"][migration.MACHINE_LED_RULES]["backup"].startswith("backups/machine-identity-T/")

        # Anclas: MAC del ARP para la que aparece; sin MAC la otra.
        assert lasers[0]["mac"] == MAC_A and "mac" not in lasers[1]

        rules = {r["key"]: r for r in _load(workshop_files, migration.MACHINE_LED_RULES)}
        assert set(rules) == {f"marlin:{uid_et4}", f"cnc:{uid_cnc}", "klipper:7125"}  # ttyUSB2 descartada
        assert rules[f"marlin:{uid_et4}"]["machine_id"] == uid_et4

        cameras = {c["id"]: c["bound_device"] for c in _load(workshop_files, migration.CAMERA_REGISTRY)}
        assert cameras == {"cam1": {"type": "laser", "id": uid_tts}, "cam2": None, "cam3": {"type": "klipper", "id": "ET4"}}

        alerts = _load(workshop_files, migration.MACHINE_ALERTS)
        assert set(alerts) == {f"laser:{uid_tts}", "klipper:7125"}

        announcements = {a["id"]: a["machine_id"] for a in _load(workshop_files, migration.ANNOUNCEMENTS)}
        assert announcements == {"a1": f"laser:{uid_tts}", "a2": None}

        history = _load(workshop_files, migration.LASER_HISTORY)
        assert history[0]["machine_id"] == f"laser:{uid_tts}" and "machine_id" not in history[1]
        assert history[1]["filename"] == "b.gc"  # el trabajo se conserva

        log = {e["id"]: e["detail"]["machine"] for e in _load(workshop_files, migration.ACTIVITY_LOG)}
        assert log == {"e1": f"laser:{uid_tts}", "e2": None}

    def test_tuna_scope_old_id_keeps_access_to_same_machine(self, workshop_files):
        migration.migrate(workshop_files, apply=True, arp={"192.168.0.61": MAC_A}, stamp="T")
        uid_tts = _load(workshop_files, migration.LASER_REGISTRY)[0]["id"]
        device = _load(workshop_files, migration.TUNASCREEN_REGISTRY)[0]

        assert device["scope"] == sorted([f"laser:laser:{uid_tts}", "printer:klipper:7125", "plugin:spoolman"])
        principal = Principal.tuna_device("tuna_x", tunascreen_service.device_scope(device))
        assert authorize(principal, Action.SET_AIR_ASSIST, Resource(ResourceKind.LASER, f"laser:{uid_tts}"))

    def test_tuna_scope_without_counterpart_is_discarded(self, workshop_files):
        report = migration.migrate(workshop_files, apply=True, arp={}, stamp="T")
        scope = _load(workshop_files, migration.TUNASCREEN_REGISTRY)[0]["scope"]
        assert not any("ttyUSB2" in key for key in scope)
        assert "tuna_x: printer:marlin:/dev/ttyUSB2" in report["files"][migration.TUNASCREEN_REGISTRY]["discarded"]

    def test_second_run_changes_nothing(self, workshop_files):
        migration.migrate(workshop_files, apply=True, arp={"192.168.0.61": MAC_A}, stamp="T")
        assert migration.migrate(workshop_files, apply=True, arp={"192.168.0.61": MAC_A}, stamp="T2")["files"] == {}

    def test_keeps_existing_ids_from_running_server(self, workshop_files):
        registry = _load(workshop_files, migration.LASER_REGISTRY)
        registry[0]["id"] = UID_L
        (workshop_files / migration.LASER_REGISTRY).write_text(json.dumps(registry), encoding="utf-8")
        migration.migrate(workshop_files, apply=True, arp={}, stamp="T")
        assert _load(workshop_files, migration.LASER_REGISTRY)[0]["id"] == UID_L
        assert _load(workshop_files, migration.CAMERA_REGISTRY)[0]["bound_device"]["id"] == UID_L

    def test_esp420_only_when_requested(self, workshop_files):
        asked = []
        migration.migrate(workshop_files, apply=True, arp={}, stamp="T",
                          esp420=lambda host: asked.append(host) or {"chip_id": "77"})
        assert sorted(asked) == ["192.168.0.61", "192.168.0.63"]
        assert _load(workshop_files, migration.LASER_REGISTRY)[0]["chip_id"] == "77"

    def test_file_mode_is_preserved(self, workshop_files):
        path = workshop_files / migration.TUNASCREEN_REGISTRY
        path.chmod(0o600)
        migration.migrate(workshop_files, apply=True, arp={"192.168.0.61": MAC_A}, stamp="T")
        assert path.stat().st_mode & 0o777 == 0o600


# ── TUNA-Screen: scope reabierto solo para identidad estable ──

MARLIN_ENTRY = {"id": UID_M, "device": "/dev/ttyUSB0", "name": "ET4 Marlin", "online": True, "identity": "stable"}
LASER_ENTRY = {"id": UID_L, "host": "192.168.0.61", "name": "TTS", "online": True, "kind": "laser", "identity": "stable"}
CNC_ENTRY = {"id": UID_C, "host": "192.168.0.72", "name": "CNC 3018", "online": True, "kind": "cnc", "identity": "missing"}
M_KEY, L_KEY, C_KEY = f"printer:marlin:{UID_M}", f"laser:laser:{UID_L}", f"cnc:laser:{UID_C}"


@pytest.fixture
def tuna_workshop(monkeypatch):
    log = []
    monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [])
    for module in (bambu_service, elegoo_service, flashforge_service):
        monkeypatch.setattr(module, "get_registered_printers_with_status", lambda: [])
    monkeypatch.setattr(marlin_printer_service, "get_registered_printers_with_status", lambda: [dict(MARLIN_ENTRY)])
    monkeypatch.setattr(marlin_printer_service, "get_printer_by_uid", lambda uid: MARLIN_ENTRY if uid == UID_M else None)

    async def marlin_status(device):
        # Misma forma que marlin_printer_service.get_status.
        return {"state": "idle", "extruder": {}, "heater_bed": {}, "x": 0.0, "y": 0.0, "z": 0.0}

    async def marlin_job(device):
        return None

    monkeypatch.setattr(marlin_printer_service, "get_status", marlin_status)
    monkeypatch.setattr(marlin_printer_service, "get_job_status", marlin_job)

    async def lasers():
        return [dict(LASER_ENTRY), dict(CNC_ENTRY)]

    async def laser_status(host, timeout=3.0):
        return {"state": "Idle", "x": 0.0, "y": 0.0, "z": 0.0, "feed": 0, "speed": 0}

    async def laser_job(host):
        return None

    monkeypatch.setattr(laser_service, "get_registered_lasers_status", lasers)
    monkeypatch.setattr(laser_service, "get_laser_by_uid",
                        lambda uid: next((e for e in (LASER_ENTRY, CNC_ENTRY) if e["id"] == uid), None))
    monkeypatch.setattr(laser_service, "get_status", laser_status)
    monkeypatch.setattr(laser_service, "get_job_status", laser_job)
    monkeypatch.setattr(laser_service, "send_raw_command", lambda host, command: log.append(("laser", host, command)) or True)

    async def dispatch_marlin(device, action, params):
        log.append(("marlin", device, action))
        return {"success": True, "action": action}

    monkeypatch.setattr(tunascreen_service, "_dispatch_marlin", dispatch_marlin)
    monkeypatch.setattr(plugin_installer_service, "read_installed_state", lambda: {})
    return log


def _pair(scope):
    code = tunascreen_service.generate_pairing_code(scope=scope)["code"]
    return tunascreen_service.confirm_pairing(code, "Tablet")["token"]


def _h(token):
    return {"Authorization": f"Bearer {token}"}


class TestTunaScope:
    def test_scope_options_offer_only_stable_identity(self, client, as_admin, tuna_workshop):
        keys = [m["key"] for m in client.get("/api/tunascreen/scope-options").json()["machines"]]
        assert keys == [M_KEY, L_KEY]  # la CNC sin MAC (identity missing) no se ofrece

    @pytest.mark.parametrize("key", ["printer:marlin:/dev/ttyUSB0", "laser:laser:192.168.0.61",
                                     "cnc:laser:usb:/dev/ttyUSB0", "marlin:/dev/ttyUSB0", "laser:192.168.0.61"])
    def test_addresses_are_rejected(self, client, as_admin, tuna_workshop, key):
        response = client.post("/api/tunascreen/pair/start", json={"scope": [key]})
        assert response.status_code == 400

    def test_unstable_machine_by_internal_id_is_rejected(self, client, as_admin, tuna_workshop):
        response = client.post("/api/tunascreen/pair/start", json={"scope": [C_KEY]})
        assert response.status_code == 400 and "desconocido" in response.json()["detail"]

    def test_internal_ids_accepted(self, client, as_admin, tuna_workshop):
        assert client.post("/api/tunascreen/pair/start", json={"scope": [M_KEY, L_KEY]}).status_code == 200

    def test_scope_valid_action_allowed_with_current_address(self, client, tuna_workshop):
        token = _pair([M_KEY, L_KEY])
        machines = [m["id"] for m in client.get("/api/tunascreen/machines", headers=_h(token)).json()["machines"]]
        assert machines == [f"marlin:{UID_M}", f"laser:{UID_L}"]

        response = client.post("/api/tunascreen/action", headers=_h(token),
                               json={"machine_id": f"laser:{UID_L}", "action": "set_air_assist", "params": {"on": True}})
        assert response.status_code == 200
        response = client.post("/api/tunascreen/action", headers=_h(token),
                               json={"machine_id": f"marlin:{UID_M}", "action": "pause", "params": {}})
        assert response.status_code == 200
        assert tuna_workshop == [("laser", "192.168.0.61", "M8"), ("marlin", "/dev/ttyUSB0", "pause")]

    @pytest.mark.parametrize("machine_id", [f"laser:{UID_L}", f"marlin:{UID_M}", "laser:192.168.0.61",
                                            "marlin:/dev/ttyUSB0", f"laser:{UID_C}"])
    def test_scope_absent_action_denied_like_nonexistent(self, client, tuna_workshop, machine_id):
        token = _pair([])
        response = client.post("/api/tunascreen/action", headers=_h(token),
                               json={"machine_id": machine_id, "action": "pause", "params": {}})
        assert response.status_code == 400 and response.json() == {"detail": "Máquina no encontrada"}
        assert tuna_workshop == []

    def test_unstable_machine_in_scope_still_invisible(self, client, tuna_workshop, monkeypatch):
        """Una clave que quedó en el scope no da acceso si su ancla pierde la
        estabilidad (conflicto o sin ancla)."""
        token = _pair([L_KEY])
        LASER_CONFLICT = {**LASER_ENTRY, "identity": "conflict"}

        async def lasers():
            return [dict(LASER_CONFLICT)]

        monkeypatch.setattr(laser_service, "get_registered_lasers_status", lasers)
        tunascreen_service._machines_cache = []
        assert client.get("/api/tunascreen/machines", headers=_h(token)).json()["machines"] == []
        response = client.post("/api/tunascreen/action", headers=_h(token),
                               json={"machine_id": f"laser:{UID_L}", "action": "set_air_assist", "params": {"on": True}})
        assert response.status_code == 400 and tuna_workshop == []

    def test_operator_cannot_edit_scope(self, client, as_operator, tuna_workshop):
        response = client.put("/api/tunascreen/devices/tuna_x/scope", json={"scope": [L_KEY]})
        assert response.status_code == 403

    def test_anonymous_and_device_token_rejected(self, client, tuna_workshop):
        assert client.put("/api/tunascreen/devices/tuna_x/scope", json={"scope": [L_KEY]}).status_code == 401
        token = _pair([L_KEY])
        assert client.get("/api/tunascreen/machines").status_code == 401
        assert client.put("/api/tunascreen/devices/tuna_x/scope", json={"scope": [L_KEY]},
                          headers=_h(token)).status_code == 401

    def test_forged_role_or_scope_ignored(self, client, tuna_workshop):
        token = _pair([L_KEY])
        response = client.post("/api/tunascreen/action", headers=_h(token), json={
            "machine_id": f"marlin:{UID_M}", "action": "pause", "params": {},
            "role": "admin", "scope": [M_KEY], "device_id": "tuna_otro"})
        assert response.status_code == 400 and tuna_workshop == []


class TestIsolation:
    def test_arp_is_simulated_not_the_real_one(self):
        assert machine_identity.ARP_PATH != "/proc/net/arp"
        assert machine_identity.read_arp_table() == {}

    def test_esp420_capture_cannot_reach_the_lan(self, monkeypatch):
        """Sin _probe_host simulado, la consulta real queda bloqueada por el
        sandbox: no hay Chip ID ni MAC, no hay red."""
        assert laser_service.capture_network_anchor("192.168.0.61", timeout=0.2) == {}


# ── Otros consumidores del id ──

class TestConsumers:
    async def test_ai_uses_internal_id_and_resolves_by_current_address(self, monkeypatch):
        from backend.services import ai_tools

        async def lasers():
            return [dict(LASER_ENTRY), {"host": "192.168.0.99", "name": "Sin id", "kind": "laser"}]

        monkeypatch.setattr(ai_tools, "get_all_printers_status", lambda: [])
        monkeypatch.setattr(ai_tools, "get_marlin_printers", lambda: [dict(MARLIN_ENTRY)])
        monkeypatch.setattr(ai_tools, "get_flashforge_printers", lambda: [])
        monkeypatch.setattr(ai_tools, "get_bambu_printers", lambda: [])
        monkeypatch.setattr(ai_tools, "get_elegoo_printers", lambda: [])
        monkeypatch.setattr(ai_tools, "get_registered_lasers_status", lasers)

        machines = await ai_tools._collect_machines()

        assert [m["id"] for m in machines] == [f"marlin:{UID_M}", f"laser:{UID_L}"]  # sin id: fuera
        assert ai_tools._resolve_machine(machines, "192.168.0.61")["id"] == f"laser:{UID_L}"
        assert ai_tools._resolve_machine(machines, "/dev/ttyUSB0")["id"] == f"marlin:{UID_M}"

    def test_panel_resources_use_internal_id(self, monkeypatch):
        from backend.api import laser as laser_api
        from backend.api import marlin_printers as marlin_api

        monkeypatch.setattr(laser_api, "get_registered_lasers", lambda: [dict(LASER_ENTRY), dict(CNC_ENTRY)])
        monkeypatch.setattr(marlin_api, "get_registered_printers", lambda: [dict(MARLIN_ENTRY)])

        assert laser_api._laser_resource("192.168.0.61").key == f"laser:laser:{UID_L}"
        assert laser_api._laser_resource("192.168.0.72").key == f"cnc:laser:{UID_C}"
        assert marlin_api._marlin_resource("/dev/ttyUSB0").key == f"printer:marlin:{UID_M}"

    async def test_tuna_camera_bound_by_internal_id(self, tuna_workshop, monkeypatch):
        asked = []
        monkeypatch.setattr(tunascreen_service, "_camera_fields", lambda kind, device_id: asked.append((kind, device_id)) or ([], None))
        tunascreen_service._machines_cache = []

        await tunascreen_service.list_machines()

        assert sorted(asked) == sorted([("marlin", UID_M), ("laser", UID_L), ("cnc", UID_C)])

    def test_new_history_job_links_internal_id(self, laser_registry, monkeypatch, tmp_path):
        write, _ = laser_registry
        write([_net("192.168.0.61", UID_L, MAC_A)])
        monkeypatch.setattr(laser_service, "HISTORY_PATH", str(tmp_path / "history.json"))
        job = laser_service.LaserJob("192.168.0.61", ["G0 X1"], filename="pieza.gc")
        laser_service.record_laser_job_history(job)
        assert laser_service.get_laser_history(1)[0]["machine_id"] == f"laser:{UID_L}"
