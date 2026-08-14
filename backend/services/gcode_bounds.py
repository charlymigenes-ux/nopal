"""Límites reales que recorre un archivo de G-code.

Sirve para "encuadrar": mover el cabezal por el rectángulo que ocupa el
trabajo, ANTES de cortar, para ver dónde va a caer sobre el material. Es la
comprobación que evita descubrir a media pasada que la pieza se salía.

Se interpreta lo mínimo indispensable para que el rectángulo sea correcto,
no se emula GRBL:

- Solo cuentan los movimientos de TRABAJO (G1/G2/G3). Un G0 es un traslado
  en vacío: mueve el cabezal pero no marca material, así que estirar el
  rectángulo hasta donde pasó de largo daría un encuadre más grande que la
  pieza. De G2/G3 se toma el punto final -- el arco puede sobresalir un
  poco, y de los dos errores posibles, quedarse corto no rompe material.
- De cada corte cuentan sus DOS extremos, no solo el destino: la línea que
  va de (10,5) a (60,5) empieza a marcar en (10,5).
- En absoluto, la posición inicial de la máquina se desconoce hasta la
  primera coordenada; suponerla en el origen estiraría el rectángulo hasta
  ahí. En relativo sí se conoce: el archivo se mide desde donde empiece.
- Posicionamiento absoluto G90 y relativo G91, que cambian el significado
  de cada coordenada.
- Unidades: G21 milímetros (lo normal) y G20 pulgadas, que se convierten.
- Modalidad: en G-code, `X10 Y5` sin letra de comando repite el movimiento
  anterior. Ignorarlo dejaba fuera la mayoría de las líneas de un archivo
  generado por LightBurn o LaserGRBL.

Solo cuentan los movimientos, no los comentarios ni los parámetros de otras
letras (S, F, P...). Una línea sin X ni Y no mueve nada y no altera el
rectángulo.
"""

import re
from typing import Any, Dict, Optional

# Tope de seguridad, no de precisión: cortar la lectura daría un rectángulo
# MÁS CHICO que el trabajo, que es justo el error que arruina material. Se
# pone alto a propósito y, si se alcanza, se avisa con `truncated` para que
# la interfaz no presente el encuadre como confiable. Un grabado a alta
# resolución ronda las 400.000 líneas; dos millones cubre con holgura.
MAX_LINES = 2_000_000

_MM_POR_PULGADA = 25.4

# Comentarios de G-code: ';' hasta fin de línea y '(...)' entre paréntesis.
_COMENTARIOS = re.compile(r";[^\n]*|\([^)]*\)")

# Un solo barrido para todo el archivo: o un salto de línea (que cierra el
# bloque, porque la modalidad de G-code es por bloque) o una palabra G/X/Y
# con su número. Se hace así, y no línea por línea, porque un grabado tiene
# cientos de miles de líneas: recorrerlas desde Python costaba 3,5 segundos
# en un archivo real de la biblioteca, y esto es lo que pasa cuando alguien
# presiona "Encuadrar" esperando que el cabezal se mueva ya. El mismo
# archivo se resuelve ahora en una fracción de eso, con el recorrido
# corriendo dentro del motor de expresiones regulares.
_TOKEN = re.compile(r"(\n)|([GXYgxy])\s*([-+]?\d*\.?\d+)")


def compute_bounds(gcode_text: str) -> Optional[Dict[str, Any]]:
    """Rectángulo que ocupa el trabajo, en milímetros.

    Devuelve None si el archivo no mueve nada en X/Y: no hay nada que
    encuadrar y decirlo es mejor que devolver un rectángulo de área cero
    que el usuario interpretaría como un origen válido.
    """
    x = y = 0.0
    absoluto = True
    factor = 1.0
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")
    movimientos = 0
    truncado = False
    movimiento_activo = False   # G0/G1/G2/G3 vigente (modalidad)
    corte_activo = False        # el vigente marca material (G1/G2/G3)
    # En G90 no se sabe dónde está el cabezal hasta la primera coordenada.
    posicion_conocida = False

    texto = _COMENTARIOS.sub("", gcode_text)
    lineas = 0
    nuevo_x = nuevo_y = None
    hubo_palabra = False

    def aplicar_bloque():
        """Cierra el bloque en curso: mueve, y si marcaba material, estira
        el rectángulo con sus dos extremos."""
        nonlocal x, y, posicion_conocida, min_x, min_y, max_x, max_y, movimientos
        if not movimiento_activo or (nuevo_x is None and nuevo_y is None):
            return
        desde_x, desde_y, venia_conocida = x, y, posicion_conocida
        if absoluto:
            if nuevo_x is not None:
                x = nuevo_x
            if nuevo_y is not None:
                y = nuevo_y
        else:
            x += nuevo_x or 0.0
            y += nuevo_y or 0.0
        posicion_conocida = True
        if not corte_activo:
            return          # G0: traslado en vacío, no marca material
        if venia_conocida:  # el extremo de partida solo cuenta si se sabía
            min_x, max_x = min(min_x, desde_x), max(max_x, desde_x)
            min_y, max_y = min(min_y, desde_y), max(max_y, desde_y)
        min_x, max_x = min(min_x, x), max(max_x, x)
        min_y, max_y = min(min_y, y), max(max_y, y)
        movimientos += 1

    for salto, letra, valor in _TOKEN.findall(texto):
        if salto:
            if hubo_palabra:
                aplicar_bloque()
                nuevo_x = nuevo_y = None
                hubo_palabra = False
            lineas += 1
            if lineas >= MAX_LINES:
                truncado = True
                break
            continue

        try:
            numero_valor = float(valor)
        except ValueError:
            continue
        hubo_palabra = True
        letra = letra.upper()

        if letra == "G":
            codigo = int(numero_valor)
            if codigo in (0, 1, 2, 3):
                movimiento_activo = True
                corte_activo = codigo != 0
            elif codigo == 90:
                absoluto = True
            elif codigo == 91:
                absoluto = False
                # En relativo el archivo se mide desde donde empiece: esa
                # posición ES el origen, así que ya es conocida.
                posicion_conocida = True
            elif codigo == 20:
                factor = _MM_POR_PULGADA
            elif codigo == 21:
                factor = 1.0
            elif codigo not in (53, 54, 55, 56, 57, 58, 59):
                # G4, G28... no mueven por sí mismos y cortan la modalidad.
                movimiento_activo = False
                corte_activo = False
        elif letra == "X":
            nuevo_x = numero_valor * factor
        elif letra == "Y":
            nuevo_y = numero_valor * factor

    if hubo_palabra:
        aplicar_bloque()   # último bloque, si el archivo no termina en salto

    if not movimientos or min_x == float("inf"):
        return None

    return {
        "min_x": round(min_x, 3),
        "min_y": round(min_y, 3),
        "max_x": round(max_x, 3),
        "max_y": round(max_y, 3),
        "width": round(max_x - min_x, 3),
        "height": round(max_y - min_y, 3),
        "moves": movimientos,
        "truncated": truncado,
    }


# --------------------------------------------------------------------------
# Caché en disco
# --------------------------------------------------------------------------
# Medir un grabado de 22 MB toma varios segundos: son millones de
# coordenadas y no hay forma de recorrerlas gratis. Pero los límites de un
# archivo NO cambian, así que se pagan una sola vez y se guardan. La clave
# incluye tamaño y fecha de modificación: si el archivo se reemplaza por
# otro con el mismo nombre, la entrada vieja no se reusa.
#
# Mismo criterio que el resto de los registros de NOPAL: un JSON plano en la
# raíz, escrito de forma atómica para que un corte a media escritura no deje
# el archivo corrupto.

import json
import logging
import os

logger = logging.getLogger(__name__)

CACHE_PATH = "gcode_bounds_cache.json"
MAX_CACHE_ENTRIES = 500


def _cache_key(path: str) -> Optional[str]:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return f"{os.path.abspath(path)}:{stat.st_size}:{int(stat.st_mtime)}"


def _read_cache() -> Dict[str, Any]:
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_cache(cache: Dict[str, Any]) -> None:
    # Se recorta por si alguien procesa miles de archivos: el caché es una
    # comodidad, no un registro que deba conservarse entero.
    if len(cache) > MAX_CACHE_ENTRIES:
        cache = dict(list(cache.items())[-MAX_CACHE_ENTRIES:])
    temporal = f"{CACHE_PATH}.tmp"
    try:
        with open(temporal, "w", encoding="utf-8") as handle:
            json.dump(cache, handle)
        os.replace(temporal, CACHE_PATH)
    except OSError as exc:
        logger.warning(f"No se pudo guardar el caché de límites de G-code: {exc}")


def bounds_for_file(path: str) -> Optional[Dict[str, Any]]:
    """Límites de un archivo, calculados una vez y recordados después."""
    clave = _cache_key(path)
    if clave is None:
        return None

    cache = _read_cache()
    if clave in cache:
        return cache[clave] or None

    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            limites = compute_bounds(handle.read())
    except OSError as exc:
        logger.warning(f"No se pudo leer {path} para medir sus límites: {exc}")
        return None

    cache[clave] = limites
    _write_cache(cache)
    return limites
