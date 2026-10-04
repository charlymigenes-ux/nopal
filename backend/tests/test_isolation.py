"""Regresión del entorno aislado de tests (backend/tests/isolation.py).

Incidente del 2026-10-03: con el repo como directorio de trabajo, el fixture
`client` (de sesión) arrancaba la app con los plugins reales instalados y un
test ejecutó `assign_spool` real: escribió `spoolman_printer_links.json` y
mandó `POST /server/spoolman/spool_id` al Moonraker de la impresora 7125.

Estos tests fallan si el entorno real vuelve a estar al alcance. Los que
provocarían una conexión o una escritura real comprueban PRIMERO que el
bloqueo está activo y, si no, fallan sin intentar nada.
"""

import hashlib
import os
import socket
import sys
from pathlib import Path

import pytest

from backend.tests import isolation

REAL_LINKS = isolation.REPO_ROOT / "spoolman_printer_links.json"
REAL_STATE_FILES = (
    "spoolman_printer_links.json",
    "scheduled_prints.json",
    "laser_registry.json",
    "accessory_registry.json",
    "auth_users.json",
    "ai_config.json",
    "data/plugins/installed.json",
)


def _require_guards():
    """Nunca intentar algo real si el bloqueo no está puesto."""
    if socket.socket.connect is not isolation._connect or not isolation._active:
        pytest.fail("El entorno aislado no está activo: no se intenta ninguna conexión real")


def _fingerprint(path: Path):
    if not path.exists():
        return None
    return path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest()


class TestSandbox:
    def test_cwd_is_a_sandbox_not_the_repo(self):
        cwd = Path.cwd().resolve()
        assert cwd == isolation.SANDBOX.resolve()
        assert cwd != isolation.REPO_ROOT and isolation.REPO_ROOT not in cwd.parents

    @pytest.mark.parametrize("relative", REAL_STATE_FILES)
    def test_real_state_files_are_not_reachable(self, relative):
        """Las rutas relativas que usa NOPAL resuelven al sandbox, donde los
        archivos del taller no existen."""
        assert not Path(relative).exists()
        assert isolation.SANDBOX.resolve() in Path(relative).resolve().parents

    def test_sandbox_has_no_plugins(self):
        assert list(Path("plugins").iterdir()) == []


class TestAppStartup:
    def test_session_client_loads_no_real_plugin(self, client):
        """`client` es de sesión y arranca antes de los fixtures por test: aun
        así no hay plugins reales cargados."""
        from backend.services.plugin_loader_service import NAMESPACE_PACKAGE, get_loaded_plugin_module

        assert client.get("/api/auth/me").status_code in (200, 401)
        # Los tests del loader cargan plugins FALSOS desde tmp; ninguno puede
        # venir de la carpeta real de plugins del repo.
        real_plugins = isolation.REPO_ROOT / "plugins"
        from_real = [
            name for name, module in list(sys.modules.items())
            if name.startswith(f"{NAMESPACE_PACKAGE}.")
            and real_plugins in Path(os.path.realpath(getattr(module, "__file__", None) or "/")).parents
        ]
        assert from_real == []
        assert get_loaded_plugin_module("spoolman", "services.config_service") is None
        assert get_loaded_plugin_module("arduino-accessories", "services.accessory_service") is None

    def test_scheduled_prints_loop_sees_no_real_schedule(self):
        from backend.services import klipper_service

        assert klipper_service._load_schedule() == []


class TestSpoolmanIncident:
    async def test_assign_spool_cannot_reach_real_spoolman(self, client, monkeypatch):
        """El escenario exacto del incidente, con la app ya arrancada: sin
        plugin real cargado falla limpio, sin red ni escritura."""
        from backend.services import ai_actions

        _require_guards()
        before = _fingerprint(REAL_LINKS)
        attempts = len(isolation.BLOCKED_ATTEMPTS)

        async def resolve(machine_id):
            return {"id": "klipper:7125", "name": "nopal-i3", "kind": "printer", "brand": "klipper"}

        monkeypatch.setattr(ai_actions, "_resolve_machine", resolve)
        with pytest.raises(ai_actions.ActionError, match="Materiales"):
            await ai_actions.execute("assign_spool", {"machine_id": "nopal-i3", "spool_id": 3}, "admin")

        assert _fingerprint(REAL_LINKS) == before
        assert len(isolation.BLOCKED_ATTEMPTS) == attempts  # ni siquiera lo intentó

    def test_real_moonraker_is_unreachable(self):
        """Aunque algo llegara a llamar a Moonraker (localhost:7125), la
        conexión se bloquea antes de salir."""
        from backend.services.klipper_service import MoonrakerClient

        _require_guards()
        attempts = len(isolation.BLOCKED_ATTEMPTS)

        assert MoonrakerClient(7125).set_spoolman_active_spool(3) is False

        blocked = isolation.BLOCKED_ATTEMPTS[attempts:]
        assert ("connect", ("127.0.0.1", 7125)) in blocked or any(
            kind == "connect" and address[1] == 7125 for kind, address in blocked)

    def test_spoolman_link_writes_land_in_the_sandbox(self):
        """Una escritura relativa (como la de spool_link_service) cae en el
        sandbox; el archivo real no cambia."""
        _require_guards()
        before = _fingerprint(REAL_LINKS)

        with open("spoolman_printer_links.json", "w", encoding="utf-8") as handle:
            handle.write("{}")

        assert Path("spoolman_printer_links.json").resolve().parent == isolation.SANDBOX.resolve()
        assert _fingerprint(REAL_LINKS) == before
        os.remove("spoolman_printer_links.json")


class TestNetworkBlocked:
    @pytest.mark.parametrize("address", [("192.168.0.61", 80), ("127.0.0.1", 7125), ("10.0.0.1", 1883)])
    def test_tcp_connect_blocked(self, address):
        _require_guards()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            with pytest.raises(isolation.BlockedNetworkError):
                sock.connect(address)

    def test_udp_broadcast_blocked(self):
        _require_guards()
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            with pytest.raises(isolation.BlockedNetworkError):
                sock.sendto(b"descubrimiento", ("255.255.255.255", 3000))

    def test_dns_blocked_for_names(self):
        _require_guards()
        with pytest.raises(socket.gaierror):
            socket.getaddrinfo("spoolman.local", 7912)

    def test_http_client_blocked(self):
        import requests

        _require_guards()
        with pytest.raises(requests.exceptions.ConnectionError):
            requests.get("http://192.168.0.61/", timeout=1)

    def test_own_loopback_server_still_works(self):
        """Los servidores falsos de los tests (p. ej. el puente MKS) siguen
        funcionando: solo se permite loopback a puertos de este proceso."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            server.listen()
            with socket.create_connection(server.getsockname(), timeout=1):
                pass


class TestSerialAndRepoWrites:
    def test_serial_ports_blocked(self):
        import serial

        _require_guards()
        with pytest.raises(serial.SerialException):
            serial.Serial("/dev/ttyUSB0", 115200, timeout=0.5)

    def test_writes_inside_repo_blocked(self):
        _require_guards()
        probe = isolation.REPO_ROOT / "nopal-isolation-probe.json"

        with pytest.raises(isolation.BlockedFilesystemError):
            open(probe, "w", encoding="utf-8")
        with pytest.raises(isolation.BlockedFilesystemError):
            probe.write_text("{}", encoding="utf-8")
        assert not probe.exists()

    def test_reading_the_repo_still_works(self):
        assert (isolation.REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
