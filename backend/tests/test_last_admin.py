"""C-6 (ADR-006): NOPAL nunca debe quedar sin al menos un admin.

Cada caso verifica la respuesta y el estado final de auth_users.json.
"""

import json

import pytest

from backend.auth_deps import require_auth
from backend.main import app
from backend.services import auth_service
from backend.services import config_backup_service as backup
from backend.services.config_backup_service import BackupError

PASSPHRASE = "frase-larga-y-secreta"


@pytest.fixture
def users_file(tmp_path, monkeypatch):
    """auth_users.json aislado en tmp_path. Se trabaja desde tmp_path porque
    la importación de respaldos usa rutas relativas al directorio actual."""
    monkeypatch.chdir(tmp_path)
    path = tmp_path / "auth_users.json"
    monkeypatch.setattr(auth_service, "AUTH_USERS_PATH", str(path))
    return path


def _stored(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _roles(path):
    return sorted(u["role"] for u in _stored(path))


@pytest.fixture
def act_as():
    """Hace que la petición la haga un usuario concreto del archivo (para
    probar la auto-degradación con el id real del admin)."""
    def _set(user):
        app.dependency_overrides[require_auth] = lambda: {
            "user_id": user["id"], "username": user["username"], "role": user["role"],
        }
    yield _set
    app.dependency_overrides.pop(require_auth, None)


# ── Servicio ──

class TestService:
    def test_cannot_delete_last_admin(self, users_file):
        admin = auth_service.create_user("unico", "password-1", "admin")
        auth_service.create_user("oper", "password-2", "operador")

        with pytest.raises(ValueError, match="al menos un administrador"):
            auth_service.delete_user(admin["id"])
        assert _roles(users_file) == ["admin", "operador"]

    def test_cannot_demote_last_admin(self, users_file):
        admin = auth_service.create_user("unico", "password-1", "admin")
        auth_service.create_user("oper", "password-2", "operador")

        with pytest.raises(ValueError, match="al menos un administrador"):
            auth_service.update_user(admin["id"], role="operador")
        assert _roles(users_file) == ["admin", "operador"]

    def test_failed_demotion_does_not_apply_password_change(self, users_file):
        admin = auth_service.create_user("unico", "password-1", "admin")
        before = _stored(users_file)[0]["password_hash"]

        with pytest.raises(ValueError):
            auth_service.update_user(admin["id"], role="operador", new_password="nueva-clave-1")
        assert _stored(users_file)[0]["password_hash"] == before
        assert auth_service.verify_password("unico", "password-1") is not None

    def test_can_delete_admin_when_another_exists(self, users_file):
        a1 = auth_service.create_user("admin1", "password-1", "admin")
        auth_service.create_user("admin2", "password-2", "admin")

        assert auth_service.delete_user(a1["id"]) is True
        assert [u["username"] for u in _stored(users_file)] == ["admin2"]
        assert _roles(users_file) == ["admin"]

    def test_can_demote_admin_when_another_exists(self, users_file):
        a1 = auth_service.create_user("admin1", "password-1", "admin")
        auth_service.create_user("admin2", "password-2", "admin")

        updated = auth_service.update_user(a1["id"], role="operador")
        assert updated["role"] == "operador"
        assert _roles(users_file) == ["admin", "operador"]

    def test_second_demotion_blocked_after_first(self, users_file):
        """Con dos admins se puede degradar uno; el que queda ya es el último."""
        a1 = auth_service.create_user("admin1", "password-1", "admin")
        a2 = auth_service.create_user("admin2", "password-2", "admin")

        auth_service.update_user(a1["id"], role="operador")
        with pytest.raises(ValueError, match="al menos un administrador"):
            auth_service.update_user(a2["id"], role="operador")
        assert _roles(users_file) == ["admin", "operador"]

    def test_keeping_admin_role_is_allowed(self, users_file):
        admin = auth_service.create_user("unico", "password-1", "admin")
        assert auth_service.update_user(admin["id"], role="admin")["role"] == "admin"
        assert auth_service.update_user(admin["id"], new_password="otra-clave-1")["role"] == "admin"
        assert _roles(users_file) == ["admin"]
        assert auth_service.verify_password("unico", "otra-clave-1") is not None

    def test_operator_changes_unaffected(self, users_file):
        auth_service.create_user("unico", "password-1", "admin")
        oper = auth_service.create_user("oper", "password-2", "operador")

        assert auth_service.update_user(oper["id"], role="admin")["role"] == "admin"
        assert auth_service.update_user(oper["id"], role="operador")["role"] == "operador"
        assert auth_service.delete_user(oper["id"]) is True
        assert _roles(users_file) == ["admin"]


# ── API ──

class TestApi:
    def test_delete_last_admin_rejected(self, client, as_admin, users_file):
        admin = auth_service.create_user("unico", "password-1", "admin")

        response = client.post("/api/auth/users/remove", data={"user_id": admin["id"]})

        assert response.status_code == 400
        assert "al menos un administrador" in response.json()["detail"]
        assert _roles(users_file) == ["admin"]

    def test_demote_last_admin_rejected(self, client, as_admin, users_file):
        admin = auth_service.create_user("unico", "password-1", "admin")
        auth_service.create_user("oper", "password-2", "operador")

        response = client.post("/api/auth/users/update", data={"user_id": admin["id"], "role": "operador"})

        assert response.status_code == 400
        assert "al menos un administrador" in response.json()["detail"]
        assert _roles(users_file) == ["admin", "operador"]

    def test_last_admin_cannot_self_demote(self, client, users_file, act_as):
        admin = auth_service.create_user("unico", "password-1", "admin")
        auth_service.create_user("oper", "password-2", "operador")
        act_as(admin)

        response = client.post("/api/auth/users/update", data={"user_id": admin["id"], "role": "operador"})

        assert response.status_code == 400
        assert _roles(users_file) == ["admin", "operador"]
        assert auth_service.get_user_by_id(admin["id"])["role"] == "admin"

    def test_admin_can_self_demote_when_another_admin_exists(self, client, users_file, act_as):
        a1 = auth_service.create_user("admin1", "password-1", "admin")
        auth_service.create_user("admin2", "password-2", "admin")
        act_as(a1)

        response = client.post("/api/auth/users/update", data={"user_id": a1["id"], "role": "operador"})

        assert response.status_code == 200
        assert response.json()["role"] == "operador"
        assert _roles(users_file) == ["admin", "operador"]

    def test_delete_admin_allowed_when_another_exists(self, client, as_admin, users_file):
        a1 = auth_service.create_user("admin1", "password-1", "admin")
        auth_service.create_user("admin2", "password-2", "admin")

        response = client.post("/api/auth/users/remove", data={"user_id": a1["id"]})

        assert response.status_code == 200
        assert [u["username"] for u in _stored(users_file)] == ["admin2"]

    def test_demote_admin_allowed_when_another_exists(self, client, as_admin, users_file):
        a1 = auth_service.create_user("admin1", "password-1", "admin")
        auth_service.create_user("admin2", "password-2", "admin")

        response = client.post("/api/auth/users/update", data={"user_id": a1["id"], "role": "operador"})

        assert response.status_code == 200
        assert _roles(users_file) == ["admin", "operador"]

    def test_normal_create_and_update_flow(self, client, as_admin, users_file):
        auth_service.create_user("unico", "password-1", "admin")

        created = client.post("/api/auth/users", data={"username": "nuevo", "password": "password-9", "role": "operador"})
        assert created.status_code == 200
        user_id = created.json()["id"]

        promoted = client.post("/api/auth/users/update", data={"user_id": user_id, "role": "admin"})
        assert promoted.status_code == 200 and promoted.json()["role"] == "admin"

        reset = client.post("/api/auth/users/update", data={"user_id": user_id, "new_password": "otra-clave-9"})
        assert reset.status_code == 200
        assert auth_service.verify_password("nuevo", "otra-clave-9") is not None

        listed = client.get("/api/auth/users")
        assert sorted(u["username"] for u in listed.json()["users"]) == ["nuevo", "unico"]
        assert _roles(users_file) == ["admin", "admin"]

    def test_error_does_not_reveal_other_users(self, client, as_admin, users_file):
        admin = auth_service.create_user("unico", "password-1", "admin")
        auth_service.create_user("secreto-oper", "password-2", "operador")

        response = client.post("/api/auth/users/update", data={"user_id": admin["id"], "role": "operador"})

        assert response.status_code == 400
        assert "secreto-oper" not in response.text
        assert "unico" not in response.text


# ── Otro endpoint que restaura usuarios: importación de respaldos ──

class TestBackupImport:
    def _backup_with_users(self, users_file, users):
        users_file.write_text(json.dumps(users), encoding="utf-8")
        return backup.export_config(["users"], PASSPHRASE)

    def test_import_without_admin_rejected_by_service(self, users_file):
        raw = self._backup_with_users(users_file, [{"id": "u1", "username": "oper", "role": "operador"}])
        users_file.write_text(json.dumps([{"id": "a1", "username": "admin-actual", "role": "admin"}]), encoding="utf-8")

        with pytest.raises(BackupError, match="ningún administrador"):
            backup.import_config(raw, ["users"], PASSPHRASE)
        assert _roles(users_file) == ["admin"]
        assert not (users_file.parent / ("auth_users.json" + backup.BACKUP_SUFFIX)).exists()

    def test_import_without_admin_rejected_by_api(self, client, as_admin, users_file):
        raw = self._backup_with_users(users_file, [{"id": "u1", "username": "oper", "role": "operador"}])
        users_file.write_text(json.dumps([{"id": "a1", "username": "admin-actual", "role": "admin"}]), encoding="utf-8")

        response = client.post(
            "/api/config-backup/import",
            files={"file": ("respaldo.json", raw, "application/json")},
            data={"groups": "users", "passphrase": PASSPHRASE},
        )

        assert response.status_code == 400
        assert "ningún administrador" in response.json()["detail"]
        assert _stored(users_file)[0]["username"] == "admin-actual"

    def test_import_with_admin_still_works(self, client, as_admin, users_file):
        raw = self._backup_with_users(users_file, [
            {"id": "a9", "username": "admin-respaldo", "role": "admin"},
            {"id": "u9", "username": "oper-respaldo", "role": "operador"},
        ])
        users_file.write_text(json.dumps([{"id": "a1", "username": "admin-actual", "role": "admin"}]), encoding="utf-8")

        response = client.post(
            "/api/config-backup/import",
            files={"file": ("respaldo.json", raw, "application/json")},
            data={"groups": "users", "passphrase": PASSPHRASE},
        )

        assert response.status_code == 200
        assert sorted(u["username"] for u in _stored(users_file)) == ["admin-respaldo", "oper-respaldo"]

    def test_import_of_other_groups_unaffected(self, users_file):
        """Un respaldo con usuarios sin admin no bloquea importar otros grupos."""
        (users_file.parent / "temperature_presets.json").write_text(json.dumps({"pla": 200}), encoding="utf-8")
        users_file.write_text(json.dumps([{"id": "u1", "username": "oper", "role": "operador"}]), encoding="utf-8")
        raw = backup.export_config(["users", "presets"], PASSPHRASE)
        users_file.write_text(json.dumps([{"id": "a1", "username": "admin-actual", "role": "admin"}]), encoding="utf-8")

        result = backup.import_config(raw, ["presets"], PASSPHRASE)

        assert result["restored"] == ["temperature_presets.json"]
        assert _roles(users_file) == ["admin"]
