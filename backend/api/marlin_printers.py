import os
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth, require_role
from backend.services import printer_profiles
from backend.services.marlin_printer_service import (
    list_usb_marlin_ports,
    probe_marlin,
    probe_marlin_autobaud,
    probe_marlin_firmware_info,
    get_registered_printers,
    get_registered_printers_with_status,
    register_printer,
    unregister_printer,
    get_status,
    jog,
    home,
    get_temperature_snapshot,
    set_heater_target,
    ensure_listener,
    get_console_buffer,
    send_console_command,
    start_print,
    get_job_status,
    get_active_job_devices,
    pause_job,
    resume_job,
    cancel_job,
)
from backend.utils import safe_section_path

router = APIRouter()


@router.get("/api/marlin-printers/profiles")
async def marlin_printers_profiles_endpoint(user: dict = Depends(require_auth)):
    """Catálogo de perfiles de impresora conocidos (ver printer_profiles.py)
    -- para poblar el selector de modelo del alta. Vacío para una placa
    Marlin genérica sin perfil, eso sigue siendo válido."""
    return {"profiles": printer_profiles.list_profiles()}


@router.get("/api/marlin-printers/discover")
async def marlin_printers_discover_endpoint(user: dict = Depends(require_auth)):
    """Puertos USB conectados que podrían ser una impresora Marlin (aún no registrados)."""
    return {"ports": list_usb_marlin_ports()}


@router.get("/api/marlin-printers/registry")
async def marlin_printers_registry_endpoint(user: dict = Depends(require_auth)):
    return {"printers": get_registered_printers()}


@router.get("/api/marlin-printers/registry/status")
async def marlin_printers_registry_status_endpoint(user: dict = Depends(require_auth)):
    return {"printers": get_registered_printers_with_status()}


@router.post("/api/marlin-printers/usb-ports/test")
async def marlin_usb_test_endpoint(
    device: str = Form(...),
    baud: Optional[int] = Form(None),
    user: dict = Depends(require_auth),
):
    """Prueba si el puerto USB indicado responde al protocolo Marlin (M105).
    Si no se manda `baud`, autodetecta probando 115200 y 250000 en orden
    (ver probe_marlin_autobaud) -- antes esto siempre asumía 115200 sin
    importar lo elegido en el dropdown del frontend."""
    if baud is not None:
        detected_baud = baud if await probe_marlin(device, baud) else None
    else:
        detected_baud = await probe_marlin_autobaud(device)
    if detected_baud is None:
        raise HTTPException(status_code=502, detail="No se detectó respuesta Marlin en este puerto")
    return {"connected": True, "device": device, "baud": detected_baud}


@router.post("/api/marlin-printers/registry")
async def marlin_printers_registry_add_endpoint(
    device: str = Form(...),
    name: str = Form(...),
    baud: Optional[int] = Form(None),
    profile_id: Optional[str] = Form(None),
    board_variant: Optional[str] = Form(None),
    extruder_count: Optional[int] = Form(None),
    user: dict = Depends(require_role("admin")),
):
    """Registra una impresora Marlin conectada por USB. El handshake es
    obligatorio server-side (no solo confiar en que el frontend haya
    llamado a /usb-ports/test antes) — así el registro sigue siendo
    seguro incluso si algo llama a este endpoint directo. Si no se manda
    `baud`, autodetecta (ver probe_marlin_autobaud); si autodetectar no
    encuentra nada, igual registra a 115200 para no bloquear el alta (queda
    marcada verified_marlin=False, como ya pasaba antes con un baud
    incorrecto a mano).

    `profile_id`/`board_variant`/`extruder_count` son opcionales -- una
    placa Marlin genérica sin perfil se sigue registrando igual que
    siempre, sin mandar ninguno de los tres."""
    if profile_id is not None and printer_profiles.get_profile(profile_id) is None:
        raise HTTPException(status_code=400, detail="Perfil de impresora desconocido")
    if board_variant is not None:
        if profile_id is None:
            raise HTTPException(status_code=400, detail="board_variant requiere un profile_id")
        if not printer_profiles.is_valid_board_variant(profile_id, board_variant):
            raise HTTPException(status_code=400, detail="Revisión de placa desconocida para este perfil")
    if extruder_count is not None:
        if profile_id is None:
            raise HTTPException(status_code=400, detail="extruder_count requiere un profile_id")
        if not printer_profiles.is_valid_extruder_count(profile_id, extruder_count):
            raise HTTPException(status_code=400, detail="Cantidad de extrusores fuera de rango para este perfil")

    if baud is not None:
        verified_marlin = await probe_marlin(device, baud)
        resolved_baud = baud
    else:
        detected_baud = await probe_marlin_autobaud(device)
        verified_marlin = detected_baud is not None
        resolved_baud = detected_baud or 115200

    firmware_info = await probe_marlin_firmware_info(device, resolved_baud) if verified_marlin else None
    return register_printer(
        device, name, resolved_baud, verified_marlin, firmware_info,
        profile_id, board_variant, extruder_count,
    )


@router.post("/api/marlin-printers/registry/remove")
async def marlin_printers_registry_remove_endpoint(device: str = Form(...), user: dict = Depends(require_role("admin"))):
    if not unregister_printer(device):
        raise HTTPException(status_code=404, detail="No encontrado en el registro")
    return {"success": True}


@router.get("/api/marlin-printers/status")
async def marlin_printers_status_endpoint(device: str, user: dict = Depends(require_auth)):
    status = await get_status(device)
    if status is None:
        return {"connected": False, "device": device}
    return {"connected": True, "device": device, "firmware": "marlin", **status}


@router.post("/api/marlin-printers/jog")
async def marlin_printers_jog_endpoint(
    device: str = Form(...),
    axis: str = Form(...),
    distance: float = Form(...),
    feed: float = Form(...),
    user: dict = Depends(require_auth),
):
    if not await jog(device, axis, distance, feed):
        raise HTTPException(status_code=502, detail="No se pudo mover el eje")
    return {"success": True}


@router.post("/api/marlin-printers/home")
async def marlin_printers_home_endpoint(
    device: str = Form(...),
    axes: Optional[str] = Form(None),
    user: dict = Depends(require_auth),
):
    if not await home(device, axes):
        raise HTTPException(status_code=502, detail="No se pudo iniciar el home")
    return {"success": True}


@router.get("/api/marlin-printers/temperatures")
async def marlin_printers_temperatures_endpoint(device: str, user: dict = Depends(require_auth)):
    return await get_temperature_snapshot(device)


@router.post("/api/marlin-printers/temperature-target")
async def marlin_printers_temperature_target_endpoint(
    device: str = Form(...),
    heater: str = Form(...),
    target: float = Form(...),
    user: dict = Depends(require_auth),
):
    if not set_heater_target(device, heater, target):
        raise HTTPException(status_code=502, detail="No se pudo actualizar la temperatura objetivo")
    return {"success": True}


@router.get("/api/marlin-printers/console")
async def marlin_printers_console_endpoint(device: str, count: int = 100, user: dict = Depends(require_auth)):
    ensure_listener(device)
    return {"messages": get_console_buffer(device, count=count)}


@router.post("/api/marlin-printers/console")
async def marlin_printers_console_command_endpoint(
    device: str = Form(...),
    command: str = Form(...),
    user: dict = Depends(require_auth),
):
    if not await send_console_command(device, command):
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    return {"success": True}


@router.post("/api/marlin-printers/print/start")
async def marlin_printers_print_start_endpoint(
    device: str = Form(...),
    path: str = Form(...),
    user: dict = Depends(require_auth),
):
    """Inicia el envío de un archivo G-code (de la biblioteca) a la impresora."""
    file_path = safe_section_path("gcode", path)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
        gcode_text = handle.read()

    try:
        job = start_print(device, gcode_text, filename=os.path.basename(path))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return job


@router.get("/api/marlin-printers/print/status")
async def marlin_printers_print_status_endpoint(device: str, user: dict = Depends(require_auth)):
    return await get_job_status(device)


@router.get("/api/marlin-printers/jobs/active")
async def marlin_printers_active_jobs_endpoint(user: dict = Depends(require_auth)):
    return {"jobs": get_active_job_devices()}


@router.post("/api/marlin-printers/print/pause")
async def marlin_printers_print_pause_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    if not await pause_job(device):
        raise HTTPException(status_code=409, detail="No hay una impresión en curso para pausar")
    return {"success": True}


@router.post("/api/marlin-printers/print/resume")
async def marlin_printers_print_resume_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    if not await resume_job(device):
        raise HTTPException(status_code=409, detail="No hay una impresión pausada para reanudar")
    return {"success": True}


@router.post("/api/marlin-printers/print/cancel")
async def marlin_printers_print_cancel_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    if not await cancel_job(device):
        raise HTTPException(status_code=409, detail="No hay una impresión en curso para cancelar")
    return {"success": True}
