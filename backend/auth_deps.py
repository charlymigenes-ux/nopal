from fastapi import Depends, HTTPException, Request


def require_auth(request: Request) -> dict:
    """Cualquier usuario logueado (admin u operador)."""
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="No autenticado")
    return user


def require_role(role: str):
    """Solo dos roles, sin jerarquía entre ellos más allá de lo que cada
    endpoint decida explícitamente — por eso acá es una igualdad simple, no
    una comparación de rango."""
    def _dependency(user: dict = Depends(require_auth)) -> dict:
        if user.get("role") != role:
            raise HTTPException(status_code=403, detail="Permiso insuficiente")
        return user
    return _dependency
