"""Scope persistente de TUNA-Screen (D3-Q5): qué puede ver y hacer cada dispositivo.

La autenticación (token) identifica al dispositivo; el scope persistente de su
registro decide qué ve y qué hace. Fail-closed: sin scope, nada. Fuera del
scope = inexistente (mismo código y detalle). Lecturas, cámaras, plugins y
WebSocket incluidos. Solo recursos con identidad estable.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketDisconnect

import backend.services.bambu_service as bambu_service
import backend.services.elegoo_service as elegoo_service
import backend.services.flashforge_service as flashforge_service
import backend.services.klipper_service as klipper_service
import backend.services.laser_service as laser_service
import backend.services.marlin_printer_service as marlin_printer_service
import backend.services.plugin_installer_service as plugin_installer_service
import backend.services.tunascreen_service as tunascreen_service
from backend.services.authorization_policy import Action

A, B = "printer:klipper:7125", "printer:klipper:7126"
SPOOLMAN, ACCESSORIES = "plugin:spoolman", "plugin:arduino-accessories"
LASER_HOST = "192.168.0.61"
NOT_FOUND_400 = {"detail": "Máquina no encontrada"}
CAMERAS = {
    "cama0000000a": {"bound": ("klipper", "ET4"), "path": "/dev/video0"},
    "camb0000000b": {"bound": ("klipper", "VORON"), "path": "/dev/video2"},
    "camc0000000c": {"bound": None, "path": "/dev/video4"},  # sin vincular
}


class _Log(list):
    """Lista de llamadas que además guarda las impresoras simuladas."""


@pytest.fixture
def workshop(monkeypatch):
    """Dos Klipper (7125 'ET4', 7126 'VORON') y un láser por IP, cada Klipper
    con su cámara USB; plugins arduino-accessories y spoolman instalados.
    Registra cada llamada a un driver/servicio (nada real)."""
    log = _Log()
    printers = [
        {"name": "ET4", "port": 7125, "status": "online", "data": {"extruder": {}, "heater_bed": {}}, "job": {}},
        {"name": "VORON", "port": 7126, "status": "online", "data": {"extruder": {}, "heater_bed": {}}, "job": {}},
    ]
    monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: list(printers))
    for module in (bambu_service, elegoo_service, flashforge_service, marlin_printer_service):
        monkeypatch.setattr(module, "get_registered_printers_with_status", lambda: [])

    async def lasers():
        return [{"host": LASER_HOST, "name": "TTS", "online": True, "kind": "laser"}]

    async def laser_status(host, timeout=3.0):
        return {"state": "Idle", "x": 0.0, "y": 0.0, "z": 0.0, "feed": 0, "speed": 0}

    async def laser_job(host):
        return None

    monkeypatch.setattr(laser_service, "get_registered_lasers_status", lasers)
    monkeypatch.setattr(laser_service, "get_status", laser_status)
    monkeypatch.setattr(laser_service, "get_job_status", laser_job)

    def record(name, result=True):
        return lambda *args, **kwargs: log.append((name, args)) or result

    monkeypatch.setattr(klipper_service, "pause_printer_print", record("klipper.pause"))
    monkeypatch.setattr(klipper_service, "get_macros", lambda port: log.append(("macros", port)) or [{"name": "PURGE"}])
    monkeypatch.setattr(klipper_service, "get_console_messages",
                        lambda port, count=50: log.append(("console", port)) or [{"message": "ok"}])
    monkeypatch.setattr(laser_service, "send_raw_command", record("laser.send_raw_command"))

    def bound_to(device_type, device_id):
        return next(({"id": cid} for cid, c in CAMERAS.items() if c["bound"] == (device_type, device_id)), None)

    def camera_by_id(camera_id):
        c = CAMERAS.get(camera_id)
        if c is None:
            return None
        bound = {"type": c["bound"][0], "id": c["bound"][1]} if c["bound"] else None
        return {"id": camera_id, "name": camera_id, "stream_url": f"/api/cameras/{camera_id}/stream",
                "device_path": c["path"], "bound_device": bound}

    async def subscribe(camera_id, device_path):
        log.append(("camera.subscribe", camera_id))
        return asyncio.Queue()

    async def unsubscribe(camera_id, queue):
        log.append(("camera.unsubscribe", camera_id))

    spool_client = SimpleNamespace(list_spools=lambda allow_archived: [{"id": 7, "filament": {"material": "PLA"}}])
    modules = {
        ("camera-viewer", "services.camera_service"): SimpleNamespace(get_camera_bound_to=bound_to, get_camera_by_id=camera_by_id),
        ("camera-viewer", "services.usb_camera_service"): SimpleNamespace(subscribe=subscribe, unsubscribe=unsubscribe),
        ("spoolman", "services.config_service"): SimpleNamespace(get_client=lambda: spool_client),
        ("spoolman", "services.spool_link_service"): SimpleNamespace(
            get_all_links=lambda: {"7125": {"spool_id": 7}, "7126": {"spool_id": 8}}),
        ("spoolman", "services.reservation_service"): None,
        ("arduino-accessories", "services.accessory_service"): SimpleNamespace(
            get_accessories_status=lambda: _value([]),
            set_accessory_power=lambda accessory_id, on: log.append(("accessory.power", accessory_id)) or _value(True)),
        ("arduino-accessories", "services.accessory_scenes"): SimpleNamespace(get_scenes=lambda: []),
    }
    monkeypatch.setattr(tunascreen_service, "get_loaded_plugin_module", lambda plugin, name: modules.get((plugin, name)))

    async def fake_set_active_material(machine_id, spool_id):
        log.append(("spoolman.assign", machine_id, spool_id))
        return {"success": True, "machine_id": machine_id, "spool_id": spool_id}

    monkeypatch.setattr(tunascreen_service, "set_active_material", fake_set_active_material)
    monkeypatch.setattr(plugin_installer_service, "read_installed_state",
                        lambda: {"arduino-accessories": {"enabled": True}, "spoolman": {"enabled": True}})
    log.printers = printers
    return log


async def _value(value):
    return value


def _pair(scope):
    code = tunascreen_service.generate_pairing_code(scope=scope)["code"]
    result = tunascreen_service.confirm_pairing(code, "Tablet")
    return result["token"], result["device_id"]


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _ids(response):
    return [m["id"] for m in response.json()["machines"]]


def _calls(log, kind):
    return [entry for entry in log if entry[0] == kind]


# --------------------------------------------------------------------------
# Lecturas y acciones por HTTP
# --------------------------------------------------------------------------

class TestEmptyScope:
    def test_device_without_scope_sees_and_does_nothing(self, client, workshop):
        token, _ = _pair([])

        assert _ids(client.get("/api/tunascreen/machines", headers=_h(token))) == []
        assert _ids(client.get("/api/tunascreen/config", headers=_h(token))) == []
        assert client.get("/api/tunascreen/machine/klipper:7125", headers=_h(token)).status_code == 404
        macros = client.get("/api/tunascreen/machine/klipper:7125/macros", headers=_h(token))
        console = client.get("/api/tunascreen/machine/klipper:7125/console", headers=_h(token))
        assert (macros.status_code, macros.json()) == (400, NOT_FOUND_400)
        assert (console.status_code, console.json()) == (400, NOT_FOUND_400)
        assert client.get("/api/tunascreen/cameras/cama0000000a/stream", headers=_h(token)).status_code == 404
        action = client.post("/api/tunascreen/action", headers=_h(token),
                             json={"machine_id": "klipper:7125", "action": "pause", "params": {}})
        assert (action.status_code, action.json()) == (400, NOT_FOUND_400)
        assert client.get("/api/tunascreen/materials", headers=_h(token)).status_code == 403
        assert client.get("/api/tunascreen/accessories", headers=_h(token)).status_code == 403
        assert workshop == []

    def test_websocket_sends_no_machines(self, client, workshop):
        token, _ = _pair([])

        with client.websocket_connect("/ws/tunascreen", headers=_h(token)) as ws:
            assert ws.receive_json() == {"type": "machines", "api_version": 1, "machines": []}


class TestSingleMachineScope:
    def test_lists_only_its_machine(self, client, workshop):
        token, _ = _pair([A])

        assert _ids(client.get("/api/tunascreen/machines", headers=_h(token))) == ["klipper:7125"]
        assert _ids(client.get("/api/tunascreen/config", headers=_h(token))) == ["klipper:7125"]

    @pytest.mark.parametrize("machine_id", ["klipper:7126", "klipper:9999", f"laser:{LASER_HOST}"])
    def test_out_of_scope_looks_like_missing(self, client, workshop, machine_id):
        token, _ = _pair([A])

        detail = client.get(f"/api/tunascreen/machine/{machine_id}", headers=_h(token))
        macros = client.get(f"/api/tunascreen/machine/{machine_id}/macros", headers=_h(token))
        console = client.get(f"/api/tunascreen/machine/{machine_id}/console", headers=_h(token))
        action = client.post("/api/tunascreen/action", headers=_h(token),
                             json={"machine_id": machine_id, "action": "pause", "params": {}})

        assert (detail.status_code, detail.json()) == (404, NOT_FOUND_400)
        assert (macros.status_code, macros.json()) == (400, NOT_FOUND_400)
        assert (console.status_code, console.json()) == (400, NOT_FOUND_400)
        assert (action.status_code, action.json()) == (400, NOT_FOUND_400)
        assert workshop == []

    def test_in_scope_machine_works(self, client, workshop):
        token, _ = _pair([A])

        assert client.get("/api/tunascreen/machine/klipper:7125", headers=_h(token)).json()["id"] == "klipper:7125"
        assert client.get("/api/tunascreen/machine/klipper:7125/macros", headers=_h(token)).json() == {"macros": [{"name": "PURGE"}]}
        assert client.get("/api/tunascreen/machine/klipper:7125/console", headers=_h(token)).status_code == 200
        action = client.post("/api/tunascreen/action", headers=_h(token),
                             json={"machine_id": "klipper:7125", "action": "pause", "params": {}})
        assert action.status_code == 200
        assert _calls(workshop, "klipper.pause") == [("klipper.pause", (7125,))]

    def test_client_scope_or_device_id_in_request_is_ignored(self, client, workshop):
        token, _ = _pair([A])

        response = client.post("/api/tunascreen/action", headers=_h(token), json={
            "machine_id": "klipper:7126", "action": "pause", "params": {},
            "scope": [B], "device_id": "otro", "role": "admin",
        })

        assert (response.status_code, response.json()) == (400, NOT_FOUND_400)
        assert workshop == []


class TestTwoDevices:
    def test_http_isolation(self, client, workshop):
        token_a, _ = _pair([A])
        token_b, _ = _pair([B])

        assert _ids(client.get("/api/tunascreen/machines", headers=_h(token_a))) == ["klipper:7125"]
        assert _ids(client.get("/api/tunascreen/machines", headers=_h(token_b))) == ["klipper:7126"]
        assert client.get("/api/tunascreen/machine/klipper:7126", headers=_h(token_a)).status_code == 404
        assert client.get("/api/tunascreen/machine/klipper:7125", headers=_h(token_b)).status_code == 404

    def test_websocket_isolation_with_both_open(self, client, workshop):
        token_a, _ = _pair([A])
        token_b, _ = _pair([B])

        with client.websocket_connect("/ws/tunascreen", headers=_h(token_a)) as ws_a, \
                client.websocket_connect("/ws/tunascreen", headers=_h(token_b)) as ws_b:
            assert [m["id"] for m in ws_a.receive_json()["machines"]] == ["klipper:7125"]
            assert [m["id"] for m in ws_b.receive_json()["machines"]] == ["klipper:7126"]

            workshop.printers[0]["job"] = {"state": "printing", "progress": 10}
            workshop.printers[1]["job"] = {"state": "printing", "progress": 20}
            _invalidate_machine_cache()
            client.portal.call(tunascreen_service.broadcast_machines)

            assert [m["id"] for m in ws_a.receive_json()["machines"]] == ["klipper:7125"]
            assert [m["id"] for m in ws_b.receive_json()["machines"]] == ["klipper:7126"]


def _invalidate_machine_cache():
    tunascreen_service._machines_cache = []
    tunascreen_service._machines_cache_at = 0.0


# --------------------------------------------------------------------------
# WebSocket: revocación, cambio de scope, deduplicación
# --------------------------------------------------------------------------

class TestWebSocketLifecycle:
    def test_revoked_device_is_closed_on_next_cycle(self, client, workshop):
        token, device_id = _pair([A])

        with client.websocket_connect("/ws/tunascreen", headers=_h(token)) as ws:
            ws.receive_json()
            assert tunascreen_service.revoke_device(device_id)
            client.portal.call(tunascreen_service.broadcast_machines)

            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 4401
        assert tunascreen_service._ws_connections == {}

    def test_scope_change_applies_without_reconnecting(self, client, workshop):
        token, device_id = _pair([A])

        with client.websocket_connect("/ws/tunascreen", headers=_h(token)) as ws:
            assert [m["id"] for m in ws.receive_json()["machines"]] == ["klipper:7125"]
            tunascreen_service.set_device_scope(device_id, [B])
            client.portal.call(tunascreen_service.broadcast_machines)

            assert [m["id"] for m in ws.receive_json()["machines"]] == ["klipper:7126"]

    def test_deduplication_is_per_connection(self, client, workshop):
        """Sin cambios no se reenvía; el siguiente mensaje es el cambio real
        (si se hubiera reenviado el duplicado, llegaría primero)."""
        token, device_id = _pair([A])

        with client.websocket_connect("/ws/tunascreen", headers=_h(token)) as ws:
            first = ws.receive_json()
            client.portal.call(tunascreen_service.broadcast_machines)  # sin cambios
            tunascreen_service.set_device_scope(device_id, [A, B])
            client.portal.call(tunascreen_service.broadcast_machines)

            second = ws.receive_json()
            assert second != first
            assert [m["id"] for m in second["machines"]] == ["klipper:7125", "klipper:7126"]

    def test_connection_is_bound_to_handshake_device(self, client, workshop):
        token, device_id = _pair([A])

        with client.websocket_connect("/ws/tunascreen", headers=_h(token)) as ws:
            ws.receive_json()
            assert [state["device_id"] for state in tunascreen_service._ws_connections.values()] == [device_id]


# --------------------------------------------------------------------------
# Cámaras
# --------------------------------------------------------------------------

class TestCameras:
    async def test_camera_of_machine_in_scope_is_allowed(self, workshop):
        device = {"device_id": "tuna_x", "scope": [A]}

        await tunascreen_service.subscribe_camera_stream("cama0000000a", device)

        assert _calls(workshop, "camera.subscribe") == [("camera.subscribe", "cama0000000a")]

    @pytest.mark.parametrize("camera_id", ["camb0000000b", "camc0000000c", "noexiste0000"],
                             ids=["otra-maquina", "sin-vincular", "inexistente"])
    async def test_other_unbound_or_missing_camera_is_denied(self, workshop, camera_id):
        device = {"device_id": "tuna_x", "scope": [A]}

        with pytest.raises(KeyError):
            await tunascreen_service.subscribe_camera_stream(camera_id, device)
        assert _calls(workshop, "camera.subscribe") == []

    @pytest.mark.parametrize("camera_id", ["camb0000000b", "camc0000000c", "noexiste0000"])
    def test_denied_cameras_look_identical_over_http(self, client, workshop, camera_id):
        token, _ = _pair([A])

        response = client.get(f"/api/tunascreen/cameras/{camera_id}/stream", headers=_h(token))

        assert response.status_code == 404
        assert response.json() == {"detail": "Cámara USB vinculada no encontrada"}
        assert _calls(workshop, "camera.subscribe") == []


# --------------------------------------------------------------------------
# Plugins: Spoolman y accesorios
# --------------------------------------------------------------------------

class TestPlugins:
    def test_accessories_need_explicit_plugin_entry(self, client, workshop):
        machine_only, _ = _pair([A])
        with_plugin, _ = _pair([A, ACCESSORIES])

        assert client.get("/api/tunascreen/accessories", headers=_h(machine_only)).status_code == 403
        assert client.post("/api/tunascreen/accessories/rele1/power", json={"on": True},
                           headers=_h(machine_only)).status_code == 403
        assert client.get("/api/tunascreen/accessories", headers=_h(with_plugin)).status_code == 200
        assert client.post("/api/tunascreen/accessories/rele1/power", json={"on": True},
                           headers=_h(with_plugin)).status_code == 200
        assert _calls(workshop, "accessory.power") == [("accessory.power", "rele1")]

    def test_materials_need_spoolman_and_filter_links(self, client, workshop):
        machine_only, _ = _pair([A])
        with_spoolman, _ = _pair([A, SPOOLMAN])

        assert client.get("/api/tunascreen/materials", headers=_h(machine_only)).status_code == 403
        materials = client.get("/api/tunascreen/materials", headers=_h(with_spoolman))
        assert materials.status_code == 200
        assert materials.json()["links"] == {"klipper:7125": 7}  # nunca 7126, fuera del scope

    @pytest.mark.parametrize("scope, allowed", [
        ([A, SPOOLMAN], True),
        ([SPOOLMAN], False),      # plugin sin la máquina
        ([A], False),             # máquina sin el plugin
        ([B, SPOOLMAN], False),   # otra máquina
    ], ids=["maquina+plugin", "solo-plugin", "solo-maquina", "otra-maquina"])
    def test_assign_active_spool_needs_machine_and_plugin(self, client, workshop, scope, allowed):
        token, _ = _pair(scope)

        response = client.post("/api/tunascreen/materials/active", headers=_h(token),
                               json={"machine_id": "klipper:7125", "spool_id": 7})

        if allowed:
            assert response.status_code == 200
            assert _calls(workshop, "spoolman.assign") == [("spoolman.assign", "klipper:7125", 7)]
        else:
            assert response.status_code == 403
            assert _calls(workshop, "spoolman.assign") == []


# --------------------------------------------------------------------------
# Gestión del scope (admin)
# --------------------------------------------------------------------------

UNSTABLE = ["marlin:/dev/ttyUSB0", "laser:192.168.0.61", "laser:usb:/dev/ttyUSB0",
            "printer:marlin:/dev/ttyUSB0", f"laser:laser:{LASER_HOST}", "cnc:laser:192.168.0.63",
            "laser:laser:usb:/dev/ttyUSB0"]
INVALID = [["sin-dos-puntos"], ["printer:"], ["printer:klipper:abc"], ["printer:octoprint:1"],
           ["system:x"], [""], [" printer:klipper:7125"], [A, A], "printer:klipper:7125", [7125],
           ["printer:klipper:9999"], ["plugin:no-instalado"]]


class TestScopeManagement:
    def test_admin_edits_scope(self, client, workshop, as_admin):
        _, device_id = _pair([])

        response = client.put(f"/api/tunascreen/devices/{device_id}/scope", json={"scope": [SPOOLMAN, A, ACCESSORIES]})

        assert response.status_code == 200
        assert response.json()["scope"] == sorted([SPOOLMAN, A, ACCESSORIES])
        assert "token_hash" not in response.json()

    def test_operator_cannot_edit_scope(self, client, workshop, as_operator):
        _, device_id = _pair([])

        assert client.put(f"/api/tunascreen/devices/{device_id}/scope", json={"scope": [A]}).status_code == 403
        assert tunascreen_service.device_scope(tunascreen_service.get_device(device_id)) == set()

    def test_device_token_cannot_use_admin_endpoints(self, client, workshop):
        token, device_id = _pair([A])

        for method, url, body in [("put", f"/api/tunascreen/devices/{device_id}/scope", {"scope": [A, B]}),
                                  ("post", "/api/tunascreen/pair/start", {"scope": [B]}),
                                  ("get", "/api/tunascreen/devices", None),
                                  ("get", "/api/tunascreen/scope-options", None)]:
            response = getattr(client, method)(url, headers=_h(token), **({"json": body} if body else {}))
            assert response.status_code == 401, (method, url)
        assert tunascreen_service.device_scope(tunascreen_service.get_device(device_id)) == {A}

    @pytest.mark.parametrize("key", UNSTABLE)
    def test_unstable_identity_rejected_everywhere(self, client, workshop, as_admin, key):
        _, device_id = _pair([A])

        edit = client.put(f"/api/tunascreen/devices/{device_id}/scope", json={"scope": [A, key]})
        start = client.post("/api/tunascreen/pair/start", json={"scope": [key]})

        assert edit.status_code == 400 and "identidad estable" in edit.json()["detail"]
        assert start.status_code == 400 and "identidad estable" in start.json()["detail"]
        assert tunascreen_service.device_scope(tunascreen_service.get_device(device_id)) == {A}

    @pytest.mark.parametrize("scope", INVALID, ids=[repr(s)[:30] for s in INVALID])
    def test_invalid_scope_rejected_without_partial_write(self, client, workshop, as_admin, scope):
        _, device_id = _pair([A])

        response = client.put(f"/api/tunascreen/devices/{device_id}/scope", json={"scope": scope})

        assert response.status_code == 400
        assert tunascreen_service.device_scope(tunascreen_service.get_device(device_id)) == {A}

    def test_unknown_device_returns_404(self, client, workshop, as_admin):
        assert client.put("/api/tunascreen/devices/tuna_noexiste/scope", json={"scope": [A]}).status_code == 404

    def test_pairing_carries_admin_scope_and_ignores_device_scope(self, client, workshop, as_admin):
        code = client.post("/api/tunascreen/pair/start", json={"scope": [A]}).json()["code"]

        paired = client.post("/api/tunascreen/pair/confirm",
                             json={"code": code, "device_name": "Tablet", "scope": [A, B, SPOOLMAN]}).json()

        assert tunascreen_service.device_scope(tunascreen_service.get_device(paired["device_id"])) == {A}

    def test_pairing_without_scope_means_no_access(self, client, workshop, as_admin):
        code = client.post("/api/tunascreen/pair/start").json()["code"]

        paired = client.post("/api/tunascreen/pair/confirm", json={"code": code, "device_name": "Tablet"}).json()

        assert tunascreen_service.get_device(paired["device_id"])["scope"] == []
        assert _ids(client.get("/api/tunascreen/machines", headers=_h(paired["token"]))) == []

    def test_scope_options_offer_only_stable_resources(self, client, workshop, as_admin):
        options = client.get("/api/tunascreen/scope-options").json()

        assert [m["key"] for m in options["machines"]] == [A, B]  # el láser por IP no se ofrece
        assert [p["key"] for p in options["plugins"]] == [ACCESSORIES, SPOOLMAN]

    def test_operator_cannot_list_scope_options(self, client, workshop, as_operator):
        assert client.get("/api/tunascreen/scope-options").status_code == 403


# --------------------------------------------------------------------------
# Migración, scope corrupto y máquinas eliminadas
# --------------------------------------------------------------------------

class TestMigrationAndFailClosed:
    def _write_registry(self, entries):
        with open(tunascreen_service.REGISTRY_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle)

    def test_legacy_device_without_scope_gets_nothing_and_migrates_to_empty(self, client, workshop):
        token = "token-del-samsung"
        self._write_registry([{"device_id": "tuna_samsung", "name": "samsung SM-A035M",
                               "token_hash": tunascreen_service._hash_token(token),
                               "paired_at": 1.0, "last_seen": None}])

        assert _ids(client.get("/api/tunascreen/machines", headers=_h(token))) == []
        assert client.post("/api/tunascreen/action", headers=_h(token),
                           json={"machine_id": "klipper:7125", "action": "pause", "params": {}}).status_code == 400
        assert tunascreen_service.migrate_registry_scopes() == 1
        assert tunascreen_service.get_device("tuna_samsung")["scope"] == []
        assert tunascreen_service.migrate_registry_scopes() == 0  # idempotente
        assert workshop == []

    @pytest.mark.parametrize("stored", ["printer:klipper:7125", {"x": 1}, [A, "printer:marlin:/dev/ttyUSB0"],
                                        [A, 7], [A, A], None])
    def test_corrupt_or_invalid_stored_scope_is_empty(self, stored):
        assert tunascreen_service.device_scope({"device_id": "tuna_x", "scope": stored}) == set()

    def test_removed_machine_grants_nothing(self, client, workshop):
        token, _ = _pair([B])
        del workshop.printers[1]  # la 7126 desaparece
        _invalidate_machine_cache()

        assert _ids(client.get("/api/tunascreen/machines", headers=_h(token))) == []
        assert client.get("/api/tunascreen/machine/klipper:7126", headers=_h(token)).status_code == 404
        assert client.get("/api/tunascreen/machine/klipper:7125", headers=_h(token)).status_code == 404
        assert workshop == []

    def test_policy_actions_used_are_existing_ones(self, client, workshop, monkeypatch):
        seen = []
        real = tunascreen_service.authorize
        monkeypatch.setattr(tunascreen_service, "authorize",
                            lambda p, a, r=None: seen.append(a) or real(p, a, r))
        token, _ = _pair([A, SPOOLMAN, ACCESSORIES])

        client.get("/api/tunascreen/machines", headers=_h(token))
        client.get("/api/tunascreen/materials", headers=_h(token))
        client.get("/api/tunascreen/accessories", headers=_h(token))

        assert set(seen) <= {Action.VIEW_STATUS, Action.USE_PLUGIN}
