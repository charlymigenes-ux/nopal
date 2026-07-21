from backend.services import marlin_printer_service


class TestProbeMarlinAutobaud:
    async def test_returns_first_baud_that_responds(self, monkeypatch):
        calls = []

        async def fake_probe(device, baud, timeout=3.0):
            calls.append(baud)
            return baud == 250000

        monkeypatch.setattr(marlin_printer_service, "probe_marlin", fake_probe)
        result = await marlin_printer_service.probe_marlin_autobaud("/dev/ttyUSB0")
        assert result == 250000
        # Prueba en el orden declarado (115200 primero) y se detiene apenas
        # encuentra uno que responde -- no sigue probando bauds de más.
        assert calls == [115200, 250000]

    async def test_stops_at_first_success_without_trying_the_rest(self, monkeypatch):
        calls = []

        async def fake_probe(device, baud, timeout=3.0):
            calls.append(baud)
            return baud == 115200

        monkeypatch.setattr(marlin_printer_service, "probe_marlin", fake_probe)
        result = await marlin_printer_service.probe_marlin_autobaud("/dev/ttyUSB0")
        assert result == 115200
        assert calls == [115200]

    async def test_returns_none_if_nothing_responds(self, monkeypatch):
        async def fake_probe(device, baud, timeout=3.0):
            return False

        monkeypatch.setattr(marlin_printer_service, "probe_marlin", fake_probe)
        result = await marlin_printer_service.probe_marlin_autobaud("/dev/ttyUSB0")
        assert result is None

    async def test_respects_custom_baud_list(self, monkeypatch):
        calls = []

        async def fake_probe(device, baud, timeout=3.0):
            calls.append(baud)
            return False

        monkeypatch.setattr(marlin_printer_service, "probe_marlin", fake_probe)
        await marlin_printer_service.probe_marlin_autobaud("/dev/ttyUSB0", bauds=(9600, 57600))
        assert calls == [9600, 57600]


class TestRegisterPrinterFirmwareInfo:
    def test_persists_firmware_info(self, monkeypatch, tmp_path):
        registry_path = str(tmp_path / "marlin_printer_registry.json")
        monkeypatch.setattr(marlin_printer_service, "REGISTRY_PATH", registry_path)
        monkeypatch.setattr(
            "backend.services.laser_service._location_for_device", lambda device: None
        )

        info = {"FIRMWARE_NAME": "Marlin 2.1.2", "EXTRUDER_COUNT": "2"}
        entry = marlin_printer_service.register_printer(
            "/dev/ttyUSB0", "Hellbot Magna 2", baud=250000, verified_marlin=True, firmware_info=info,
        )
        assert entry["firmware_info"] == info

        reloaded = marlin_printer_service.get_registered_printers()
        assert reloaded[0]["firmware_info"] == info

    def test_firmware_info_defaults_to_none(self, monkeypatch, tmp_path):
        registry_path = str(tmp_path / "marlin_printer_registry.json")
        monkeypatch.setattr(marlin_printer_service, "REGISTRY_PATH", registry_path)
        monkeypatch.setattr(
            "backend.services.laser_service._location_for_device", lambda device: None
        )

        entry = marlin_printer_service.register_printer("/dev/ttyUSB0", "Placa genérica")
        assert entry["firmware_info"] is None

    def test_re_registering_without_firmware_info_keeps_previous(self, monkeypatch, tmp_path):
        registry_path = str(tmp_path / "marlin_printer_registry.json")
        monkeypatch.setattr(marlin_printer_service, "REGISTRY_PATH", registry_path)
        monkeypatch.setattr(
            "backend.services.laser_service._location_for_device", lambda device: None
        )

        marlin_printer_service.register_printer(
            "/dev/ttyUSB0", "Hellbot", firmware_info={"FIRMWARE_NAME": "Marlin 2.1.2"},
        )
        entry = marlin_printer_service.register_printer("/dev/ttyUSB0", "Hellbot renombrada")
        assert entry["firmware_info"] == {"FIRMWARE_NAME": "Marlin 2.1.2"}


class TestSetHeaterTargetDualExtruder:
    def test_single_extruder_unchanged(self, monkeypatch):
        sent = []
        monkeypatch.setattr(marlin_printer_service, "_send_raw", lambda device, cmd: sent.append(cmd) or True)
        marlin_printer_service.set_heater_target("/dev/ttyUSB0", "extruder", 210)
        assert sent == ["M104 S210"]

    def test_bed_unchanged(self, monkeypatch):
        sent = []
        monkeypatch.setattr(marlin_printer_service, "_send_raw", lambda device, cmd: sent.append(cmd) or True)
        marlin_printer_service.set_heater_target("/dev/ttyUSB0", "heater_bed", 60)
        assert sent == ["M140 S60"]

    def test_extruder0_selects_tool_0(self, monkeypatch):
        """Bug real: antes cualquier heater que no fuera exactamente
        "extruder" caía en la rama de M140 (cama) -- "extruder0" habría
        mandado M140 en vez de M104 T0."""
        sent = []
        monkeypatch.setattr(marlin_printer_service, "_send_raw", lambda device, cmd: sent.append(cmd) or True)
        marlin_printer_service.set_heater_target("/dev/ttyUSB0", "extruder0", 215)
        assert sent == ["M104 T0 S215"]

    def test_extruder1_selects_tool_1(self, monkeypatch):
        sent = []
        monkeypatch.setattr(marlin_printer_service, "_send_raw", lambda device, cmd: sent.append(cmd) or True)
        marlin_printer_service.set_heater_target("/dev/ttyUSB0", "extruder1", 195)
        assert sent == ["M104 T1 S195"]

    def test_unknown_heater_rejected(self, monkeypatch):
        sent = []
        monkeypatch.setattr(marlin_printer_service, "_send_raw", lambda device, cmd: sent.append(cmd) or True)
        result = marlin_printer_service.set_heater_target("/dev/ttyUSB0", "chamber", 40)
        assert result is False
        assert sent == []


class TestTemperatureSnapshotDualExtruder:
    async def test_labels_per_extruder(self, monkeypatch):
        async def fake_get_temperatures(transport, timeout=4.0):
            return {
                "extruder0": {"current": 210.0, "target": 215.0},
                "extruder1": {"current": 190.0, "target": 195.0},
                "heater_bed": {"current": 60.0, "target": 60.0},
            }

        monkeypatch.setattr(marlin_printer_service.marlin_driver, "get_temperatures", fake_get_temperatures)
        monkeypatch.setattr(marlin_printer_service, "_transport_for", lambda device: object())

        snapshot = await marlin_printer_service.get_temperature_snapshot("/dev/ttyUSB0")
        by_key = {s["key"]: s["label"] for s in snapshot["sensors"]}
        assert by_key["extruder0"] == "Extruder 0"
        assert by_key["extruder1"] == "Extruder 1"
        assert by_key["heater_bed"] == "Heater Bed"

    async def test_single_extruder_label_unchanged(self, monkeypatch):
        async def fake_get_temperatures(transport, timeout=4.0):
            return {"extruder": {"current": 200.0, "target": 205.0}}

        monkeypatch.setattr(marlin_printer_service.marlin_driver, "get_temperatures", fake_get_temperatures)
        monkeypatch.setattr(marlin_printer_service, "_transport_for", lambda device: object())

        snapshot = await marlin_printer_service.get_temperature_snapshot("/dev/ttyUSB0")
        assert snapshot["sensors"][0]["label"] == "Extruder"
