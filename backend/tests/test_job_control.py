"""Historial de trabajos con control: usuario por trabajo, bajas con motivo (solo admin, solo fallidos o
incompletos), registro de control y exportación. Sin red ni hardware: las fuentes se simulan."""

import asyncio
import time
import xml.etree.ElementTree as ET

import pytest

import backend.api.jobs as jobs_api
import backend.services.job_control_service as control
import backend.services.laser_service as laser_service
from backend.tests.conftest import ADMIN_USER, OPERATOR_USER

NOW = time.time()
REGISTRY = [{"id": "mch_laser", "host": "192.168.0.50", "name": "TTS 55 PRO", "kind": "laser"},
            {"id": "mch_cnc", "host": "192.168.0.72", "name": "CNC 3018", "kind": "cnc"}]


def entry(id_, state, host="192.168.0.72", filename="dibujo.gc", user="ana", ago=600, machine="mch_cnc"):
    return {"id": id_, "host": host, "machine_id": f"laser:{machine}", "filename": filename, "source": "sd", "state": state,
            "current": 10, "total": 100, "error": "error:21 (línea 5)" if state == "error" else None, "user": user,
            "started_at": NOW - ago - 120, "completed_at": None if state == "running" else NOW - ago}


@pytest.fixture
def sources(monkeypatch):
    """Historial láser/CNC y de impresoras 3D simulados."""
    data = {"laser": [entry("a1", "completed"), entry("a2", "error", ago=1200), entry("a3", "cancelled", host="192.168.0.50",
                                                                                      machine="mch_laser", ago=2400),
                      entry("a4", "running", ago=60)],
            "printers": [{"printer": "Klipper ET4", "port": 7125, "jobs": [
                {"filename": "cactus.gcode", "status": "completed", "end_time": NOW - 300, "print_duration": 3600,
                 "thumbnail_url": "http://x/t.png", "file_url": "http://h:7125/server/files/gcodes/cactus.gcode"},
                {"filename": "falla.gcode", "status": "error", "end_time": NOW - 900, "print_duration": 120,
                 "thumbnail_url": None, "file_url": "http://h:7125/server/files/gcodes/sub/falla.gcode"}]}]}
    monkeypatch.setattr(laser_service, "get_laser_history", lambda limit=50: [dict(e) for e in data["laser"]])
    monkeypatch.setattr(laser_service, "_load_registry", lambda: REGISTRY)
    monkeypatch.setattr(jobs_api, "_printers", lambda host: [dict(p) for p in data["printers"]])
    monkeypatch.setattr(jobs_api, "library_index", lambda: {"dibujo.gc": {"section": "gcode", "path": "dibujo.gc"}})
    return data


class TestRows:
    def test_unified_list_has_kind_status_user_and_machine(self, client, as_operator, sources):
        body = client.get("/api/jobs/history", params={"days": 0}).json()
        by_id = {r["id"]: r for r in body["items"]}
        assert by_id["a1"]["kind"] == "cnc" and by_id["a1"]["machine"] == "CNC 3018" and by_id["a1"]["user"] == "ana"
        assert by_id["a3"]["kind"] == "laser" and by_id["a3"]["machine"] == "TTS 55 PRO"
        assert by_id["a4"]["status"] == "running"
        three_d = [r for r in body["items"] if r["kind"] == "3d"]
        assert {r["name"] for r in three_d} == {"cactus.gcode", "falla.gcode"}
        assert body["summary"] == {"3d": 2, "laser": 1, "cnc": 3, "total": 6}

    def test_only_failed_or_incomplete_are_deletable_and_library_file_is_found(self, client, as_operator, sources):
        rows = {r["id"]: r for r in client.get("/api/jobs/history", params={"days": 0}).json()["items"]}
        assert rows["a1"]["deletable"] is False and rows["a4"]["deletable"] is False
        assert rows["a2"]["deletable"] is True and rows["a3"]["deletable"] is True
        assert rows["a1"]["library"] == {"section": "gcode", "path": "dibujo.gc"} and rows["a2"]["library"]
        falla = next(r for r in rows.values() if r["name"] == "falla.gcode")
        assert falla["deletable"] and falla["remote_path"] == "sub/falla.gcode" and falla["library"] is None

    def test_filters_and_pagination(self, client, as_operator, sources):
        r = client.get("/api/jobs/history", params={"days": 0, "kind": "cnc", "page_size": 8}).json()
        assert [x["kind"] for x in r["items"]] == ["cnc", "cnc", "cnc"] and r["total"] == 3
        assert r["summary"]["total"] == 6                                  # el resumen cuenta todos los tipos
        assert client.get("/api/jobs/history", params={"days": 0, "q": "CACT"}).json()["total"] == 1
        assert client.get("/api/jobs/history", params={"days": 0, "kind": "x"}).status_code == 400
        sources["laser"][0]["completed_at"] = NOW - 40 * 86400
        sources["laser"][0]["started_at"] = NOW - 40 * 86400 - 60
        assert client.get("/api/jobs/history", params={"days": 30, "q": "dibujo"}).json()["total"] == 3     # sin el de hace 40 días

    def test_pagination_clamps_the_page(self, client, as_operator, sources):
        r = client.get("/api/jobs/history", params={"days": 0, "page": 99}).json()
        assert r["page"] == r["pages"] == 1


class TestUserOfAPrint:
    LOG = [{"id": "p1", "brand": "klipper", "machine_id": "klipper:7125", "machine_name": "7125", "filename": "cactus.gcode",
            "user": "luis", "sent_at": NOW - 4000}]

    def test_matches_the_last_send_of_that_file_to_that_machine(self):
        assert control.print_user(["klipper:7125"], "cactus.gcode", NOW - 3700, self.LOG) == "luis"
        assert control.print_user(["klipper:7125"], "otro.gcode", NOW - 3700, self.LOG) == ""
        assert control.print_user(["klipper:9999"], "cactus.gcode", NOW - 3700, self.LOG) == ""
        assert control.print_user(["klipper:7125"], "cactus.gcode", NOW + 20 * 3600, self.LOG) == ""    # demasiado tarde

    def test_a_job_started_elsewhere_has_no_user(self, client, as_operator, sources):
        three_d = {r["name"]: r for r in client.get("/api/jobs/history", params={"days": 0}).json()["items"] if r["kind"] == "3d"}
        assert three_d["cactus.gcode"]["user"] == ""

    def test_sent_to_other_brands_stay_in_control_as_sent(self, client, as_operator, sources):
        control.record_print_sent("elegoo", "e1", "Centauri", "pieza.gcode", "ana")
        control._write(control.PRINT_LOG_PATH, control._read(control.PRINT_LOG_PATH) + [
            {"id": "k1", "brand": "klipper", "machine_id": "klipper:7125", "machine_name": "7125",
             "filename": "cactus.gcode", "user": "luis", "sent_at": NOW - 4000}])
        items = client.get("/api/jobs/history", params={"days": 0}).json()["items"]
        sent = [r for r in items if r["status"] == "sent"]
        assert len(sent) == 1 and sent[0]["user"] == "ana" and sent[0]["name"] == "pieza.gcode" and not sent[0]["deletable"]
        cactus = next(r for r in items if r["name"] == "cactus.gcode" and r["kind"] == "3d" and r["status"] != "sent")
        assert cactus["user"] == "luis"                                  # el envío de NOPAL le pone nombre a la impresión


class TestDeletion:
    def delete(self, client, id_, reason="Se atoró el filamento"):
        return client.post("/api/jobs/history/delete", data={"id": id_, "reason": reason})

    def test_admin_deletes_a_failed_job_with_a_reason_and_it_leaves_a_record(self, client, as_admin, sources):
        r = self.delete(client, "a2")
        assert r.status_code == 200 and r.json()["deletion"]["reason"] == "Se atoró el filamento"
        assert r.json()["deletion"]["deleted_by"] == ADMIN_USER["username"]
        ids = {x["id"] for x in client.get("/api/jobs/history", params={"days": 0}).json()["items"]}
        assert "a2" not in ids
        log = client.get("/api/jobs/deletions").json()
        assert log["total"] == 1 and log["deletions"][0]["job"]["name"] == "dibujo.gc" and log["deletions"][0]["job"]["status"] == "error"
        assert self.delete(client, "a2").status_code == 400                    # ya estaba dado de baja

    def test_a_completed_job_is_never_deleted_not_even_by_the_admin(self, client, as_admin, sources):
        r = self.delete(client, "a1")
        assert r.status_code == 400 and "completados no se eliminan" in r.json()["detail"]
        assert client.get("/api/jobs/deletions").json()["total"] == 0

    def test_a_running_job_cannot_be_deleted(self, client, as_admin, sources):
        assert self.delete(client, "a4").status_code == 400

    @pytest.mark.parametrize("reason", ["", "  ", "ab", "x" * 301])
    def test_the_reason_is_required(self, client, as_admin, sources, reason):
        assert self.delete(client, "a2", reason).status_code == 400

    def test_the_operator_cannot_delete_or_read_the_control_log(self, client, as_operator, sources):
        assert self.delete(client, "a2").status_code == 403
        assert client.get("/api/jobs/deletions").status_code == 403

    def test_unknown_job_and_3d_jobs(self, client, as_admin, sources):
        assert self.delete(client, "no-existe").status_code == 400
        falla = next(r for r in client.get("/api/jobs/history", params={"days": 0}).json()["items"] if r["name"] == "falla.gcode")
        assert self.delete(client, falla["id"]).status_code == 200
        assert all(r["name"] != "falla.gcode" for r in client.get("/api/jobs/history", params={"days": 0}).json()["items"])

    def test_requires_a_session(self, client):
        assert client.post("/api/jobs/history/delete", data={"id": "a2", "reason": "motivo"}).status_code in (401, 403)


class TestExport:
    def test_xml_lists_what_the_filters_show(self, client, as_operator, sources):
        r = client.get("/api/jobs/history/export", params={"format": "xml", "days": 0, "kind": "cnc"})
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/xml")
        assert "historial-trabajos-" in r.headers["content-disposition"] and r.headers["content-disposition"].endswith('.xml"')
        root = ET.fromstring(r.content)
        jobs = root.findall("./trabajos/trabajo")
        assert len(jobs) == 3 and {j.get("tipo") for j in jobs} == {"CNC"}
        assert {j.find("usuario").text for j in jobs} == {"ana"}
        assert root.get("por") == OPERATOR_USER["username"]
        assert {t.get("nombre"): t.get("trabajos") for t in root.findall("./resumen/tipo")}["Total"] == "6"

    def test_pdf_is_a_real_pdf(self, client, as_operator, sources):
        r = client.get("/api/jobs/history/export", params={"format": "pdf", "days": 0})
        assert r.status_code == 200 and r.content.startswith(b"%PDF") and r.headers["content-type"] == "application/pdf"

    def test_deleted_jobs_are_not_exported_and_bad_format_is_rejected(self, client, as_admin, sources):
        client.post("/api/jobs/history/delete", data={"id": "a2", "reason": "prueba de calibración"})
        root = ET.fromstring(client.get("/api/jobs/history/export", params={"format": "xml", "days": 0}).content)
        assert "a2" not in {j.get("id") for j in root.findall("./trabajos/trabajo")}
        assert client.get("/api/jobs/history/export", params={"format": "docx"}).status_code == 400


class TestLaserHistoryControl:
    def test_a_job_is_in_the_history_from_the_moment_it_is_sent_and_gets_its_user(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {})
        monkeypatch.setattr(laser_service, "_load_registry", lambda: REGISTRY)

        async def go():
            monkeypatch.setattr(laser_service, "_run_job", lambda job: asyncio.sleep(0))
            return laser_service.start_job("192.168.0.72", "G0 X1\nG1 X2 F100", "dibujo.gc", user="ana")

        info = asyncio.run(go())
        started = laser_service.get_laser_history()[0]
        assert started["id"] == info["job_id"] and started["state"] == "running" and started["user"] == "ana"
        job = laser_service._jobs["192.168.0.72"]
        job.state, job.current = "completed", 2
        laser_service.record_laser_job_history(job)
        history = laser_service.get_laser_history()
        assert len(history) == 1 and history[0]["state"] == "completed" and history[0]["completed_at"] and history[0]["user"] == "ana"

    def test_jobs_left_running_when_nopal_restarts_become_incomplete(self, monkeypatch):
        monkeypatch.setattr(laser_service, "_jobs", {})
        laser_service._save_history([entry("z1", "running"), entry("z2", "completed")])
        assert laser_service.reconcile_laser_history() == 1
        states = {e["id"]: e["state"] for e in laser_service.get_laser_history()}
        assert states == {"z1": "incomplete", "z2": "completed"}
        assert "reinici" in laser_service.get_laser_history()[0]["error"]
        assert laser_service.reconcile_laser_history() == 0

    def test_old_entries_without_id_get_a_stable_one(self):
        old = {"host": "h", "started_at": 5.0, "filename": "f.gc", "state": "completed"}
        laser_service._save_history([old])
        first = laser_service.get_laser_history()[0]["id"]
        assert first.startswith("h") and laser_service.get_laser_history()[0]["id"] == first


class TestSendsAreRecorded:
    def test_klipper_send_records_who_sent_it(self, client, as_operator, monkeypatch):
        import backend.api.printers as printers_api
        monkeypatch.setattr(printers_api, "send_gcode_to_printer", lambda port, path, mode, section: {"success": True})
        assert client.post("/api/printers/7125/send", data={"path": "carpeta/cactus.gcode", "mode": "print"}).status_code == 200
        log = control._read(control.PRINT_LOG_PATH)
        assert len(log) == 1 and log[0]["user"] == OPERATOR_USER["username"] and log[0]["filename"] == "cactus.gcode"
        assert log[0]["machine_id"] == "klipper:7125" and log[0]["brand"] == "klipper"

    def test_queueing_is_not_a_print_yet(self, client, as_operator, monkeypatch):
        import backend.api.printers as printers_api
        monkeypatch.setattr(printers_api, "send_gcode_to_printer", lambda port, path, mode, section: {"success": True})
        client.post("/api/printers/7125/send", data={"path": "cactus.gcode", "mode": "queue"})
        assert control._read(control.PRINT_LOG_PATH) == []

    def test_a_failed_send_is_not_recorded(self, client, as_operator, monkeypatch):
        import backend.api.printers as printers_api
        monkeypatch.setattr(printers_api, "send_gcode_to_printer", lambda *a: {"success": False, "error": "x"})
        assert client.post("/api/printers/7125/send", data={"path": "cactus.gcode"}).status_code == 400
        assert control._read(control.PRINT_LOG_PATH) == []

    def test_reprint_klipper(self, client, as_operator, monkeypatch):
        class Fake:
            def __init__(self, port): self.port = port
            def start_print(self, path): return path == "sub/falla.gcode"
        monkeypatch.setattr(jobs_api.klipper_service, "MoonrakerClient", Fake)
        assert client.post("/api/jobs/reprint-klipper", data={"port": 7125, "path": "sub/falla.gcode"}).status_code == 200
        assert control._read(control.PRINT_LOG_PATH)[0]["user"] == OPERATOR_USER["username"]
        assert client.post("/api/jobs/reprint-klipper", data={"port": 7125, "path": "../etc"}).status_code == 400
        assert client.post("/api/jobs/reprint-klipper", data={"port": 7125, "path": "otro.gcode"}).status_code == 409
