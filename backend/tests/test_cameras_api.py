import asyncio

import backend.api.cameras as cameras_api
import backend.services.camera_service as camera_service


class TestCameraRegisterOnvif:
    def test_full_url_skips_autoscan(self, client, as_admin, monkeypatch):
        calls = []

        def fake_resolve_from_url(device_url, username, password, timeout=8):
            calls.append(device_url)
            return "rtsp://192.168.0.76:554/stream1"

        def fake_autoscan(*args, **kwargs):
            raise AssertionError("no debería llamar al autoscan si se dio onvif_url")

        monkeypatch.setattr(cameras_api, "resolve_rtsp_uri_from_url", fake_resolve_from_url)
        monkeypatch.setattr(cameras_api, "resolve_rtsp_uri_autoscan", fake_autoscan)

        response = client.post("/api/cameras/onvif", data={
            "name": "DVR", "onvif_url": "http://192.168.0.76:8899/onvif/device_service",
            "username": "admin", "password": "secret",
        })
        assert response.status_code == 200
        assert calls == ["http://192.168.0.76:8899/onvif/device_service"]
        assert response.json()["source_url"] == "rtsp://192.168.0.76:554/stream1"

    def test_host_autoscan_still_works(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(cameras_api, "resolve_rtsp_uri_autoscan", lambda host, username, password, port: ("rtsp://192.168.0.76:554/stream1", 8899))
        response = client.post("/api/cameras/onvif", data={
            "name": "DVR", "host": "192.168.0.76", "username": "admin", "password": "secret",
        })
        assert response.status_code == 200
        assert response.json()["onvif_port"] == 8899

    def test_requires_host_or_onvif_url(self, client, as_admin):
        response = client.post("/api/cameras/onvif", data={"name": "DVR", "username": "admin", "password": "secret"})
        assert response.status_code == 400

    def test_onvif_failure_returns_400_and_does_not_save(self, client, as_admin, monkeypatch):
        def fake_resolve_from_url(*args, **kwargs):
            raise ValueError("El dispositivo rechazó las credenciales ONVIF")

        monkeypatch.setattr(cameras_api, "resolve_rtsp_uri_from_url", fake_resolve_from_url)
        response = client.post("/api/cameras/onvif", data={
            "name": "DVR", "onvif_url": "http://192.168.0.76:8899/onvif/device_service",
            "username": "admin", "password": "wrong",
        })
        assert response.status_code == 400
        assert client.get("/api/cameras").json()["cameras"] == []


class TestCameraRegisterDirectUrl:
    def test_register_success(self, client, as_admin):
        response = client.post("/api/cameras", data={"name": "Cama", "stream_url": "http://192.168.1.50:8080/stream"})
        assert response.status_code == 200
        body = response.json()
        assert body["name"] == "Cama"
        assert body["source_url"] == "http://192.168.1.50:8080/stream"

    def test_requires_admin(self, client, as_operator):
        response = client.post("/api/cameras", data={"name": "Cama", "stream_url": "http://192.168.1.50:8080/stream"})
        assert response.status_code == 403

    def test_empty_url_rejected(self, client, as_admin):
        response = client.post("/api/cameras", data={"name": "Cama", "stream_url": "   "})
        assert response.status_code == 400

    def test_list_requires_only_auth_not_admin(self, client, as_operator):
        response = client.get("/api/cameras")
        assert response.status_code == 200


class TestCameraRegistryBackwardCompatibility:
    def test_old_style_entry_without_new_fields_still_lists_fine(self, client, as_admin, isolated_printer_registries):
        # Simula un registro viejo (de antes de purpose/bound_device/device_path)
        # escrito directo al archivo, como hubiera quedado en una instalación
        # real que ya tenía cámaras antes de esta entrega.
        import json
        registry_path = camera_service.REGISTRY_PATH
        with open(registry_path, "w", encoding="utf-8") as handle:
            json.dump([{
                "id": "legacy1",
                "name": "Cámara vieja",
                "source_url": "http://192.168.1.60:8080/stream",
                "registered_at": 1700000000.0,
            }], handle)

        response = client.get("/api/cameras")
        assert response.status_code == 200
        cameras = response.json()["cameras"]
        assert len(cameras) == 1
        assert cameras[0]["name"] == "Cámara vieja"
        assert cameras[0].get("purpose") is None
        assert cameras[0].get("device_path") is None


class TestCameraRemove:
    def test_remove_requires_admin(self, client, as_operator):
        response = client.post("/api/cameras/remove", data={"id": "whatever"})
        assert response.status_code == 403

    def test_remove_unknown_returns_404(self, client, as_admin):
        response = client.post("/api/cameras/remove", data={"id": "does-not-exist"})
        assert response.status_code == 404

    def test_remove_existing_camera(self, client, as_admin):
        created = client.post("/api/cameras", data={"name": "Temp", "stream_url": "http://192.168.1.70:8080/stream"}).json()
        response = client.post("/api/cameras/remove", data={"id": created["id"]})
        assert response.status_code == 200
        assert not any(c["id"] == created["id"] for c in client.get("/api/cameras").json()["cameras"])


class TestUsbDiscover:
    def test_discover_requires_auth(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(cameras_api.usb_camera_service, "list_usb_video_devices", lambda: [
            {"device_path": "/dev/video0", "usb_location": "1-2", "name": "GENERAL WEBCAM", "driver": "uvcvideo", "vendor_id": "1b3f", "product_id": "2247"},
        ])
        response = client.get("/api/cameras/usb/discover")
        assert response.status_code == 200
        assert response.json()["devices"][0]["name"] == "GENERAL WEBCAM"

    def test_discover_empty(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(cameras_api.usb_camera_service, "list_usb_video_devices", lambda: [])
        response = client.get("/api/cameras/usb/discover")
        assert response.status_code == 200
        assert response.json()["devices"] == []


class TestUsbRegister:
    def test_register_rejects_missing_device(self, client, as_admin):
        response = client.post("/api/cameras/usb/register", data={
            "name": "Webcam Taller", "device_path": "/dev/video-does-not-exist",
        })
        assert response.status_code == 400

    def test_register_monitoring_purpose(self, client, as_admin, tmp_path):
        fake_device = tmp_path / "video0"
        fake_device.write_bytes(b"")
        response = client.post("/api/cameras/usb/register", data={
            "name": "Webcam Taller", "device_path": str(fake_device), "purpose": "monitoring",
        })
        assert response.status_code == 200
        body = response.json()
        assert body["purpose"] == "monitoring"
        assert body["device_path"] == str(fake_device)
        assert body["source_url"] == f"/api/cameras/usb/{body['id']}/stream"

    def test_register_timelapse_purpose_with_bound_device(self, client, as_admin, tmp_path):
        fake_device = tmp_path / "video0"
        fake_device.write_bytes(b"")
        response = client.post("/api/cameras/usb/register", data={
            "name": "Webcam Impresora", "device_path": str(fake_device),
            "purpose": "timelapse", "bound_device_type": "bambu", "bound_device_id": "01S00A123456789",
        })
        assert response.status_code == 200
        body = response.json()
        assert body["purpose"] == "timelapse"
        assert body["bound_device"] == {"type": "bambu", "id": "01S00A123456789"}

    def test_register_other_purpose_keeps_note(self, client, as_admin, tmp_path):
        fake_device = tmp_path / "video0"
        fake_device.write_bytes(b"")
        response = client.post("/api/cameras/usb/register", data={
            "name": "Webcam", "device_path": str(fake_device),
            "purpose": "other", "purpose_note": "Vigilar la impresora de resina",
        })
        assert response.status_code == 200
        body = response.json()
        assert body["purpose_note"] == "Vigilar la impresora de resina"
        # confirma que quedó persistido, no solo en la respuesta del POST
        listed = client.get("/api/cameras").json()["cameras"]
        assert next(c for c in listed if c["id"] == body["id"])["purpose_note"] == "Vigilar la impresora de resina"

    def test_register_requires_admin(self, client, as_operator, tmp_path):
        fake_device = tmp_path / "video0"
        fake_device.write_bytes(b"")
        response = client.post("/api/cameras/usb/register", data={"name": "Webcam", "device_path": str(fake_device)})
        assert response.status_code == 403


class TestUsbStream:
    def test_stream_unknown_camera_404(self, client, as_admin):
        response = client.get("/api/cameras/usb/does-not-exist/stream")
        assert response.status_code == 404

    def test_stream_non_usb_camera_404(self, client, as_admin):
        created = client.post("/api/cameras", data={"name": "Red", "stream_url": "http://192.168.1.80:8080/stream"}).json()
        response = client.get(f"/api/cameras/usb/{created['id']}/stream")
        assert response.status_code == 404

    def test_stream_subscribes_when_ffmpeg_unavailable_returns_503(self, client, as_admin, monkeypatch, tmp_path):
        fake_device = tmp_path / "video0"
        fake_device.write_bytes(b"")
        created = client.post("/api/cameras/usb/register", data={"name": "Webcam", "device_path": str(fake_device)}).json()

        async def fake_subscribe(camera_id, device_path):
            raise RuntimeError("ffmpeg no está instalado en este equipo (instalalo con: sudo apt install ffmpeg)")

        monkeypatch.setattr(cameras_api.usb_camera_service, "subscribe", fake_subscribe)
        response = client.get(f"/api/cameras/usb/{created['id']}/stream")
        assert response.status_code == 503
