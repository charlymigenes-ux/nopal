"""Protocolo Marlin puro (sin conexión propia).

A diferencia de GRBL/FluidNC, Marlin no empuja reportes de estado ni tiene
protocolo de ventana/buffer: cada comando se confirma con un 'ok' (o un error)
antes de poder mandar el siguiente, y la posición/temperatura solo se conocen
pidiéndolas explícitamente (M114/M105).

Este módulo no abre ninguna conexión — recibe un MarlinTransport ya
conectado, inyectado por quien lo llama. laser_service.py lo usa para placas
CNC/láser flasheadas con Marlin (reutilizando su gestor de conexión
websocket/serie existente); marlin_printer_service.py lo usa para impresoras
3D standalone (con su propio gestor, solo serie). Así el protocolo se escribe
una sola vez sin acoplar los dos gestores de conexión entre sí.
"""

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

OK_RE = re.compile(r"^\s*ok\b", re.IGNORECASE)
ERROR_RE = re.compile(r"^\s*(Error:|!!|Resend:)", re.IGNORECASE)
POSITION_RE = re.compile(
    r"X:(?P<x>-?\d+\.?\d*)\s+Y:(?P<y>-?\d+\.?\d*)\s+Z:(?P<z>-?\d+\.?\d*)(?:\s+E:(?P<e>-?\d+\.?\d*))?"
)
TEMP_RE = re.compile(r"(?P<label>[TB]\d*):(?P<current>-?\d+\.?\d*)\s*/(?P<target>-?\d+\.?\d*)")


@dataclass
class MarlinTransport:
    """Adapta la conexión real (websocket/serie de laser_service.py, o el
    hilo serie propio de marlin_printer_service.py) a la interfaz mínima que
    este módulo necesita."""
    send: Callable[[str], bool]
    ensure_ready: Callable[[], Awaitable[None]]
    subscribe: Callable[[], "asyncio.Queue"]
    unsubscribe: Callable[["asyncio.Queue"], None]


async def _collect_until_ok(queue: "asyncio.Queue", timeout: float) -> Dict[str, Any]:
    lines: List[str] = []
    end_time = time.monotonic() + timeout
    while time.monotonic() < end_time:
        remaining = max(end_time - time.monotonic(), 0.1)
        try:
            text = await asyncio.wait_for(queue.get(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        lines.append(text)
        if ERROR_RE.match(text):
            return {"success": False, "lines": lines, "error": text}
        if OK_RE.match(text):
            return {"success": True, "lines": lines, "error": None}
    error = "Sin respuesta de la placa" if not lines else "Timeout esperando 'ok'"
    return {"success": False, "lines": lines, "error": error}


async def send_and_await_ok(transport: MarlinTransport, command: str, timeout: float = 10.0) -> Dict[str, Any]:
    """Manda una línea y junta las líneas de respuesta hasta ver un 'ok'
    (éxito), un error, o el timeout. Bloque base reutilizado por
    get_position/get_temperatures y por cualquier comando suelto (jog, home)."""
    await transport.ensure_ready()
    queue = transport.subscribe()
    try:
        loop = asyncio.get_event_loop()
        sent = await loop.run_in_executor(None, transport.send, command)
        if not sent:
            return {"success": False, "lines": [], "error": "No se pudo enviar el comando"}
        return await _collect_until_ok(queue, timeout)
    finally:
        transport.unsubscribe(queue)


async def get_position(transport: MarlinTransport, timeout: float = 4.0) -> Optional[Dict[str, float]]:
    """Manda M114 y parsea 'X:.. Y:.. Z:.. E:..' de la respuesta."""
    result = await send_and_await_ok(transport, "M114", timeout=timeout)
    for line in result["lines"]:
        match = POSITION_RE.search(line)
        if match:
            position = {"x": float(match.group("x")), "y": float(match.group("y")), "z": float(match.group("z"))}
            if match.group("e") is not None:
                position["e"] = float(match.group("e"))
            return position
    return None


async def get_temperatures(transport: MarlinTransport, timeout: float = 4.0) -> Optional[Dict[str, Dict[str, float]]]:
    """Manda M105 y parsea 'T:cur/tgt' (extrusor) y 'B:cur/tgt' (cama)."""
    result = await send_and_await_ok(transport, "M105", timeout=timeout)
    temps: Dict[str, Dict[str, float]] = {}
    for line in result["lines"]:
        for match in TEMP_RE.finditer(line):
            key = "heater_bed" if match.group("label").startswith("B") else "extruder"
            temps[key] = {"current": float(match.group("current")), "target": float(match.group("target"))}
    return temps or None


def build_jog_lines(axis: str, distance: float, feed: float) -> List[str]:
    """['G91', 'G1 {axis}{dist} F{feed}', 'G90'] — mismo patrón ya usado para
    el jog de impresoras Klipper en app.js (sendPrinterGcode)."""
    return ["G91", f"G1 {axis.upper()}{distance:.3f} F{feed}", "G90"]


def build_home_command(axes: Optional[str] = None) -> str:
    if axes:
        return f"G28 {' '.join(letter.upper() for letter in axes)}"
    return "G28"


async def run_job(transport: MarlinTransport, job, line_timeout: float = 30.0) -> None:
    """Streaming estricto ok-por-línea: manda una línea, espera su 'ok',
    recién ahí manda la siguiente. A diferencia del buffer-fill por conteo de
    caracteres que usa GRBL (ver _run_job en laser_service.py), Marlin no
    tiene protocolo de ventana — adelantarse desborda su buffer serie chico.

    `job` es duck-typed (mismo shape que LaserJob): necesita .lines/.current/
    .total/.state/.error_message/.cancel_requested/.pause_requested. No
    registra historial ni loguea el resultado — eso queda a cargo de quien
    llama, que sabe a qué historial pertenece el job."""
    await transport.ensure_ready()
    queue = transport.subscribe()
    loop = asyncio.get_event_loop()

    lines = [
        line.strip() for line in job.lines
        if line.strip() and not line.strip().startswith((";", "("))
    ]
    job.total = len(lines)

    try:
        for line in lines:
            if job.cancel_requested:
                job.state = "cancelled"
                return

            while job.pause_requested:
                await asyncio.sleep(0.3)
                if job.cancel_requested:
                    job.state = "cancelled"
                    return

            sent = await loop.run_in_executor(None, transport.send, line)
            if not sent:
                job.state = "error"
                job.error_message = f"No se pudo enviar la línea {job.current + 1}"
                return

            result = await _collect_until_ok(queue, line_timeout)
            if not result["success"]:
                job.state = "error"
                job.error_message = result["error"] or f"Sin respuesta en la línea {job.current + 1}"
                return
            job.current += 1

        job.state = "completed"
    except Exception as e:
        logger.exception("Excepción no controlada en el trabajo Marlin")
        job.state = "error"
        job.error_message = str(e)
    finally:
        transport.unsubscribe(queue)
