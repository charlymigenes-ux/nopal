import asyncio
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from backend.errors import PrinterRegistrationError

from backend.config import (
    LOG_BACKUP_COUNT,
    LOG_DATE_FORMAT,
    LOG_DIR,
    LOG_FILE,
    LOG_FORMAT,
    LOG_LEVEL,
    LOG_MAX_BYTES,
)
from backend.api.models import router as models_router
from backend.api.status import router as status_router
from backend.api.upload import router as upload_router
from backend.api.printers import router as printers_router
from backend.api.console import router as console_router
from backend.api.laser import router as laser_router
from backend.api.marlin_printers import router as marlin_printers_router
from backend.api.elegoo_printers import router as elegoo_printers_router
from backend.api.flashforge_printers import router as flashforge_printers_router
from backend.api.bambu_printers import router as bambu_printers_router
from backend.api.logs import router as logs_router
from backend.api.system import router as system_router
from backend.api.auth import router as auth_router
from backend.api.notifications import router as notifications_router
from backend.api.plugins import router as plugins_router
from backend.api.dashboard import router as dashboard_router
from backend.api.tunascreen import router as tunascreen_router
from backend.services.auth_service import get_or_create_session_secret
from backend.auth_deps import require_auth
from backend.services.klipper_service import run_due_scheduled_prints
from backend.services.laser_service import set_main_event_loop
from backend.services.marlin_printer_service import set_main_event_loop as set_marlin_printer_event_loop
from backend.services.plugin_loader_service import load_installed_plugin_routers
from backend.services import tunascreen_service
from backend.utils import get_app_version

# Log a archivo (con rotación) + consola — antes NOPAL no persistía nada,
# solo klipper_service.py llamaba a logger.warning/info sin ningún handler
# configurado, así que se perdía apenas se cerraba la terminal. Se configura
# antes de instanciar FastAPI para capturar también lo que pase durante el
# arranque de la app.
os.makedirs(LOG_DIR, exist_ok=True)
_file_handler = RotatingFileHandler(
    LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
)
_formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
_file_handler.setFormatter(_formatter)
_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_formatter)
logging.basicConfig(level=LOG_LEVEL, handlers=[_file_handler, _console_handler])

logger = logging.getLogger(__name__)

app = FastAPI(
    title="NOPAL",
    description="Biblioteca inteligente para modelos 3D y G-code",
    version=get_app_version()
)

# Clave persistida en disco (no generada en cada arranque) para que la
# sesión sobreviva los reinicios de `uvicorn --reload` — si se regenerara
# cada vez, cada recarga por un cambio de código desconectaría a todo el
# mundo, algo que en este entorno pasa seguido.
app.add_middleware(SessionMiddleware, secret_key=get_or_create_session_secret(), same_site="lax")


@app.middleware("http")
async def log_unhandled_exceptions(request: Request, call_next):
    """Registra cualquier excepción no controlada (con traceback completo)
    antes de dejar que FastAPI la convierta en su respuesta 500 normal —
    hoy no existe nada así, un error sin manejar en un endpoint no dejaba
    ningún rastro más allá del stack trace efímero en la terminal."""
    try:
        return await call_next(request)
    except Exception:
        logger.exception(f"Excepción no controlada en {request.method} {request.url.path}")
        raise


@app.exception_handler(PrinterRegistrationError)
async def printer_registration_error_handler(request: Request, exc: PrinterRegistrationError):
    """`detail` sigue siendo string puro (compatibilidad con las modales de
    registro ya existentes); `error_code` es un campo hermano nuevo que solo
    lee el asistente guiado de instalación de impresoras."""
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail, "error_code": exc.error_code})


app.mount("/static", StaticFiles(directory="backend/static"), name="static")

# Carpeta de plugins clonados por git (ver plugin_installer_service.py) --
# fuera del control de versiones de NOPAL (.gitignore), se crea vacía si
# todavía no se instaló ningún plugin para que el mount no falle al
# arrancar en una instalación nueva.
os.makedirs("plugins", exist_ok=True)
app.mount("/plugins-static", StaticFiles(directory="plugins"), name="plugins-static")

app.include_router(status_router)
app.include_router(upload_router)
app.include_router(models_router)
app.include_router(printers_router)
app.include_router(console_router)
app.include_router(laser_router)
app.include_router(marlin_printers_router)
app.include_router(elegoo_printers_router)
app.include_router(flashforge_printers_router)
app.include_router(bambu_printers_router)
app.include_router(logs_router)
app.include_router(system_router)
app.include_router(auth_router)
app.include_router(notifications_router)
app.include_router(plugins_router)
app.include_router(dashboard_router)
app.include_router(tunascreen_router)


@app.on_event("startup")
async def _log_startup():
    logger.info("NOPAL iniciado")


@app.on_event("startup")
async def _load_plugin_routers():
    """Backend de cámaras/accesorios Arduino/etc. ya no vive en NOPAL core
    -- se carga acá dinámicamente si el plugin correspondiente está
    instalado (ver backend/services/plugin_loader_service.py). Un plugin
    roto no debe impedir que el resto de NOPAL arranque."""
    load_installed_plugin_routers(app)


@app.on_event("shutdown")
async def _log_shutdown():
    logger.info("NOPAL detenido")


@app.on_event("startup")
async def _capture_main_event_loop():
    """Guarda el event loop principal para que los hilos de lectura serie
    del láser (USB) puedan reenviar datos de forma segura con
    call_soon_threadsafe (asyncio.get_event_loop() ya no sirve para esto
    desde un hilo de ThreadPoolExecutor en Python 3.13)."""
    set_main_event_loop(asyncio.get_running_loop())
    set_marlin_printer_event_loop(asyncio.get_running_loop())


@app.on_event("startup")
async def _start_scheduled_prints_loop():
    """Revisa cada 30s si alguna impresión programada ya llegó a su hora."""
    async def loop():
        while True:
            try:
                run_due_scheduled_prints()
            except Exception:
                logger.exception("Error en el loop de impresiones programadas")
            await asyncio.sleep(30)
    asyncio.create_task(loop())


@app.on_event("startup")
async def _start_tunascreen_broadcaster():
    """Empuja el estado normalizado de máquinas a los clientes TUNA-Screen
    conectados por WS cada ~2s (ver tunascreen_service.broadcaster_loop)."""
    asyncio.create_task(tunascreen_service.broadcaster_loop())


templates = Jinja2Templates(directory="backend/templates")
UPLOADS_ROOT = Path("uploads").resolve()


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request},
    )


@app.get("/uploads/{filename:path}")
async def protected_upload(filename: str, user: dict = Depends(require_auth)):
    """Sirve archivos de la biblioteca solo a usuarios autenticados."""
    file_path = (UPLOADS_ROOT / filename).resolve()
    if UPLOADS_ROOT not in file_path.parents or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    return FileResponse(file_path)


@app.get("/view/{filename:path}", response_class=HTMLResponse)
async def view_model(request: Request, filename: str, user: dict = Depends(require_auth)):
    file_path = (UPLOADS_ROOT / filename).resolve()
    if UPLOADS_ROOT not in file_path.parents or not file_path.is_file():
        return HTMLResponse(content="<h1>Archivo no encontrado</h1>", status_code=404)

    stats = os.stat(file_path)
    return templates.TemplateResponse(
        request=request,
        name="view.html",
        context={
            "filename": filename,
            "size": stats.st_size,
            "url": f"/uploads/{filename}",
        },
    )


