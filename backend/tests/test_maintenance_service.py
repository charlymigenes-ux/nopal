import time

import pytest

from backend.services import ai_config_service, maintenance_service
from backend.services.ai_provider import AIProviderError


@pytest.fixture(autouse=True)
def reset_cache():
    maintenance_service._cache["result"] = None
    maintenance_service._cache["computed_at"] = None
    maintenance_service._refresh_in_progress = False
    yield
    maintenance_service._cache["result"] = None
    maintenance_service._cache["computed_at"] = None
    maintenance_service._refresh_in_progress = False


class TestGetCachedSuggestion:
    def test_none_si_ia_desactivada(self, monkeypatch):
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": False})
        maintenance_service._cache["result"] = "algo"
        assert maintenance_service.get_cached_suggestion() is None

    def test_devuelve_el_cache_si_ia_activada(self, monkeypatch):
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})
        maintenance_service._cache["result"] = "Revisar nopal-i3."
        assert maintenance_service.get_cached_suggestion() == "Revisar nopal-i3."


class TestMaybeRefresh:
    async def test_no_dispara_nada_si_ia_desactivada(self, monkeypatch):
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": False})
        called = []
        monkeypatch.setattr(maintenance_service.asyncio, "create_task", lambda coro: called.append(coro))
        await maintenance_service.maybe_refresh([], [], 0, 0)
        assert called == []

    async def test_no_dispara_si_el_cache_todavia_esta_fresco(self, monkeypatch):
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})
        maintenance_service._cache["computed_at"] = time.monotonic()
        called = []
        monkeypatch.setattr(maintenance_service.asyncio, "create_task", lambda coro: called.append(coro))
        await maintenance_service.maybe_refresh([], [], 0, 0)
        assert called == []

    async def test_no_dispara_dos_veces_en_paralelo(self, monkeypatch):
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})
        maintenance_service._cache["computed_at"] = None
        maintenance_service._refresh_in_progress = True
        called = []
        monkeypatch.setattr(maintenance_service.asyncio, "create_task", lambda coro: called.append(coro))
        await maintenance_service.maybe_refresh([], [], 0, 0)
        assert called == []

    async def test_dispara_un_refresco_si_nunca_se_calculo(self, monkeypatch):
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})
        maintenance_service._cache["computed_at"] = None
        captured = {}

        def fake_create_task(coro):
            captured["coro"] = coro

        monkeypatch.setattr(maintenance_service.asyncio, "create_task", fake_create_task)
        await maintenance_service.maybe_refresh([], [], 0, 0)

        assert "coro" in captured
        assert maintenance_service._refresh_in_progress is True
        await captured["coro"]  # limpia la corrutina creada (evita el warning de "never awaited")

    async def test_dispara_un_refresco_si_vencio_el_ttl(self, monkeypatch):
        # Regresión: computed_at NO puede compararse contra 0.0 como
        # "nunca calculado" -- time.monotonic() no arranca en cero, así que
        # un caché "viejo" puede parecer más fresco que el TTL en una
        # máquina con horas de uptime. Acá se prueba con un timestamp
        # monotonic real, bien en el pasado, no con el centinela None.
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})
        maintenance_service._cache["computed_at"] = time.monotonic() - maintenance_service.MAINTENANCE_CACHE_TTL_SECONDS - 1
        captured = {}

        def fake_create_task(coro):
            captured["coro"] = coro

        monkeypatch.setattr(maintenance_service.asyncio, "create_task", fake_create_task)
        await maintenance_service.maybe_refresh([], [], 0, 0)

        assert "coro" in captured
        await captured["coro"]


class TestAskAiForCandidate:
    async def test_none_si_la_ia_no_encuentra_senal(self, monkeypatch):
        class _FakeProvider:
            async def chat(self, messages):
                return {"content": "Sin datos suficientes."}

        monkeypatch.setattr(maintenance_service, "get_provider", lambda config: _FakeProvider())
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})

        result = await maintenance_service._ask_ai_for_candidate([], [], 5, 5)
        assert result is None

    async def test_devuelve_la_respuesta_de_la_ia(self, monkeypatch):
        respuesta = "nopal-i3: 3 alertas de desconexión recientes, revisar cableado."

        class _FakeProvider:
            async def chat(self, messages):
                return {"content": respuesta}

        monkeypatch.setattr(maintenance_service, "get_provider", lambda config: _FakeProvider())
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})

        result = await maintenance_service._ask_ai_for_candidate(
            [{"severity": "error", "message": "nopal-i3 desconectada"}], [], 4, 5,
        )
        assert result == respuesta

    async def test_trunca_respuestas_largas(self, monkeypatch):
        class _FakeProvider:
            async def chat(self, messages):
                return {"content": "x" * 500}

        monkeypatch.setattr(maintenance_service, "get_provider", lambda config: _FakeProvider())
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})

        result = await maintenance_service._ask_ai_for_candidate([], [], 5, 5)
        assert len(result) <= 240
        assert result.endswith("…")


class TestRefreshCache:
    async def test_guarda_el_resultado_y_limpia_el_flag(self, monkeypatch):
        class _FakeProvider:
            async def chat(self, messages):
                return {"content": "Revisar nopal-i3."}

        monkeypatch.setattr(maintenance_service, "get_provider", lambda config: _FakeProvider())
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})
        maintenance_service._refresh_in_progress = True

        await maintenance_service._refresh_cache([], [], 5, 5)

        assert maintenance_service._cache["result"] == "Revisar nopal-i3."
        assert maintenance_service._refresh_in_progress is False

    async def test_falla_de_la_ia_no_rompe_y_conserva_el_valor_anterior(self, monkeypatch):
        class _FakeProvider:
            async def chat(self, messages):
                raise AIProviderError("no responde")

        monkeypatch.setattr(maintenance_service, "get_provider", lambda config: _FakeProvider())
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"enabled": True})
        maintenance_service._cache["result"] = "anterior"
        maintenance_service._refresh_in_progress = True

        await maintenance_service._refresh_cache([], [], 5, 5)

        assert maintenance_service._cache["result"] == "anterior"
        assert maintenance_service._refresh_in_progress is False
