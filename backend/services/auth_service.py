import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

AUTH_USERS_PATH = "auth_users.json"
SESSION_SECRET_PATH = ".session_secret"
PBKDF2_ITERATIONS = 260_000

ROLES = ("admin", "operador")


def _load_users() -> List[Dict[str, Any]]:
    try:
        with open(AUTH_USERS_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _save_users(users: List[Dict[str, Any]]):
    try:
        with open(AUTH_USERS_PATH, "w", encoding="utf-8") as handle:
            json.dump(users, handle, indent=2)
    except OSError:
        pass


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS).hex()
    return f"{salt}${PBKDF2_ITERATIONS}${digest}"


def _check_password(password: str, stored: str) -> bool:
    try:
        salt, iterations, digest = stored.split("$", 2)
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations)).hex()
        return hmac.compare_digest(candidate, digest)
    except (ValueError, AttributeError):
        return False


def _public(user: Dict[str, Any]) -> Dict[str, Any]:
    """Nunca se serializa password_hash de vuelta — ni en listados ni en la
    respuesta de alta/edición de un usuario."""
    return {k: v for k, v in user.items() if k != "password_hash"}


def list_users() -> List[Dict[str, Any]]:
    return [_public(u) for u in _load_users()]


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    username_lower = username.lower()
    return next((u for u in _load_users() if u["username"].lower() == username_lower), None)


def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    return next((u for u in _load_users() if u["id"] == user_id), None)


def create_user(username: str, password: str, role: str) -> Dict[str, Any]:
    if role not in ROLES:
        raise ValueError(f"Rol desconocido: {role}")
    if get_user_by_username(username) is not None:
        raise ValueError(f"El usuario '{username}' ya existe")

    users = _load_users()
    user = {
        "id": f"u_{secrets.token_hex(8)}",
        "username": username,
        "password_hash": _hash_password(password),
        "role": role,
        "created_at": time.time(),
    }
    users.append(user)
    _save_users(users)
    logger.info(f"Usuario creado: {username} ({role})")
    return _public(user)


def verify_password(username: str, password: str) -> Optional[Dict[str, Any]]:
    user = get_user_by_username(username)
    if user is None or not _check_password(password, user["password_hash"]):
        return None
    return _public(user)


def update_user(user_id: str, role: Optional[str] = None, new_password: Optional[str] = None) -> Dict[str, Any]:
    if role is not None and role not in ROLES:
        raise ValueError(f"Rol desconocido: {role}")

    users = _load_users()
    user = next((u for u in users if u["id"] == user_id), None)
    if user is None:
        raise ValueError("Usuario no encontrado")

    if role is not None:
        user["role"] = role
    if new_password:
        user["password_hash"] = _hash_password(new_password)

    _save_users(users)
    return _public(user)


def delete_user(user_id: str) -> bool:
    """Rechaza borrar al último admin restante — evita quedarse sin acceso
    a la app por accidente."""
    users = _load_users()
    target = next((u for u in users if u["id"] == user_id), None)
    if target is None:
        return False

    if target["role"] == "admin":
        remaining_admins = [u for u in users if u["role"] == "admin" and u["id"] != user_id]
        if not remaining_admins:
            raise ValueError("No se puede eliminar al último administrador")

    filtered = [u for u in users if u["id"] != user_id]
    _save_users(filtered)
    logger.info(f"Usuario eliminado: {target['username']}")
    return True


def ensure_bootstrap_admin():
    """Ya no se llama automáticamente al arrancar (ver needs_bootstrap() /
    bootstrap_create_admin()) — se deja el código porque sigue siendo una
    forma válida de crear el admin inicial si alguna vez hace falta un
    bootstrap no interactivo (ej. despliegue automatizado sin navegador a
    mano)."""
    if _load_users():
        return
    password = secrets.token_urlsafe(12)
    create_user("admin", password, role="admin")
    logger.warning(
        f"Cuenta admin creada automáticamente — usuario 'admin', "
        f"contraseña temporal: {password} (cámbiala en Configuración > Usuarios)"
    )


def needs_bootstrap() -> bool:
    """True si todavía no existe ningún usuario — el frontend usa esto para
    decidir si mostrar la pantalla de configuración inicial (crear admin
    con las credenciales que elige la propia persona) en vez del login."""
    return not _load_users()


def bootstrap_create_admin(username: str, password: str) -> Dict[str, Any]:
    """Crea la cuenta admin inicial desde la pantalla de configuración del
    primer arranque. A diferencia de ensure_bootstrap_admin() (contraseña
    aleatoria solo visible en el log), acá la persona elige sus propias
    credenciales en el navegador — solo funciona mientras no exista ningún
    usuario todavía, para que no sirva como puerta trasera para crear un
    segundo admin más adelante."""
    if _load_users():
        raise ValueError("Ya existe al menos un usuario — la configuración inicial ya se completó")
    return create_user(username, password, role="admin")


def get_or_create_session_secret() -> str:
    """Persistida en disco para que la sesión sobreviva los reinicios de
    uvicorn --reload — si se regenerara en cada arranque, cada recarga
    (que en este entorno pasa seguido) desconectaría a todo el mundo."""
    if os.path.isfile(SESSION_SECRET_PATH):
        try:
            with open(SESSION_SECRET_PATH, "r", encoding="utf-8") as handle:
                secret = handle.read().strip()
            if secret:
                return secret
        except OSError:
            pass

    secret = secrets.token_hex(32)
    try:
        with open(SESSION_SECRET_PATH, "w", encoding="utf-8") as handle:
            handle.write(secret)
    except OSError:
        pass
    return secret
