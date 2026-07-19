import pytest
from fastapi.testclient import TestClient

import backend.services.bambu_service as bambu_service
import backend.services.elegoo_service as elegoo_service
import backend.services.flashforge_service as flashforge_service
from backend.auth_deps import require_auth
from backend.main import app

ADMIN_USER = {"id": "test-admin", "username": "test-admin", "role": "admin"}
OPERATOR_USER = {"id": "test-operator", "username": "test-operator", "role": "operator"}


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def as_admin():
    """Simula una sesión de administrador sin pasar por SessionMiddleware
    real -- alcanza con reemplazar `require_auth`, ya que `require_role`
    depende de él internamente para saber quién es el usuario (ver
    backend/auth_deps.py:25-33)."""
    app.dependency_overrides[require_auth] = lambda: ADMIN_USER
    yield ADMIN_USER
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def as_operator():
    """Mismo mecanismo que `as_admin` pero con rol no-admin -- usado para
    confirmar que los endpoints admin-only devuelven 403."""
    app.dependency_overrides[require_auth] = lambda: OPERATOR_USER
    yield OPERATOR_USER
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture(autouse=True)
def isolated_printer_registries(tmp_path, monkeypatch):
    """Aísla el REGISTRY_PATH de las 3 marcas a un directorio temporal por
    test -- sin esto, correr la suite escribiría/leería los
    *_printer_registry.json reales del repo. autouse=True porque olvidar
    pedirlo en un test nuevo sería un riesgo real, no cosmético."""
    monkeypatch.setattr(bambu_service, "REGISTRY_PATH", str(tmp_path / "bambu_printer_registry.json"))
    monkeypatch.setattr(elegoo_service, "REGISTRY_PATH", str(tmp_path / "elegoo_printer_registry.json"))
    monkeypatch.setattr(flashforge_service, "REGISTRY_PATH", str(tmp_path / "flashforge_printer_registry.json"))
    yield tmp_path
