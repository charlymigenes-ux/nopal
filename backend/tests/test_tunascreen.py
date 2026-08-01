import pytest

import backend.services.bambu_service as bambu_service
import backend.services.elegoo_service as elegoo_service
import backend.services.flashforge_service as flashforge_service
import backend.services.klipper_service as klipper_service
import backend.services.laser_service as laser_service
import backend.services.marlin_printer_service as marlin_printer_service
import backend.services.tunascreen_service as tunascreen_service


@pytest.fixture(autouse=True)
def _quiet_brands(monkeypatch):
    """list_machines() barre las 6 marcas -- sin esto, cualquier test de
    este archivo dispararía descubrimiento real de red (Klipper vía
    find_moonraker_instances) y tocaría el laser_registry.json real del
    repo (laser_service.REGISTRY_PATH no está en el fixture compartido de
    conftest.py, a diferencia de bambu/elegoo/flashforge/marlin). Se
    neutraliza acá, local a este archivo, sin tocar ese fixture compartido."""
    monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [])
    monkeypatch.setattr(bambu_service, "get_registered_printers_with_status", lambda: [])
    monkeypatch.setattr(elegoo_service, "get_registered_printers_with_status", lambda: [])
    monkeypatch.setattr(flashforge_service, "get_registered_printers_with_status", lambda: [])
    monkeypatch.setattr(marlin_printer_service, "get_registered_printers_with_status", lambda: [])

    async def _no_lasers():
        return []
    monkeypatch.setattr(laser_service, "get_registered_lasers_status", _no_lasers)


class TestPairing:
    def test_full_pairing_flow_and_token_works(self, client, as_admin):
        start = client.post("/api/tunascreen/pair/start")
        assert start.status_code == 200
        code = start.json()["code"]
        assert len(code) == 6

        confirm = client.post("/api/tunascreen/pair/confirm", json={"code": code, "device_name": "Tablet Taller"})
        assert confirm.status_code == 200
        body = confirm.json()
        assert body["device_id"].startswith("tuna_")
        token = body["token"]
        assert token

        machines = client.get("/api/tunascreen/machines", headers={"Authorization": f"Bearer {token}"})
        assert machines.status_code == 200
        assert machines.json() == {"api_version": 1, "machines": []}

    def test_pair_start_requires_admin(self, client, as_operator):
        response = client.post("/api/tunascreen/pair/start")
        assert response.status_code == 403

    def test_wrong_code_rejected(self, client, as_admin):
        client.post("/api/tunascreen/pair/start")
        response = client.post("/api/tunascreen/pair/confirm", json={"code": "000000", "device_name": "X"})
        assert response.status_code == 400

    def test_code_is_single_use(self, client, as_admin):
        code = client.post("/api/tunascreen/pair/start").json()["code"]
        first = client.post("/api/tunascreen/pair/confirm", json={"code": code, "device_name": "A"})
        assert first.status_code == 200
        second = client.post("/api/tunascreen/pair/confirm", json={"code": code, "device_name": "B"})
        assert second.status_code == 400

    def test_expired_code_rejected(self, client, as_admin, monkeypatch):
        code = client.post("/api/tunascreen/pair/start").json()["code"]
        monkeypatch.setitem(tunascreen_service._pending_codes, code, 0)  # ya vencido
        response = client.post("/api/tunascreen/pair/confirm", json={"code": code, "device_name": "A"})
        assert response.status_code == 400


class TestDeviceAuth:
    def test_missing_token_rejected(self, client):
        response = client.get("/api/tunascreen/machines")
        assert response.status_code == 401

    def test_invalid_token_rejected(self, client):
        response = client.get("/api/tunascreen/machines", headers={"Authorization": "Bearer not-a-real-token"})
        assert response.status_code == 401

    def test_valid_token_resolves_device(self, client, as_admin):
        code = client.post("/api/tunascreen/pair/start").json()["code"]
        token = client.post(
            "/api/tunascreen/pair/confirm", json={"code": code, "device_name": "Tablet"}
        ).json()["token"]
        device = tunascreen_service.resolve_device(token)
        assert device is not None
        assert device["name"] == "Tablet"


class TestDeviceManagement:
    def test_list_devices_requires_admin(self, client, as_operator):
        assert client.get("/api/tunascreen/devices").status_code == 403

    def test_list_devices_never_leaks_token_hash(self, client, as_admin):
        code = client.post("/api/tunascreen/pair/start").json()["code"]
        client.post("/api/tunascreen/pair/confirm", json={"code": code, "device_name": "Tablet Taller"})

        response = client.get("/api/tunascreen/devices")
        assert response.status_code == 200
        devices = response.json()["devices"]
        assert len(devices) == 1
        assert devices[0]["name"] == "Tablet Taller"
        assert "token_hash" not in devices[0]

    def test_revoke_device(self, client, as_admin):
        code = client.post("/api/tunascreen/pair/start").json()["code"]
        pair_response = client.post(
            "/api/tunascreen/pair/confirm", json={"code": code, "device_name": "Tablet"}
        ).json()
        token = pair_response["token"]
        device_id = pair_response["device_id"]

        revoke = client.delete(f"/api/tunascreen/devices/{device_id}")
        assert revoke.status_code == 200

        assert tunascreen_service.resolve_device(token) is None
        assert client.get("/api/tunascreen/devices").json()["devices"] == []

    def test_revoke_unknown_device_returns_404(self, client, as_admin):
        response = client.delete("/api/tunascreen/devices/tuna_doesnotexist")
        assert response.status_code == 404


class TestListMachinesShape:
    async def test_klipper_machine_shape(self, monkeypatch):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "online",
            "data": {"extruder": {"temperature": 205.0, "target": 205.0}, "heater_bed": {"temperature": 60.0, "target": 60.0}},
            "job": {"filename": "pieza.gcode", "state": "printing", "progress": 72, "print_duration": 8325, "estimated_remaining": 3075},
        }])
        machines = await tunascreen_service.list_machines()
        assert len(machines) == 1
        machine = machines[0]
        assert machine["id"] == "klipper:7125"
        assert machine["type"] == "printer"
        assert machine["driver"] == "klipper"
        assert {
            "temperature", "movement", "extrusion", "fan", "speed_override",
            "flow_override", "z_offset", "macros", "console",
        }.issubset(machine["capabilities"])
        assert "move" in machine["actions"]
        assert "set_temperature" in machine["actions"]
        assert machine["status"]["state"] == "printing"
        assert machine["status"]["hotend"] == {"current": 205.0, "target": 205.0}
        assert machine["status"]["job"]["percent"] == 72

    async def test_cnc_machine_gets_cnc_capabilities_not_laser(self, monkeypatch):
        async def _lasers():
            return [{"host": "192.168.1.60", "name": "Router CNC", "kind": "cnc", "online": True}]
        monkeypatch.setattr(laser_service, "get_registered_lasers_status", _lasers)

        async def _status(host, timeout=3.0):
            return {"state": "Run", "x": 10.0, "y": 5.0, "z": -2.0, "feed": 800, "speed": 12000}
        async def _job(host):
            return {"filename": "", "source": "", "state": "running", "current": 40, "total": 100, "error": None}
        monkeypatch.setattr(laser_service, "get_status", _status)
        monkeypatch.setattr(laser_service, "get_job_status", _job)

        machines = await tunascreen_service.list_machines()
        assert len(machines) == 1
        machine = machines[0]
        assert machine["id"] == "laser:192.168.1.60"
        assert machine["type"] == "cnc"
        assert "spindle" in machine["capabilities"]
        assert "laser_power" not in machine["capabilities"]
        assert "set_work_zero" in machine["actions"]
        assert machine["status"]["spindle_rpm"] == 12000
        assert machine["status"]["state"] == "printing"  # "running" normalizado
        assert machine["status"]["job"]["percent"] == 40


class TestDispatchAction:
    async def test_unsupported_action_rejected(self, monkeypatch):
        monkeypatch.setattr(bambu_service, "get_registered_printers_with_status", lambda: [{
            "id": "01S00A1", "name": "P2S", "model": "P2S", "ip": "1.2.3.4", "online": True,
            "status": "online", "temps": {"extruder": {"current": 1, "target": 1}, "heater_bed": {"current": 1, "target": 1}},
            "job": {"state": "idle", "filename": None, "progress": None, "current_layer": None, "total_layer": None},
        }])
        with pytest.raises(ValueError, match="no soportada"):
            await tunascreen_service.dispatch_action("bambu:01S00A1", "home", {})

    async def test_pause_dispatches_to_klipper_service(self, monkeypatch):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "online",
            "data": {"extruder": {}, "heater_bed": {}}, "job": {},
        }])
        called = {}
        def _pause(port):
            called["port"] = port
            return True
        monkeypatch.setattr(klipper_service, "pause_printer_print", _pause)

        result = await tunascreen_service.dispatch_action("klipper:7125", "pause", {})
        assert result == {"success": True}
        assert called["port"] == 7125

    async def test_klipper_move_uses_safe_relative_gcode(self, monkeypatch):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "online",
            "data": {"extruder": {}, "heater_bed": {}}, "job": {},
        }])
        called = {}

        def _send(port, command):
            called.update(port=port, command=command)
            return True

        monkeypatch.setattr(klipper_service, "send_console_command", _send)
        result = await tunascreen_service.dispatch_action(
            "klipper:7125",
            "move",
            {"axis": "X", "distance": 5, "feed": 1200},
        )
        assert result == {"success": True}
        assert called["port"] == 7125
        assert "SAVE_GCODE_STATE" in called["command"]
        assert "G0 X5 F1200" in called["command"]
        assert "RESTORE_GCODE_STATE" in called["command"]

    async def test_action_rejected_when_machine_is_offline(self, monkeypatch):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "offline",
            "data": {}, "job": {},
        }])
        with pytest.raises(ValueError, match="fuera de línea"):
            await tunascreen_service.dispatch_action("klipper:7125", "home", {})

    @pytest.mark.parametrize(
        ("action", "params", "expected"),
        [
            ("set_fan", {"percent": 50}, "M106 S128"),
            ("set_speed_factor", {"percent": 125}, "M220 S125"),
            ("set_flow_factor", {"percent": 95}, "M221 S95"),
            ("set_z_offset", {"offset": -0.15}, "SET_GCODE_OFFSET Z=-0.15 MOVE=1"),
        ],
    )
    async def test_klipper_advanced_controls_emit_validated_gcode(
        self, monkeypatch, action, params, expected
    ):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "online",
            "data": {"extruder": {}, "heater_bed": {}}, "job": {},
        }])
        called = {}
        monkeypatch.setattr(
            klipper_service,
            "send_console_command",
            lambda port, command: called.update(port=port, command=command) or True,
        )

        result = await tunascreen_service.dispatch_action("klipper:7125", action, params)

        assert result == {"success": True}
        assert called == {"port": 7125, "command": expected}

    async def test_macro_name_is_validated_before_dispatch(self, monkeypatch):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "online",
            "data": {"extruder": {}, "heater_bed": {}}, "job": {},
        }])
        with pytest.raises(ValueError, match="Macro inv"):
            await tunascreen_service.dispatch_action(
                "klipper:7125", "run_macro", {"macro": "SAFE_MACRO\nM112"}
            )

    async def test_klipper_macros_are_exposed_only_for_supported_machine(self, monkeypatch):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "online",
            "data": {"extruder": {}, "heater_bed": {}}, "job": {},
        }])
        monkeypatch.setattr(
            klipper_service,
            "get_macros",
            lambda port: [{"name": "PURGE", "description": "Purga"}],
        )

        assert await tunascreen_service.get_machine_macros("klipper:7125") == [
            {"name": "PURGE", "description": "Purga"}
        ]

    async def test_invalid_move_params_are_rejected(self, monkeypatch):
        monkeypatch.setattr(klipper_service, "get_all_printers_status", lambda host=None: [{
            "name": "ET4-AC", "port": 7125, "status": "online",
            "data": {}, "job": {},
        }])
        with pytest.raises(ValueError, match="Eje inválido"):
            await tunascreen_service.dispatch_action(
                "klipper:7125",
                "move",
                {"axis": "A", "distance": 5},
            )

    async def test_unknown_machine_rejected(self):
        with pytest.raises(ValueError, match="no encontrada"):
            await tunascreen_service.dispatch_action("klipper:9999", "pause", {})


class TestWebSocket:
    def test_rejects_missing_token(self, client):
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/tunascreen"):
                pass

    def test_accepts_valid_token_and_sends_initial_snapshot(self, client, as_admin):
        code = client.post("/api/tunascreen/pair/start").json()["code"]
        token = client.post(
            "/api/tunascreen/pair/confirm", json={"code": code, "device_name": "Tablet"}
        ).json()["token"]

        with client.websocket_connect(
            "/ws/tunascreen", headers={"Authorization": f"Bearer {token}"}
        ) as websocket:
            first_message = websocket.receive_json()
            assert first_message == {"type": "machines", "api_version": 1, "machines": []}


class TestContractMetadata:
    def test_info_exposes_contract_version(self, client):
        response = client.get("/api/tunascreen/info")
        assert response.status_code == 200
        assert response.json()["api_version"] == 1
        assert response.json()["websocket_path"] == "/ws/tunascreen"

    def test_config_requires_device_token(self, client):
        assert client.get("/api/tunascreen/config").status_code == 401
