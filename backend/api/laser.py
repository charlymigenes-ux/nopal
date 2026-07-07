import asyncio
import os
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from backend.services.laser_service import (
    get_status,
    get_board_info,
    start_job,
    get_job_status,
    pause_job,
    resume_job,
    cancel_job,
    send_raw_command,
    ensure_listener,
    get_console_buffer,
    send_console_command,
    get_grbl_settings,
    set_grbl_setting,
    add_to_queue,
    get_queue,
    remove_from_queue,
    pop_from_queue,
    get_active_host,
    set_active_host,
    scan_network,
    list_usb_laser_ports,
    ensure_listener_ready,
    get_registered_lasers,
    register_laser,
    unregister_laser,
    sd_list_files,
    sd_create_folder,
    sd_delete_entry,
    sd_upload_file,
    has_sd_card,
)
from backend.utils import safe_section_path

router = APIRouter()


@router.get("/api/laser/host")
async def laser_host_endpoint():
    """Host activo del láser (el que usan todas las operaciones por defecto)."""
    return {"host": get_active_host()}


@router.post("/api/laser/host")
async def laser_set_host_endpoint(host: str = Form(...)):
    """Cambia el host activo del láser (ej. tras elegirlo de la lista de escaneo)."""
    clean_host = host.strip()
    if not clean_host:
        raise HTTPException(status_code=400, detail="Host inválido")
    set_active_host(clean_host)
    return {"success": True, "host": clean_host}


@router.get("/api/laser/scan")
async def laser_scan_endpoint():
    """Escanea la red local en busca de otras placas láser (ESP3D) disponibles."""
    devices = await scan_network()
    return {"devices": devices}


@router.get("/api/laser/usb-ports")
async def laser_usb_ports_endpoint():
    """Puertos serie USB conectados que coinciden con chips de controladoras láser."""
    return {"ports": list_usb_laser_ports()}


@router.post("/api/laser/usb-ports/test")
async def laser_usb_test_endpoint(device: str = Form(...)):
    """Prueba si el puerto USB indicado responde al protocolo GRBL (envía '?')."""
    host = f"usb:{device}"
    status = await get_status(host=host, timeout=3.0)
    if status is None:
        raise HTTPException(status_code=502, detail="No se detectó respuesta GRBL en este puerto")
    return {"connected": True, "host": host, **status}


@router.get("/api/laser/registry")
async def laser_registry_list_endpoint():
    """Placas láser registradas en NOPAL (red y USB)."""
    return {"lasers": get_registered_lasers()}


@router.post("/api/laser/registry")
async def laser_registry_add_endpoint(host: str = Form(...), name: str = Form(...), transport: str = Form(...)):
    """Registra una placa (red o USB) como láser disponible en NOPAL."""
    entry = register_laser(host, name, transport)
    return entry


@router.post("/api/laser/registry/remove")
async def laser_registry_remove_endpoint(host: str = Form(...)):
    """Quita una placa registrada."""
    if not unregister_laser(host):
        raise HTTPException(status_code=404, detail="No encontrado en el registro")
    return {"success": True}


@router.get("/api/laser/status")
async def laser_status_endpoint(host: Optional[str] = None):
    """Estado en vivo del láser (posición, estado GRBL) vía websocket."""
    resolved_host = host or get_active_host()
    status = await get_status(host=resolved_host)
    if status is None:
        return {"connected": False, "host": resolved_host}
    return {"connected": True, "host": resolved_host, **status}


@router.get("/api/laser/info")
async def laser_info_endpoint(host: Optional[str] = None):
    """Información estática de la placa controladora (chip, firmware, red)."""
    info = get_board_info(host=host or get_active_host())
    if not info:
        raise HTTPException(status_code=502, detail="No se pudo contactar al láser")
    return info


@router.post("/api/laser/command")
async def laser_command_endpoint(command: str = Form(...), host: Optional[str] = Form(None)):
    """Envía un comando GRBL suelto (jog, $H, $X, etc.)."""
    target = host or get_active_host()
    await ensure_listener_ready(target)
    success = send_raw_command(target, command)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    return {"success": True}


@router.post("/api/laser/job/start")
async def laser_job_start_endpoint(path: str = Form(...), host: Optional[str] = Form(None)):
    """Inicia el envío de un archivo G-code (de la biblioteca) al láser."""
    file_path = safe_section_path("gcode", path)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
        gcode_text = handle.read()

    try:
        job = start_job(host or get_active_host(), gcode_text, filename=os.path.basename(path))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return job


@router.get("/api/laser/job/status")
async def laser_job_status_endpoint(host: Optional[str] = None):
    return get_job_status(host or get_active_host())


@router.post("/api/laser/job/pause")
async def laser_job_pause_endpoint(host: Optional[str] = Form(None)):
    if not pause_job(host or get_active_host()):
        raise HTTPException(status_code=409, detail="No hay un trabajo en curso para pausar")
    return {"success": True}


@router.post("/api/laser/job/resume")
async def laser_job_resume_endpoint(host: Optional[str] = Form(None)):
    if not resume_job(host or get_active_host()):
        raise HTTPException(status_code=409, detail="No hay un trabajo pausado para reanudar")
    return {"success": True}


@router.post("/api/laser/job/cancel")
async def laser_job_cancel_endpoint(host: Optional[str] = Form(None)):
    if not cancel_job(host or get_active_host()):
        raise HTTPException(status_code=409, detail="No hay un trabajo en curso para cancelar")
    return {"success": True}


@router.get("/api/laser/console")
async def laser_console_endpoint(host: Optional[str] = None, count: int = 100):
    """Últimos mensajes transmitidos por el láser (consola en vivo)."""
    target = host or get_active_host()
    ensure_listener(target)
    return {"messages": get_console_buffer(host=target, count=count)}


@router.post("/api/laser/console")
async def laser_console_command_endpoint(command: str = Form(...), host: Optional[str] = Form(None)):
    """Envía un comando desde la consola del láser."""
    success = await send_console_command(host or get_active_host(), command)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    return {"success": True}


@router.get("/api/laser/settings")
async def laser_settings_endpoint(host: Optional[str] = None):
    """Parámetros $$ actuales de la placa GRBL."""
    settings = await get_grbl_settings(host=host or get_active_host())
    return {"settings": settings}


@router.post("/api/laser/settings")
async def laser_settings_update_endpoint(key: str = Form(...), value: str = Form(...), host: Optional[str] = Form(None)):
    """Actualiza un parámetro $$ individual."""
    result = await set_grbl_setting(host or get_active_host(), key, value)
    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("message", "No se pudo actualizar el parámetro"))
    return {"success": True}


@router.get("/api/laser/queue")
async def laser_queue_list_endpoint():
    """Trabajos en espera para enviarse al láser."""
    return {"queue": get_queue()}


@router.post("/api/laser/queue/add")
async def laser_queue_add_endpoint(path: str = Form(...)):
    """Agrega un archivo G-code de la biblioteca a la cola del láser."""
    file_path = safe_section_path("gcode", path)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    entry = add_to_queue(path, os.path.basename(path))
    return entry


@router.post("/api/laser/queue/remove")
async def laser_queue_remove_endpoint(id: int = Form(...)):
    """Quita un trabajo de la cola sin enviarlo."""
    if not remove_from_queue(id):
        raise HTTPException(status_code=404, detail="Elemento no encontrado en la cola")
    return {"success": True}


@router.get("/api/laser/sd/available")
async def laser_sd_available_endpoint(host: Optional[str] = None):
    """Indica si la placa activa tiene una tarjeta SD navegable."""
    target = host or get_active_host()
    loop = asyncio.get_event_loop()
    available = await loop.run_in_executor(None, has_sd_card, target)
    return {"available": available}


@router.post("/api/laser/queue/start")
async def laser_queue_start_endpoint(id: int = Form(...), host: Optional[str] = Form(None)):
    """Saca un trabajo de la cola y lo transmite línea por línea al láser.

    Nota: la ejecución directa desde SD ($F=archivo) se probó contra el
    firmware real (DLC32) y no arranca el trabajo (la placa se queda en
    Idle sin moverse, aunque acepta el comando sin error) — por eso,
    mientras no se identifique el comando correcto de este firmware,
    siempre se transmite por streaming, que sí es confiable.
    """
    target = host or get_active_host()

    current = get_job_status(target)
    if current.get("state") in ("running", "paused"):
        raise HTTPException(status_code=409, detail="Ya hay un trabajo en curso en este láser")

    entry = pop_from_queue(id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Elemento no encontrado en la cola")

    file_path = safe_section_path("gcode", entry["path"])
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            gcode_text = handle.read()
        job = start_job(target, gcode_text, filename=entry["filename"])
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return job


@router.get("/api/laser/sd/files")
async def laser_sd_files_endpoint(path: str = "/", host: Optional[str] = None):
    """Lista archivos/carpetas de la tarjeta SD insertada en la placa (ESP3D)."""
    target = host or get_active_host()
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, sd_list_files, target, path)


@router.post("/api/laser/sd/run")
async def laser_sd_run_endpoint(
    path: str = Form(""),
    name: str = Form(...),
    host: Optional[str] = Form(None),
):
    """Corre directamente un archivo que ya está en la SD, sin volver a subirlo.

    Deshabilitado: se confirmó contra hardware real que $F=archivo no arranca
    el trabajo en este firmware (DLC32) — la placa se queda en Idle sin
    moverse, sin reportar error. Hasta identificar el comando correcto de
    este firmware, no hay forma confiable de ejecutar un archivo que ya
    está en la SD (no tenemos su texto para transmitirlo por streaming).
    """
    raise HTTPException(
        status_code=501,
        detail=(
            "No se pudo confirmar el comando correcto para correr archivos "
            "directo desde la SD en este firmware. Usa la Cola (Biblioteca "
            "G-code) para enviar el archivo por streaming."
        ),
    )


@router.post("/api/laser/sd/folder")
async def laser_sd_folder_endpoint(path: str = Form(""), name: str = Form(...), host: Optional[str] = Form(None)):
    """Crea una carpeta en la tarjeta SD."""
    target = host or get_active_host()
    loop = asyncio.get_event_loop()
    success = await loop.run_in_executor(None, sd_create_folder, target, path, name)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo crear la carpeta en la SD")
    return {"success": True}


@router.post("/api/laser/sd/delete")
async def laser_sd_delete_endpoint(
    path: str = Form(""),
    name: str = Form(...),
    is_dir: bool = Form(False),
    host: Optional[str] = Form(None),
):
    """Elimina un archivo o carpeta de la tarjeta SD."""
    target = host or get_active_host()
    loop = asyncio.get_event_loop()
    success = await loop.run_in_executor(None, sd_delete_entry, target, path, name, is_dir)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo eliminar en la SD")
    return {"success": True}


@router.post("/api/laser/sd/upload")
async def laser_sd_upload_endpoint(
    path: str = Form(""),
    host: Optional[str] = Form(None),
    file: UploadFile = File(...),
):
    """Sube un archivo (desde tu computadora) directo a la tarjeta SD de la placa."""
    target = host or get_active_host()
    contents = await file.read()
    loop = asyncio.get_event_loop()
    success = await loop.run_in_executor(None, sd_upload_file, target, path, file.filename, contents)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo subir el archivo a la SD")
    return {"success": True}


@router.post("/api/laser/sd/upload-from-library")
async def laser_sd_upload_from_library_endpoint(
    gcode_path: str = Form(...),
    sd_path: str = Form(""),
    host: Optional[str] = Form(None),
):
    """Envía un archivo ya subido a la biblioteca de G-code de NOPAL directo a la SD de la placa."""
    file_path = safe_section_path("gcode", gcode_path)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado en la biblioteca")

    with open(file_path, "rb") as handle:
        contents = handle.read()

    filename = os.path.basename(gcode_path)
    target = host or get_active_host()
    loop = asyncio.get_event_loop()
    success = await loop.run_in_executor(None, sd_upload_file, target, sd_path, filename, contents)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo subir el archivo a la SD")
    return {"success": True}
