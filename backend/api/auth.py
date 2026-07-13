import time
from collections import defaultdict, deque
from typing import Deque, Dict, Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request

from backend.auth_deps import require_auth, require_role
from backend.services.auth_service import (
    bootstrap_create_admin,
    create_user,
    delete_user,
    list_users,
    needs_bootstrap,
    update_user,
    verify_password,
)

router = APIRouter()

LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_FAILURES = 5
_login_failures: Dict[str, Deque[float]] = defaultdict(deque)


def _login_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _recent_failures(request: Request) -> Deque[float]:
    failures = _login_failures[_login_key(request)]
    cutoff = time.monotonic() - LOGIN_WINDOW_SECONDS
    while failures and failures[0] < cutoff:
        failures.popleft()
    return failures


@router.get("/api/auth/setup-required")
async def setup_required_endpoint():
    """Público a propósito (todavía no puede existir ninguna sesión antes
    de que exista el primer usuario) — el frontend lo consulta antes de
    decidir si muestra el login o la pantalla de configuración inicial."""
    return {"required": needs_bootstrap()}


@router.post("/api/auth/setup")
async def setup_endpoint(request: Request, username: str = Form(...), password: str = Form(...)):
    """Crea la cuenta admin inicial y arranca la sesión de una — solo
    funciona una vez, mientras auth_users.json esté vacío."""
    try:
        user = bootstrap_create_admin(username, password)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    request.session["user"] = {"user_id": user["id"], "username": user["username"], "role": user["role"]}
    return {"username": user["username"], "role": user["role"]}


@router.post("/api/auth/login")
async def login_endpoint(request: Request, username: str = Form(...), password: str = Form(...)):
    failures = _recent_failures(request)
    if len(failures) >= LOGIN_MAX_FAILURES:
        raise HTTPException(status_code=429, detail="Demasiados intentos; vuelve a intentarlo en unos minutos")
    user = verify_password(username, password)
    if user is None:
        failures.append(time.monotonic())
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")
    _login_failures.pop(_login_key(request), None)
    request.session["user"] = {"user_id": user["id"], "username": user["username"], "role": user["role"]}
    return {"username": user["username"], "role": user["role"]}


@router.post("/api/auth/logout")
async def logout_endpoint(request: Request):
    request.session.clear()
    return {"success": True}


@router.get("/api/auth/me")
async def me_endpoint(user: dict = Depends(require_auth)):
    return {"username": user["username"], "role": user["role"]}


@router.get("/api/auth/users")
async def list_users_endpoint(user: dict = Depends(require_role("admin"))):
    return {"users": list_users()}


@router.post("/api/auth/users")
async def create_user_endpoint(
    username: str = Form(...),
    password: str = Form(...),
    role: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    try:
        entry = create_user(username, password, role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return entry


@router.post("/api/auth/users/update")
async def update_user_endpoint(
    user_id: str = Form(...),
    role: Optional[str] = Form(None),
    new_password: Optional[str] = Form(None),
    user: dict = Depends(require_role("admin")),
):
    """Cambia el rol y/o resetea la contraseña de un usuario existente —
    usado desde Configuración > Usuarios."""
    try:
        entry = update_user(user_id, role=role, new_password=new_password or None)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return entry


@router.post("/api/auth/users/remove")
async def remove_user_endpoint(user_id: str = Form(...), user: dict = Depends(require_role("admin"))):
    try:
        if not delete_user(user_id):
            raise HTTPException(status_code=404, detail="Usuario no encontrado")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True}
