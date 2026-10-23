from backend.services import dashboard_service


class TestEstimatedActivePowerWatts:
    def test_none_sin_cotizador_instalado(self, monkeypatch):
        monkeypatch.setattr(dashboard_service, "get_loaded_plugin_module", lambda *a: None)
        assert dashboard_service._estimated_active_power_watts(["printer"]) is None

    def test_none_sin_ninguna_potencia_configurada(self, monkeypatch):
        class _Modulo:
            @staticmethod
            def get_settings():
                return {"machine_watts_default": {"printer": 0, "laser": 0}}

        monkeypatch.setattr(dashboard_service, "get_loaded_plugin_module", lambda *a: _Modulo)
        assert dashboard_service._estimated_active_power_watts(["printer"]) is None

    def test_cero_watts_si_esta_configurado_pero_nada_corre(self, monkeypatch):
        class _Modulo:
            @staticmethod
            def get_settings():
                return {"machine_watts_default": {"printer": 150, "laser": 400}}

        monkeypatch.setattr(dashboard_service, "get_loaded_plugin_module", lambda *a: _Modulo)
        # Ninguna máquina en active_job_kinds -- 0, pero no None: "sí está
        # configurado, ahora mismo no hay nada corriendo".
        assert dashboard_service._estimated_active_power_watts([]) == 0

    def test_suma_watts_de_maquinas_activas(self, monkeypatch):
        class _Modulo:
            @staticmethod
            def get_settings():
                return {"machine_watts_default": {"printer": 150, "laser": 400}}

        monkeypatch.setattr(dashboard_service, "get_loaded_plugin_module", lambda *a: _Modulo)
        assert dashboard_service._estimated_active_power_watts(["printer", "printer", "laser"]) == 700


class TestGetAmbientTemperature:
    async def test_none_sin_plugin_instalado(self, monkeypatch):
        monkeypatch.setattr(dashboard_service, "get_loaded_plugin_module", lambda *a: None)
        assert await dashboard_service._get_ambient_temperature_c() is None

    async def test_devuelve_lo_que_reporta_el_plugin(self, monkeypatch):
        class _Modulo:
            @staticmethod
            async def get_ambient_temperature_c():
                return 24.5

        monkeypatch.setattr(dashboard_service, "get_loaded_plugin_module", lambda *a: _Modulo)
        assert await dashboard_service._get_ambient_temperature_c() == 24.5

    async def test_none_si_el_plugin_no_tiene_lectura_valida(self, monkeypatch):
        class _Modulo:
            @staticmethod
            async def get_ambient_temperature_c():
                return None

        monkeypatch.setattr(dashboard_service, "get_loaded_plugin_module", lambda *a: _Modulo)
        assert await dashboard_service._get_ambient_temperature_c() is None


def test_el_resumen_trae_el_espacio_libre_real_del_disco(client, as_admin):
    """disk_percent es lo que ocupa uploads/ (casi siempre ~0%): la pantalla de
    carga necesita el espacio libre para decir qué tan lleno está el disco."""
    response = client.get("/api/dashboard/summary")
    assert response.status_code == 200
    host = response.json()["host"]
    assert isinstance(host["disk_free_bytes"], int)
    assert 0 < host["disk_free_bytes"] <= host["disk_total_bytes"]
