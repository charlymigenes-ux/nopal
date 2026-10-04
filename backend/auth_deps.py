from typing import Optional

from fastapi import Depends, HTTPException, Request

from backend.services.auth_service import get_user_by_id
from backend.services.authorization_policy import Action, Principal, Resource, authorize


def require_auth(request: Request) -> dict:
    """Cualquier usuario logueado (admin u operador)."""
    session_user = request.session.get("user")
    if not session_user:
        raise HTTPException(status_code=401, detail="No autenticado")
    # El rol guardado en la cookie puede quedar obsoleto si otro
    # administrador degrada o elimina la cuenta. Se consulta el registro
    # actual en cada solicitud para aplicar el cambio inmediatamente.
    stored_user = get_user_by_id(session_user.get("user_id", ""))
    if stored_user is None:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Sesión inválida")
    return {
        "user_id": stored_user["id"],
        "username": stored_user["username"],
        "role": stored_user["role"],
    }


def require_role(role: str):
    """Solo dos roles, sin jerarquía entre ellos más allá de lo que cada
    endpoint decida explícitamente — por eso acá es una igualdad simple, no
    una comparación de rango."""
    def _dependency(user: dict = Depends(require_auth)) -> dict:
        if user.get("role") != role:
            raise HTTPException(status_code=403, detail="Permiso insuficiente")
        return user
    return _dependency


def principal_for_user(user: dict) -> Principal:
    """Adaptador del usuario que devuelve `require_auth` (rol releído del
    registro en cada request) al `Principal` de la Authorization Policy
    (ADR-006). Un rol desconocido queda sin rol y la política lo deniega."""
    return Principal.user(user.get("user_id"), user.get("role"))


def ensure_authorized(user: dict, action: Action, resource: Optional[Resource] = None) -> None:
    """Enforcement de ADR-006 para rutas ya migradas: consulta la política
    antes de ejecutar la acción y responde 403 (mismo detalle que
    `require_role`) si la decisión es DENY. La sesión la sigue validando
    `require_auth`, que responde 401 antes de llegar aquí."""
    if not authorize(principal_for_user(user), action, resource):
        raise HTTPException(status_code=403, detail="Permiso insuficiente")
