import backend.api.bambu_printers as bambu_printers_api
import backend.services.bambu_service as bambu_service


def _fake_scan_network(devices):
    async def _scan(timeout=None):
        return devices
    return _scan


def _fake_validate(ok, error=None, error_code=None):
    def _validate(ip, serial, access_code, timeout=5.0):
        return {"ok": ok, "error": error, "error_code": error_code}
    return _validate


class TestBambuDiscover:
    def test_empty_discovery(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(bambu_printers_api, "scan_network", _fake_scan_network([]))
        response = client.post("/api/bambu/printers/discover")
        assert response.status_code == 200
        assert response.json() == {"devices": []}

    def test_device_detected_shape(self, client, as_admin, monkeypatch):
        device = {"serial": "01S00A123456789", "ip": "192.168.1.42", "name": "01S00A123456789", "model": ""}
        monkeypatch.setattr(bambu_printers_api, "scan_network", _fake_scan_network([device]))
        response = client.post("/api/bambu/printers/discover")
        assert response.status_code == 200
        assert response.json() == {"devices": [device]}


class TestBambuRegister:
    def test_register_success_and_does_not_leak_access_code(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", _fake_validate(True))
        response = client.post("/api/bambu/printers", data={
            "ip": "192.168.1.42", "serial": "SN-OK-1", "access_code": "12345678",
            "name": "P2S Taller", "model": "P2S",
        })
        assert response.status_code == 200
        body = response.json()
        assert body["serial"] == "SN-OK-1"
        assert "access_code" not in body

        entries = bambu_service._load_registry()
        assert any(e["serial"] == "SN-OK-1" and e["name"] == "P2S Taller" for e in entries)

    def test_wrong_credential_returns_400_and_does_not_save(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(
            bambu_service, "_validate_credentials_sync",
            _fake_validate(False, "Access code rechazado (reason_code=5)", "CREDENTIAL_REJECTED"),
        )
        response = client.post("/api/bambu/printers", data={
            "ip": "192.168.1.42", "serial": "SN-BAD-CRED", "access_code": "wrong", "name": "N",
        })
        assert response.status_code == 400
        assert response.json()["error_code"] == "CREDENTIAL_REJECTED"
        assert not any(e["serial"] == "SN-BAD-CRED" for e in bambu_service._load_registry())

    def test_timeout_returns_400_and_does_not_save(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(
            bambu_service, "_validate_credentials_sync",
            _fake_validate(False, "Tiempo de espera agotado conectando con la impresora", "CONNECTION_FAILED"),
        )
        response = client.post("/api/bambu/printers", data={
            "ip": "192.168.1.99", "serial": "SN-TIMEOUT", "access_code": "x", "name": "N",
        })
        assert response.status_code == 400
        assert response.json()["error_code"] == "CONNECTION_FAILED"
        assert not any(e["serial"] == "SN-TIMEOUT" for e in bambu_service._load_registry())

    def test_requires_admin(self, client, as_operator, monkeypatch):
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", _fake_validate(True))
        response = client.post("/api/bambu/printers", data={
            "ip": "192.168.1.42", "serial": "SN-NOPERM", "access_code": "x", "name": "N",
        })
        assert response.status_code == 403
        assert not any(e["serial"] == "SN-NOPERM" for e in bambu_service._load_registry())

    def test_invalid_ip_rejected_before_touching_network(self, client, as_admin, monkeypatch):
        called = False

        def _should_not_be_called(*args, **kwargs):
            nonlocal called
            called = True
            return {"ok": True, "error": None, "error_code": None}

        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", _should_not_be_called)
        response = client.post("/api/bambu/printers", data={
            "ip": "not an ip!", "serial": "SN-BADIP", "access_code": "x", "name": "N",
        })
        assert response.status_code == 400
        assert called is False

    def test_malicious_name_rejected(self, client, as_admin):
        response = client.post("/api/bambu/printers", data={
            "ip": "192.168.1.42", "serial": "SN-BADNAME", "access_code": "x", "name": "bad\x00name",
        })
        assert response.status_code == 400

    def test_duplicate_registration_updates_in_place(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", _fake_validate(True))
        client.post("/api/bambu/printers", data={
            "ip": "192.168.1.42", "serial": "SN-DUP", "access_code": "x", "name": "Old Name",
        })
        client.post("/api/bambu/printers", data={
            "ip": "192.168.1.43", "serial": "SN-DUP", "access_code": "x", "name": "New Name",
        })
        entries = [e for e in bambu_service._load_registry() if e["serial"] == "SN-DUP"]
        assert len(entries) == 1
        assert entries[0]["name"] == "New Name"
        assert entries[0]["ip"] == "192.168.1.43"


class TestBambuUnregister:
    def test_unregister_removes_entry(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", _fake_validate(True))
        client.post("/api/bambu/printers", data={
            "ip": "192.168.1.42", "serial": "SN-DEL", "access_code": "x", "name": "N",
        })
        response = client.delete("/api/bambu/printers/SN-DEL")
        assert response.status_code == 200
        assert not any(e["serial"] == "SN-DEL" for e in bambu_service._load_registry())

    def test_unregister_requires_admin(self, client, as_operator):
        response = client.delete("/api/bambu/printers/SN-WHATEVER")
        assert response.status_code == 403

    def test_unregister_unknown_returns_404(self, client, as_admin):
        response = client.delete("/api/bambu/printers/SN-NEVER-EXISTED")
        assert response.status_code == 404


class TestBambuListingAndOfflineState:
    def test_registered_printer_survives_as_offline_when_unreachable(self, client, as_admin, monkeypatch):
        # No se intenta una conexión MQTT real en el test -- _ensure_client
        # queda de no-op, y _connected/_status_cache arrancan vacíos para un
        # serial nuevo, que es exactamente el estado real de "recién
        # registrada, todavía sin señal de vida".
        monkeypatch.setattr(bambu_service, "_ensure_client", lambda *a, **k: None)
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", _fake_validate(True))
        client.post("/api/bambu/printers", data={
            "ip": "192.168.1.200", "serial": "SN-OFFLINE", "access_code": "x", "name": "Fuera de línea",
        })
        response = client.get("/api/bambu/printers")
        assert response.status_code == 200
        printer = next(p for p in response.json()["printers"] if p["id"] == "SN-OFFLINE")
        assert printer["online"] is False
        assert printer["status"] == "offline"
        # Sigue registrada aunque esté offline -- no se pierde el registro.
        assert any(e["serial"] == "SN-OFFLINE" for e in bambu_service._load_registry())


class TestBambuOtherBrandsUnaffected:
    def test_registering_bambu_does_not_touch_other_brands_registry(self, client, as_admin, monkeypatch, tmp_path):
        import backend.services.elegoo_service as elegoo_service
        import backend.services.flashforge_service as flashforge_service

        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", _fake_validate(True))
        client.post("/api/bambu/printers", data={
            "ip": "192.168.1.42", "serial": "SN-ISOLATION", "access_code": "x", "name": "N",
        })
        assert elegoo_service._load_registry() == []
        assert flashforge_service._load_registry() == []
