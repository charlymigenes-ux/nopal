import asyncio
import json

import pytest

import backend.api.elegoo_printers as elegoo_printers_api
import backend.services.elegoo_service as elegoo_service


def _fake_scan_network(devices):
    async def _scan(timeout=None):
        return devices
    return _scan


def _fake_verify(ok, error=None, confirmed_id=False):
    async def _verify(ip, mainboard_id, timeout=4.0):
        return {"ok": ok, "error": error, "confirmed_id": confirmed_id}
    return _verify


class _FakeWSConnection:
    def __init__(self, messages, hang=False):
        self._messages = list(messages)
        self._hang = hang

    async def recv(self):
        if self._messages:
            return self._messages.pop(0)
        if self._hang:
            await asyncio.sleep(100)
        raise asyncio.TimeoutError()


class _FakeWSConnect:
    """Reemplaza websockets.connect(...) -- se usa como `async with
    websockets.connect(...) as ws:` en _verify_connection, así que hace
    falta un objeto que sea tanto invocable como context manager async."""

    def __init__(self, messages=(), hang=False, raise_on_enter=None):
        self._messages = messages
        self._hang = hang
        self._raise_on_enter = raise_on_enter

    def __call__(self, uri, open_timeout=None, ping_interval=None):
        return self

    async def __aenter__(self):
        if self._raise_on_enter is not None:
            raise self._raise_on_enter
        return _FakeWSConnection(self._messages, hang=self._hang)

    async def __aexit__(self, exc_type, exc, tb):
        return False


class TestVerifyConnectionUnit:
    """Cobertura directa de _verify_connection (código nuevo agregado para
    cerrar el hueco de seguridad de Elegoo: antes register_printer guardaba
    sin verificar nada)."""

    async def test_ok_with_confirmed_id_when_topic_matches(self, monkeypatch):
        message = json.dumps({"Topic": "sdcp/status/MB-REAL-1", "Status": {}})
        monkeypatch.setattr(elegoo_service.websockets, "connect", _FakeWSConnect(messages=[message]))
        result = await elegoo_service._verify_connection("192.168.1.55", "MB-REAL-1", timeout=1.0)
        assert result["ok"] is True
        assert result["confirmed_id"] is True

    async def test_ok_but_not_confirmed_when_topic_does_not_match(self, monkeypatch):
        message = json.dumps({"Topic": "sdcp/status/OTHER-BOARD", "Status": {}})
        monkeypatch.setattr(elegoo_service.websockets, "connect", _FakeWSConnect(messages=[message]))
        result = await elegoo_service._verify_connection("192.168.1.55", "MB-REAL-1", timeout=1.0)
        assert result["ok"] is True
        assert result["confirmed_id"] is False

    async def test_incomplete_response_times_out(self, monkeypatch):
        # La impresora "conecta" el socket pero nunca manda un mensaje de
        # status/attributes -- no debe quedar colgado, ni marcarse ok.
        monkeypatch.setattr(elegoo_service.websockets, "connect", _FakeWSConnect(hang=True))
        result = await elegoo_service._verify_connection("192.168.1.55", "MB-REAL-1", timeout=0.05)
        assert result["ok"] is False
        assert "no envió estado" in result["error"]

    async def test_unreachable_ip_fails(self, monkeypatch):
        monkeypatch.setattr(elegoo_service.websockets, "connect", _FakeWSConnect(raise_on_enter=OSError("Connection refused")))
        result = await elegoo_service._verify_connection("192.168.1.250", "MB-REAL-1", timeout=1.0)
        assert result["ok"] is False
        assert "No se pudo conectar" in result["error"]


class TestElegooDiscover:
    def test_empty_discovery(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(elegoo_printers_api, "scan_network", _fake_scan_network([]))
        response = client.post("/api/elegoo/printers/discover")
        assert response.status_code == 200
        assert response.json() == {"devices": []}

    def test_device_detected_shape(self, client, as_admin, monkeypatch):
        device = {"mainboard_id": "42:59:AB:CD:EF:12", "ip": "192.168.1.55", "name": "Neptune 4 Pro", "model": "Neptune 4 Pro"}
        monkeypatch.setattr(elegoo_printers_api, "scan_network", _fake_scan_network([device]))
        response = client.post("/api/elegoo/printers/discover")
        assert response.status_code == 200
        assert response.json() == {"devices": [device]}


class TestElegooRegister:
    def test_register_success(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_verify(True, confirmed_id=True))
        response = client.post("/api/elegoo/printers", data={
            "ip": "192.168.1.55", "mainboard_id": "MB-OK-1", "name": "Neptune Taller", "model": "Neptune 4 Pro",
        })
        assert response.status_code == 200
        assert response.json()["mainboard_id"] == "MB-OK-1"
        assert any(e["mainboard_id"] == "MB-OK-1" for e in elegoo_service._load_registry())

    def test_unreachable_printer_returns_400_and_does_not_save(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_verify(False, "No se pudo conectar a 192.168.1.250:3030: timed out"))
        response = client.post("/api/elegoo/printers", data={
            "ip": "192.168.1.250", "mainboard_id": "MB-UNREACHABLE", "name": "N",
        })
        assert response.status_code == 400
        assert not any(e["mainboard_id"] == "MB-UNREACHABLE" for e in elegoo_service._load_registry())

    def test_requires_admin(self, client, as_operator, monkeypatch):
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_verify(True))
        response = client.post("/api/elegoo/printers", data={
            "ip": "192.168.1.55", "mainboard_id": "MB-NOPERM", "name": "N",
        })
        assert response.status_code == 403

    def test_invalid_ip_rejected_before_touching_network(self, client, as_admin, monkeypatch):
        called = False

        async def _should_not_be_called(*args, **kwargs):
            nonlocal called
            called = True
            return {"ok": True, "confirmed_id": True}

        monkeypatch.setattr(elegoo_service, "_verify_connection", _should_not_be_called)
        response = client.post("/api/elegoo/printers", data={
            "ip": "'; DROP TABLE printers;--", "mainboard_id": "MB-INJECT", "name": "N",
        })
        assert response.status_code == 400
        assert called is False

    def test_malicious_name_rejected(self, client, as_admin):
        response = client.post("/api/elegoo/printers", data={
            "ip": "192.168.1.55", "mainboard_id": "MB-BADNAME", "name": "bad\x00name",
        })
        assert response.status_code == 400

    def test_duplicate_registration_updates_in_place(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_verify(True))
        client.post("/api/elegoo/printers", data={"ip": "192.168.1.55", "mainboard_id": "MB-DUP", "name": "Old"})
        client.post("/api/elegoo/printers", data={"ip": "192.168.1.56", "mainboard_id": "MB-DUP", "name": "New"})
        entries = [e for e in elegoo_service._load_registry() if e["mainboard_id"] == "MB-DUP"]
        assert len(entries) == 1
        assert entries[0]["name"] == "New"


class TestElegooUnregister:
    def test_unregister_removes_entry(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_verify(True))
        client.post("/api/elegoo/printers", data={"ip": "192.168.1.55", "mainboard_id": "MB-DEL", "name": "N"})
        response = client.delete("/api/elegoo/printers/MB-DEL")
        assert response.status_code == 200
        assert not any(e["mainboard_id"] == "MB-DEL" for e in elegoo_service._load_registry())

    def test_unregister_requires_admin(self, client, as_operator):
        response = client.delete("/api/elegoo/printers/MB-WHATEVER")
        assert response.status_code == 403

    def test_unregister_unknown_returns_404(self, client, as_admin):
        response = client.delete("/api/elegoo/printers/MB-NEVER-EXISTED")
        assert response.status_code == 404


class TestElegooListingAndOfflineState:
    def test_registered_printer_survives_as_offline_when_unreachable(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(elegoo_service, "_ensure_listener", lambda *a, **k: None)
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_verify(True))
        client.post("/api/elegoo/printers", data={"ip": "192.168.1.200", "mainboard_id": "MB-OFFLINE", "name": "Fuera de línea"})
        response = client.get("/api/elegoo/printers")
        assert response.status_code == 200
        printer = next(p for p in response.json()["printers"] if p["id"] == "MB-OFFLINE")
        assert printer["online"] is False
        assert printer["status"] == "offline"
        assert any(e["mainboard_id"] == "MB-OFFLINE" for e in elegoo_service._load_registry())


class TestElegooOtherBrandsUnaffected:
    def test_registering_elegoo_does_not_touch_other_brands_registry(self, client, as_admin, monkeypatch):
        import backend.services.bambu_service as bambu_service
        import backend.services.flashforge_service as flashforge_service

        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_verify(True))
        client.post("/api/elegoo/printers", data={"ip": "192.168.1.55", "mainboard_id": "MB-ISOLATION", "name": "N"})
        assert bambu_service._load_registry() == []
        assert flashforge_service._load_registry() == []
