import backend.services.tunascreen_service as tunascreen_service


class TestDevicesRegistryEndpoint:
    def test_requires_auth(self, client):
        response = client.get("/api/devices/registry")
        assert response.status_code == 401

    def test_returns_list_machines_snapshot(self, client, as_admin, monkeypatch):
        fake_machines = [
            {"id": "marlin:/dev/ttyUSB0", "name": "Anet ET4 Pro", "driver": "marlin", "online": True},
            {"id": "laser:usb:/dev/ttyUSB1", "name": "Sculpfun S30 Pro", "driver": "grbl", "online": False},
        ]

        async def fake_list_machines():
            return fake_machines

        monkeypatch.setattr(tunascreen_service, "list_machines", fake_list_machines)

        response = client.get("/api/devices/registry")
        assert response.status_code == 200
        assert response.json() == {"machines": fake_machines}
