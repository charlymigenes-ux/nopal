"""Historial de trabajos con control (3D, láser y CNC): lista unificada, eliminación con motivo
(solo administrador, solo fallidos o incompletos), registro de control y exportación a XML o PDF.
Delgado: las reglas viven en services/job_control_service.py."""

import html
import io
import logging
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from backend.auth_deps import require_auth, require_role
from backend.services import job_control_service as control
from backend.services import klipper_service, laser_service
from backend.utils import get_section_root

logger = logging.getLogger(__name__)
router = APIRouter()

KIND_LABELS = {"3d": "3D", "laser": "Láser", "cnc": "CNC"}
STATUS_LABELS = {"sent": "Enviado", "completed": "Completado", "error": "Error", "cancelled": "Cancelado",
                 "incomplete": "Incompleto", "running": "En curso"}
PAGE_SIZES = (8, 12, 16, 24, 48)
_library_cache: Dict[str, Any] = {"at": 0.0, "index": {}}


def library_index() -> Dict[str, Dict[str, str]]:
    """Nombre de archivo -> dónde está en la Biblioteca (para reimprimir). Se recuerda 20 s."""
    if time.time() - _library_cache["at"] < 20 and _library_cache["index"]:
        return _library_cache["index"]
    index: Dict[str, Dict[str, str]] = {}
    for section in ("gcode", "model"):
        root = os.path.abspath(get_section_root(section))
        for folder, _dirs, files in os.walk(root):
            for name in files:
                index.setdefault(name, {"section": section, "path": os.path.relpath(os.path.join(folder, name), root)})
    _library_cache.update(at=time.time(), index=index)
    return index


def _printers(host: str) -> List[Dict[str, Any]]:
    try:
        return klipper_service.get_recent_printer_files(host=host, limit=30)
    except Exception:       # Moonraker caído: el historial láser/CNC no debe fallar por eso
        logger.warning("Historial: no se pudo leer el historial de las impresoras 3D", exc_info=True)
        return []


def collect_rows(host: str) -> List[Dict[str, Any]]:
    """Todas las filas visibles (sin las dadas de baja), de la más reciente a la más antigua."""
    rows = control.laser_rows(laser_service.get_laser_history(limit=laser_service.HISTORY_MAX_ENTRIES),
                              laser_service._load_registry(), laser_service.legacy_entry_id)
    print_log = control._read(control.PRINT_LOG_PATH)
    rows += control.printer_rows(_printers(host), print_log)
    rows += control.sent_rows(print_log)
    for row in rows:
        url = row.get("file_url") or ""
        row["remote_path"] = url.split("/server/files/gcodes/", 1)[1] if "/server/files/gcodes/" in url else None
    return control.finish_rows(rows, control.deleted_ids(), library_index())


def _filters(kind: str, days: int, q: str) -> Dict[str, Any]:
    if kind not in ("all", "3d", "laser", "cnc"):
        raise HTTPException(status_code=400, detail="Tipo no válido")
    if days < 0 or days > 3650:
        raise HTTPException(status_code=400, detail="Periodo no válido")
    return {"kind": kind, "days": days or None, "query": q}


@router.get("/api/jobs/history")
async def jobs_history(request: Request, kind: str = "all", days: int = 30, q: str = "", page: int = 1,
                       page_size: int = 8, user: dict = Depends(require_auth)) -> Dict[str, Any]:
    flt = _filters(kind, days, q)
    rows = await run_in_threadpool(collect_rows, request.url.hostname)
    scope = control.filter_rows(rows, "all", flt["days"], flt["query"])     # el resumen cuenta todos los tipos
    shown = control.filter_rows(scope, flt["kind"])
    size = page_size if page_size in PAGE_SIZES else 8
    pages = max(1, -(-len(shown) // size))
    page = max(1, min(page, pages))
    return {"items": shown[(page - 1) * size: page * size], "total": len(shown), "page": page, "pages": pages,
            "page_size": size, "summary": control.summary(scope), "can_delete": user.get("role") == "admin"}


@router.post("/api/jobs/history/delete")
async def jobs_history_delete(request: Request, id: str = Form(...), reason: str = Form(""),
                              user: dict = Depends(require_role("admin"))) -> Dict[str, Any]:
    rows = await run_in_threadpool(collect_rows, request.url.hostname)
    row = next((r for r in rows if r["id"] == id), None)
    try:
        entry = control.delete_row(row, reason, user)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except control.JobControlError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    logger.info(f"Historial: {entry['deleted_by']} eliminó '{row['name']}' ({row['status']}): {entry['reason']}")
    return {"success": True, "deletion": entry}


@router.get("/api/jobs/deletions")
async def jobs_deletions(limit: int = 200, user: dict = Depends(require_role("admin"))) -> Dict[str, Any]:
    """Registro de control: los trabajos dados de baja, con quién, cuándo y por qué."""
    entries = control.read_deletions()
    return {"deletions": entries[:max(1, min(limit, 1000))], "total": len(entries)}


@router.post("/api/jobs/reprint-klipper")
async def jobs_reprint_klipper(port: int = Form(...), path: str = Form(...), user: dict = Depends(require_auth)):
    """Vuelve a imprimir, en la misma impresora Klipper, un archivo que ya está en su carpeta de G-code."""
    if ".." in path.split("/") or path.startswith("/"):
        raise HTTPException(status_code=400, detail="Ruta no válida")
    ok = await run_in_threadpool(lambda: klipper_service.MoonrakerClient(port).start_print(path))
    if not ok:
        raise HTTPException(status_code=409, detail="No se pudo iniciar la impresión (¿la impresora está ocupada?)")
    control.record_print_sent("klipper", f"klipper:{port}", str(port), path, user.get("username", ""))
    return {"success": True}


# ------------------------------------------------------------------ exportación
def _fmt(ts: Optional[float]) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else ""


def _duration(seconds: Optional[float]) -> str:
    if not seconds:
        return ""
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes} min" if hours else (f"{minutes} min {secs} s" if minutes else f"{secs} s")


def build_xml(rows: List[Dict[str, Any]], summ: Dict[str, int], meta: Dict[str, str]) -> bytes:
    root = ET.Element("historial_trabajos", {"generado": meta["generated"], "por": meta["by"], "periodo": meta["period"]})
    totals = ET.SubElement(root, "resumen")
    for key in ("3d", "laser", "cnc", "total"):
        ET.SubElement(totals, "tipo", {"nombre": KIND_LABELS.get(key, "Total"), "trabajos": str(summ.get(key, 0))})
    jobs = ET.SubElement(root, "trabajos", {"cantidad": str(len(rows))})
    for row in rows:
        job = ET.SubElement(jobs, "trabajo", {"id": str(row["id"]), "tipo": KIND_LABELS.get(row["kind"], row["kind"])})
        for tag, value in (("archivo", row["name"]), ("maquina", row["machine"]), ("estado", STATUS_LABELS.get(row["status"], row["status"])),
                           ("duracion", _duration(row.get("duration_s"))), ("inicio", _fmt(row.get("started_at"))),
                           ("fin", _fmt(row.get("ended_at"))), ("usuario", row.get("user") or ""), ("error", row.get("error") or "")):
            ET.SubElement(job, tag).text = str(value)
    out = io.BytesIO()
    ET.ElementTree(root).write(out, encoding="utf-8", xml_declaration=True)
    return out.getvalue()


def build_pdf(rows: List[Dict[str, Any]], summ: Dict[str, int], meta: Dict[str, str]) -> bytes:
    from xhtml2pdf import pisa            # ya es dependencia de NOPAL (requirements.txt)

    esc = html.escape
    body = "".join(
        f"<tr><td>{esc(KIND_LABELS.get(r['kind'], r['kind']))}</td><td>{esc(r['name'])}</td><td>{esc(r['machine'])}</td>"
        f"<td>{esc(STATUS_LABELS.get(r['status'], r['status']))}</td><td>{esc(_duration(r.get('duration_s')))}</td>"
        f"<td>{esc(_fmt(r.get('ended_at') or r.get('started_at')))}</td><td>{esc(r.get('user') or '—')}</td></tr>"
        for r in rows)
    doc = f"""<html><head><meta charset="utf-8"><style>
      @page {{ size: A4 landscape; margin: 1.2cm; }}
      body {{ font-family: Helvetica; font-size: 9pt; color: #1b1f24; }}
      h1 {{ font-size: 16pt; margin: 0 0 4px 0; }} p {{ margin: 2px 0; color: #444; }}
      table {{ width: 100%; border-collapse: collapse; margin-top: 8px; }}
      th {{ background: #e8edf2; text-align: left; padding: 4px; border: 1px solid #b9c2cc; }}
      td {{ padding: 3px 4px; border: 1px solid #d5dbe1; }}
    </style></head><body>
      <h1>Historial de trabajos — NOPAL</h1>
      <p>Periodo: {esc(meta['period'])} · Generado: {esc(meta['generated'])} · Por: {esc(meta['by'])}</p>
      <p>Resumen: 3D {summ.get('3d', 0)} · Láser {summ.get('laser', 0)} · CNC {summ.get('cnc', 0)} · Total {summ.get('total', 0)}</p>
      <table><thead><tr><th>Tipo</th><th>Archivo</th><th>Máquina</th><th>Estado</th><th>Duración</th><th>Fecha</th><th>Usuario</th></tr></thead>
      <tbody>{body}</tbody></table></body></html>"""
    out = io.BytesIO()
    result = pisa.CreatePDF(doc, dest=out, encoding="utf-8")
    if result.err:
        raise RuntimeError("No se pudo generar el PDF")
    return out.getvalue()


@router.get("/api/jobs/history/export")
async def jobs_history_export(request: Request, format: str = "pdf", kind: str = "all", days: int = 30, q: str = "",
                              user: dict = Depends(require_auth)) -> Response:
    """Resumen de la lista que se está viendo (mismos filtros), en XML o PDF."""
    if format not in ("xml", "pdf"):
        raise HTTPException(status_code=400, detail="Formato no válido (xml o pdf)")
    flt = _filters(kind, days, q)
    rows = await run_in_threadpool(collect_rows, request.url.hostname)
    scope = control.filter_rows(rows, "all", flt["days"], flt["query"])
    shown = control.filter_rows(scope, flt["kind"])
    meta = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "by": user.get("username") or "",
            "period": f"últimos {flt['days']} días" if flt["days"] else "todo el historial"}
    name = f"historial-trabajos-{datetime.now().strftime('%Y%m%d-%H%M')}.{format}"
    if format == "xml":
        data, media = build_xml(shown, control.summary(scope), meta), "application/xml"
    else:
        try:
            data = await run_in_threadpool(build_pdf, shown, control.summary(scope), meta)
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        media = "application/pdf"
    return Response(content=data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})
