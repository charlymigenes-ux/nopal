import ipaddress
import re
import subprocess
from pathlib import Path

from fastapi import HTTPException

from backend.errors import PrinterRegistrationError

UPLOAD_FOLDER = "uploads"
MODELS_ROOT = "uploads/models"
GCODE_ROOT = "uploads/gcode"

# RFC 1123 (hostname simple, sin punto final ni wildcard) -- alcanza para
# nombres tipo "bambu-a1.local", no intenta validar DNS completo.
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)"
    r"(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_DOTTED_DECIMAL_SHAPE_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
MAX_DEVICE_NAME_LENGTH = 80


def validate_printer_ip(ip: str) -> str:
    """IPv4/IPv6 válida o hostname simple -- rechaza lo demás (rutas,
    comandos, espacios, etc.) antes de que llegue a un socket real. No
    resuelve DNS acá: solo valida forma, la resolución real (o su falla) ya
    la reporta la verificación de conexión de cada marca."""
    candidate = (ip or "").strip()
    if not candidate:
        raise PrinterRegistrationError("IP_INVALID", "La dirección IP no puede estar vacía")
    try:
        ipaddress.ip_address(candidate)
        return candidate
    except ValueError:
        pass
    # Con forma de IPv4 (4 grupos de dígitos) pero que ipaddress ya rechazó
    # (ej. octeto > 255): es una IP inválida, no un hostname válido -- no
    # debe caer al chequeo de hostname de abajo (que aceptaría labels
    # puramente numéricos sin problema).
    if _DOTTED_DECIMAL_SHAPE_RE.match(candidate):
        raise PrinterRegistrationError("IP_INVALID", f"Dirección IP inválida: {candidate!r}")
    if _HOSTNAME_RE.match(candidate):
        return candidate
    raise PrinterRegistrationError("IP_INVALID", f"Dirección IP u host inválido: {candidate!r}")


def sanitize_device_name(name: str, max_length: int = MAX_DEVICE_NAME_LENGTH) -> str:
    """Recorta espacios/longitud y rechaza caracteres de control -- no
    escapa HTML acá (el frontend ya usa escapeHtml() al renderizar), esto
    solo evita que un nombre de dispositivo lleve bytes de control o quede
    vacío/gigante en el registro persistido."""
    candidate = (name or "").strip()
    if not candidate:
        raise HTTPException(status_code=400, detail="El nombre no puede estar vacío")
    if _CONTROL_CHARS_RE.search(candidate):
        raise HTTPException(status_code=400, detail="El nombre contiene caracteres no permitidos")
    if len(candidate) > max_length:
        raise HTTPException(status_code=400, detail=f"El nombre no puede superar {max_length} caracteres")
    return candidate


def get_app_version() -> str:
    """Versión semántica de la app (archivo VERSION en la raíz del proyecto)."""
    try:
        return Path("VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0"


def get_section_root(section: str) -> str:
    return GCODE_ROOT if section == "gcode" else MODELS_ROOT


def is_git_update_available(timeout: int = 6) -> bool:
    """Chequeo liviano de si el remoto tiene commits nuevos — usado por las
    notificaciones. No repite la lógica completa de /api/system/version (que
    además informa ahead/pending_commits para esa pantalla), acá solo
    interesa el booleano, así que es una función aparte y no una que ese
    endpoint reutilice."""
    try:
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        branch = branch_result.stdout.strip() or "main"

        fetch_result = subprocess.run(
            ["git", "fetch", "--quiet", "origin", branch],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        if fetch_result.returncode != 0:
            return False

        counts_result = subprocess.run(
            ["git", "rev-list", "--left-right", "--count", f"HEAD...origin/{branch}"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        parts = counts_result.stdout.split()
        if len(parts) == 2:
            return int(parts[1]) > 0
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return False


def safe_section_path(section: str, relative_path: str = "") -> str:
    """Resuelve `relative_path` dentro de la raíz de la sección (models/gcode),
    evitando path traversal."""
    base = Path(get_section_root(section)).resolve()
    target = (base / (relative_path or "")).resolve()
    if target != base and base not in target.parents:
        raise HTTPException(status_code=400, detail="Ruta inválida")
    return str(target)
