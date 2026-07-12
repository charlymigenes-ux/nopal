import json
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException

from backend.auth_deps import require_auth
from backend.services.pricing_service import (
    compute_quote,
    get_quote,
    get_settings,
    list_machines,
    list_materials,
    list_quotes,
    remove_machine,
    remove_material,
    save_quote,
    update_quote_status,
    update_settings,
    upsert_machine,
    upsert_material,
)

router = APIRouter()


@router.get("/api/pricing/materials")
async def pricing_materials_list_endpoint(user: dict = Depends(require_auth)):
    """Catálogo de materiales (filamento/lámina/consumible) para el cotizador."""
    return {"materials": list_materials()}


@router.post("/api/pricing/materials")
async def pricing_materials_upsert_endpoint(
    name: str = Form(...),
    kind: str = Form(...),
    unit_cost: float = Form(...),
    unit: str = Form(...),
    config: str = Form("{}"),
    id: Optional[str] = Form(None),
    user: dict = Depends(require_auth),
):
    """Da de alta o edita (si se manda `id`) un material. `config` es un JSON
    con los campos específicos del tipo — filamento: density_g_cm3,
    diameter_mm; lámina: thickness_mm; consumible: sin campos extra."""
    try:
        extra = json.loads(config)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="El campo 'config' no es un JSON válido")

    try:
        entry = upsert_material(name, kind, unit_cost, unit, extra, material_id=id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return entry


@router.post("/api/pricing/materials/remove")
async def pricing_materials_remove_endpoint(id: str = Form(...), user: dict = Depends(require_auth)):
    if not remove_material(id):
        raise HTTPException(status_code=404, detail="Material no encontrado")
    return {"success": True}


@router.get("/api/pricing/machines")
async def pricing_machines_list_endpoint(user: dict = Depends(require_auth)):
    """Catálogo de perfiles de costo por máquina (nombre, watts, tarifa/hora)
    — no son los dispositivos reales del registro de impresoras/láser/CNC."""
    return {"machines": list_machines()}


@router.post("/api/pricing/machines")
async def pricing_machines_upsert_endpoint(
    name: str = Form(...),
    kind: str = Form(...),
    watts: float = Form(...),
    rate_per_hour: float = Form(...),
    id: Optional[str] = Form(None),
    user: dict = Depends(require_auth),
):
    try:
        entry = upsert_machine(name, kind, watts, rate_per_hour, machine_id=id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return entry


@router.post("/api/pricing/machines/remove")
async def pricing_machines_remove_endpoint(id: str = Form(...), user: dict = Depends(require_auth)):
    if not remove_machine(id):
        raise HTTPException(status_code=404, detail="Máquina no encontrada")
    return {"success": True}


@router.get("/api/pricing/settings")
async def pricing_settings_get_endpoint(user: dict = Depends(require_auth)):
    return get_settings()


@router.post("/api/pricing/settings")
async def pricing_settings_update_endpoint(
    currency: Optional[str] = Form(None),
    price_per_kwh: Optional[float] = Form(None),
    machine_watts_default: Optional[str] = Form(None),
    margin: Optional[str] = Form(None),
    labor_rate_per_hour: Optional[float] = Form(None),
    default_prep_minutes: Optional[float] = Form(None),
    user: dict = Depends(require_auth),
):
    """Ajustes globales del cotizador. `machine_watts_default` y `margin` son
    JSON (ej. `{"printer": 250, "laser": 150, "cnc": 800}` y
    `{"mode": "percentage", "percentage": 30, "flat_amount": 0}`)."""
    try:
        watts_dict = json.loads(machine_watts_default) if machine_watts_default else None
        margin_dict = json.loads(margin) if margin else None
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="JSON inválido en 'machine_watts_default' o 'margin'")

    return update_settings(
        currency, price_per_kwh, watts_dict, margin_dict, labor_rate_per_hour, default_prep_minutes
    )


@router.post("/api/pricing/quote")
def pricing_quote_endpoint(
    path: str = Form(...),
    section: str = Form("model"),
    material_id: str = Form(...),
    quantity: float = Form(1),
    overrides: str = Form("{}"),
    machine_id: Optional[str] = Form(None),
    extra_costs: str = Form("[]"),
    user: dict = Depends(require_auth),
):
    """Cotiza un archivo ya subido (modelo/gcode) contra un material del
    catálogo. Sin `async` a propósito: la extracción de filamento (metadata +
    fallback por eje E) o de geometría láser/CNC puede tardar en archivos
    grandes — la primera vez, después queda cacheada por mtime — y si el
    endpoint fuera async esos segundos bloquean el event loop entero de
    FastAPI, igual que se resolvió para /api/gcode/thumbnail. Con `def`
    normal, Starlette lo corre en su threadpool."""
    try:
        overrides_dict = json.loads(overrides)
        extra_costs_list = json.loads(extra_costs)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="El campo 'overrides' o 'extra_costs' no es un JSON válido")

    try:
        return compute_quote(section, path, material_id, quantity, overrides_dict, machine_id, extra_costs_list)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/api/pricing/quotes")
async def pricing_quotes_list_endpoint(user: dict = Depends(require_auth)):
    """Historial de cotizaciones guardadas, para la tabla de 'Cotizaciones
    recientes' — más nuevas primero."""
    return {"quotes": list_quotes()}


@router.get("/api/pricing/quotes/{quote_id}")
async def pricing_quotes_detail_endpoint(quote_id: str, user: dict = Depends(require_auth)):
    quote = get_quote(quote_id)
    if quote is None:
        raise HTTPException(status_code=404, detail="Cotización no encontrada")
    return quote


@router.post("/api/pricing/quotes")
async def pricing_quotes_save_endpoint(quote: str = Form(...), user: dict = Depends(require_auth)):
    """Guarda una cotización ya calculada (el JSON completo que devolvió
    /api/pricing/quote, más los campos de encabezado que arma el frontend:
    cliente, notas, vigencia) — no se recalcula nada acá."""
    try:
        quote_dict = json.loads(quote)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="El campo 'quote' no es un JSON válido")
    return save_quote(quote_dict)


@router.post("/api/pricing/quotes/{quote_id}/status")
async def pricing_quotes_status_endpoint(quote_id: str, status: str = Form(...), user: dict = Depends(require_auth)):
    """'Enviar cotización' desde la UI solo llama esto con status='sent' —
    no manda ningún correo real, no hay SMTP configurado en el proyecto."""
    entry = update_quote_status(quote_id, status)
    if entry is None:
        raise HTTPException(status_code=404, detail="Cotización no encontrada")
    return entry
