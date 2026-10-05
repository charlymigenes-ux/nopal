"""Seguimiento de trabajos corridos desde la SD de la placa ($SD/Run=).

Caso real (TTS-55 Pro, FluidNC): NOPAL marcó "completado" un grabado a los 39 s
porque vio un Idle momentáneo después de Run, y la placa siguió grabando; el
panel, la IA y TUNA-Screen lo perdieron de vista. Ahora el campo "SD:<pct>,
<archivo>" del estado indica que el archivo sigue corriendo (y su avance), y
sin él un Idle se confirma en varias lecturas seguidas. Estados simulados.
"""

import asyncio
from types import SimpleNamespace

import pytest

import backend.services.laser_service as laser_service

HOST = "192.168.0.61"
_real_sleep = asyncio.sleep


def _st(state, sd=None):
    status = {"state": state, "x": 0.0, "y": 0.0, "z": 0.0, "feed": 0, "speed": 0}
    if sd is not None:
        status["sd_percent"], status["sd_file"] = sd, "/sd/cena.gc"
    return status


@pytest.fixture
def board(monkeypatch, tmp_path):
    """Placa simulada: devuelve en orden los estados de `sequence` (y repite
    el último). Registra el estado del trabajo en cada lectura."""
    state = SimpleNamespace(sequence=[], seen=[], commands=[], job=None)

    async def get_status(host, timeout=3.0):
        status = state.sequence.pop(0) if len(state.sequence) > 1 else state.sequence[0]
        state.seen.append((state.job.state if state.job else None, state.job.current if state.job else None))
        return status

    async def fast_sleep(_seconds):
        await _real_sleep(0)

    monkeypatch.setattr(laser_service, "get_status", get_status)
    monkeypatch.setattr(laser_service, "send_raw_command",
                        lambda host, command, allow_during_job=False: state.commands.append(command) or True)
    monkeypatch.setattr(laser_service, "asyncio", SimpleNamespace(sleep=fast_sleep, get_event_loop=asyncio.get_event_loop))
    monkeypatch.setattr(laser_service, "HISTORY_PATH", str(tmp_path / "history.json"))
    monkeypatch.setattr(laser_service, "REGISTRY_PATH", str(tmp_path / "registry.json"))
    return state


async def _run(board, sequence):
    board.sequence = list(sequence)
    job = laser_service.LaserJob(HOST, [], "cena.gc", source="sd")
    board.job = job
    await laser_service._run_sd_job(job)
    return job


class TestParser:
    def test_sd_field_gives_progress_and_file(self):
        status = laser_service._parse_grbl_status_line("<Run|MPos:1.000,2.000,0.000|FS:1200,800|SD:42.57,/sd/cena.gc>")
        assert status["sd_percent"] == pytest.approx(42.57) and status["sd_file"] == "/sd/cena.gc"

    def test_without_sd_field(self):
        status = laser_service._parse_grbl_status_line("<Idle|MPos:0.000,0.000,0.000|FS:0,0>")
        assert "sd_percent" not in status


class TestRunSdJob:
    async def test_momentary_idle_does_not_finish_the_job(self, board):
        """Regresión del caso real: Run → un Idle → Run sigue en curso."""
        job = await _run(board, [_st("Run"), _st("Idle"), _st("Run"), _st("Run"),
                                 _st("Idle"), _st("Idle"), _st("Idle")])
        assert job.state == "completed"
        # Después del primer Idle la placa volvió a Run y el trabajo seguía en curso.
        assert board.seen[2][0] == "running" and board.seen[3][0] == "running"
        assert board.commands == ["$SD/Run=cena.gc"]

    async def test_sd_field_keeps_job_running_even_if_idle(self, board):
        job = await _run(board, [_st("Run", 10.0), _st("Idle", 42.5), _st("Idle", 43.0), _st("Idle", 44.0),
                                 _st("Run", 80.0), _st("Idle"), _st("Idle"), _st("Idle")])
        assert job.state == "completed"
        assert [s for s, _ in board.seen[:6]] == ["running"] * 6
        assert (42, 43, 44) == tuple(c for _, c in board.seen[2:5])

    async def test_progress_from_sd_percent_reaches_100(self, board):
        job = await _run(board, [_st("Run", 55.9), _st("Idle"), _st("Idle"), _st("Idle")])
        assert job.state == "completed" and job.total == 100 and job.current == 100
        assert board.seen[1] == ("running", 55)

    async def test_alarm_is_error(self, board):
        job = await _run(board, [_st("Run", 5.0), _st("Alarm")])
        assert job.state == "error" and "alarma" in job.error_message

    async def test_board_never_starts_is_error(self, board):
        job = await _run(board, [_st("Idle")])
        assert job.state == "error" and "nunca inició" in job.error_message

    async def test_cancel_sends_soft_reset(self, board):
        board.sequence = [_st("Run", 5.0)]
        job = laser_service.LaserJob(HOST, [], "cena.gc", source="sd")
        board.job = job
        job.cancel_requested = True
        await laser_service._run_sd_job(job)
        assert job.state == "cancelled" and board.commands[-1] == "\x18"


class TestUntrackedSdJob:
    async def test_external_sd_job_shows_file_and_progress(self, board):
        """Un archivo de la SD que NOPAL no sigue (p. ej. tras reiniciar) sí
        muestra nombre y avance, aunque la placa diga Idle un instante."""
        laser_service._jobs.pop(HOST, None)
        board.sequence = [_st("Idle", 61.2)]
        board.job = None

        job = await laser_service.get_job_status(HOST)

        assert job == {"filename": "/sd/cena.gc", "source": "external", "state": "running",
                       "current": 61, "total": 100, "error": None}

    async def test_idle_without_sd_is_idle(self, board):
        laser_service._jobs.pop(HOST, None)
        board.sequence = [_st("Idle")]
        board.job = None
        assert (await laser_service.get_job_status(HOST))["state"] == "idle"


class TestActiveJobsSeeExternal:
    """El caso reportado: la placa graba un archivo de la SD que NOPAL ya no
    sigue (empezó antes de reiniciar) y la IA decía que no había nada."""

    ENTRIES = [
        {"id": "mch_00000000000000a1", "host": HOST, "name": "TTS 55 PRO", "kind": "laser", "online": True},
        {"id": "mch_00000000000000a2", "host": "192.168.0.87", "name": "ATOMSTACK", "kind": "laser", "online": True},
        {"id": "mch_00000000000000a3", "host": "192.168.0.63", "name": "NOPAL-55", "kind": "cnc", "online": False},
    ]

    @pytest.fixture
    def boards(self, monkeypatch):
        asked = []

        async def get_status(host, timeout=3.0):
            asked.append(host)
            return _st("Run", 37.4) if host == HOST else _st("Idle")

        monkeypatch.setattr(laser_service, "get_status", get_status)
        for host in (HOST, "192.168.0.87", "192.168.0.63"):
            laser_service._jobs.pop(host, None)
        return asked

    async def test_external_sd_job_is_listed(self, boards):
        jobs = await laser_service.get_active_laser_jobs(self.ENTRIES)

        assert jobs == [{"filename": "/sd/cena.gc", "source": "external", "state": "running",
                         "current": 37, "total": 100, "error": None, "host": HOST}]
        assert "192.168.0.63" not in boards  # fuera de línea: ni se consulta

    async def test_own_job_not_asked_twice(self, boards, monkeypatch):
        own = laser_service.LaserJob(HOST, [], "propio.gc", source="sd")
        own.state = "running"
        monkeypatch.setitem(laser_service._jobs, HOST, own)

        jobs = await laser_service.get_active_laser_jobs(self.ENTRIES)

        assert [j["filename"] for j in jobs] == ["propio.gc"] and HOST not in boards

    async def test_ai_and_dashboard_see_it(self, boards, monkeypatch):
        from backend.services import ai_tools, dashboard_service

        async def lasers():
            return [dict(e) for e in self.ENTRIES]

        monkeypatch.setattr(ai_tools, "get_registered_lasers_status", lasers)
        for name in ("get_all_printers_status", "get_marlin_printers", "get_flashforge_printers",
                     "get_bambu_printers", "get_elegoo_printers"):
            monkeypatch.setattr(ai_tools, name, lambda: [])

        progress = await ai_tools.get_job_progress("TTS 55 PRO")
        assert progress["active"] is True and progress["job"]["filename"] == "/sd/cena.gc"

        jobs = dashboard_service._active_jobs([], [], [], [], [], [], await laser_service.get_active_laser_jobs(self.ENTRIES), self.ENTRIES)
        assert len(jobs) == 1
        assert jobs[0]["name"] == "TTS 55 PRO" and jobs[0]["progress"] == 37
        assert jobs[0]["filename"] == "/sd/cena.gc" and jobs[0]["device_id"] == "mch_00000000000000a1"
