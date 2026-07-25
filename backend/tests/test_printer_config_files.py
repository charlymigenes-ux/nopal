import backend.api.printers as printers_api


class TestListConfigFiles:
    def test_lists_files(self, client, as_admin, monkeypatch):
        files = [{"path": "printer.cfg", "size": 2048, "modified": 1234.0}]
        monkeypatch.setattr(printers_api, "get_printer_config_files", lambda port: files)
        response = client.get("/api/printers/7125/config-files")
        assert response.status_code == 200
        assert response.json() == {"files": files}


class TestReadConfigFile:
    def test_reads_content(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(printers_api, "get_printer_config_file_content", lambda port, path: "[printer]\nkinematics: corexy\n")
        response = client.get("/api/printers/7125/config-files/content", params={"path": "printer.cfg"})
        assert response.status_code == 200
        assert response.json() == {"content": "[printer]\nkinematics: corexy\n"}

    def test_unreadable_file_returns_404(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(printers_api, "get_printer_config_file_content", lambda port, path: None)
        response = client.get("/api/printers/7125/config-files/content", params={"path": "printer.cfg"})
        assert response.status_code == 404

    def test_path_traversal_rejected(self, client, as_admin, monkeypatch):
        called = []
        monkeypatch.setattr(printers_api, "get_printer_config_file_content", lambda port, path: called.append(path))
        response = client.get("/api/printers/7125/config-files/content", params={"path": "../../etc/passwd"})
        assert response.status_code == 400
        assert called == []


class TestSaveConfigFile:
    def test_saves_content(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(printers_api, "save_printer_config_file", lambda port, path, content: True)
        response = client.post(
            "/api/printers/7125/config-files/content",
            data={"path": "printer.cfg", "content": "[printer]\n"},
        )
        assert response.status_code == 200
        assert response.json() == {"success": True}

    def test_save_failure_returns_400(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(printers_api, "save_printer_config_file", lambda port, path, content: False)
        response = client.post(
            "/api/printers/7125/config-files/content",
            data={"path": "printer.cfg", "content": "[printer]\n"},
        )
        assert response.status_code == 400

    def test_path_traversal_rejected(self, client, as_admin, monkeypatch):
        called = []
        monkeypatch.setattr(printers_api, "save_printer_config_file", lambda port, path, content: called.append(path) or True)
        response = client.post(
            "/api/printers/7125/config-files/content",
            data={"path": "../../etc/passwd", "content": "pwned"},
        )
        assert response.status_code == 400
        assert called == []
