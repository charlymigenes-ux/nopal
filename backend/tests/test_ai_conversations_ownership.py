"""D-9: conversaciones de IA privadas por usuario (ADR-006 D3-Q8 / C-4).

- Cada conversación tiene `owner_user_id` = el `user_id` del usuario
  autenticado; nadie lo elige desde fuera.
- Leer, continuar (`read_conversation`), renombrar y borrar: solo el
  propietario, sin excepción para Admin (Authorization Policy, `owner_only`).
- Ajena, sin propietario, inexistente o inventada: el mismo 404 "Esa
  conversación ya no existe". En `ask`, igual que un id desconocido.
- Antiguas sin propietario: invisibles e intocables; solo las borra el
  borrado global (C-4, admin), que no concede lectura.
- Recorte de MAX_CONVERSATIONS por propietario.
- Conversaciones fuera de los respaldos generales.
- Confirmaciones pendientes ligadas al `user_id`.
"""

import json
import time

import pytest

import backend.services.auth_service as auth_service
from backend.auth_deps import require_auth
from backend.main import app
from backend.services import ai_actions, ai_agent, ai_config_service, config_backup_service
from backend.services import ai_conversations_service as conv

A = {"user_id": "u-a", "username": "ana", "role": "operador"}
B = {"user_id": "u-b", "username": "beto", "role": "operador"}
ADMIN = {"user_id": "u-admin", "username": "jefa", "role": "admin"}
OPERATOR = {"user_id": "u-op", "username": "oscar", "role": "operador"}
NOT_FOUND = {"detail": "Esa conversación ya no existe"}


def _conversation(cid, owner, title, updated_at, text):
    entry = {
        "id": cid, "title": title, "created_at": updated_at, "updated_at": updated_at,
        "messages": [{"role": "user", "content": text, "at": updated_at},
                     {"role": "assistant", "content": f"respuesta a {text}", "at": updated_at}],
    }
    if owner:
        entry["owner_user_id"] = owner
    return entry


@pytest.fixture
def store():
    """conversation-A (de A), conversation-B (de B) y legacy-X (sin dueño, con
    el formato exacto de las antiguas)."""
    data = [
        _conversation("conv0000000a", "u-a", "Diagnóstico de A", 100.0, "secreto de A"),
        _conversation("conv0000000b", "u-b", "Diagnóstico de B", 200.0, "secreto de B"),
        _conversation("legacy00000x", None, "Conversación antigua", 50.0, "secreto antiguo"),
    ]
    with open(conv.STORE_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    return data


def _disk():
    with open(conv.STORE_PATH, encoding="utf-8") as handle:
        return {c["id"]: c for c in json.load(handle)}


@pytest.fixture
def act_as():
    def _set(user):
        app.dependency_overrides[require_auth] = lambda: dict(user)
    yield _set
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def fake_model(monkeypatch):
    """Modelo simulado (modo contexto): registra lo que recibe."""
    seen = []

    class _Provider:
        async def chat(self, messages, tools=None, model=None):
            seen.append(messages)
            return {"role": "assistant", "content": "Respuesta del modelo."}

        async def test_connection(self):
            return {"ok": True}

    monkeypatch.setattr(ai_agent, "get_provider", lambda config: _Provider())
    ai_config_service.save_config({"enabled": True, "base_url": "http://127.0.0.1:8081/v1",
                                   "model": "m", "tool_mode": "context"})
    return seen


def _ids(response):
    return [c["id"] for c in response.json()["conversations"]]


class TestList:
    @pytest.mark.parametrize("user, expected", [(A, ["conv0000000a"]), (B, ["conv0000000b"]),
                                                (ADMIN, []), (OPERATOR, [])])
    def test_each_user_lists_only_their_own(self, client, store, act_as, user, expected):
        act_as(user)

        response = client.get("/api/ai/conversations")

        assert response.status_code == 200
        assert _ids(response) == expected
        assert response.json()["count"] == len(expected)


class TestReadRenameDelete:
    MATRIX = [  # (actor, conversación, ¿permitido?)
        (A, "conv0000000a", True), (A, "conv0000000b", False),
        (B, "conv0000000b", True), (B, "conv0000000a", False),
        (ADMIN, "conv0000000a", False), (ADMIN, "conv0000000b", False), (OPERATOR, "conv0000000a", False),
    ]
    IDS = [f"{actor['username']}->{cid}" for actor, cid, _ in MATRIX]

    @pytest.mark.parametrize("actor, cid, allowed", MATRIX, ids=IDS)
    def test_read(self, client, store, act_as, actor, cid, allowed):
        act_as(actor)

        response = client.get(f"/api/ai/conversations/{cid}")

        if allowed:
            assert response.status_code == 200 and response.json()["id"] == cid
        else:
            assert response.status_code == 404 and response.json() == NOT_FOUND

    @pytest.mark.parametrize("actor, cid, allowed", MATRIX, ids=IDS)
    def test_rename(self, client, store, act_as, actor, cid, allowed):
        act_as(actor)
        before = _disk()[cid]

        response = client.put(f"/api/ai/conversations/{cid}", json={"title": "Renombrada"})

        after = _disk()[cid]
        if allowed:
            assert response.status_code == 200 and after["title"] == "Renombrada"
        else:
            assert response.status_code == 404 and response.json() == NOT_FOUND
            assert after == before

    @pytest.mark.parametrize("actor, cid, allowed", MATRIX, ids=IDS)
    def test_delete(self, client, store, act_as, actor, cid, allowed):
        act_as(actor)

        response = client.delete(f"/api/ai/conversations/{cid}")

        if allowed:
            assert response.status_code == 200 and cid not in _disk()
            assert cid not in _ids(response)
        else:
            assert response.status_code == 404 and response.json() == NOT_FOUND
            assert cid in _disk()

    def test_delete_response_lists_only_own(self, client, store, act_as):
        act_as(A)
        client.put("/api/ai/conversations/conv0000000a", json={"title": "x"})
        conv.append_turn(None, "otra de A", "R", owner_user_id="u-a", role="operador")

        response = client.delete("/api/ai/conversations/conv0000000a")

        assert all(c["id"] not in ("conv0000000b", "legacy00000x") for c in response.json()["conversations"])
        assert response.json()["count"] == 1


class TestNoEnumeration:
    @pytest.mark.parametrize("cid", ["conv0000000b", "legacy00000x", "noexiste0000", "CONV0000000A", "0"])
    @pytest.mark.parametrize("method", ["get", "put", "delete"])
    def test_foreign_legacy_missing_and_invented_look_identical(self, client, store, act_as, cid, method):
        act_as(A)

        response = getattr(client, method)(f"/api/ai/conversations/{cid}",
                                           **({"json": {"title": "x"}} if method == "put" else {}))

        assert response.status_code == 404
        assert response.json() == NOT_FOUND


class TestLegacyWithoutOwner:
    @pytest.mark.parametrize("actor", [A, B, ADMIN, OPERATOR], ids=lambda u: u["username"])
    def test_invisible_and_untouchable_for_everyone(self, client, store, act_as, actor):
        act_as(actor)

        assert "legacy00000x" not in _ids(client.get("/api/ai/conversations"))
        assert client.get("/api/ai/conversations/legacy00000x").status_code == 404
        assert client.put("/api/ai/conversations/legacy00000x", json={"title": "mía"}).status_code == 404
        assert client.delete("/api/ai/conversations/legacy00000x").status_code == 404
        assert _disk()["legacy00000x"] == store[2]  # intacta, sin propietario inventado

    def test_continuing_legacy_starts_a_new_own_conversation(self, client, store, act_as, fake_model):
        act_as(ADMIN)

        result = client.post("/api/ai/ask", json={"question": "sigo", "conversation_id": "legacy00000x"}).json()

        assert result["conversation_id"] != "legacy00000x"
        assert _disk()["legacy00000x"] == store[2]
        assert _disk()[result["conversation_id"]]["owner_user_id"] == "u-admin"
        assert not any("secreto antiguo" in m["content"] for m in fake_model[-1])

    def test_survives_owner_trimming(self, store, monkeypatch):
        monkeypatch.setattr(conv, "MAX_CONVERSATIONS", 1)
        for i in range(3):
            conv.append_turn(None, f"nueva {i}", "R", owner_user_id="u-a", role="operador")

        assert "legacy00000x" in _disk()

    def test_cleared_only_by_global_clear(self, client, store, act_as):
        act_as(ADMIN)

        response = client.delete("/api/ai/conversations")

        assert response.status_code == 200 and response.json() == {"deleted": 3}
        assert _disk() == {}


class TestContinue:
    @pytest.mark.parametrize("actor, foreign", [(A, "conv0000000b"), (B, "conv0000000a"), (ADMIN, "conv0000000a")],
                             ids=["A->B", "B->A", "admin->A"])
    def test_foreign_conversation_behaves_like_unknown(self, client, store, act_as, fake_model, actor, foreign):
        act_as(actor)
        before = _disk()[foreign]

        result = client.post("/api/ai/ask", json={"question": "continúo", "conversation_id": foreign}).json()

        # Sin historial ajeno al modelo, sin escribir en la ajena, sin su título.
        secret = before["messages"][0]["content"]
        assert not any(secret in m["content"] for m in fake_model[-1])
        assert _disk()[foreign] == before  # incluido updated_at
        assert result["conversation_id"] != foreign
        assert result["conversation_title"] != before["title"]
        mine = _disk()[result["conversation_id"]]
        assert mine["owner_user_id"] == actor["user_id"] and len(mine["messages"]) == 2

    def test_owner_continues_with_history(self, client, store, act_as, fake_model):
        act_as(A)

        result = client.post("/api/ai/ask", json={"question": "continúo", "conversation_id": "conv0000000a"}).json()

        assert result["conversation_id"] == "conv0000000a"
        assert any("secreto de A" in m["content"] for m in fake_model[-1])
        assert len(_disk()["conv0000000a"]["messages"]) == 4


class TestCreateAndIdentity:
    def test_new_conversation_belongs_to_session_user(self, client, store, act_as, fake_model):
        act_as(A)

        result = client.post("/api/ai/ask", json={
            "question": "nueva", "owner_user_id": "u-b", "user_id": "u-b", "username": "beto", "role": "admin",
        }).json()

        created = _disk()[result["conversation_id"]]
        assert created["owner_user_id"] == "u-a"
        assert result["conversation_id"] in _ids(client.get("/api/ai/conversations"))
        act_as(B)
        assert result["conversation_id"] not in _ids(client.get("/api/ai/conversations"))

    def test_rename_body_cannot_change_owner(self, client, store, act_as):
        act_as(A)

        client.put("/api/ai/conversations/conv0000000a",
                   json={"title": "t", "owner_user_id": "u-b", "user_id": "u-b", "role": "admin"})

        assert _disk()["conv0000000a"]["owner_user_id"] == "u-a"

    def test_same_username_other_user_id_is_another_person(self, client, store, act_as):
        act_as({"user_id": "u-impostor", "username": "ana", "role": "admin"})

        assert client.get("/api/ai/conversations/conv0000000a").status_code == 404
        assert _ids(client.get("/api/ai/conversations")) == []

    def test_ask_without_identity_persists_nothing(self, store, fake_model):
        """Fail-closed: sin usuario autenticado no hay historial ni se crea
        una conversación sin propietario."""
        import asyncio

        result = asyncio.run(ai_agent.ask("hola", "conv0000000a"))

        assert result["conversation_id"] is None
        assert not any("secreto de A" in m["content"] for m in fake_model[-1])
        assert set(_disk()) == {"conv0000000a", "conv0000000b", "legacy00000x"}

    def test_anonymous_rejected(self, client, store):
        for method, url in [("get", "/api/ai/conversations"), ("get", "/api/ai/conversations/conv0000000a"),
                            ("put", "/api/ai/conversations/conv0000000a"),
                            ("delete", "/api/ai/conversations/conv0000000a"), ("delete", "/api/ai/conversations"),
                            ("post", "/api/ai/ask")]:
            kwargs = {"json": {"title": "x", "question": "x"}} if method in ("put", "post") else {}
            assert getattr(client, method)(url, **kwargs).status_code == 401, (method, url)
        assert _disk()["conv0000000a"] == store[0]

    def test_tuna_device_token_has_no_access(self, client, store):
        from backend.services import tunascreen_service

        token = tunascreen_service.confirm_pairing(tunascreen_service.generate_pairing_code()["code"], "Tablet")["token"]

        response = client.get("/api/ai/conversations/conv0000000a", headers={"Authorization": f"Bearer {token}"})

        assert response.status_code == 401


class TestGlobalClear:
    def test_operator_cannot_clear(self, client, store, act_as):
        act_as(OPERATOR)

        response = client.delete("/api/ai/conversations")

        assert response.status_code == 403
        assert len(_disk()) == 3

    def test_admin_clear_grants_no_read(self, client, store, act_as):
        """C-4: poder borrar todo no da lectura de ninguna ajena."""
        act_as(ADMIN)

        assert client.get("/api/ai/conversations/conv0000000a").status_code == 404
        assert client.delete("/api/ai/conversations").status_code == 200


class TestPerOwnerCap:
    def test_one_user_cannot_evict_another(self, store, monkeypatch):
        monkeypatch.setattr(conv, "MAX_CONVERSATIONS", 3)
        for i in range(6):
            conv.append_turn(None, f"A {i}", "R", owner_user_id="u-a", role="operador")

        on_disk = _disk()
        mine = [c for c in on_disk.values() if c.get("owner_user_id") == "u-a"]
        assert len(mine) == 3
        assert "conv0000000a" not in on_disk  # la más vieja de A se fue
        assert "conv0000000b" in on_disk and "legacy00000x" in on_disk
        assert conv.list_conversations("u-b")["count"] == 1

    def test_each_owner_keeps_their_most_recent(self, store, monkeypatch):
        monkeypatch.setattr(conv, "MAX_CONVERSATIONS", 2)
        for i in range(3):
            conv.append_turn(None, f"B {i}", "R", owner_user_id="u-b", role="operador")
            time.sleep(0.001)

        titles = [c["title"] for c in conv.list_conversations("u-b")["conversations"]]
        assert titles == ["B 2", "B 1"]
        assert conv.list_conversations("u-a")["count"] == 1


class TestBackups:
    def test_conversations_are_not_a_backup_group(self):
        groups = config_backup_service.GROUPS
        assert "ai_conversations" not in groups
        assert all("ai_conversations.json" not in spec["files"] for spec in groups.values())

    @pytest.fixture
    def workshop_dir(self, tmp_path, monkeypatch):
        """Directorio de trabajo con un grupo con datos y un
        ai_conversations.json presente (como en una instalación real)."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "temperature_presets.json").write_text("[]", encoding="utf-8")
        (tmp_path / "ai_conversations.json").write_text(
            json.dumps([{"id": "real00000000", "owner_user_id": "u-b", "messages": []}]), encoding="utf-8")
        return tmp_path

    def test_export_never_contains_conversations(self, workshop_dir):
        raw = config_backup_service.export_config(list(config_backup_service.GROUPS), passphrase="frase-de-prueba")

        files = config_backup_service.inspect_backup(raw, "frase-de-prueba")["files"]
        assert "temperature_presets.json" in files
        assert "ai_conversations.json" not in files

    def test_import_of_old_backup_never_writes_conversations(self, workshop_dir, monkeypatch):
        """Un respaldo hecho antes de D-9 (con el grupo de conversaciones) no
        las restaura: el grupo ya no existe y su archivo nunca se escribe."""
        old_groups = dict(config_backup_service.GROUPS, ai_conversations={
            "label": "Historial", "files": ["ai_conversations.json"], "sensitive": True})
        monkeypatch.setattr(config_backup_service, "GROUPS", old_groups)
        (workshop_dir / "ai_conversations.json").write_text(
            json.dumps([{"id": "inyectada000", "owner_user_id": "u-a", "messages": []}]), encoding="utf-8")
        raw = config_backup_service.export_config(["presets", "ai_conversations"], passphrase="frase-de-prueba")
        monkeypatch.undo()
        monkeypatch.chdir(workshop_dir)
        (workshop_dir / "ai_conversations.json").write_text(
            json.dumps([{"id": "real00000000", "owner_user_id": "u-b", "messages": []}]), encoding="utf-8")

        assert "ai_conversations" not in config_backup_service.GROUPS
        with pytest.raises(config_backup_service.BackupError, match="Grupo desconocido"):
            config_backup_service.import_config(raw, ["ai_conversations"], "frase-de-prueba")
        config_backup_service.import_config(raw, ["presets"], "frase-de-prueba")

        current = json.loads((workshop_dir / "ai_conversations.json").read_text(encoding="utf-8"))
        assert [c["id"] for c in current] == ["real00000000"]


class TestPendingConfirmationIdentity:
    @pytest.fixture
    def users(self, tmp_path, monkeypatch):
        monkeypatch.setattr(auth_service, "AUTH_USERS_PATH", str(tmp_path / "auth_users.json"))
        auth_service.create_user("jefa", "contraseña-admin", "admin")
        return auth_service

    @pytest.fixture
    def handler(self, monkeypatch):
        calls = []

        async def run(**kwargs):
            calls.append(kwargs)
            return {"ok": True}

        async def resolve(machine_id):
            return {"id": "klipper:7125", "name": "ET4", "kind": "printer", "brand": "klipper"}

        monkeypatch.setattr(ai_actions.ACTIONS["preheat_machine"], "handler", run)
        monkeypatch.setattr(ai_actions, "_resolve_machine", resolve)
        monkeypatch.setattr(ai_actions, "_pending", {})
        monkeypatch.setattr(ai_config_service, "get_config", lambda: {"actions_enabled": True})
        return calls

    def _login(self, client, username, password):
        response = client.post("/api/auth/login", data={"username": username, "password": password})
        assert response.status_code == 200, response.text

    def test_recreated_user_with_same_username_cannot_confirm(self, client, users, handler):
        try:
            a = users.create_user("ana", "contraseña-a", "operador")
            pending = ai_actions.stage_action("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "ana", a["id"])
            assert users.delete_user(a["id"])
            b = users.create_user("ana", "contraseña-b", "operador")
            assert b["id"] != a["id"] and b["username"] == a["username"]

            self._login(client, "ana", "contraseña-b")
            response = client.post(f"/api/ai/actions/{pending['id']}/confirm")

            assert response.status_code == 400
            assert response.json() == {"detail": "Solo quien pidió la acción puede confirmarla"}
            assert handler == []
        finally:
            client.post("/api/auth/logout")
            client.cookies.clear()

    def test_same_user_can_confirm(self, client, users, handler):
        try:
            a = users.create_user("ana", "contraseña-a", "operador")
            pending = ai_actions.stage_action("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "ana", a["id"])

            self._login(client, "ana", "contraseña-a")
            response = client.post(f"/api/ai/actions/{pending['id']}/confirm")

            assert response.status_code == 200
            assert len(handler) == 1
        finally:
            client.post("/api/auth/logout")
            client.cookies.clear()

    async def test_other_user_cannot_confirm_and_identity_is_not_exposed(self, handler):
        pending = ai_actions.stage_action("preheat_machine", {"machine_id": "ET4", "nozzle": 200}, "ana", "u-a")
        assert "user_id" not in pending

        with pytest.raises(ai_actions.ActionError, match="Solo quien pidió"):
            await ai_actions.confirm(pending["id"], "admin", "beto", "u-b")
        with pytest.raises(ai_actions.ActionError, match="Solo quien pidió"):
            await ai_actions.confirm(pending["id"], "admin", "ana", None)  # sin id: fail-closed
        assert handler == []
