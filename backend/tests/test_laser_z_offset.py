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
