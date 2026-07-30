import asyncio
import os
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from backend.auth_deps import require_auth, require_role
from backend.services.laser_service import (
    get_status,
    get_parser_state,
    get_board_info,
    start_job,
    get_job_status,
    get_active_job_hosts,
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
    probe_single_host,
    list_usb_laser_ports,
    probe_grbl,
    ensure_listener_ready,
    get_registered_lasers,
    get_registered_lasers_status,
    register_laser,
    unregister_laser,
    sd_list_files,
    sd_create_folder,
    sd_delete_entry,
    sd_upload_file,
    start_sd_job,
    has_sd_card,
    get_laser_history,
    attach_laser_history_snapshot,
    jog,
    home,
    get_host_firmware,
)
from backend.utils import safe_section_path

router = APIRouter()


@router.get("/api/laser/host")
async def laser_host_endpoint(user: dict = Depends(require_auth)):
    """Host activo del láser (el que usan todas las operaciones por defecto)."""
    return {"host": get_active_host()}


@router.post("/api/laser/host")
async def laser_set_host_endpoint(host: str = Form(...), user: dict = Depends(require_auth)):
    """Cambia el host activo del láser (ej. tras elegirlo de la lista de escaneo)."""
    clean_host = host.strip()
    if not clean_host:
        raise HTTPException(status_code=400, detail="Host inválido")
    set_active_host(clean_host)
    return {"success": True, "host": clean_host}


@router.get("/api/laser/scan")
async def laser_scan_endpoint(user: dict = Depends(require_auth)):
    """Escanea la red local en busca de otras placas láser (ESP3D) disponibles."""
    devices = await scan_network()
    return {"devices": devices}


@router.get("/api/laser/scan-ip")
async def laser_scan_ip_endpoint(ip: str, user: dict = Depends(require_auth)):
    """Prueba una IP puntual en vez de barrer toda la subred — para placas
    fuera del rango detectado automáticamente (otra subred, modo Punto de
    Acceso propio, etc.)."""
    # Solo host[:puerto] — cualquier "/", "#" o "?" que se haya colado del
    # campo de texto (ej. pegar una URL completa) rompe la petición HTTP más
    # adelante de forma silenciosa (el fragmento nunca llega al servidor).
    clean_ip = ip.strip().split("/")[0].split("#")[0].split("?")[0]
    if not clean_ip:
        raise HTTPException(status_code=400, detail="IP inválida")
    device = await probe_single_host(clean_ip)
    if not device:
        raise HTTPException(status_code=404, detail="No se encontró una placa en esa IP")
    return device


@router.get("/api/laser/usb-ports")
async def laser_usb_ports_endpoint(user: dict = Depends(require_auth)):
    """Puertos serie USB conectados que coinciden con chips de controladoras láser."""
    return {"ports": list_usb_laser_ports()}


@router.post("/api/laser/usb-ports/test")
async def laser_usb_test_endpoint(device: str = Form(...), user: dict = Depends(require_auth)):
    """Prueba si el puerto USB indicado responde al protocolo GRBL (envía '?')."""
    host = f"usb:{device}"
    status = await get_status(host=host, timeout=3.0)
    if status is None:
        raise HTTPException(status_code=502, detail="No se detectó respuesta GRBL en este puerto")
    return {"connected": True, "host": host, **status}


@router.get("/api/laser/registry")
async def laser_registry_list_endpoint(user: dict = Depends(require_auth)):
    """Placas láser registradas en NOPAL (red y USB)."""
    return {"lasers": get_registered_lasers()}


@router.get("/api/laser/registry/status")
async def laser_registry_status_endpoint(user: dict = Depends(require_auth)):
    """Igual que /api/laser/registry pero con un campo "online" agregado por
    placa (USB: existe el puerto ahora; red: probe puntual a ese host) — para
    una pantalla de "todos los dispositivos" que los liste sin importar si
    están conectados. Deliberadamente un endpoint aparte: /api/laser/registry
    lo llaman varias pantallas seguido y no deben pagar el costo de una
    probada de red en cada una."""
    return {"lasers": await get_registered_lasers_status()}


@router.get("/api/laser/history")
async def laser_history_endpoint(limit: int = 50, user: dict = Depends(require_auth)):
    """Historial de trabajos láser (completados, cancelados o con error), más recientes primero."""
    return {"jobs": get_laser_history(limit)}


@router.post("/api/laser/history/snapshot")
async def laser_history_snapshot_endpoint(host: str = Form(...), snapshot: str = Form(...), user: dict = Depends(require_auth)):
    """Adjunta la captura del grill (figura trazada) al trabajo más reciente de ese host."""
    if not attach_laser_history_snapshot(host, snapshot):
        raise HTTPException(status_code=404, detail="No hay historial para ese host")
    return {"success": True}


@router.post("/api/laser/registry")
async def laser_registry_add_endpoint(
    host: str = Form(...),
    name: str = Form(...),
    transport: str = Form(...),
    work_area_width: Optional[float] = Form(None),
    work_area_height: Optional[float] = Form(None),
    home_corner: Optional[str] = Form(None),
    kind: str = Form("laser"),
    machine_profile: Optional[str] = Form(None),
    firmware: Optional[str] = Form(None),
    user: dict = Depends(require_role("admin")),
):
    """Registra una placa (red o USB) como láser o CNC disponible en NOPAL."""
    verified_grbl = None
    if host.startswith("usb:"):
        verified_grbl = await probe_grbl(host[len("usb:"):])
    entry = register_laser(
        host, name, transport, work_area_width, work_area_height, home_corner,
        kind, machine_profile, firmware, verified_grbl,
    )
    return entry


@router.post("/api/laser/registry/remove")
async def laser_registry_remove_endpoint(host: str = Form(...), user: dict = Depends(require_role("admin"))):
    """Quita una placa registrada."""
    if not unregister_laser(host):
        raise HTTPException(status_code=404, detail="No encontrado en el registro")
    return {"success": True}


@router.get("/api/laser/status")
async def laser_status_endpoint(host: Optional[str] = None, user: dict = Depends(require_auth)):
    """Estado en vivo del láser (posición, estado GRBL) vía websocket."""
    resolved_host = host or get_active_host()
    status = await get_status(host=resolved_host)
    if status is None:
        return {"connected": False, "host": resolved_host}
    return {"connected": True, "host": resolved_host, "firmware": get_host_firmware(resolved_host), **status}


@router.get("/api/laser/parser-state")
async def laser_parser_state_endpoint(host: Optional[str] = None, user: dict = Depends(require_auth)):
    """Sistema de coordenadas activo (G54/G55/...) vía '$G'."""
    resolved_host = host or get_active_host()
    state = await get_parser_state(host=resolved_host)
    if state is None:
        raise HTTPException(status_code=502, detail="No se pudo leer el estado del parser")
    return {"host": resolved_host, **state}


@router.get("/api/laser/info")
async def laser_info_endpoint(host: Optional[str] = None, user: dict = Depends(require_auth)):
    """Información estática de la placa controladora (chip, firmware, red)."""
    info = get_board_info(host=host or get_active_host())
    if not info:
        raise HTTPException(status_code=502, detail="No se pudo contactar al láser")
    return info


@router.post("/api/laser/command")
async def laser_command_endpoint(command: str = Form(...), host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
    """Envía un comando GRBL suelto (jog, $H, $X, etc.)."""
    target = host or get_active_host()
    await ensure_listener_ready(target)
    success = send_raw_command(target, command)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    return {"success": True}


@router.post("/api/laser/jog")
async def laser_jog_endpoint(
    axis: str = Form(...),
    distance: float = Form(...),
    feed: float = Form(...),
    host: Optional[str] = Form(None),
    user: dict = Depends(require_auth),
):
    """Mueve un eje en relativo. La secuencia real (jog GRBL vs. G91/G1/G90
    de Marlin) se arma en el backend según el firmware registrado para ese
    host, para que el frontend no tenga que saber qué protocolo habla la placa."""
    target = host or get_active_host()
    if not await jog(target, axis, distance, feed):
        raise HTTPException(status_code=502, detail="No se pudo mover el eje")
    return {"success": True}


@router.post("/api/laser/home")
async def laser_home_endpoint(
    axes: Optional[str] = Form(None),
    host: Optional[str] = Form(None),
    user: dict = Depends(require_auth),
):
    """Inicia el ciclo de home ($H en GRBL, G28 en Marlin)."""
    target = host or get_active_host()
    if not await home(target, axes):
        raise HTTPException(status_code=502, detail="No se pudo iniciar el home")
    return {"success": True}


@router.post("/api/laser/job/start")
async def laser_job_start_endpoint(path: str = Form(...), host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
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
async def laser_job_status_endpoint(host: Optional[str] = None, user: dict = Depends(require_auth)):
    return await get_job_status(host or get_active_host())


@router.get("/api/laser/jobs/active")
async def laser_active_jobs_endpoint(user: dict = Depends(require_auth)):
    """Todos los hosts con un trabajo propio en curso ahora mismo — para que
    el frontend no pierda de vista un corte activo aunque el usuario esté
    viendo otro láser/CNC en la interfaz."""
    return {"jobs": get_active_job_hosts()}


@router.post("/api/laser/job/pause")
async def laser_job_pause_endpoint(host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
    if not await pause_job(host or get_active_host()):
        raise HTTPException(status_code=409, detail="No hay un trabajo en curso para pausar")
    return {"success": True}


@router.post("/api/laser/job/resume")
async def laser_job_resume_endpoint(host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
    if not await resume_job(host or get_active_host()):
        raise HTTPException(status_code=409, detail="No hay un trabajo pausado para reanudar")
    return {"success": True}


@router.post("/api/laser/job/cancel")
async def laser_job_cancel_endpoint(host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
    if not await cancel_job(host or get_active_host()):
        raise HTTPException(status_code=409, detail="No hay un trabajo en curso para cancelar")
    return {"success": True}


@router.get("/api/laser/console")
async def laser_console_endpoint(host: Optional[str] = None, count: int = 100, user: dict = Depends(require_auth)):
    """Últimos mensajes transmitidos por el láser (consola en vivo)."""
    target = host or get_active_host()
    ensure_listener(target)
    return {"messages": get_console_buffer(host=target, count=count)}


@router.post("/api/laser/console")
async def laser_console_command_endpoint(command: str = Form(...), host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
    """Envía un comando desde la consola del láser."""
    success = await send_console_command(host or get_active_host(), command)
    if not success:
        raise HTTPException(status_code=502, detail="No se pudo enviar el comando")
    return {"success": True}


@router.get("/api/laser/settings")
async def laser_settings_endpoint(host: Optional[str] = None, user: dict = Depends(require_auth)):
    """Parámetros $$ actuales de la placa GRBL."""
    settings = await get_grbl_settings(host=host or get_active_host())
    return {"settings": settings}


@router.post("/api/laser/settings")
async def laser_settings_update_endpoint(key: str = Form(...), value: str = Form(...), host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
    """Actualiza un parámetro $$ individual."""
    result = await set_grbl_setting(host or get_active_host(), key, value)
    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("message", "No se pudo actualizar el parámetro"))
    return {"success": True}


@router.get("/api/laser/queue")
async def laser_queue_list_endpoint(user: dict = Depends(require_auth)):
    """Trabajos en espera para enviarse al láser."""
    return {"queue": get_queue()}


@router.post("/api/laser/queue/add")
async def laser_queue_add_endpoint(path: str = Form(...), kind: str = Form("laser"), user: dict = Depends(require_auth)):
    """Agrega un archivo G-code de la biblioteca a la cola del láser o del CNC
    (`kind` decide en qué ficha aparece — ver add_to_queue)."""
    file_path = safe_section_path("gcode", path)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    entry = add_to_queue(path, os.path.basename(path), kind)
    return entry


@router.post("/api/laser/queue/remove")
async def laser_queue_remove_endpoint(id: int = Form(...), user: dict = Depends(require_auth)):
    """Quita un trabajo de la cola sin enviarlo."""
    if not remove_from_queue(id):
        raise HTTPException(status_code=404, detail="Elemento no encontrado en la cola")
    return {"success": True}


@router.get("/api/laser/sd/available")
async def laser_sd_available_endpoint(host: Optional[str] = None, user: dict = Depends(require_auth)):
    """Indica si la placa activa tiene una tarjeta SD navegable."""
    target = host or get_active_host()
    loop = asyncio.get_event_loop()
    available = await loop.run_in_executor(None, has_sd_card, target)
    return {"available": available}


@router.post("/api/laser/queue/start")
async def laser_queue_start_endpoint(id: int = Form(...), host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
    """Saca un trabajo de la cola y lo transmite línea por línea al láser.

    Nota: la ejecución directa desde SD ($F=archivo) se probó contra el
    firmware real (DLC32) y no arranca el trabajo (la placa se queda en
    Idle sin moverse, aunque acepta el comando sin error) — por eso,
    mientras no se identifique el comando correcto de este firmware,
    siempre se transmite por streaming, que sí es confiable.
    """
    target = host or get_active_host()

    current = await get_job_status(target)
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
async def laser_sd_files_endpoint(path: str = "/", host: Optional[str] = None, user: dict = Depends(require_auth)):
    """Lista archivos/carpetas de la tarjeta SD insertada en la placa (ESP3D)."""
    target = host or get_active_host()
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, sd_list_files, target, path)


@router.post("/api/laser/sd/run")
async def laser_sd_run_endpoint(
    path: str = Form(""),
    name: str = Form(...),
    host: Optional[str] = Form(None),
    user: dict = Depends(require_auth),
):
    """Corre directamente un archivo que ya está en la SD, sin volver a subirlo.

    Antes esto quedaba deshabilitado (501 fijo) porque un intento con
    $F=archivo, probado contra hardware real (TTS-55 Pro / FluidNC), no
    arrancaba el trabajo. $F= no es el comando real de FluidNC para esto —
    es $SD/Run=archivo (ver wiki.fluidnc.com/en/features/jobs), que es lo
    que manda start_sd_job/_run_sd_job en laser_service.py. Acá solo se arma
    la ruta relativa a la raíz de la SD juntando `path` (puede venir vacío
    o "/subcarpeta") con `name`.
    """
    target = host or get_active_host()
    clean_path = (path or "").strip("/")
    full_path = f"{clean_path}/{name}" if clean_path else name
    try:
        # Sin executor a propósito: start_sd_job hace asyncio.create_task(...)
        # para programar _run_sd_job, y eso necesita correr sobre el loop de
        # eventos real (mismo criterio que start_job en /api/laser/queue/start,
        # unas líneas más arriba en este archivo) -- en un hilo de executor
        # no habría loop corriendo y create_task fallaría.
        return start_sd_job(target, full_path)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/api/laser/sd/folder")
async def laser_sd_folder_endpoint(path: str = Form(""), name: str = Form(...), host: Optional[str] = Form(None), user: dict = Depends(require_auth)):
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
    user: dict = Depends(require_auth),
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
    user: dict = Depends(require_auth),
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
    user: dict = Depends(require_auth),
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
