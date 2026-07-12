import asyncio
import logging
import os
from datetime import datetime
from logging.handlers import RotatingFileHandler

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

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
from backend.api.logs import router as logs_router
from backend.api.accessories import router as accessories_router
from backend.api.pricing import router as pricing_router
from backend.api.auth import router as auth_router
from backend.api.notifications import router as notifications_router
from backend.services.pricing_service import get_quote
from backend.services.auth_service import get_or_create_session_secret
from backend.services.klipper_service import run_due_scheduled_prints
from backend.services.laser_service import set_main_event_loop
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


app.mount("/static", StaticFiles(directory="backend/static"), name="static")
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

app.include_router(status_router)
app.include_router(upload_router)
app.include_router(models_router)
app.include_router(printers_router)
app.include_router(console_router)
app.include_router(laser_router)
app.include_router(logs_router)
app.include_router(accessories_router)
app.include_router(pricing_router)
app.include_router(auth_router)
app.include_router(notifications_router)


@app.on_event("startup")
async def _log_startup():
    logger.info("NOPAL iniciado")


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


templates = Jinja2Templates(directory="backend/templates")


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request},
    )


@app.get("/view/{filename:path}", response_class=HTMLResponse)
async def view_model(request: Request, filename: str):
    file_path = os.path.join("uploads", filename)
    if not os.path.exists(file_path):
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


@app.get("/cotizador/print/{quote_id}", response_class=HTMLResponse)
async def print_quote(request: Request, quote_id: str):
    """Vista imprimible de una cotización guardada — el usuario la exporta a
    PDF con el diálogo nativo del navegador (Ctrl+P). No hay librería de
    generación de PDF en el proyecto; agregar una para esto sería una
    dependencia nueva para algo que el navegador ya resuelve solo."""
    quote = get_quote(quote_id)
    if quote is None:
        return HTMLResponse(content="<h1>Cotización no encontrada</h1>", status_code=404)

    created_at = quote.get("created_at")
    created_at_str = datetime.fromtimestamp(created_at).strftime("%d/%m/%Y %H:%M") if created_at else "—"

    return templates.TemplateResponse(
        request=request,
        name="quote_print.html",
        context={"quote": quote, "created_at_str": created_at_str},
    )
