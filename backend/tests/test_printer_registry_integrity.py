import asyncio

import backend.services.bambu_service as bambu_service
import backend.services.elegoo_service as elegoo_service
import backend.services.flashforge_service as flashforge_service


async def _fake_elegoo_verify(ip, mainboard_id, timeout=4.0):
    return {"ok": True, "confirmed_id": True}


class TestRegistryIntegrityBambu:
    def test_adding_second_printer_preserves_first(self, monkeypatch):
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", lambda *a, **k: {"ok": True, "error": None, "error_code": None})
        asyncio.run(bambu_service.register_printer("192.168.1.10", "SN-A", "x", "Printer A"))
        asyncio.run(bambu_service.register_printer("192.168.1.11", "SN-B", "x", "Printer B"))
        serials = {e["serial"] for e in bambu_service._load_registry()}
        assert serials == {"SN-A", "SN-B"}


class TestRegistryIntegrityElegoo:
    def test_adding_second_printer_preserves_first(self, monkeypatch):
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_elegoo_verify)
        asyncio.run(elegoo_service.register_printer("192.168.1.20", "MB-A", "Printer A"))
        asyncio.run(elegoo_service.register_printer("192.168.1.21", "MB-B", "Printer B"))
        ids = {e["mainboard_id"] for e in elegoo_service._load_registry()}
        assert ids == {"MB-A", "MB-B"}


class TestRegistryIntegrityFlashforge:
    def test_adding_second_printer_preserves_first(self, monkeypatch):
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", lambda self: {"code": 0, "detail": {}})
        flashforge_service.register_printer("192.168.1.30", "FF-A", "0", "Printer A")
        flashforge_service.register_printer("192.168.1.31", "FF-B", "0", "Printer B")
        serials = {e["serial_number"] for e in flashforge_service._load_registry()}
        assert serials == {"FF-A", "FF-B"}


class TestRegistryIntegrityCrossBrand:
    """El upsert de cada servicio (`entries = [e for e in _load_registry()
    if e.get(idField) != value]; entries.append(entry)`) es copy-paste entre
    las 3 marcas -- estos tests cubren el comportamiento que ningún test
    por-marca ejercita de forma natural: que los 3 archivos de registro son
    completamente independientes entre sí."""

    def test_registries_are_fully_independent_files(self, monkeypatch):
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", lambda *a, **k: {"ok": True, "error": None, "error_code": None})
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_elegoo_verify)
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", lambda self: {"code": 0, "detail": {}})

        asyncio.run(bambu_service.register_printer("192.168.1.10", "SN-X", "x", "Bambu X"))
        asyncio.run(elegoo_service.register_printer("192.168.1.20", "MB-X", "Elegoo X"))
        flashforge_service.register_printer("192.168.1.30", "FF-X", "0", "FlashForge X")

        assert len(bambu_service._load_registry()) == 1
        assert len(elegoo_service._load_registry()) == 1
        assert len(flashforge_service._load_registry()) == 1
        assert bambu_service.REGISTRY_PATH != elegoo_service.REGISTRY_PATH
        assert elegoo_service.REGISTRY_PATH != flashforge_service.REGISTRY_PATH

    def test_removing_one_brand_does_not_affect_others(self, monkeypatch):
        monkeypatch.setattr(bambu_service, "_validate_credentials_sync", lambda *a, **k: {"ok": True, "error": None, "error_code": None})
        monkeypatch.setattr(elegoo_service, "_verify_connection", _fake_elegoo_verify)
        monkeypatch.setattr(flashforge_service.FlashForgeClient, "check_auth", lambda self: {"code": 0, "detail": {}})

        asyncio.run(bambu_service.register_printer("192.168.1.10", "SN-Y", "x", "Bambu Y"))
        asyncio.run(elegoo_service.register_printer("192.168.1.20", "MB-Y", "Elegoo Y"))
        flashforge_service.register_printer("192.168.1.30", "FF-Y", "0", "FlashForge Y")

        bambu_service.unregister_printer("SN-Y")

        assert bambu_service._load_registry() == []
        assert len(elegoo_service._load_registry()) == 1
        assert len(flashforge_service._load_registry()) == 1
