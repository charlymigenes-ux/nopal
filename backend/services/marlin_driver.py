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
BUSY_RE = re.compile(r"busy:\s*processing", re.IGNORECASE)
RESEND_RE = re.compile(r"Resend:\s*N?(\d+)", re.IGNORECASE)
POSITION_RE = re.compile(
    r"X:(?P<x>-?\d+\.?\d*)\s+Y:(?P<y>-?\d+\.?\d*)\s+Z:(?P<z>-?\d+\.?\d*)(?:\s+E:(?P<e>-?\d+\.?\d*))?"
)
TEMP_RE = re.compile(r"(?P<label>[TB]\d*):(?P<current>-?\d+\.?\d*)\s*/(?P<target>-?\d+\.?\d*)")
# Línea típica de M115: "FIRMWARE_NAME:Marlin 2.1.2 (Github) SOURCE_CODE_URL:...
# PROTOCOL_VERSION:1.0 MACHINE_TYPE:... EXTRUDER_COUNT:1 UUID:..." -- los
# valores pueden traer espacios, así que cada campo se corta donde empieza
# el próximo "CLAVE:" (lookahead), no por espacio simple. Las líneas
# "Cap:ALGO:0" (capacidades M115) no matchean a propósito -- formato
# distinto, no se parsean acá.
M115_FIELD_RE = re.compile(r"([A-Z_]+):(.*?)(?=\s+[A-Z_]+:|$)")


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
        if BUSY_RE.search(text):
            # "echo:busy: processing" -- Marlin sigue vivo, solo tardando
            # (un movimiento largo, un cálculo, etc.). No cuenta como parte
            # de la respuesta ni consume el timeout -- se lo estira, para
            # no abortar una impresión real solo porque una línea tardó.
            end_time = time.monotonic() + timeout
            continue
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
    """Manda M105 y parsea 'T:cur/tgt' (extrusor) y 'B:cur/tgt' (cama). Con
    más de un extrusor, Marlin reporta T0/T1/... por separado -- se
    exponen como extruder0/extruder1/..., cada uno con su propia clave
    (antes se pisaban entre sí: T1 sobreescribía a T0 porque ambos caían
    en la misma clave "extruder", bug real nunca notado porque hasta ahora
    ningún consumidor tenía más de un extrusor). T sin número (el caso de
    toda la vida, un solo hotend) sigue siendo la clave "extruder", sin
    cambios para ese caso."""
    result = await send_and_await_ok(transport, "M105", timeout=timeout)
    temps: Dict[str, Dict[str, float]] = {}
    for line in result["lines"]:
        for match in TEMP_RE.finditer(line):
            label = match.group("label")
            if label.startswith("B"):
                key = "heater_bed"
            elif label == "T":
                key = "extruder"
            else:
                key = f"extruder{label[1:]}"
            temps[key] = {"current": float(match.group("current")), "target": float(match.group("target"))}
    return temps or None


def parse_firmware_info_lines(lines: List[str]) -> Optional[Dict[str, str]]:
    """Parser puro, compartido por get_firmware_info (transporte
    persistente) y el probe autocontenido de marlin_printer_service.py
    (previo al registro, sin transporte todavía) -- una sola
    implementación para no arreglar el mismo bug dos veces."""
    info: Dict[str, str] = {}
    for line in lines:
        # "Cap:NOMBRE:0/1" es un sub-formato aparte de M115 (una capacidad
        # por línea) -- se descarta antes de aplicar M115_FIELD_RE, que si
        # no igual le encontraría un match espurio a partir de "NOMBRE:0"
        # (finditer no exige que el match empiece al inicio de la línea).
        if line.startswith("Cap:"):
            continue
        for match in M115_FIELD_RE.finditer(line):
            key, value = match.group(1), match.group(2).strip()
            if key and value:
                info[key] = value
    return info or None


async def get_firmware_info(transport: MarlinTransport, timeout: float = 4.0) -> Optional[Dict[str, str]]:
    """Manda M115 y parsea la línea 'CLAVE:valor CLAVE:valor ...' que
    devuelve Marlin (FIRMWARE_NAME, MACHINE_TYPE, EXTRUDER_COUNT, etc.) --
    tal cual lo reporte el firmware, sin inventar ningún campo que no
    venga. Útil como señal complementaria para "Detectar automáticamente"
    en el alta de una impresora (ver printer_profiles.py), nunca como
    reemplazo de lo que el usuario elige a mano -- M115 no siempre reporta
    EXTRUDER_COUNT ni MACHINE_TYPE, depende de cómo se compiló el firmware."""
    result = await send_and_await_ok(transport, "M115", timeout=timeout)
    return parse_firmware_info_lines(result["lines"])


def build_jog_lines(axis: str, distance: float, feed: float) -> List[str]:
    """['G91', 'G1 {axis}{dist} F{feed}', 'G90'] — mismo patrón ya usado para
    el jog de impresoras Klipper en app.js (sendPrinterGcode)."""
    return ["G91", f"G1 {axis.upper()}{distance:.3f} F{feed}", "G90"]


def build_home_command(axes: Optional[str] = None) -> str:
    if axes:
        return f"G28 {' '.join(letter.upper() for letter in axes)}"
    return "G28"


def _line_checksum(line: str) -> int:
    """XOR de todos los bytes de la línea (sin el '*' ni el propio
    checksum) -- algoritmo estándar de Marlin para validar la integridad de
    una línea numerada."""
    checksum = 0
    for char in line:
        checksum ^= ord(char)
    return checksum & 0xFF


# Reenvíos seguidos de la MISMA línea antes de rendirse -- una placa real
# nunca debería pedir esto más de una o dos veces (ruido puntual en el
# cable); si sigue pidiendo, hay algo más serio (desconexión a medias) y
# hay que abortar en vez de reintentar para siempre.
MAX_CONSECUTIVE_RESENDS = 5


async def run_job(transport: MarlinTransport, job, line_timeout: float = 30.0) -> None:
    """Streaming estricto ok-por-línea: manda una línea, espera su 'ok',
    recién ahí manda la siguiente. A diferencia del buffer-fill por conteo de
    caracteres que usa GRBL (ver _run_job en laser_service.py), Marlin no
    tiene protocolo de ventana — adelantarse desborda su buffer serie chico.

    Numeración real: antes de la primera línea se manda 'M110 N0' (reinicia
    el contador del firmware), y cada línea se manda como
    'N<n> <gcode>*<checksum>'. Si Marlin responde 'Resend: N<n>' (línea
    corrupta o fuera de secuencia), se retoma el envío desde esa línea en
    vez de abortar el trabajo entero -- antes CUALQUIER 'Resend:' mataba la
    impresión completa (falso positivo de error real, ver ERROR_RE). Un
    error real (Error:/!!) sigue abortando igual que antes.

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
        sent = await loop.run_in_executor(None, transport.send, "M110 N0")
        reset_result = (
            await _collect_until_ok(queue, line_timeout) if sent
            else {"success": False, "error": "No se pudo enviar M110"}
        )
        if not reset_result["success"]:
            job.state = "error"
            job.error_message = reset_result.get("error") or "No se pudo reiniciar la numeración de línea (M110)"
            return

        index = 0
        consecutive_resends = 0
        while index < len(lines):
            if job.cancel_requested:
                job.state = "cancelled"
                return

            while job.pause_requested:
                await asyncio.sleep(0.3)
                if job.cancel_requested:
                    job.state = "cancelled"
                    return

            line_number = index + 1
            numbered = f"N{line_number} {lines[index]}"
            outgoing = f"{numbered}*{_line_checksum(numbered)}"

            sent = await loop.run_in_executor(None, transport.send, outgoing)
            if not sent:
                job.state = "error"
                job.error_message = f"No se pudo enviar la línea {line_number}"
                return

            result = await _collect_until_ok(queue, line_timeout)
            if result["success"]:
                consecutive_resends = 0
                index += 1
                job.current = index
                continue

            resend_match = RESEND_RE.search(result["error"] or "")
            if resend_match:
                requested_line = int(resend_match.group(1))
                if not 1 <= requested_line <= len(lines):
                    job.state = "error"
                    job.error_message = f"La placa pidió reenviar una línea fuera de rango ({requested_line})"
                    return
                consecutive_resends += 1
                if consecutive_resends > MAX_CONSECUTIVE_RESENDS:
                    job.state = "error"
                    job.error_message = f"Demasiados reenvíos seguidos en la línea {requested_line} — posible desconexión"
                    return
                index = requested_line - 1
                continue

            job.state = "error"
            job.error_message = result["error"] or f"Sin respuesta en la línea {line_number}"
            return

        job.state = "completed"
    except Exception as e:
        logger.exception("Excepción no controlada en el trabajo Marlin")
        job.state = "error"
        job.error_message = str(e)
    finally:
        transport.unsubscribe(queue)
