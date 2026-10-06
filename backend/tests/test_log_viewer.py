"""Logs Fase B: visor de la Consola del sistema (GET /api/logs).

Filtros por componente, nivel y texto en el backend, archivos rotados,
límites de lectura, fuentes silenciadas ocultas y refresco incremental (lo
que permite pausar y reanudar sin perder eventos). Archivos simulados en
tmp_path; nada del registro real.
"""

import os

import pytest

import backend.services.log_viewer_service as viewer
import backend.services.logging_config_service as svc

LASER = "backend.services.laser_service"
PRINTER = "backend.services.klipper_service"
AI = "backend.services.ai_tools"
LED = "pypixelcolor"


def line(n, level="INFO", source=LASER, message=None):
    return f"2026-10-05 12:{n // 60 % 60:02d}:{n % 60:02d} {level:<8} [{source}] {message or f'evento {n}'}\n"


@pytest.fixture(autouse=True)
def restore_logging():
    yield
    svc.apply_config(svc.validate_config(svc.DEFAULT_CONFIG))


@pytest.fixture
def log(tmp_path, monkeypatch):
    path = tmp_path / "nopal.log"
    monkeypatch.setattr(svc, "current_log_file", lambda: str(path))

    def write(*lines, index=0, mode="w"):
        target = path if index == 0 else tmp_path / f"nopal.log.{index}"
        with open(target, mode, encoding="utf-8") as handle:
            handle.write("".join(lines))
        return target

    return write


def get(client, **params):
    response = client.get("/api/logs", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def messages(data):
    return [e["message"] for e in data["entries"]]


# ── Formato y filtros ──

class TestEntries:
    def test_structured_entry_with_friendly_component(self, client, as_admin, log):
        log(line(1, "WARNING", LASER, "[192.168.0.61] sin respuesta"))
        entry = get(client)["entries"][0]
        assert entry == {"time": "2026-10-05 12:00:01", "level": "WARNING", "component": "laser",
                         "source": LASER, "message": "[192.168.0.61] sin respuesta", "detail": ""}

    def test_traceback_stays_with_its_event(self, client, as_admin, log):
        log(line(1, "ERROR", PRINTER, "falló"), "Traceback (most recent call last):\n",
            '  File "x.py", line 1\n', "ValueError: malo\n", line(2))
        entries = get(client)["entries"]
        assert [e["message"] for e in entries] == ["falló", "evento 2"]
        assert entries[0]["detail"].splitlines() == ["Traceback (most recent call last):",
                                                     '  File "x.py", line 1', "ValueError: malo"]

    def test_repeat_summary_is_a_normal_event(self, client, as_admin, log):
        summary = "[repetido] sin respuesta — se repitió 12 veces en 10 min"
        log(line(1, "WARNING", LASER, summary))
        assert messages(get(client, component="laser")) == [summary]

    def test_unmapped_source_has_no_component(self, client, as_admin, log):
        log(line(1, source="asyncio"))
        assert get(client)["entries"][0]["component"] is None


class TestFilters:
    @pytest.fixture
    def mixed(self, log):
        log(line(1, "INFO", LASER, "láser info"), line(2, "WARNING", LASER, "láser aviso"),
            line(3, "ERROR", PRINTER, "impresora error"), line(4, "INFO", AI, "ia info"),
            line(5, "CRITICAL", LASER, "láser crítico"), line(6, "WARNING", PRINTER, "impresora aviso"))

    def test_component(self, client, as_admin, mixed):
        assert messages(get(client, component="printers")) == ["impresora error", "impresora aviso"]

    def test_level(self, client, as_admin, mixed):
        assert messages(get(client, level="WARNING")) == ["láser aviso", "impresora aviso"]

    def test_error_level_includes_critical(self, client, as_admin, mixed):
        assert messages(get(client, level="ERROR")) == ["impresora error", "láser crítico"]

    def test_component_and_level(self, client, as_admin, mixed):
        assert messages(get(client, component="laser", level="WARNING")) == ["láser aviso"]

    def test_all_means_no_filter(self, client, as_admin, mixed):
        assert len(get(client, component="all", level="all")["entries"]) == 6

    def test_search_is_case_insensitive(self, client, as_admin, mixed):
        assert messages(get(client, q="AVISO")) == ["láser aviso", "impresora aviso"]

    def test_search_includes_detail_and_source(self, client, as_admin, log):
        log(line(1, "ERROR", PRINTER, "falló"), "ConnectionRefusedError: puerto 7125\n", line(2))
        assert messages(get(client, q="7125")) == ["falló"]
        assert messages(get(client, q="klipper_service")) == ["falló"]

    def test_search_combined_with_filters(self, client, as_admin, mixed):
        assert messages(get(client, q="aviso", component="printers")) == ["impresora aviso"]
        assert messages(get(client, q="aviso", level="ERROR")) == []
        assert messages(get(client, q="láser", component="laser", level="CRITICAL")) == ["láser crítico"]

    @pytest.mark.parametrize("params", [{"component": "backend.services.laser_service"},
                                        {"component": "inventado"}, {"level": "VERBOSE"},
                                        {"q": "x" * (viewer.MAX_QUERY + 1)}, {"file": -1},
                                        {"file": svc.MAX_BACKUPS + 1}])
    def test_invalid_params_are_rejected(self, client, as_admin, log, params):
        log(line(1))
        assert client.get("/api/logs", params=params).status_code == 400


class TestSilenced:
    def test_silenced_source_is_hidden(self, client, as_admin, log):
        log(line(1, "ERROR", LED, "matriz"), line(2, "WARNING", LASER, "láser"))
        svc.apply_config(svc.validate_config({**svc.DEFAULT_CONFIG, "console": False,
                                              "sources": {LED: "silenced"}}))
        data = get(client)
        assert messages(data) == ["láser"]
        assert messages(get(client, q="matriz")) == []

    def test_component_threshold_hides_lower_levels(self, client, as_admin, log):
        """Matriz LED en "solo errores" (el valor por defecto): sus avisos viejos no salen."""
        log(line(1, "WARNING", LED, "aviso matriz"), line(2, "ERROR", LED, "error matriz"))
        assert messages(get(client, component="led_matrix")) == ["error matriz"]


# ── Archivos ──

class TestFiles:
    def test_current_file_and_list(self, client, as_admin, log):
        log(line(1, message="actual"))
        log(line(1, message="anterior"), index=1)
        log(line(1, message="anterior 2"), index=2)
        data = get(client)
        assert messages(data) == ["actual"]
        assert [f["index"] for f in data["files"]] == [0, 1, 2]

    def test_rotated_file(self, client, as_admin, log):
        log(line(1, message="actual"))
        log(line(1, message="anterior 2"), index=2)
        data = get(client, file=2, q="anterior")
        assert messages(data) == ["anterior 2"] and data["cursor"] is None

    def test_missing_rotated_file_is_404(self, client, as_admin, log):
        log(line(1))
        assert client.get("/api/logs", params={"file": 3}).status_code == 404

    def test_missing_current_file_is_empty(self, client, as_admin, log):
        assert get(client)["entries"] == []


# ── Límites ──

class TestLimits:
    def test_limit_returns_the_newest(self, client, as_admin, log):
        log(*(line(n) for n in range(50)))
        assert messages(get(client, limit=3)) == ["evento 47", "evento 48", "evento 49"]

    def test_legacy_lines_param(self, client, as_admin, log):
        log(*(line(n) for n in range(10)))
        assert len(get(client, lines=4)["entries"]) == 4

    def test_limit_is_capped(self, client, as_admin, log):
        log(*(line(n) for n in range(viewer.MAX_LIMIT + 20)))
        assert len(get(client, limit=10 ** 6)["entries"]) == viewer.MAX_LIMIT

    def test_scan_never_reads_whole_big_file(self, client, as_admin, log, monkeypatch):
        monkeypatch.setattr(viewer, "SCAN_BYTES", 4096)
        monkeypatch.setattr(viewer, "CHUNK_BYTES", 1024)
        log(line(0, message="muy viejo"), *(line(n, message=f"relleno {n:04d}") for n in range(1, 400)))
        read = []
        real_open = open

        class Spy:
            def __init__(self, handle):
                self.handle = handle

            def __getattr__(self, name):
                return getattr(self.handle, name)

            def read(self, size=-1):
                data = self.handle.read(size)
                read.append(len(data))
                return data

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self.handle.close()

        monkeypatch.setattr(viewer, "open", lambda *a, **k: Spy(real_open(*a, **k)), raising=False)
        data = get(client, q="muy viejo")
        assert messages(data) == [] and data["scan_limited"] is True
        assert sum(read) <= 4096 + 1024

    def test_partial_last_line_waits(self, client, as_admin, log):
        path = log(line(1), "2026-10-05 12:00:02 INFO     [backend.serv")
        data = get(client)
        assert messages(data) == ["evento 1"]
        assert data["cursor"]["offset"] == len(line(1).encode())
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("ices.laser_service] completa\n")
        cursor = data["cursor"]
        assert messages(get(client, after=cursor["offset"], file_id=cursor["file_id"])) == ["completa"]


# ── Actualización, pausa y reanudación ──

class TestIncremental:
    def test_normal_update_returns_only_new(self, client, as_admin, log):
        log(line(1), line(2))
        first = get(client)
        log(line(3), mode="a")
        cursor = first["cursor"]
        data = get(client, after=cursor["offset"], file_id=cursor["file_id"])
        assert messages(data) == ["evento 3"] and data["reset"] is False
        assert "files" not in data  # el sondeo no vuelve a listar archivos
        again = get(client, after=data["cursor"]["offset"], file_id=data["cursor"]["file_id"])
        assert again["entries"] == []

    def test_pause_then_resume_loses_nothing(self, client, as_admin, log):
        """En pausa el visor no pide nada y conserva su cursor; al reanudar,
        lo escrito mientras tanto llega completo."""
        log(line(1))
        cursor = get(client)["cursor"]
        log(*(line(n) for n in range(2, 30)), mode="a")
        data = get(client, after=cursor["offset"], file_id=cursor["file_id"])
        assert messages(data) == [f"evento {n}" for n in range(2, 30)] and data["gap"] is False

    def test_resume_respects_filters(self, client, as_admin, log):
        log(line(1))
        cursor = get(client, component="printers")["cursor"]
        log(line(2, source=PRINTER, message="nueva impresora"), line(3, source=LASER), mode="a")
        data = get(client, component="printers", after=cursor["offset"], file_id=cursor["file_id"])
        assert messages(data) == ["nueva impresora"]

    def test_resume_after_long_pause_marks_gap(self, client, as_admin, log):
        log(line(1))
        cursor = get(client)["cursor"]
        log(*(line(n) for n in range(2, 40)), mode="a")
        data = get(client, limit=5, after=cursor["offset"], file_id=cursor["file_id"])
        assert messages(data) == [f"evento {n}" for n in range(35, 40)] and data["gap"] is True

    def test_rotation_while_paused_resets(self, client, as_admin, log, tmp_path):
        log(*(line(n) for n in range(1, 5)))
        cursor = get(client)["cursor"]
        os.replace(tmp_path / "nopal.log", tmp_path / "nopal.log.1")
        log(line(9, message="después de rotar"))
        data = get(client, after=cursor["offset"], file_id=cursor["file_id"])
        assert data["reset"] is True and messages(data) == ["después de rotar"]
        assert [f["index"] for f in data["files"]] == [0, 1]


# ── Permisos ──

class TestPermissions:
    def test_anonymous_is_401(self, client, log):
        log(line(1))
        assert client.get("/api/logs").status_code == 401

    def test_operator_can_read(self, client, as_operator, log):
        log(line(1))
        assert messages(get(client)) == ["evento 1"]
