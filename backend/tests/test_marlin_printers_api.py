import backend.api.marlin_printers as marlin_printers_api


def _mock_successful_probe(monkeypatch, baud=115200, firmware_info=None):
    async def fake_probe(device, baud_arg, timeout=3.0):
        return True

    async def fake_autobaud(device, bauds=(115200, 250000), timeout=3.0):
        return baud

    async def fake_firmware_info(device, baud_arg, timeout=4.0):
        return firmware_info

    monkeypatch.setattr(marlin_printers_api, "probe_marlin", fake_probe)
    monkeypatch.setattr(marlin_printers_api, "probe_marlin_autobaud", fake_autobaud)
    monkeypatch.setattr(marlin_printers_api, "probe_marlin_firmware_info", fake_firmware_info)


class TestProfilesEndpoint:
    def test_lists_hellbot_profile(self, client, as_admin):
        response = client.get("/api/marlin-printers/profiles")
        assert response.status_code == 200
        ids = [p["id"] for p in response.json()["profiles"]]
        assert "hellbot_magna2_300" in ids

    def test_requires_auth(self, client):
        response = client.get("/api/marlin-printers/profiles")
        assert response.status_code == 401


class TestUsbProbeIdentity:
    def test_returns_machine_type_for_automatic_name(self, client, as_admin, monkeypatch):
        firmware_info = {
            "FIRMWARE_NAME": "Marlin 2.1.2.7",
            "MACHINE_TYPE": "ANET ET4 PRO",
            "EXTRUDER_COUNT": "1",
        }
        _mock_successful_probe(monkeypatch, baud=250000, firmware_info=firmware_info)

        response = client.post(
            "/api/marlin-printers/usb-ports/test",
            data={"device": "/dev/ttyUSB2"},
        )

        assert response.status_code == 200
        assert response.json() == {
            "connected": True,
            "device": "/dev/ttyUSB2",
            "baud": 250000,
            "firmware_info": firmware_info,
        }


class TestPrintStartEndpoint:
    def test_accepts_library_section_and_starts_marlin_job(self, client, as_admin, monkeypatch, tmp_path):
        gcode_file = tmp_path / "ANET_ET4.gcode"
        gcode_file.write_text("G28\nG1 X10", encoding="utf-8")
        captured = {}

        def fake_safe_section_path(section, path):
            captured["section"] = section
            captured["path"] = path
            return str(gcode_file)

        def fake_start_print(device, gcode_text, filename=""):
            captured.update(device=device, gcode_text=gcode_text, filename=filename)
            return {"state": "running", "filename": filename}

        monkeypatch.setattr(marlin_printers_api, "safe_section_path", fake_safe_section_path)
        monkeypatch.setattr(marlin_printers_api, "start_print", fake_start_print)

        response = client.post(
            "/api/marlin-printers/print/start",
            data={
                "device": "/dev/ttyUSB2",
                "path": "ANET_ET4.gcode",
                "section": "model",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"state": "running", "filename": "ANET_ET4.gcode"}
        assert captured == {
            "section": "model",
            "path": "ANET_ET4.gcode",
            "device": "/dev/ttyUSB2",
            "gcode_text": "G28\nG1 X10",
            "filename": "ANET_ET4.gcode",
        }


class TestSdCardEndpoints:
    def test_lists_files_directly_from_marlin_sd(self, client, as_admin, monkeypatch):
        async def fake_list_sd_files(device):
            assert device == "/dev/ttyUSB2"
            return [{"name": "DONA.GC", "size": 9207543}]

        monkeypatch.setattr(marlin_printers_api, "list_sd_files", fake_list_sd_files)
        response = client.get(
            "/api/marlin-printers/sd/files",
            params={"device": "/dev/ttyUSB2"},
        )

        assert response.status_code == 200
        assert response.json() == {"files": [{"name": "DONA.GC", "size": 9207543}]}

    def test_starts_native_sd_file_without_local_path(self, client, as_admin, monkeypatch):
        async def fake_start_sd_print(device, filename):
            assert device == "/dev/ttyUSB2"
            assert filename == "DONA.GC"
            return {
                "filename": filename,
                "source": "sd",
                "state": "running",
                "current": 0,
                "total": 9207543,
                "error": None,
            }

        monkeypatch.setattr(marlin_printers_api, "start_sd_print", fake_start_sd_print)
        response = client.post(
            "/api/marlin-printers/sd/print/start",
            data={"device": "/dev/ttyUSB2", "filename": "DONA.GC"},
        )

        assert response.status_code == 200
        assert response.json()["source"] == "sd"
        assert response.json()["filename"] == "DONA.GC"


class TestMksWifiEndpoints:
    def test_discovers_modules(self, client, as_admin, monkeypatch):
        module = {
            "module_id": "ABC123",
            "ip": "192.168.1.44",
            "device": "tcp://192.168.1.44:8080",
            "transport": "mks_wifi",
        }
        monkeypatch.setattr(
            marlin_printers_api.mks_wifi_transport,
            "discover_mks_wifi",
            lambda: [module],
        )
        response = client.get("/api/marlin-printers/mks-wifi/discover")
        assert response.status_code == 200
        assert response.json()["modules"] == [module]

    def test_tcp_probe_returns_normalized_device(self, client, as_admin, monkeypatch):
        _mock_successful_probe(
            monkeypatch,
            firmware_info={"FIRMWARE_NAME": "Robin", "EXTRUDER_COUNT": "2"},
        )
        response = client.post(
            "/api/marlin-printers/mks-wifi/test",
            data={"host": "192.168.1.44", "port": 8080},
        )
        assert response.status_code == 200
        assert response.json() == {
            "connected": True,
            "device": "tcp://192.168.1.44:8080",
            "transport": "mks_wifi",
            "firmware_info": {"FIRMWARE_NAME": "Robin", "EXTRUDER_COUNT": "2"},
        }

    def test_rejects_invalid_tcp_host(self, client, as_admin):
        response = client.post(
            "/api/marlin-printers/mks-wifi/test",
            data={"host": "bad/host", "port": 8080},
        )
        assert response.status_code == 400


class TestRegisterWithProfile:
    def test_register_with_valid_profile_and_variant(self, client, as_admin, monkeypatch):
        _mock_successful_probe(monkeypatch, firmware_info={"FIRMWARE_NAME": "Marlin 2.1.2"})
        response = client.post(
            "/api/marlin-printers/registry",
            data={
                "device": "/dev/ttyUSB0",
                "name": "Hellbot Magna 2",
                "profile_id": "hellbot_magna2_300",
                "board_variant": "mks_robin_nano_v3",
                "extruder_count": 2,
            },
        )
        assert response.status_code == 200
        entry = response.json()
        assert entry["profile_id"] == "hellbot_magna2_300"
        assert entry["board_variant"] == "mks_robin_nano_v3"
        assert entry["extruder_count"] == 2
        assert entry["firmware_info"] == {"FIRMWARE_NAME": "Marlin 2.1.2"}

    def test_register_without_profile_still_works(self, client, as_admin, monkeypatch):
        """Una placa Marlin genérica, sin perfil -- tiene que seguir
        funcionando exactamente como antes de que existiera este concepto."""
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={"device": "/dev/ttyUSB0", "name": "Placa genérica"},
        )
        assert response.status_code == 200
        entry = response.json()
        assert entry["profile_id"] is None
        assert entry["board_variant"] is None
        assert entry["extruder_count"] is None

    def test_unknown_profile_rejected(self, client, as_admin, monkeypatch):
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={"device": "/dev/ttyUSB0", "name": "x", "profile_id": "no_existe"},
        )
        assert response.status_code == 400

    def test_invalid_board_variant_rejected(self, client, as_admin, monkeypatch):
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={
                "device": "/dev/ttyUSB0", "name": "x",
                "profile_id": "hellbot_magna2_300", "board_variant": "raspberry_pi_pico",
            },
        )
        assert response.status_code == 400

    def test_board_variant_without_profile_rejected(self, client, as_admin, monkeypatch):
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={"device": "/dev/ttyUSB0", "name": "x", "board_variant": "mks_robin_nano_v3"},
        )
        assert response.status_code == 400

    def test_extruder_count_out_of_range_rejected(self, client, as_admin, monkeypatch):
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={
                "device": "/dev/ttyUSB0", "name": "x",
                "profile_id": "hellbot_magna2_300", "extruder_count": 5,
            },
        )
        assert response.status_code == 400

    def test_extruder_count_without_profile_rejected(self, client, as_admin, monkeypatch):
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={"device": "/dev/ttyUSB0", "name": "x", "extruder_count": 1},
        )
        assert response.status_code == 400

    def test_re_registering_keeps_profile_when_omitted(self, client, as_admin, monkeypatch):
        """Re-registrar (ej. para cambiar el nombre) sin volver a mandar el
        perfil no debe borrarlo -- mismo criterio que firmware_info."""
        _mock_successful_probe(monkeypatch)
        client.post(
            "/api/marlin-printers/registry",
            data={
                "device": "/dev/ttyUSB0", "name": "Hellbot",
                "profile_id": "hellbot_magna2_300", "board_variant": "mks_robin_nano_v1_2",
                "extruder_count": 1,
            },
        )
        response = client.post(
            "/api/marlin-printers/registry",
            data={"device": "/dev/ttyUSB0", "name": "Hellbot renombrada"},
        )
        entry = response.json()
        assert entry["name"] == "Hellbot renombrada"
        assert entry["profile_id"] == "hellbot_magna2_300"
        assert entry["board_variant"] == "mks_robin_nano_v1_2"
        assert entry["extruder_count"] == 1

    def test_requires_admin(self, client, as_operator, monkeypatch):
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={"device": "/dev/ttyUSB0", "name": "x"},
        )
        assert response.status_code == 403

    def test_registers_mks_wifi_transport(self, client, as_admin, monkeypatch):
        _mock_successful_probe(
            monkeypatch,
            firmware_info={"FIRMWARE_NAME": "Robin", "EXTRUDER_COUNT": "2"},
        )
        response = client.post(
            "/api/marlin-printers/registry",
            data={
                "device": "tcp://192.168.1.44:8080",
                "name": "Hellbot WiFi",
                "transport": "mks_wifi",
                "profile_id": "hellbot_magna2_300",
                "board_variant": "mks_robin_nano_v3",
                "extruder_count": 2,
            },
        )
        assert response.status_code == 200
        entry = response.json()
        assert entry["transport"] == "mks_wifi"
        assert entry["device"] == "tcp://192.168.1.44:8080"
        assert entry["baud"] == 0
        assert entry["location"] is None

    def test_rejects_unknown_transport(self, client, as_admin, monkeypatch):
        _mock_successful_probe(monkeypatch)
        response = client.post(
            "/api/marlin-printers/registry",
            data={"device": "x", "name": "x", "transport": "bluetooth"},
        )
        assert response.status_code == 400
