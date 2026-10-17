"""Ajuste de Z en vivo (plotter) y envío de líneas a una placa con búfer lleno.

Sin red ni hardware: solo toca `_jobs` y simula `requests.get`.
"""

import asyncio

import pytest

import backend.services.laser_service as laser_service

HOST = "192.168.0.72"
PLOTTER = ["G21", "G90", "G0 Z3", "G0 X5 Y5 F2000", "G1 Z0 F500", "G1 X10 Y5 F1500", "G0 Z3", "G1 Z0"]


def _job(lines=PLOTTER, state="running"):
    job = laser_service.LaserJob(HOST, lines, "dibujo.gc")
    job.state = state
    return job


class TestZOffsetLines:
    def test_lowest_z_needs_two_distinct_heights(self):
        assert laser_service._lowest_z(PLOTTER) == 0.0
        assert laser_service._lowest_z(["G0 Z5", "G1 Z5"]) is None                # un láser o un trabajo sin lápiz
        assert laser_service._lowest_z(["G1 X1 Y1", "M4 S500"]) is None
        assert laser_service._lowest_z(["G1 Z-0.5 ; baja", "G0 Z2"]) == -0.5

    def test_only_the_pen_down_height_moves(self):
        assert laser_service.apply_z_offset("G1 Z0 F500", 0.0, -0.1) == "G1 Z-0.1 F500"
        assert laser_service.apply_z_offset("G0 Z3", 0.0, -0.1) == "G0 Z3"        # lápiz arriba no cambia
        assert laser_service.apply_z_offset("G1 X10 Y5 F1500", 0.0, -0.1) == "G1 X10 Y5 F1500"
        assert laser_service.apply_z_offset("G1 Z-0.5 F500", -0.5, 0.25) == "G1 Z-0.25 F500"

    def test_no_offset_no_change(self):
        assert laser_service.apply_z_offset("G1 Z0 F500", 0.0, 0.0) == "G1 Z0 F500"
        assert laser_service.apply_z_offset("G1 Z0", None, -0.1) == "G1 Z0"


class TestAdjustJobZ:
    def test_adds_up_and_reports_in_the_job(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {HOST: _job()})
        assert asyncio.run(laser_service.adjust_job_z(HOST, -0.1)) == -0.1
        assert asyncio.run(laser_service.adjust_job_z(HOST, -0.05)) == -0.15
        data = laser_service._jobs[HOST].to_dict()
        assert data["z_offset"] == -0.15 and data["has_z"] is True

    @pytest.mark.parametrize("state", ["completed", "error", "cancelled"])
    def test_needs_a_job_in_progress(self, monkeypatch, state):
        monkeypatch.setattr(laser_service, "_jobs", {HOST: _job(state=state)})
        with pytest.raises(ValueError, match="No hay un trabajo"):
            asyncio.run(laser_service.adjust_job_z(HOST, 0.1))

    def test_a_job_without_z_cannot_be_adjusted(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {HOST: _job(["G1 X1 S500", "M4"])})
        with pytest.raises(ValueError, match="Z"):
            asyncio.run(laser_service.adjust_job_z(HOST, 0.1))

    def test_limit(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {HOST: _job()})
        asyncio.run(laser_service.adjust_job_z(HOST, 0.9))
        for _ in range(4):
            asyncio.run(laser_service.adjust_job_z(HOST, 1.0))
        with pytest.raises(ValueError, match="±"):
            asyncio.run(laser_service.adjust_job_z(HOST, 1.0))


class TestEndpoint:
    def test_ok_and_validation(self, client, as_operator, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {HOST: _job()})
        r = client.post("/api/laser/job/z-offset", data={"host": HOST, "delta": "-0.1"})
        assert r.status_code == 200 and r.json() == {"success": True, "z_offset": -0.1}
        assert client.post("/api/laser/job/z-offset", data={"host": HOST, "delta": "3"}).status_code == 400
        monkeypatch.setattr(laser_service, "_jobs", {})
        assert client.post("/api/laser/job/z-offset", data={"host": HOST, "delta": "0.1"}).status_code == 409

    def test_requires_a_session(self, client):
        assert client.post("/api/laser/job/z-offset", data={"host": HOST, "delta": "0.1"}).status_code in (401, 403)


class _Reply:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        pass


class TestBoardRefusesTheLine:
    def test_body_error_means_the_line_was_not_accepted(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {})
        monkeypatch.setattr(laser_service.requests, "get", lambda *a, **k: _Reply("Error"))
        assert laser_service.send_raw_command(HOST, "G1 X1 Y1") is False

    def test_empty_or_ok_body_is_accepted_and_realtime_is_never_judged(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {})
        for body in ("", "ok"):
            monkeypatch.setattr(laser_service.requests, "get", lambda *a, _b=body, **k: _Reply(_b))
            assert laser_service.send_raw_command(HOST, "G1 X1 Y1") is True
        monkeypatch.setattr(laser_service.requests, "get", lambda *a, **k: _Reply("Error"))
        assert laser_service.send_raw_command(HOST, "?") is True


class TestRunFromSd:
    """Correr desde la SD de la placa: sube el archivo y arranca $SD/Run (todo simulado)."""

    def test_sd_presence_is_read_from_esp200(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {})
        for body, expected in (("SD card detected", True), ("No SD card", False), ("SD card not enabled", False), ("", False)):
            monkeypatch.setattr(laser_service.requests, "get", lambda *a, _b=body, **k: _Reply(_b))
            assert laser_service.sd_card_present(HOST) is expected, body

    def test_uploads_then_runs_and_reports_the_phase(self, monkeypatch):
        calls = []
        monkeypatch.setattr(laser_service, "_jobs", {})
        monkeypatch.setattr(laser_service, "sd_card_present", lambda host: True)

        def fake_upload(host, path, filename, data, upload_id):
            calls.append(("upload", path, filename, len(data)))
            laser_service._sd_upload_progress[upload_id] = {"sent": len(data), "total": len(data), "status": "done", "error": None}

        async def fake_run(job):
            calls.append(("run", job.filename, job.phase))
            job.state = "completed"

        monkeypatch.setattr(laser_service, "sd_upload_file_tracked", fake_upload)
        monkeypatch.setattr(laser_service, "_run_sd_job", fake_run)

        async def go():
            info = laser_service.start_job_via_sd(HOST, "dibujo.gc", b"G0 X1\n" * 10)
            assert info["phase"] == "uploading" and info["total"] == 60 and info["source"] == "sd"
            for _ in range(50):
                await asyncio.sleep(0.05)
                if laser_service._jobs[HOST].state == "completed":
                    break
            return laser_service._jobs[HOST]

        job = asyncio.run(go())
        assert calls == [("upload", "/", "dibujo.gc", 60), ("run", "dibujo.gc", "running")]
        assert job.state == "completed" and job.to_dict()["has_z"] is False

    def test_a_failed_upload_is_a_readable_error(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {})
        monkeypatch.setattr(laser_service, "sd_card_present", lambda host: True)
        monkeypatch.setattr(laser_service, "record_laser_job_history", lambda job: None)
        monkeypatch.setattr(laser_service, "sd_upload_file_tracked", lambda host, path, name, data, upload_id: laser_service._sd_upload_progress.__setitem__(
            upload_id, {"sent": 0, "total": 1, "status": "error", "error": "HTTP 500"}))

        async def go():
            laser_service.start_job_via_sd(HOST, "dibujo.gc", b"G0 X1\n")
            for _ in range(50):
                await asyncio.sleep(0.05)
                if laser_service._jobs[HOST].state == "error":
                    break
            return laser_service._jobs[HOST]

        job = asyncio.run(go())
        assert job.state == "error" and "subir el archivo a la SD" in job.error_message and "HTTP 500" in job.error_message

    def test_no_sd_card_and_busy_board_are_refused(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {})
        monkeypatch.setattr(laser_service, "sd_card_present", lambda host: False)
        with pytest.raises(RuntimeError, match="tarjeta SD"):
            laser_service.start_job_via_sd(HOST, "dibujo.gc", b"G0 X1\n")
        monkeypatch.setattr(laser_service, "sd_card_present", lambda host: True)
        monkeypatch.setattr(laser_service, "_jobs", {HOST: _job()})
        with pytest.raises(RuntimeError, match="en curso"):
            laser_service.start_job_via_sd(HOST, "dibujo.gc", b"G0 X1\n")

    def test_endpoints(self, client, as_operator, monkeypatch):
        monkeypatch.setattr(laser_service, "sd_card_present", lambda host: True)
        import backend.api.laser as laser_api
        monkeypatch.setattr(laser_api, "sd_card_present", lambda host: True)
        assert client.get("/api/laser/sd/status", params={"host": HOST}).json() == {"present": True}
        monkeypatch.setattr(laser_api, "sd_card_present", lambda host: False)
        assert client.get("/api/laser/sd/status", params={"host": HOST}).json() == {"present": False}
        r = client.post("/api/laser/job/start-sd", data={"host": HOST, "path": "no-existe.gc"})
        assert r.status_code == 404
