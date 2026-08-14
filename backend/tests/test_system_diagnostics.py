"""GET /api/system/diagnostics -- info de "Acerca de NOPAL" (versión, git,
sistema operativo, arquitectura, Python). El idioma activo no viaja acá
porque es un dato del navegador, no del servidor."""

from backend.api import status as status_api


class TestDiagnostics:
    def test_requiere_sesion(self, client):
        assert client.get("/api/system/diagnostics").status_code in (401, 403)

    def test_trae_los_campos_basicos(self, client, as_admin):
        respuesta = client.get("/api/system/diagnostics")
        assert respuesta.status_code == 200
        cuerpo = respuesta.json()
        for campo in ("app_version", "commit", "branch", "os", "architecture", "python_version"):
            assert campo in cuerpo

    def test_version_viene_del_archivo_VERSION(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(status_api, "get_app_version", lambda: "9.9.9-test")
        cuerpo = client.get("/api/system/diagnostics").json()
        assert cuerpo["app_version"] == "9.9.9-test"

    def test_sin_git_el_commit_es_none(self, client, as_admin, monkeypatch):
        """NOPAL puede correr desde un .zip sin .git -- _run_git ya
        devuelve None en ese caso (ver su propio manejo de errores), y acá
        no debe inventarse un valor."""
        monkeypatch.setattr(status_api, "_run_git", lambda *a, **k: None)
        cuerpo = client.get("/api/system/diagnostics").json()
        assert cuerpo["commit"] is None
        assert cuerpo["branch"] is None

    def test_con_git_trae_commit_y_rama_reales(self, client, as_admin, monkeypatch):
        monkeypatch.setattr(status_api, "_run_git", lambda args, **k: {
            ("rev-parse", "--short", "HEAD"): "a83fc21",
            ("rev-parse", "--abbrev-ref", "HEAD"): "main",
        }.get(tuple(args)))
        cuerpo = client.get("/api/system/diagnostics").json()
        assert cuerpo["commit"] == "a83fc21"
        assert cuerpo["branch"] == "main"

    def test_arquitectura_y_python_son_los_reales_del_proceso(self, client, as_admin):
        import platform
        cuerpo = client.get("/api/system/diagnostics").json()
        assert cuerpo["architecture"] == platform.machine()
        assert cuerpo["python_version"] == platform.python_version()

    def test_os_no_es_solo_linux_a_secas(self, client, as_admin):
        """platform.system() a secas ("Linux") no ayuda a diagnosticar nada
        -- debe traer distribución+versión cuando esté disponible."""
        cuerpo = client.get("/api/system/diagnostics").json()
        assert cuerpo["os"] and cuerpo["os"] != "Linux"
