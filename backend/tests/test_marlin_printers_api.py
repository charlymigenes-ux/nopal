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
