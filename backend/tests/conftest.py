import pytest
from fastapi.testclient import TestClient

import backend.services.ai_config_service as ai_config_service
import backend.services.gcode_bounds as gcode_bounds
import backend.services.ai_conversations_service as ai_conversations_service
import backend.services.bambu_service as bambu_service
import backend.services.elegoo_service as elegoo_service
import backend.services.flashforge_service as flashforge_service
import backend.services.marlin_printer_service as marlin_printer_service
import backend.services.plugin_installer_service as plugin_installer_service
import backend.services.tunascreen_service as tunascreen_service
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
    monkeypatch.setattr(marlin_printer_service, "REGISTRY_PATH", str(tmp_path / "marlin_printer_registry.json"))
    monkeypatch.setattr(tunascreen_service, "REGISTRY_PATH", str(tmp_path / "tunascreen_devices.json"))
    # Plugins: aísla tanto la carpeta de clones (plugins/) como el estado de
    # instalación (data/plugins/installed.json) -- sin esto, instalar/
    # desinstalar un plugin en un test haría un `git clone` real y tocaría
    # el installed.json real del repo (mismo riesgo que ya pasó una vez con
    # camera_registry.json).
    monkeypatch.setattr(plugin_installer_service, "PLUGINS_DIR", tmp_path / "plugins")
    monkeypatch.setattr(plugin_installer_service, "PLUGIN_DATA_DIR", tmp_path / "data" / "plugins")
    monkeypatch.setattr(plugin_installer_service, "INSTALLED_FILE", tmp_path / "data" / "plugins" / "installed.json")
    # NOPAL Intelligence: mismo riesgo que los registros de impresoras --
    # un test que guarde configuración de IA escribiría el ai_config.json
    # real del repo (que puede tener la API key del usuario).
    monkeypatch.setattr(ai_config_service, "CONFIG_PATH", str(tmp_path / "ai_config.json"))
    monkeypatch.setattr(ai_conversations_service, "STORE_PATH", str(tmp_path / "ai_conversations.json"))
    monkeypatch.setattr(gcode_bounds, "CACHE_PATH", str(tmp_path / "gcode_bounds_cache.json"))
    # Las variables NOPAL_AI_* pisan al archivo (ver ai_config_service):
    # sin limpiarlas, el entorno de quien corre la suite decidiría el
    # resultado de los tests de configuración.
    for env_name in ai_config_service.ENV_OVERRIDES:
        monkeypatch.delenv(env_name, raising=False)
    yield tmp_path
