import math
import re

_MOTION_WORDS = {"0", "00", "1", "01"}

# Extrae pares letra+número sin depender de espacios entre parámetros — el
# G-code real (confirmado con archivos de LightBurn de esta app) a veces
# concatena varios sin separador, ej. "X-120S1000F120": partir por espacios
# deja eso como un solo token y el F (y hasta el X) se pierden en silencio.
_WORD_RE = re.compile(r"([A-Za-z])(-?\d*\.?\d+)")

# Mismo criterio que gcodeUsesLaserPower en app.js: si el archivo usa S en
# algún lado, es G-code de láser con modulación de potencia (típico del
# grabado raster) — ahí un G1 con S0 es un desplazamiento con el láser
# apagado, no un corte real, aunque el modo siga siendo G1. Sin este filtro,
# esos tramos "apagados" se dibujan igual que los cortes reales y la
# miniatura sale con líneas de más (confirmado: así se rompía antes).
_POWER_RE = re.compile(r"(?:^|\s)S-?\d")


def analyze_gcode_geometry(filepath: str, max_lines: int = None) -> dict:
    """Parser modal de G-code (X/Y + feed rate), compartido entre la miniatura
    de galería (thumbnail_service) y el cotizador (pricing_service) — una sola
    lógica de modales para no reintroducir bugs ya arreglados.

    Respeta G90/G91 (modo absoluto/relativo) y distingue G0 (desplazamiento
    en vacío) de G1 (corte/grabado real) — ver thumbnail_service para el
    porqué de cada uno. El feed rate (F) también es modal: una vez seteado
    sigue vigente en las líneas siguientes hasta que cambie, así que se
    trackea igual de explícito que G90/G91 en vez de asumir que siempre
    viene repetido.

    `max_lines=None` (sin tope) procesa el archivo entero — usarlo cuando el
    número importa para algo real (costo, largo de corte). El caller que solo
    necesita una imagen aproximada (thumbnail) puede pasar un tope: truncar
    ahí es inofensivo, truncar acá no lo es.

    Devuelve:
      points: list[(x, y, is_cut)] — mismo formato que ya consume el thumbnail
      cut_length_mm: float — suma de tramos G1
      travel_length_mm: float — suma de tramos G0
      estimated_seconds: float | None — solo tramos G1 (corte); G0 (rápido)
        no se tiempa con F porque en la máquina real no corre a esa
        velocidad. None si nunca hubo un F conocido
      truncated: bool — True si se llegó al tope de max_lines
    """
    points = []
    x = y = 0.0
    relative = False
    feed = None
    power = 0.0
    has_xy = False
    cut_length_mm = 0.0
    travel_length_mm = 0.0
    time_seconds = 0.0
    have_feed_ever = False
    truncated = False

    try:
        # Primera pasada: solo para saber si el archivo modula potencia con S
        # en algún lado (grabado láser tipo raster) — hay que saberlo ANTES
        # de la pasada real, porque cambia cómo se interpreta cada G1 desde
        # la primera línea, no solo desde donde aparezca el primer S.
        filter_by_power = False
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            for i, line in enumerate(f):
                if max_lines is not None and i >= max_lines:
                    break
                if _POWER_RE.search(line):
                    filter_by_power = True
                    break

        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            for i, line in enumerate(f):
                if max_lines is not None and i >= max_lines:
                    truncated = True
                    break
                line = line.split(";", 1)[0].strip()
                if not line:
                    continue
                words = [(letter.upper(), value) for letter, value in _WORD_RE.findall(line)]
                if not words:
                    continue

                motion = None
                for letter, value in words:
                    if letter == "G" and value in _MOTION_WORDS:
                        motion = value
                    elif letter == "G" and value == "90":
                        relative = False
                    elif letter == "G" and value == "91":
                        relative = True
                    elif letter == "M" and value in ("5", "05"):
                        power = 0.0
                    elif letter == "S":
                        try:
                            power = float(value)
                        except ValueError:
                            pass
                if motion is None:
                    continue
                # Un G1 con láser apagado (S0, modal hasta el próximo S) es un
                # desplazamiento, no un corte real — mismo criterio que
                # gcodeUsesLaserPower/parseGcodePath del lado JS. Lee el S de
                # esta misma línea (bucle de arriba) ANTES de decidir is_cut,
                # para no quedar una línea atrás si S y G1 vienen juntos.
                is_cut = motion in ("1", "01") and (power > 0 if filter_by_power else True)

                prev_x, prev_y = x, y
                moved = False
                for letter, value in words:
                    if letter == "F":
                        try:
                            feed = float(value)
                            have_feed_ever = True
                        except ValueError:
                            pass
                        continue
                    if letter not in ("X", "Y"):
                        continue
                    try:
                        parsed = float(value)
                    except ValueError:
                        continue
                    moved = True
                    if letter == "X":
                        x = x + parsed if relative else parsed
                    else:
                        y = y + parsed if relative else parsed

                if moved:
                    has_xy = True
                    points.append((x, y, is_cut))
                    segment_len = math.hypot(x - prev_x, y - prev_y)
                    if is_cut:
                        cut_length_mm += segment_len
                    else:
                        travel_length_mm += segment_len
                    # El feed (F) rige G1 (corte); G0 es rápido/desplazamiento
                    # y en la máquina real corre a su velocidad rápida propia,
                    # no a F — timearlo igual que un corte sobreestimaría el
                    # tiempo total en archivos con mucho desplazamiento.
                    if feed and is_cut:
                        time_seconds += segment_len / feed * 60
    except OSError:
        return {
            "points": [],
            "cut_length_mm": 0.0,
            "travel_length_mm": 0.0,
            "estimated_seconds": None,
            "truncated": False,
        }

    return {
        "points": points if has_xy else [],
        "cut_length_mm": cut_length_mm,
        "travel_length_mm": travel_length_mm,
        "estimated_seconds": time_seconds if have_feed_ever else None,
        "truncated": truncated,
    }
