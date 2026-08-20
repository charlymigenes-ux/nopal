"""Subida a la SD del láser -- progreso real (ver sd_upload_file_tracked en
laser_service.py). No se prueba contra hardware real (esa placa tiene
archivos de producción reales); acá solo se cubre el contrato HTTP: el
endpoint de subida devuelve un upload_id sin bloquear, y el de progreso
responde 404 para un id que no existe.
"""

import backend.api.laser as laser_api


class TestSdUploadProgress:
    def test_unknown_upload_id_returns_404(self, client, as_operator):
        response = client.get("/api/laser/sd/upload-progress/no-existe")
        assert response.status_code == 404

    def test_upload_endpoint_returns_upload_id_without_blocking(self, client, as_operator, monkeypatch):
        # No se toca la red real -- se reemplaza la subida trackeada por un
        # no-op para confirmar solo el contrato del endpoint (responde
        # rápido con un upload_id, no espera a que la subida termine).
        calls = []
        monkeypatch.setattr(laser_api, "sd_upload_file_tracked", lambda *args, **kwargs: calls.append(args))

        response = client.post(
            "/api/laser/sd/upload",
            data={"path": "/", "host": "192.0.2.1"},
            files={"file": ("test.gc", b"G0 X0 Y0\n", "text/plain")},
        )
        assert response.status_code == 200
        assert "upload_id" in response.json()

    def test_clear_progress_endpoint_ok(self, client, as_operator):
        response = client.post("/api/laser/sd/upload-progress/no-existe/clear")
        assert response.status_code == 200
        assert response.json()["success"] is True
