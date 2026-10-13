"""Último trabajo terminado visible para la tarjeta TRABAJO de CNC.

Un trabajo que acaba (error/completado/cancelado) dejaba de aparecer en
/api/laser/job/status (cae al estado de la placa); /api/laser/job/last lo
conserva hasta que arranca otro. Sin red ni hardware: solo toca _jobs.
"""

import backend.services.laser_service as laser_service

HOST = "192.168.0.72"


def _job(state, error=None):
    job = laser_service.LaserJob(HOST, ["G0 X1", "G1 X2 F100", "G1 X3"], "dibujo.gcode")
    job.state = state
    job.current = 2
    job.error_message = error
    return job


def test_last_job_none_without_jobs(client, as_admin, monkeypatch):
    monkeypatch.setattr(laser_service, "_jobs", {})
    assert client.get("/api/laser/job/last", params={"host": HOST}).json() == {"job": None}


def test_last_job_reports_error(client, as_admin, monkeypatch):
    monkeypatch.setattr(laser_service, "_jobs", {HOST: _job("error", "error:21 (línea 3)")})
    data = client.get("/api/laser/job/last", params={"host": HOST}).json()["job"]
    assert data["state"] == "error"
    assert data["filename"] == "dibujo.gcode"
    assert data["error"] == "error:21 (línea 3)"
    assert data["current"] == 2 and data["total"] == 3


def test_last_job_hidden_while_running(client, as_admin, monkeypatch):
    monkeypatch.setattr(laser_service, "_jobs", {HOST: _job("running")})
    assert client.get("/api/laser/job/last", params={"host": HOST}).json() == {"job": None}


def test_last_job_requires_host(client, as_admin):
    assert client.get("/api/laser/job/last").status_code == 400
