"""Regresión de S-1: la subida de la biblioteca no debe poder escribir fuera
de uploads/ manipulando el nombre de archivo que manda el cliente."""

import pytest

from backend import utils


@pytest.fixture
def upload_roots(tmp_path, monkeypatch):
    """Biblioteca aislada en tmp_path/uploads; todo lo demás de tmp_path
    hace de "afuera" para comprobar que nada se escribió ahí."""
    models_root = tmp_path / "uploads" / "models"
    gcode_root = tmp_path / "uploads" / "gcode"
    models_root.mkdir(parents=True)
    gcode_root.mkdir(parents=True)
    monkeypatch.setattr(utils, "MODELS_ROOT", str(models_root))
    monkeypatch.setattr(utils, "GCODE_ROOT", str(gcode_root))
    return tmp_path, models_root, gcode_root


def _upload(client, filename, path="", type_="model", content=b"solid x\nendsolid x\n"):
    return client.post(
        "/api/upload",
        files={"file": (filename, content, "application/octet-stream")},
        data={"path": path, "type": type_},
    )


def _files_outside_uploads(tmp_path):
    uploads = tmp_path / "uploads"
    return [p for p in tmp_path.rglob("*") if p.is_file() and uploads not in p.parents]


MALICIOUS_NAMES = [
    "../archivo.txt",
    "../../archivo.txt",
    "../../../archivo.txt",
    "sub/../../archivo.txt",
    "..\\archivo.txt",
    "..\\..\\archivo.txt",
    "carpeta\\archivo.txt",
    "carpeta/archivo.txt",
    "..",
    ".",
]


class TestRejectsMaliciousNames:
    @pytest.mark.parametrize("filename", MALICIOUS_NAMES)
    def test_relative_traversal_rejected(self, client, as_operator, upload_roots, filename):
        tmp_path, models_root, _ = upload_roots
        response = _upload(client, filename, path="sub")

        assert response.status_code == 400
        assert _files_outside_uploads(tmp_path) == []
        assert not any(p.is_file() for p in models_root.rglob("*"))

    def test_absolute_path_rejected(self, client, as_operator, upload_roots):
        tmp_path, models_root, _ = upload_roots
        target = tmp_path / "absoluto.txt"

        response = _upload(client, str(target))

        assert response.status_code == 400
        assert not target.exists()
        assert _files_outside_uploads(tmp_path) == []

    def test_gcode_section_also_protected(self, client, as_operator, upload_roots):
        tmp_path, _, gcode_root = upload_roots
        response = _upload(client, "../../archivo.gcode", type_="gcode")

        assert response.status_code == 400
        assert _files_outside_uploads(tmp_path) == []
        assert not any(p.is_file() for p in gcode_root.rglob("*"))

    def test_error_does_not_leak_server_paths(self, client, as_operator, upload_roots):
        tmp_path, _, _ = upload_roots
        response = _upload(client, "../../archivo.txt")

        assert response.status_code == 400
        assert str(tmp_path) not in response.text
        assert "uploads" not in response.text

    def test_folder_traversal_still_rejected(self, client, as_operator, upload_roots):
        tmp_path, _, _ = upload_roots
        response = _upload(client, "pieza.stl", path="../..")

        assert response.status_code == 400
        assert _files_outside_uploads(tmp_path) == []

    def test_requires_auth(self, client, upload_roots):
        response = _upload(client, "pieza.stl")
        assert response.status_code == 401


class TestValidUploads:
    def test_simple_name_written_in_section_root(self, client, as_operator, upload_roots):
        _, models_root, _ = upload_roots
        response = _upload(client, "pieza.stl", content=b"contenido")

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["filename"] == "pieza.stl"
        assert (models_root / "pieza.stl").read_bytes() == b"contenido"

    def test_name_into_subfolder_created_on_demand(self, client, as_operator, upload_roots):
        _, models_root, _ = upload_roots
        response = _upload(client, "pieza final.3mf", path="Clientes/Acme")

        assert response.status_code == 200
        assert (models_root / "Clientes" / "Acme" / "pieza final.3mf").is_file()

    def test_gcode_goes_to_gcode_section(self, client, as_operator, upload_roots):
        _, models_root, gcode_root = upload_roots
        response = _upload(client, "formas-2026.gcode", path="Creador de Formas", type_="gcode")

        assert response.status_code == 200
        assert (gcode_root / "Creador de Formas" / "formas-2026.gcode").is_file()
        assert not any(p.is_file() for p in models_root.rglob("*"))

    def test_response_path_is_relative(self, client, as_operator, upload_roots):
        tmp_path, _, _ = upload_roots
        response = _upload(client, "pieza.stl", path="sub")

        assert response.json()["path"] == "sub/pieza.stl"
        assert str(tmp_path) not in response.text

    def test_dotted_but_valid_names_allowed(self, client, as_operator, upload_roots):
        _, models_root, _ = upload_roots
        for name in ("pieza..v2.stl", ".oculto.svg", "acentos ñ á.svg"):
            response = _upload(client, name)
            assert response.status_code == 200, name
            assert (models_root / name).is_file()
