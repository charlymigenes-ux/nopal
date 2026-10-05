"""Visor de registros (Consola del sistema): lectura filtrada de nopal.log y
de sus archivos rotados (nopal.log.1 … nopal.log.N).

- Nunca se carga un archivo completo: se lee hacia atrás en bloques hasta
  juntar `limit` eventos o llegar a SCAN_BYTES por petición (`scan_limited`).
- Componente, nivel y texto se filtran aquí (no en el navegador), con los
  mismos componentes de Configuración → Registro (`COMPONENTS`).
- Las fuentes que hoy no se escribirían (silenciadas o con nivel mínimo más
  alto) tampoco se muestran: misma regla que Eventos recientes de la IA.
- Las líneas sin encabezado (p. ej. un traceback) se pegan como `detail` al
  evento anterior.
- Refresco incremental: `cursor` = identidad del archivo + byte final leído;
  con `after` se lee solo lo nuevo. Si el archivo rotó, se avisa con `reset`.
"""

import logging
import os
import re
from datetime import datetime
from typing import Any, Dict, Iterator, List, Optional, Tuple

from backend.services import logging_config_service as config_service

LINE_RE = re.compile(
    r"^(?P<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+"
    r"(?P<level>[A-Z]+)\s+\[(?P<source>[^\]]+)\]\s?(?P<message>.*)$"
)
DEFAULT_LIMIT, MAX_LIMIT = 300, 1000
SCAN_BYTES = 8 * 1024 * 1024  # cubre un archivo completo con el tamaño por defecto (5 MB)
CHUNK_BYTES = 64 * 1024
MAX_QUERY = 200
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


class LogViewerError(ValueError):
    """Parámetro inválido (400)."""


class LogFileNotFound(LookupError):
    """El archivo rotado pedido no existe (404)."""


def _path(index: int) -> str:
    base = config_service.current_log_file()
    return base if index == 0 else f"{base}.{index}"


def _file_id(stat: os.stat_result) -> str:
    return f"{stat.st_dev}:{stat.st_ino}"


def list_files() -> List[Dict[str, Any]]:
    """Archivos que existen: 0 = actual, 1..N = anteriores (más viejo al final)."""
    files = []
    for index in range(config_service.MAX_BACKUPS + 1):
        try:
            stat = os.stat(_path(index))
        except OSError:
            continue
        files.append({"index": index, "size": stat.st_size,
                      "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")})
    return files


def validate(file: Any, component: str, level: str, q: str, limit: Any) -> Tuple[int, str, str, str, int]:
    try:
        index = int(file)
    except (TypeError, ValueError):
        raise LogViewerError("Archivo de registro inválido.")
    if not 0 <= index <= config_service.MAX_BACKUPS:
        raise LogViewerError("Archivo de registro inválido.")
    component = (component or "").strip()
    if component in ("", "all"):
        component = ""
    elif component not in {cid for cid, _ in config_service.COMPONENTS}:
        raise LogViewerError("Componente desconocido.")
    level = (level or "").strip().upper()
    if level in ("", "ALL"):
        level = ""
    elif level not in LEVELS:
        raise LogViewerError("Nivel desconocido.")
    q = (q or "").strip()
    if len(q) > MAX_QUERY:
        raise LogViewerError(f"La búsqueda admite hasta {MAX_QUERY} caracteres.")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise LogViewerError("Límite inválido.")
    return index, component, level, q, max(1, min(limit, MAX_LIMIT))


class _Sources:
    """Componente y nivel mínimo por fuente, calculados una vez por petición
    (un archivo tiene decenas de miles de líneas y pocas fuentes distintas)."""

    def __init__(self):
        self._cache: Dict[str, Tuple[Optional[str], int]] = {}

    def get(self, source: str) -> Tuple[Optional[str], int]:
        if source not in self._cache:
            self._cache[source] = (config_service.component_of(source), config_service.source_threshold(source))
        return self._cache[source]


def _entry(header: re.Match, detail: List[str], sources: _Sources) -> Dict[str, Any]:
    source = header["source"]
    return {"time": header["time"], "level": header["level"], "component": sources.get(source)[0],
            "source": source, "message": header["message"], "detail": "\n".join(detail)}


def _matcher(component: str, level: str, q: str, sources: _Sources):
    needle = q.casefold()

    def matches(entry: Dict[str, Any]) -> bool:
        value = logging.getLevelName(entry["level"])
        if isinstance(value, int) and value < sources.get(entry["source"])[1]:
            return False
        if component and entry["component"] != component:
            return False
        if level and not (entry["level"] == level or (level == "ERROR" and entry["level"] == "CRITICAL")):
            return False
        if needle and needle not in f"{entry['message']}\n{entry['detail']}\n{entry['source']}".casefold():
            return False
        return True

    return matches


def _reverse_lines(handle, end: int) -> Iterator[Tuple[str, bool]]:
    """Líneas completas desde `end` hacia atrás. El segundo valor es True si
    la lectura se cortó por SCAN_BYTES antes del inicio del archivo (la línea
    parcial del corte no se entrega)."""
    pos, budget, rest = end, SCAN_BYTES, b""
    while pos > 0 and budget > 0:
        size = min(CHUNK_BYTES, pos, budget)
        pos -= size
        budget -= size
        handle.seek(pos)
        parts = (handle.read(size) + rest).split(b"\n")
        rest = parts[0]
        for raw in reversed(parts[1:]):
            yield raw.decode("utf-8", errors="replace"), False
    if pos == 0:
        yield rest.decode("utf-8", errors="replace"), False
    else:
        yield "", True


def _complete_end(handle, end: int) -> int:
    """Byte final de la última línea completa: una línea a medio escribir se
    deja para la siguiente lectura incremental."""
    start = max(0, end - CHUNK_BYTES)
    handle.seek(start)
    newline = handle.read(end - start).rfind(b"\n")
    return start + newline + 1 if newline >= 0 else (end if start == 0 else start)


def _tail(handle, end: int, matches, limit: int, sources: _Sources) -> Tuple[List[Dict[str, Any]], bool]:
    found: List[Dict[str, Any]] = []
    detail: List[str] = []
    limited = False
    for line, cut in _reverse_lines(handle, end):
        if cut:
            limited = True
            break
        header = LINE_RE.match(line.rstrip("\r"))
        if not header:
            if line.strip():
                detail.append(line.rstrip("\r"))
            continue
        entry = _entry(header, list(reversed(detail)), sources)
        detail = []
        if matches(entry):
            found.append(entry)
            if len(found) >= limit:
                break
    return list(reversed(found)), limited


def _forward(handle, start: int, end: int, matches, limit: int, sources: _Sources) -> Tuple[List[Dict[str, Any]], int, bool]:
    """Eventos nuevos entre `start` y `end` (solo líneas completas). Devuelve
    también el byte final consumido y si se omitió algo (`gap`)."""
    gap = end - start > SCAN_BYTES
    if gap:
        start = end - SCAN_BYTES
    handle.seek(start)
    data = handle.read(end - start)
    complete = data.rfind(b"\n") + 1
    lines = data[:complete].decode("utf-8", errors="replace").split("\n")[:-1]
    if gap and lines:
        lines = lines[1:]  # primera línea probablemente cortada
    entries: List[Dict[str, Any]] = []
    for line in lines:
        header = LINE_RE.match(line.rstrip("\r"))
        if header:
            entries.append(_entry(header, [], sources))
        elif entries and line.strip():
            entries[-1]["detail"] = "\n".join(filter(None, [entries[-1]["detail"], line.rstrip("\r")]))
    found = [e for e in entries if matches(e)]
    if len(found) > limit:
        found, gap = found[-limit:], True
    return found, start + complete, gap


def read_entries(file: Any = 0, component: str = "", level: str = "", q: str = "",
                 limit: Any = DEFAULT_LIMIT, after: Optional[int] = None,
                 file_id: str = "") -> Dict[str, Any]:
    index, component, level, q, limit = validate(file, component, level, q, limit)
    sources = _Sources()
    matches = _matcher(component, level, q, sources)
    path = _path(index)
    result: Dict[str, Any] = {"file": index, "entries": [], "scan_limited": False, "gap": False, "reset": False}
    incremental = after is not None and index == 0
    if not incremental:
        result["files"] = list_files()
    try:
        handle = open(path, "rb")
    except FileNotFoundError:
        if index:
            raise LogFileNotFound("Ese registro anterior ya no existe.")
        result["cursor"] = None
        return result
    with handle:
        stat = os.fstat(handle.fileno())
        end = stat.st_size
        if incremental and file_id == _file_id(stat) and 0 <= after <= end:
            result["entries"], end, result["gap"] = _forward(handle, after, end, matches, limit, sources)
        else:
            if incremental:
                result["reset"] = True
                result["files"] = list_files()
            end = _complete_end(handle, end)
            result["entries"], result["scan_limited"] = _tail(handle, end, matches, limit, sources)
    result["cursor"] = {"file_id": _file_id(stat), "offset": end} if index == 0 else None
    return result
