import json

from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services.accessory_service import (
    get_accessories,
    get_accessories_status,
    get_driver_names,
    register_accessory,
    set_accessory_power,
    unregister_accessory,
)

router = APIRouter()


@router.get("/api/accessories/drivers")
async def accessory_drivers_endpoint(user: dict = Depends(require_auth)):
    """Drivers disponibles (ej. 'home_assistant', 'http_relay') — para poblar
    el formulario de registro sin hardcodear la lista en el frontend."""
    return {"drivers": get_driver_names()}


@router.get("/api/accessories")
async def accessory_list_endpoint(user: dict = Depends(require_auth)):
    """Accesorios IoT registrados (extractores, ventiladores, bombas, etc.)."""
    return {"accessories": get_accessories()}


@router.get("/api/accessories/status")
async def accessory_status_endpoint(user: dict = Depends(require_auth)):
    """Igual que /api/accessories pero con el estado on/off en vivo de cada
    uno (probeo real contra el driver) — endpoint aparte porque ese probeo
    tiene costo y no todas las pantallas lo necesitan."""
    return {"accessories": await get_accessories_status()}


@router.post("/api/accessories")
async def accessory_register_endpoint(
    name: str = Form(...),
    kind: str = Form("other"),
    driver: str = Form(...),
    config: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    """Registra un accesorio nuevo. `config` es un JSON con los campos que
    pida el driver elegido (ej. para 'home_assistant': base_url, token,
    entity_id; para 'http_relay': on_url, off_url, y opcionalmente
    status_url/status_on_text)."""
    try:
        config_dict = json.loads(config)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="El campo 'config' no es un JSON válido")

    try:
        entry = register_accessory(name, kind, driver, config_dict)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return entry


@router.post("/api/accessories/remove")
async def accessory_remove_endpoint(id: str = Form(...), user: dict = Depends(require_role("admin"))):
    if not unregister_accessory(id):
        raise HTTPException(status_code=404, detail="Accesorio no encontrado")
    return {"success": True}


@router.post("/api/accessories/power")
async def accessory_power_endpoint(id: str = Form(...), on: bool = Form(...), user: dict = Depends(require_auth)):
    result = await set_accessory_power(id, on)
    if result is None:
        raise HTTPException(status_code=404, detail="Accesorio no encontrado")
    if not result:
        raise HTTPException(status_code=502, detail="No se pudo cambiar el estado del accesorio")
    return {"success": True}
