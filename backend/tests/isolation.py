"""Entorno aislado para toda la sesión de tests.

Por qué existe
--------------
NOPAL guarda su estado en archivos con ruta RELATIVA al directorio de trabajo
(`spoolman_printer_links.json`, `scheduled_prints.json`, `laser_registry.json`,
`data/plugins/installed.json`, `logs/nopal.log`…) y habla con hardware real
(Moonraker, Spoolman, Bambu, Elegoo, láseres, puertos serie). El fixture
`client` es de sesión: arranca la app (carga de plugins, loop de impresiones
programadas, broadcaster de TUNA-Screen) ANTES de que corran los fixtures de
aislamiento por test. Con el repo como directorio de trabajo, eso cargaba los
plugins reales y dejaba que un test ejecutara `assign_spool` real contra
Spoolman/Moonraker y escribiera `spoolman_printer_links.json` (incidente del
2026-10-03, ver SDD §19).

Qué hace (`activate()`, llamado al principio de conftest, antes de importar
la app)
---------------------------------------------------------------------------
1. **Directorio de trabajo temporal.** Se crea un sandbox con enlaces de solo
   código (`backend/`, `docs/`, `VERSION`) y un `plugins/` vacío; nada más. Los
   archivos reales del taller no existen ahí, así que ninguna ruta relativa
   puede leerlos ni escribirlos, y la app arranca sin plugins.
2. **Red bloqueada.** `connect`/`connect_ex`/`sendto` a IPv4/IPv6 fallan con
   `BlockedNetworkError` salvo hacia un puerto de loopback que este mismo
   proceso esté escuchando (servidores falsos de los tests). `127.0.0.1:7125`
   (Moonraker local) queda bloqueado. `getaddrinfo` solo resuelve IP literales
   y `localhost`.
3. **Puertos serie bloqueados.** `serial.Serial` no abre dispositivos reales.
4. **Escrituras en el repo bloqueadas.** `open()` en modo escritura sobre una
   ruta dentro del repo (fuera de `.pytest_cache`) falla con
   `BlockedFilesystemError`, por si algún código usa rutas absolutas.

No depende del orden de los tests: todo se instala una vez, antes de importar
la app, y vale para la sesión entera.
"""

import atexit
import builtins
import io
import ipaddress
import os
import shutil
import socket
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Solo código y documentación, de solo lectura para los tests.
_LINKED = ("backend", "docs", "VERSION")

SANDBOX: Path = None  # type: ignore[assignment]
BLOCKED_ATTEMPTS = []  # (tipo, destino) de cada intento bloqueado, para diagnóstico
_LISTENING_PORTS = set()
_active = False


class BlockedNetworkError(ConnectionRefusedError):
    """Conexión de red bloqueada por el entorno de tests."""


class BlockedFilesystemError(PermissionError):
    """Escritura en el repo bloqueada por el entorno de tests."""


def _create_sandbox() -> Path:
    sandbox = Path(tempfile.mkdtemp(prefix="nopal-tests-"))
    for name in _LINKED:
        (sandbox / name).symlink_to(REPO_ROOT / name)
    (sandbox / "plugins").mkdir()  # StaticFiles("plugins") exige que exista; vacío = sin plugins
    return sandbox


def _remove_sandbox() -> None:
    if SANDBOX is None or not SANDBOX.exists():
        return
    if Path.cwd() == SANDBOX or SANDBOX in Path.cwd().parents:
        os.chdir(tempfile.gettempdir())
    # Primero los enlaces (nunca se sigue uno hacia el repo), luego el resto.
    for name in _LINKED:
        link = SANDBOX / name
        if link.is_symlink():
            link.unlink()
    shutil.rmtree(SANDBOX, ignore_errors=True)


# --------------------------------------------------------------------------
# Red
# --------------------------------------------------------------------------

_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_sendto = socket.socket.sendto
_real_listen = socket.socket.listen
_real_getaddrinfo = socket.getaddrinfo


def _is_loopback(host) -> bool:
    try:
        return ipaddress.ip_address(str(host).split("%")[0]).is_loopback
    except ValueError:
        return str(host) == "localhost"


def _allowed(sock, address) -> bool:
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return True  # AF_UNIX (socketpair del event loop, etc.)
    host, port = address[0], address[1]
    return _is_loopback(host) and port in _LISTENING_PORTS


def _guard(sock, address, kind):
    if not _allowed(sock, address):
        BLOCKED_ATTEMPTS.append((kind, address))
        raise BlockedNetworkError(f"Red bloqueada en tests: {kind} a {address!r}")


def _connect(self, address):
    _guard(self, address, "connect")
    return _real_connect(self, address)


def _connect_ex(self, address):
    _guard(self, address, "connect")
    return _real_connect_ex(self, address)


def _sendto(self, data, *args):
    address = args[-1]
    _guard(self, address, "sendto")
    return _real_sendto(self, data, *args)


def _listen(self, *args):
    result = _real_listen(self, *args)
    try:
        _LISTENING_PORTS.add(self.getsockname()[1])
    except OSError:
        pass
    return result


def _getaddrinfo(host, *args, **kwargs):
    if host is not None:
        name = host.decode() if isinstance(host, bytes) else str(host)
        try:
            ipaddress.ip_address(name.split("%")[0])
        except ValueError:
            if name != "localhost":
                BLOCKED_ATTEMPTS.append(("dns", name))
                raise socket.gaierror(socket.EAI_NONAME, f"DNS bloqueado en tests: {name}")
    return _real_getaddrinfo(host, *args, **kwargs)


# --------------------------------------------------------------------------
# Puertos serie
# --------------------------------------------------------------------------

def _block_serial() -> None:
    try:
        import serial
    except ImportError:
        return

    def _open(self, *args, **kwargs):
        BLOCKED_ATTEMPTS.append(("serial", getattr(self, "port", None)))
        raise serial.SerialException(f"Puerto serie bloqueado en tests: {getattr(self, 'port', None)}")

    serial.Serial.open = _open


# --------------------------------------------------------------------------
# Escrituras en el repo
# --------------------------------------------------------------------------

_real_open = builtins.open
_WRITE_FLAGS = set("wax+")
_ALLOWED_REPO_WRITES = (REPO_ROOT / ".pytest_cache",)


def _guarded_open(file, mode="r", *args, **kwargs):
    if isinstance(file, (str, bytes, os.PathLike)) and _WRITE_FLAGS & set(str(mode)):
        target = Path(os.fsdecode(file))
        resolved = (target if target.is_absolute() else Path.cwd() / target).resolve()
        inside_repo = resolved == REPO_ROOT or REPO_ROOT in resolved.parents
        if inside_repo and not any(resolved == p or p in resolved.parents for p in _ALLOWED_REPO_WRITES):
            BLOCKED_ATTEMPTS.append(("write", str(resolved)))
            raise BlockedFilesystemError(f"Escritura en el repo bloqueada en tests: {resolved}")
    return _real_open(file, mode, *args, **kwargs)


def activate() -> Path:
    """Instala el entorno aislado (idempotente). Debe llamarse antes de
    importar `backend.main`."""
    global SANDBOX, _active
    if _active:
        return SANDBOX
    SANDBOX = _create_sandbox()
    os.chdir(SANDBOX)
    atexit.register(_remove_sandbox)

    socket.socket.connect = _connect
    socket.socket.connect_ex = _connect_ex
    socket.socket.sendto = _sendto
    socket.socket.listen = _listen
    socket.getaddrinfo = _getaddrinfo
    _block_serial()
    builtins.open = _guarded_open
    io.open = _guarded_open
    _active = True
    return SANDBOX
