from backend.services import printer_profiles


class TestListProfiles:
    def test_includes_hellbot_magna2_300(self):
        profiles = printer_profiles.list_profiles()
        ids = [p["id"] for p in profiles]
        assert "hellbot_magna2_300" in ids

    def test_each_entry_carries_its_own_id(self):
        for profile in printer_profiles.list_profiles():
            assert profile["id"] in printer_profiles.PRINTER_PROFILES

    def test_filters_by_machine_type(self):
        laser_profiles = printer_profiles.list_profiles(machine_type="laser")
        assert laser_profiles
        assert all(p["machine_type"] == "laser" for p in laser_profiles)
        assert "sculpfun_s30_pro" in [p["id"] for p in laser_profiles]

        cnc_profiles = printer_profiles.list_profiles(machine_type="cnc")
        assert cnc_profiles
        assert all(p["machine_type"] == "cnc" for p in cnc_profiles)
        assert "generic_cnc_3018" in [p["id"] for p in cnc_profiles]

        fdm_profiles = printer_profiles.list_profiles(machine_type="fdm")
        assert "hellbot_magna2_300" in [p["id"] for p in fdm_profiles]
        assert "bambulab_a1_mini" in [p["id"] for p in fdm_profiles]

    def test_every_profile_declares_a_nopal_brand(self):
        valid_brands = {"marlin", "klipper", "bambu", "flashforge", "laser"}
        for profile in printer_profiles.list_profiles():
            assert profile.get("nopal_brand") in valid_brands, profile["id"]


class TestGetProfile:
    def test_known_profile(self):
        profile = printer_profiles.get_profile("hellbot_magna2_300")
        assert profile["manufacturer"] == "Hellbot"
        assert profile["model"] == "Magna 2 300"
        assert profile["build_volume"] == {"x": 300, "y": 300, "z": 400}
        assert "mks_robin_nano_v1_2" in profile["board_variants"]
        assert "mks_robin_nano_v3" in profile["board_variants"]

    def test_unknown_profile_returns_none(self):
        assert printer_profiles.get_profile("does_not_exist") is None


class TestIsValidBoardVariant:
    def test_valid_variant(self):
        assert printer_profiles.is_valid_board_variant("hellbot_magna2_300", "mks_robin_nano_v1_2")
        assert printer_profiles.is_valid_board_variant("hellbot_magna2_300", "mks_robin_nano_v3")

    def test_invalid_variant(self):
        assert not printer_profiles.is_valid_board_variant("hellbot_magna2_300", "some_other_board")

    def test_unknown_profile(self):
        assert not printer_profiles.is_valid_board_variant("does_not_exist", "mks_robin_nano_v3")


class TestIsValidExtruderCount:
    def test_within_range(self):
        assert printer_profiles.is_valid_extruder_count("hellbot_magna2_300", 1)
        assert printer_profiles.is_valid_extruder_count("hellbot_magna2_300", 2)

    def test_out_of_range(self):
        assert not printer_profiles.is_valid_extruder_count("hellbot_magna2_300", 0)
        assert not printer_profiles.is_valid_extruder_count("hellbot_magna2_300", 3)

    def test_unknown_profile(self):
        assert not printer_profiles.is_valid_extruder_count("does_not_exist", 1)
