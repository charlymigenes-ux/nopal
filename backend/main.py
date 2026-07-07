import asyncio
import os

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles

from backend.api.models import router as models_router
from backend.api.status import router as status_router
from backend.api.upload import router as upload_router
from backend.api.printers import router as printers_router
from backend.api.console import router as console_router
from backend.api.laser import router as laser_router
from backend.services.laser_service import set_main_event_loop
from backend.utils import get_app_version


app = FastAPI(
    title="NOPAL",
    description="Biblioteca inteligente para modelos 3D y G-code",
    version=get_app_version()
)

app.mount("/static", StaticFiles(directory="backend/static"), name="static")
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

app.include_router(status_router)
app.include_router(upload_router)
app.include_router(models_router)
app.include_router(printers_router)
app.include_router(console_router)
app.include_router(laser_router)


@app.on_event("startup")
async def _capture_main_event_loop():
    """Guarda el event loop principal para que los hilos de lectura serie
    del láser (USB) puedan reenviar datos de forma segura con
    call_soon_threadsafe (asyncio.get_event_loop() ya no sirve para esto
    desde un hilo de ThreadPoolExecutor en Python 3.13)."""
    set_main_event_loop(asyncio.get_running_loop())


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
