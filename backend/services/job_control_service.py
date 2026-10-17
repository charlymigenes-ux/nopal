"""Historial de trabajos con control: filas unificadas (3D, láser y CNC), usuario que mandó cada
trabajo, eliminación con motivo y exportación.

Reglas de control (acordadas con el usuario):
- Todo trabajo que NOPAL manda queda registrado con el usuario que lo mandó: los de láser y CNC en
  `laser_history.json` (entrada "running" al empezar, ver laser_service) y los de impresión 3D en
  `job_print_log.json` (al enviarlos). Las impresiones 3D que arrancó otra herramienta (Mainsail, la
  pantalla de la impresora) vienen del historial de la propia máquina y no traen usuario.
- Solo se pueden eliminar trabajos fallidos o incompletos (error, cancelado, incompleto): los completados no,
  ni siquiera el administrador. Solo el administrador elimina, y siempre con un motivo.
- "Eliminar" es una baja de control: la fila deja de mostrarse en el historial, pero queda en
  `job_deletions.json` (quién, cuándo, por qué y una copia de la fila). Nunca se borra ese registro desde NOPAL
  y no se toca el historial propio de la máquina.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional

PRINT_LOG_PATH = "job_print_log.json"
DELETIONS_PATH = "job_deletions.json"
PRINT_LOG_MAX = 2000
DELETABLE_STATES = {"error", "cancelled", "incomplete"}
MIN_REASON_CHARS = 3
MAX_REASON_CHARS = 300
USER_MATCH_WINDOW_S = 12 * 3600       # una impresión 3D pertenece al último envío de ese archivo en las 12 h previas

_lock = threading.Lock()

# Estado de Moonraker -> estado del historial de NOPAL
MOONRAKER_STATES = {
    "completed": "completed", "cancelled": "cancelled", "error": "error", "klippy_shutdown": "error",
    "klippy_disconnect": "error", "server_exit": "error", "interrupted": "incomplete", "in_progress": "running",
}


class JobControlError(ValueError):
    """Regla de control incumplida; el mensaje se muestra tal cual."""


def _read(path: str) -> List[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def _write(path: str, entries: List[Dict[str, Any]]) -> None:
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(entries, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


# ------------------------------------------------------------------ envíos de impresión 3D
def record_print_sent(brand: str, machine_id: str, machine_name: str, filename: str, user: str) -> None:
    """Anota que NOPAL mandó `filename` a una impresora 3D, y quién. Nunca debe romper el envío."""
    try:
        with _lock:
            entries = _read(PRINT_LOG_PATH)
            entries.insert(0, {"id": uuid.uuid4().hex[:12], "brand": brand, "machine_id": str(machine_id),
                               "machine_name": machine_name, "filename": os.path.basename(filename or ""),
                               "user": user or "", "sent_at": time.time()})
            _write(PRINT_LOG_PATH, entries[:PRINT_LOG_MAX])
    except OSError:
        pass


def machine_name(brand: str, machine_id: str) -> str:
    """Nombre legible de una impresora 3D, del registro de su marca; si no se encuentra, su id."""
    try:
        from backend.services import bambu_service, elegoo_service, flashforge_service, marlin_printer_service
        path = {"bambu": bambu_service.REGISTRY_PATH, "elegoo": elegoo_service.REGISTRY_PATH,
                "flashforge": flashforge_service.REGISTRY_PATH, "marlin": marlin_printer_service.REGISTRY_PATH}[brand]
        for entry in _read(path):
            if str(machine_id) in (str(entry.get("id")), str(entry.get("device")), str(entry.get("uid"))):
                return entry.get("name") or str(machine_id)
    except Exception:
        pass
    return str(machine_id)


def sent_rows(print_log: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Envíos a impresoras sin historial propio (Marlin, Bambu, Elegoo, FlashForge): NOPAL solo sabe que lo mandó,
    no cómo terminó, así que quedan como "Enviado" para que ninguno quede fuera del control."""
    rows = []
    for entry in print_log:
        if entry.get("brand") == "klipper":
            continue                       # esas salen del historial de Moonraker
        rows.append({"id": f"sent:{entry.get('id')}", "kind": "3d", "name": entry.get("filename") or "—",
                     "machine": entry.get("machine_name") or entry.get("machine_id") or "—", "host": None,
                     "machine_id": entry.get("machine_id"), "port": None, "status": "sent", "error": None,
                     "started_at": entry.get("sent_at"), "ended_at": None, "duration_s": None,
                     "user": entry.get("user") or "", "thumbnail": None, "thumbnail_url": None, "file_url": None,
                     "source": entry.get("brand")})
    return rows


def print_user(machine_ids: Iterable[str], filename: str, started_at: Optional[float],
               log: Optional[List[Dict[str, Any]]] = None) -> str:
    """Usuario que mandó esa impresión 3D: el último envío de ese archivo a esa máquina antes de empezar
    (dentro de USER_MATCH_WINDOW_S). Vacío si no hay registro (la arrancó otra herramienta)."""
    ids = {str(m) for m in machine_ids if m is not None}
    name = os.path.basename(filename or "")
    for entry in (log if log is not None else _read(PRINT_LOG_PATH)):
        if entry.get("filename") != name or str(entry.get("machine_id")) not in ids:
            continue
        sent = float(entry.get("sent_at") or 0)
        if started_at is None or 0 <= started_at - sent <= USER_MATCH_WINDOW_S or abs(started_at - sent) < 60:
            return entry.get("user") or ""
    return ""


# ------------------------------------------------------------------ filas unificadas
def row_id_3d(port: Any, end_time: Any, filename: str) -> str:
    return f"3d:{port}:{int(end_time or 0)}:{filename}"


def laser_rows(entries: List[Dict[str, Any]], registry: List[Dict[str, Any]], legacy_id) -> List[Dict[str, Any]]:
    by_uid = {f"laser:{m.get('id')}": m for m in registry}
    by_host = {m.get("host"): m for m in registry}
    rows = []
    for entry in entries:
        machine = by_uid.get(entry.get("machine_id")) or by_host.get(entry.get("host")) or {}
        kind = "cnc" if machine.get("kind") == "cnc" else "laser"
        state = entry.get("state") or "incomplete"
        started, ended = entry.get("started_at"), entry.get("completed_at")
        rows.append({
            "id": entry.get("id") or legacy_id(entry), "kind": kind, "name": entry.get("filename") or "—",
            "machine": machine.get("name") or entry.get("host") or "—", "host": entry.get("host"),
            "machine_id": entry.get("machine_id"), "status": state, "error": entry.get("error"),
            "started_at": started, "ended_at": ended,
            "duration_s": round(ended - started) if started and ended and state != "running" else None,
            "user": entry.get("user") or "", "thumbnail": entry.get("snapshot"), "file_url": None,
            "source": entry.get("source"), "port": None,
        })
    return rows


def printer_rows(printers: List[Dict[str, Any]], print_log: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for printer in printers:
        for job in printer.get("jobs") or []:
            filename = job.get("filename") or "—"
            ended = job.get("end_time")
            duration = job.get("print_duration")
            started = (ended - duration) if ended and duration else None
            rows.append({
                "id": row_id_3d(printer.get("port"), ended, filename), "kind": "3d", "name": filename,
                "machine": printer.get("printer") or f"Impresora {printer.get('port')}", "host": None,
                "machine_id": f"klipper:{printer.get('port')}", "port": printer.get("port"),
                "status": MOONRAKER_STATES.get(job.get("status"), "incomplete"), "error": None,
                "started_at": started, "ended_at": ended,
                "duration_s": round(duration) if duration else None,
                "user": print_user([f"klipper:{printer.get('port')}", str(printer.get("port")), printer.get("printer")],
                                   filename, started or ended, print_log),
                "thumbnail": None, "thumbnail_url": job.get("thumbnail_url"), "file_url": job.get("file_url"),
                "source": "moonraker",
            })
    return rows


def finish_rows(rows: List[Dict[str, Any]], deleted: Iterable[str], library_index: Dict[str, Dict[str, str]]) -> List[Dict[str, Any]]:
    """Quita lo ya dado de baja, marca qué se puede eliminar y dónde está el archivo para reimprimir."""
    hidden = set(deleted)
    out = []
    for row in rows:
        if row["id"] in hidden:
            continue
        row["deletable"] = row["status"] in DELETABLE_STATES
        found = library_index.get(row["name"])
        row["library"] = found                      # {"section": "gcode"|"model", "path": ...} o None
        out.append(row)
    out.sort(key=lambda r: r.get("ended_at") or r.get("started_at") or 0, reverse=True)
    return out


def filter_rows(rows: List[Dict[str, Any]], kind: str = "all", days: Optional[int] = None, query: str = "",
                now: Optional[float] = None) -> List[Dict[str, Any]]:
    now = time.time() if now is None else now
    needle = (query or "").strip().lower()
    out = []
    for row in rows:
        if kind not in ("", "all", None) and row["kind"] != kind:
            continue
        stamp = row.get("ended_at") or row.get("started_at") or 0
        if days and stamp < now - days * 86400:
            continue
        if needle and needle not in (row["name"] or "").lower():
            continue
        out.append(row)
    return out


def summary(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    counts = {"3d": 0, "laser": 0, "cnc": 0}
    for row in rows:
        counts[row["kind"]] = counts.get(row["kind"], 0) + 1
    return {**counts, "total": sum(counts.values())}


# ------------------------------------------------------------------ eliminación con control
def read_deletions() -> List[Dict[str, Any]]:
    return _read(DELETIONS_PATH)


def deleted_ids() -> set:
    return {d.get("job_id") for d in read_deletions()}


def delete_row(row: Optional[Dict[str, Any]], reason: str, user: Dict[str, Any]) -> Dict[str, Any]:
    """Da de baja una fila del historial con motivo. Reglas: solo administrador, solo fallidos o incompletos,
    motivo obligatorio. Devuelve la entrada del registro de control."""
    if user.get("role") != "admin":
        raise PermissionError("Solo el administrador puede eliminar trabajos del historial")
    if row is None:
        raise JobControlError("No se encontró ese trabajo en el historial")
    if row["status"] not in DELETABLE_STATES:
        raise JobControlError("Solo se pueden eliminar trabajos fallidos o incompletos; los completados no se eliminan")
    text = (reason or "").strip()
    if len(text) < MIN_REASON_CHARS:
        raise JobControlError(f"Escribe el motivo de la eliminación (al menos {MIN_REASON_CHARS} caracteres)")
    if len(text) > MAX_REASON_CHARS:
        raise JobControlError(f"El motivo no puede pasar de {MAX_REASON_CHARS} caracteres")
    snapshot = {k: v for k, v in row.items() if k not in ("thumbnail", "thumbnail_url", "file_url", "library", "deletable")}
    entry = {"id": uuid.uuid4().hex[:12], "job_id": row["id"], "deleted_at": time.time(),
             "deleted_by": user.get("username") or user.get("user_id") or "", "reason": text, "job": snapshot}
    with _lock:
        log = read_deletions()
        if any(d.get("job_id") == row["id"] for d in log):
            raise JobControlError("Ese trabajo ya se había eliminado")
        log.insert(0, entry)
        _write(DELETIONS_PATH, log)
    return entry
