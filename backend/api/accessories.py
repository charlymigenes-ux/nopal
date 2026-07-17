import asyncio
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from backend.auth_deps import require_auth, require_role
from backend.services import accessory_scenes
from backend.services.accessory_service import (
    discover_arduino_boards,
    get_accessories,
    get_accessories_status,
    get_driver_names,
    register_accessory,
    rename_accessory,
    set_accessory_led_color,
    set_accessory_power,
    unregister_accessory,
)
from backend.services.activity_log import get_recent as get_recent_activity
from backend.services.firmware_flash_service import (
    flash_via_ota,
    flash_via_usb,
    list_builds,
    resolve_build_path,
    save_build,
)

router = APIRouter()


@router.get("/api/accessories/drivers")
async def accessory_drivers_endpoint(user: dict = Depends(require_auth)):
    """Drivers disponibles (ej. 'home_assistant', 'http_relay') — para poblar
    el formulario de registro sin hardcodear la lista en el frontend."""
    return {"drivers": get_driver_names()}


@router.get("/api/accessories/arduino/discover")
async def accessory_arduino_discover_endpoint(user: dict = Depends(require_role("admin"))):
    """Escanea los puertos USB en busca de placas ESP32 con el firmware
    NOPAL (firmware/nopal_accessory/) — para cada una que contesta, el
    puerto que tomó y el modelo/capacidades que declaró (relés, tira PWM,
    WS2812), para poblar el formulario de alta sin que el usuario tenga que
    adivinar nada."""
    return {"boards": await discover_arduino_boards()}


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


@router.post("/api/accessories/led")
async def accessory_led_endpoint(
    id: str = Form(...),
    r: int = Form(...),
    g: int = Form(...),
    b: int = Form(...),
    user: dict = Depends(require_auth),
):
    """Fija el color de una tira LED (PWM o WS2812) conectada a una placa
    NOPAL. Solo aplica a accesorios cuyo driver soporte 'set_color' (hoy,
    únicamente 'arduino')."""
    for value in (r, g, b):
        if not 0 <= value <= 255:
            raise HTTPException(status_code=400, detail="Los valores RGB deben estar entre 0 y 255")
    result = await set_accessory_led_color(id, r, g, b)
    if result is None:
        raise HTTPException(status_code=404, detail="Accesorio no encontrado o sin soporte de color")
    if not result:
        raise HTTPException(status_code=502, detail="No se pudo cambiar el color")
    return {"success": True}


@router.post("/api/accessories/rename")
async def accessory_rename_endpoint(
    id: str = Form(...),
    name: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    entry = rename_accessory(id, name)
    if entry is None:
        raise HTTPException(status_code=404, detail="Accesorio no encontrado")
    return entry


@router.get("/api/accessories/activity")
async def accessory_activity_endpoint(user: dict = Depends(require_auth)):
    """Historial reciente de eventos reales (encendidos, apagados, cambios
    de color, altas/bajas de accesorios, escenas ejecutadas) — ver
    activity_log.py. Vacío si todavía no pasó nada."""
    return {"activity": get_recent_activity(30)}


@router.get("/api/accessories/scenes")
async def accessory_scenes_list_endpoint(user: dict = Depends(require_auth)):
    return {"scenes": accessory_scenes.get_scenes()}


@router.post("/api/accessories/scenes")
async def accessory_scenes_create_endpoint(
    name: str = Form(...),
    actions: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    """`actions` es un JSON: lista de {"accessory_id", "on"} o
    {"accessory_id", "color": [r, g, b]}."""
    try:
        actions_list = json.loads(actions)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="El campo 'actions' no es un JSON válido")
    try:
        scene = accessory_scenes.create_scene(name, actions_list)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return scene


@router.delete("/api/accessories/scenes/{scene_id}")
async def accessory_scenes_delete_endpoint(scene_id: str, user: dict = Depends(require_role("admin"))):
    if not accessory_scenes.delete_scene(scene_id):
        raise HTTPException(status_code=404, detail="Escena no encontrada")
    return {"success": True}


@router.post("/api/accessories/scenes/{scene_id}/run")
async def accessory_scenes_run_endpoint(scene_id: str, user: dict = Depends(require_auth)):
    result = await accessory_scenes.run_scene(scene_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Escena no encontrada")
    return {"success": result}


# ── Flasheo de firmware ──
#
# NOPAL nunca compila nada (no hay arduino-cli/platformio en el servidor):
# estos endpoints administran binarios .bin YA COMPILADOS que el usuario
# sube (Arduino IDE -> Sketch -> Export Compiled Binary) y los escriben en
# una placa real, por USB (esptool) o por red (ElegantOTA). Ver
# backend/services/firmware_flash_service.py.

@router.get("/api/accessories/firmware/builds")
async def accessory_firmware_builds_endpoint(user: dict = Depends(require_auth)):
    """Binarios .bin ya subidos y disponibles para flashear."""
    return {"builds": list_builds()}


@router.post("/api/accessories/firmware/upload")
async def accessory_firmware_upload_endpoint(
    file: UploadFile = File(...),
    user: dict = Depends(require_role("admin")),
):
    """Sube un binario .bin ya compilado (Export Compiled Binary) al
    servidor, para poder flashearlo después por USB u OTA."""
    if not file.filename or not file.filename.lower().endswith(".bin"):
        raise HTTPException(status_code=400, detail="El archivo debe ser un binario .bin")

    content = await file.read()

    try:
        build = save_build(file.filename, content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"success": True, "build": build}


@router.post("/api/accessories/firmware/flash-usb")
async def accessory_firmware_flash_usb_endpoint(
    device: str = Form(...),
    filename: str = Form(...),
    user: dict = Depends(require_role("admin")),
):
    """Flashea `filename` (ya subido, ver /firmware/upload) en la placa
    conectada en `device` (ej. /dev/ttyUSB1) usando esptool, offset 0x0.
    Suelta cualquier conexión serie del driver 'arduino' sobre ese puerto
    antes de tocarlo — esptool necesita control exclusivo del puerto."""
    try:
        bin_path = resolve_build_path(filename)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, flash_via_usb, device, str(bin_path))

    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("error") or "Fallo al flashear por USB")

    return result


@router.post("/api/accessories/firmware/flash-ota")
async def accessory_firmware_flash_ota_endpoint(
    ip: str = Form(...),
    filename: str = Form(...),
    username: str = Form(""),
    password: str = Form(""),
    user: dict = Depends(require_role("admin")),
):
    """Flashea `filename` (ya subido) por red, contra el ElegantOTA que
    corre en la placa en `ip` (firmware 1.3+, Wi-Fi ya conectado).
    username/password son las credenciales de ElegantOTA configuradas en
    secrets.h de esa placa (vacías si esa placa no tiene autenticación)."""
    try:
        bin_path = resolve_build_path(filename)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, flash_via_ota, ip, str(bin_path), username, password)

    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("error") or "Fallo al flashear por OTA")

    return result
