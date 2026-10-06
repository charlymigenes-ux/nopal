"""Configuración → Registro (logs): fuentes, repetidos, destino y permisos.

Se prueba sobre el logging real del proceso, con carpetas temporales dentro de
`logs/` (el sandbox de tests) y reloj simulado para la ventana de repetidos.
Cada test deja el logging como al arrancar (configuración por omisión).
"""

import json
import logging
import os
import uuid
from pathlib import Path

import pytest

import backend.auth_deps as auth_deps
import backend.services.ai_tools as ai_tools
import backend.services.config_backup_service as config_backup_service
import backend.services.logging_config_service as svc
from backend.services.authorization_policy import Action


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now


@pytest.fixture(autouse=True)
def restore_logging():
    yield
    svc.apply_config(svc.validate_config(svc.DEFAULT_CONFIG))


@pytest.fixture
def folder():
    return f"logs/t_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(svc, "time", fake)
    return fake


def _config(folder, **overrides):
    return {**svc.DEFAULT_CONFIG, "folder": folder, "console": False, **overrides}


def _lines(folder):
    path = Path(folder) / svc.LOG_FILENAME
    for handler in logging.getLogger().handlers:
        handler.flush()
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def _has(lines, text):
    return any(text in line for line in lines)


# ── Fuentes ──

class TestSources:
    def test_each_source_respects_its_state(self, folder):
        svc.apply_config(_config(folder, sources={
            "nopaltest.normal": "normal", "nopaltest.warn": "warnings",
            "nopaltest.err": "errors", "nopaltest.mute": "silenced",
        }))
        for name in ("normal", "warn", "err", "mute"):
            log = logging.getLogger(f"nopaltest.{name}")
            log.info(f"{name}-info")
            log.warning(f"{name}-warning")
            log.error(f"{name}-error")
            log.critical(f"{name}-critical")

        lines = _lines(folder)
        assert all(_has(lines, f"normal-{lvl}") for lvl in ("info", "warning", "error"))
        assert not _has(lines, "warn-info") and _has(lines, "warn-warning") and _has(lines, "warn-error")
        assert not _has(lines, "err-warning") and _has(lines, "err-error") and _has(lines, "err-critical")
        assert not any(_has(lines, f"mute-{lvl}") for lvl in ("info", "warning", "error", "critical"))

    def test_prefix_covers_child_loggers(self, folder):
        svc.apply_config(_config(folder, sources={"nopaltest.pkg": "errors"}))
        logging.getLogger("nopaltest.pkg.sub.mod").warning("hijo-aviso")
        logging.getLogger("nopaltest.pkg.sub.mod").error("hijo-error")
        lines = _lines(folder)
        assert not _has(lines, "hijo-aviso") and _has(lines, "hijo-error")

    def test_led_matrix_defaults_to_errors_only(self, folder):
        svc.apply_config(_config(folder))
        matrix = logging.getLogger("pypixelcolor.commands.send_image")
        matrix.warning("Device info not provided; skipping image resizing.")
        matrix.error("La matriz no respondió")
        lines = _lines(folder)
        assert not _has(lines, "Device info not provided")
        assert _has(lines, "La matriz no respondió")
        assert svc.DEFAULT_CONFIG["sources"]["pypixelcolor"] == "errors"

    def test_removed_source_inherits_again(self, folder):
        svc.apply_config(_config(folder, sources={"nopaltest.x": "silenced"}))
        svc.apply_config(_config(folder, sources={}))
        logging.getLogger("nopaltest.x").info("de-vuelta")
        assert _has(_lines(folder), "de-vuelta")

    def test_source_list_comes_from_real_loggers_grouped(self):
        logging.getLogger("nopal_plugins.matriz_led.services.screen_service")
        sources = {s["name"]: s for s in svc.list_sources()}
        assert sources["pypixelcolor"]["group"] == "libraries" and sources["pypixelcolor"]["state"] == "errors"
        assert sources["backend.services.laser_service"]["group"] == "nopal"
        assert sources["nopal_plugins.matriz_led"]["group"] == "plugins"
        assert not any(name.startswith("uvicorn") for name in sources)


# ── Repetidos ──

class TestRepeats:
    def test_identical_messages_are_grouped_with_summary(self, folder, clock):
        svc.apply_config(_config(folder))
        log = logging.getLogger("backend.services.laser_service")
        for _ in range(120):
            log.warning("[192.168.0.63] Fallo al enviar ''?'': sin conexión")
            clock.now += 4
        lines = _lines(folder)
        assert sum("Fallo al enviar" in line for line in lines) == 1  # solo la primera

        clock.now += 600
        log.warning("[192.168.0.63] Fallo al enviar ''?'': sin conexión")
        lines = _lines(folder)
        summary = [line for line in lines if "[repetido]" in line]
        assert len(summary) == 1
        assert "WARNING" in summary[0] and "[backend.services.laser_service]" in summary[0]
        assert "se repitió 119 veces en" in summary[0] and "192.168.0.63" in summary[0]
        assert sum("Fallo al enviar" in line and "[repetido]" not in line for line in lines) == 2

    def test_different_machines_are_not_mixed(self, folder, clock):
        svc.apply_config(_config(folder))
        log = logging.getLogger("backend.services.laser_service")
        for host in ("192.168.0.63", "192.168.0.72", "192.168.0.63", "192.168.0.72"):
            log.warning(f"[{host}] Fallo al enviar")
        lines = _lines(folder)
        assert _has(lines, "[192.168.0.63] Fallo") and _has(lines, "[192.168.0.72] Fallo")
        assert sum("Fallo al enviar" in line for line in lines) == 2

    def test_errors_first_always_and_summary_keeps_diagnostics(self, folder, clock):
        svc.apply_config(_config(folder))
        log = logging.getLogger("backend.services.klipper_service")
        for _ in range(5):
            log.error("mcu 'mcu': Unable to connect")
        clock.now += 601
        svc.flush_repeats()
        lines = _lines(folder)
        first = [l for l in lines if "Unable to connect" in l and "[repetido]" not in l]
        summary = [l for l in lines if "[repetido]" in l]
        assert len(first) == 1 and "ERROR" in first[0]
        assert len(summary) == 1 and "ERROR" in summary[0] and "[backend.services.klipper_service]" in summary[0]
        assert "mcu 'mcu': Unable to connect" in summary[0] and "se repitió 4 veces en 10 min" in summary[0]

    def test_pending_summary_written_on_reconfigure(self, folder, clock):
        svc.apply_config(_config(folder))
        log = logging.getLogger("backend.services.laser_service")
        for _ in range(3):
            log.warning("se repite")
        svc.apply_config(_config(folder))
        assert _has(_lines(folder), "se repitió 2 veces")

    def test_dedup_can_be_disabled(self, folder):
        svc.apply_config(_config(folder, dedup={"enabled": False, "window_s": 600}))
        for _ in range(3):
            logging.getLogger("backend.x").warning("igual")
        assert sum("igual" in line for line in _lines(folder)) == 3

    def test_other_handlers_still_see_everything(self, folder, caplog):
        """El filtro está en los handlers de NOPAL, no en los loggers."""
        svc.apply_config(_config(folder))
        with caplog.at_level(logging.WARNING):
            for _ in range(3):
                logging.getLogger("backend.y").warning("para-caplog")
        assert sum(r.getMessage() == "para-caplog" for r in caplog.records) == 3


# ── Destino, persistencia y aplicación ──

class TestDestinationAndPersistence:
    def test_rotation_respects_size_and_count(self, folder):
        svc.apply_config(_config(folder, max_bytes=svc.MIN_MAX_BYTES, backup_count=2,
                                 dedup={"enabled": False, "window_s": 600}))
        log = logging.getLogger("backend.rotacion")
        for i in range(4000):
            log.warning(f"linea {i:05d} " + "x" * 200)
        files = sorted(os.listdir(folder))
        assert files == ["nopal.log", "nopal.log.1", "nopal.log.2"]
        assert all(os.path.getsize(Path(folder) / f) <= svc.MIN_MAX_BYTES for f in files)

    def test_console_duplication_can_be_turned_off(self, folder):
        root = logging.getLogger()
        svc.apply_config(_config(folder, console=True))
        assert svc._console_handler in root.handlers
        svc.apply_config(_config(folder, console=False))
        assert svc._console_handler is None
        assert not any(type(h) is logging.StreamHandler for h in root.handlers)
        logging.getLogger("backend.z").warning("solo-archivo")
        assert _has(_lines(folder), "solo-archivo")

    def test_changes_apply_without_restart_and_persist(self, folder):
        svc.save_config(_config(folder, sources={"nopaltest.live": "silenced"}))
        assert logging.getLogger("nopaltest.live").getEffectiveLevel() > logging.CRITICAL
        assert json.loads(Path(svc.CONFIG_PATH).read_text(encoding="utf-8"))["sources"]["nopaltest.live"] == "silenced"

        # "Reinicio": el estado en memoria se pierde; lo guardado manda.
        svc._current = {}
        logging.getLogger("nopaltest.live").setLevel(logging.NOTSET)
        svc.apply_config()
        assert logging.getLogger("nopaltest.live").getEffectiveLevel() > logging.CRITICAL
        assert svc.current_log_file() == f"{folder}/nopal.log"

    @pytest.mark.parametrize("content", [None, "{no soy json", json.dumps({"max_bytes": 1})])
    def test_missing_or_bad_file_falls_back_to_defaults(self, content):
        if content is not None:
            Path(svc.CONFIG_PATH).write_text(content, encoding="utf-8")
        assert svc.get_config() == svc.validate_config(svc.DEFAULT_CONFIG)

    @pytest.mark.parametrize("folder_value", ["/etc", "/var/log", "/home/jcjc", "..", "logs/../backend",
                                              "backend", "data", "logs/../../x", ""])
    def test_folder_outside_logs_is_rejected(self, folder_value):
        with pytest.raises(svc.LoggingConfigError):
            svc.validate_config({**svc.DEFAULT_CONFIG, "folder": folder_value})

    def test_folder_is_normalized(self):
        assert svc.validate_config({**svc.DEFAULT_CONFIG, "folder": "logs/archivo/"})["folder"] == "logs/archivo"
        assert svc.validate_config({**svc.DEFAULT_CONFIG, "folder": "./logs"})["folder"] == "logs"

    def test_symlink_escaping_logs_is_rejected(self, tmp_path):
        os.makedirs("logs", exist_ok=True)
        link = Path("logs") / f"escape_{uuid.uuid4().hex[:6]}"
        link.symlink_to(tmp_path)
        try:
            with pytest.raises(svc.LoggingConfigError):
                svc.validate_config({**svc.DEFAULT_CONFIG, "folder": str(link)})
        finally:
            link.unlink()

    @pytest.mark.parametrize("change", [
        {"max_bytes": 10}, {"max_bytes": 10**10}, {"backup_count": -1}, {"backup_count": 99},
        {"console": "si"}, {"sources": {"pypixelcolor": "medio"}}, {"sources": {"uvicorn.access": "silenced"}},
        {"sources": {"../x": "errors"}}, {"sources": []}, {"dedup": {"enabled": True, "window_s": 5}},
    ])
    def test_invalid_values_rejected(self, change):
        with pytest.raises(svc.LoggingConfigError):
            svc.validate_config({**svc.DEFAULT_CONFIG, **change})

    def test_backup_group_is_non_sensitive(self):
        group = config_backup_service.GROUPS["logging"]
        assert group["files"] == ["logging_config.json"] and group["sensitive"] is False


# ── Eventos recientes ──

class TestRecentEvents:
    def test_silenced_sources_hidden_even_old_lines(self, folder, monkeypatch):
        svc.apply_config(_config(folder))
        path = Path(folder) / "eventos.log"
        path.write_text(
            "2026-10-05 01:00:00 WARNING  [pypixelcolor.commands.send_image] Device info not provided\n"
            "2026-10-05 01:00:01 ERROR    [pypixelcolor.commands.send_image] La matriz falló\n"
            "2026-10-05 01:00:02 WARNING  [backend.services.laser_service] TTS sin responder\n"
            "2026-10-05 01:00:03 INFO     [nopaltest.mute] ruido\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(ai_tools, "current_log_file", lambda: str(path))
        svc.apply_config(_config(folder, sources={"pypixelcolor": "errors", "nopaltest.mute": "silenced"}))

        messages = [e["message"] for e in ai_tools._read_recent_events(30, None)]

        assert messages == ["La matriz falló", "TTS sin responder"]

        svc.apply_config(_config(folder, sources={}))
        assert len(ai_tools._read_recent_events(30, None)) == 4


# ── API y permisos ──

class TestApi:
    def test_operator_can_read(self, client, as_operator):
        response = client.get("/api/logs/config")
        assert response.status_code == 200
        body = response.json()
        assert body["config"]["sources"]["pypixelcolor"] == "errors"
        assert body["states"] == ["normal", "warnings", "errors", "silenced"]
        assert body["limits"]["folder_base"] == "logs"

    def test_operator_cannot_modify(self, client, as_operator):
        before = svc.get_config()
        response = client.put("/api/logs/config", json={**svc.DEFAULT_CONFIG, "console": False})
        assert response.status_code == 403
        assert svc.get_config() == before

    def test_admin_modifies_through_system_control(self, client, as_admin, monkeypatch, folder):
        asked = []
        real = auth_deps.authorize

        def spy(principal, action, resource=None):
            asked.append(action)
            return real(principal, action, resource)

        monkeypatch.setattr(auth_deps, "authorize", spy)
        response = client.put("/api/logs/config", json=_config(folder, sources={"pypixelcolor": "silenced"}))

        assert response.status_code == 200
        assert asked == [Action.SYSTEM_CONTROL]
        assert response.json()["config"]["sources"]["pypixelcolor"] == "silenced"
        assert logging.getLogger("pypixelcolor").getEffectiveLevel() > logging.CRITICAL

    def test_admin_invalid_config_is_400(self, client, as_admin):
        response = client.put("/api/logs/config", json={**svc.DEFAULT_CONFIG, "folder": "/etc"})
        assert response.status_code == 400 and "logs/" in response.json()["detail"]

    def test_anonymous_rejected(self, client):
        assert client.get("/api/logs/config").status_code == 401
        assert client.put("/api/logs/config", json=svc.DEFAULT_CONFIG).status_code == 401


# ── Capa amigable: nivel general y componentes ──

class TestGeneralLevel:
    def _emit(self, name):
        log = logging.getLogger(name)
        log.debug(f"{name}-debug")
        log.info(f"{name}-info")
        log.warning(f"{name}-warning")

    @pytest.mark.parametrize("level, own_debug, lib_debug, own_info", [
        ("basic", False, False, False),
        ("normal", False, False, True),
        ("detailed", True, False, True),
        ("diagnostic", True, True, True),
    ])
    def test_levels_map_to_real_logging_levels(self, folder, level, own_debug, lib_debug, own_info):
        svc.apply_config(_config(folder, level=level))
        self._emit("backend.services.nivel_test")
        self._emit("nivellib.sub")
        lines = _lines(folder)
        assert _has(lines, "backend.services.nivel_test-debug") is own_debug
        assert _has(lines, "backend.services.nivel_test-info") is own_info
        assert _has(lines, "nivellib.sub-debug") is lib_debug
        assert _has(lines, "backend.services.nivel_test-warning")  # avisos en todos los niveles

    def test_old_config_without_level_is_normal(self):
        Path(svc.CONFIG_PATH).write_text(json.dumps({"sources": {}}), encoding="utf-8")
        assert svc.get_config()["level"] == "normal"

    def test_invalid_level_rejected(self):
        with pytest.raises(svc.LoggingConfigError):
            svc.validate_config({**svc.DEFAULT_CONFIG, "level": "todo"})

    def test_recent_events_follow_general_level(self, folder, monkeypatch):
        path = Path(folder) / "eventos.log"
        os.makedirs(folder, exist_ok=True)
        path.write_text(
            "2026-10-05 01:00:00 INFO     [backend.main] NOPAL iniciado\n"
            "2026-10-05 01:00:01 WARNING  [backend.services.laser_service] TTS sin responder\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(ai_tools, "current_log_file", lambda: str(path))
        svc.apply_config(_config(folder, level="basic"))
        assert [e["message"] for e in ai_tools._read_recent_events(30, None)] == ["TTS sin responder"]


class TestComponents:
    def test_default_led_matrix_errors_others_inherit(self):
        components = {c["id"]: c["state"] for c in svc.list_components()}
        assert components["led_matrix"] == "errors"
        assert components["laser"] == "inherit" and components["printers"] == "inherit"

    def test_only_components_with_real_loggers_are_listed(self, monkeypatch):
        monkeypatch.setattr(svc, "_existing_loggers", lambda: {"backend.services.laser_service"})
        monkeypatch.setattr(svc, "_current", svc.validate_config({**svc.DEFAULT_CONFIG, "sources": {}}))
        assert [c["id"] for c in svc.list_components()] == ["laser"]

    def test_component_state_writes_all_its_loggers(self, folder):
        svc.apply_config(_config(folder, components={"laser": "silenced"}))
        assert svc._current["sources"]["backend.services.laser_service"] == "silenced"
        assert svc._current["sources"]["backend.services.gcode_bounds"] == "silenced"
        logging.getLogger("backend.services.laser_service").error("laser-silenciado")
        assert not _has(_lines(folder), "laser-silenciado")

        svc.apply_config(_config(folder, sources=svc._current["sources"], components={"laser": "inherit"}))
        assert "backend.services.laser_service" not in svc._current["sources"]
        logging.getLogger("backend.services.laser_service").warning("laser-de-vuelta")
        assert _has(_lines(folder), "laser-de-vuelta")

    def test_component_info_overrides_basic_general_level(self, folder):
        svc.apply_config(_config(folder, level="basic", components={"laser": "info"}))
        logging.getLogger("backend.services.laser_service").info("laser-info")
        logging.getLogger("backend.services.klipper_service").info("klipper-info")
        lines = _lines(folder)
        assert _has(lines, "laser-info") and not _has(lines, "klipper-info")

    def test_mixed_sources_show_custom_and_are_left_untouched(self, folder):
        svc.apply_config(_config(folder, sources={"backend.services.laser_service": "errors"}))
        assert {c["id"]: c["state"] for c in svc.list_components()}["laser"] == "custom"
        svc.apply_config(_config(folder, sources=svc._current["sources"], components={"laser": "custom"}))
        assert svc._current["sources"] == {"backend.services.laser_service": "errors"}

    @pytest.mark.parametrize("components", [{"cnc_inventado": "errors"}, {"laser": "medio"}, ["laser"]])
    def test_invalid_components_rejected(self, components):
        with pytest.raises(svc.LoggingConfigError):
            svc.validate_config({**svc.DEFAULT_CONFIG, "components": components})

    def test_technical_sources_carry_friendly_component(self):
        sources = {s["name"]: s for s in svc.list_sources()}
        assert sources["pypixelcolor"]["component"] == "led_matrix"
        assert sources["backend.services.laser_service"]["component"] == "laser"

    def test_api_exposes_friendly_layer_and_admin_saves_it(self, client, as_admin, folder):
        body = client.get("/api/logs/config").json()
        assert body["level"] == "normal" and body["levels"] == ["basic", "normal", "detailed", "diagnostic"]
        assert body["component_states"] == ["inherit", "info", "warnings", "errors", "silenced"]
        assert {"id": "led_matrix", "state": "errors"} in body["components"]

        response = client.put("/api/logs/config", json={**_config(folder), "level": "basic",
                                                        "components": {"led_matrix": "silenced"}})
        assert response.status_code == 200
        assert response.json()["level"] == "basic"
        assert {"id": "led_matrix", "state": "silenced"} in response.json()["components"]

    def test_operator_cannot_change_level(self, client, as_operator):
        response = client.put("/api/logs/config", json={**svc.DEFAULT_CONFIG, "level": "diagnostic"})
        assert response.status_code == 403 and svc.get_config()["level"] == "normal"
