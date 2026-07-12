import json
import math
import os
import re
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from backend.services.gcode_geometry import analyze_gcode_geometry
from backend.utils import safe_section_path

PRICING_CONFIG_PATH = "pricing_config.json"
PRICING_CACHE_ROOT = "uploads/.pricing_cache"
QUOTES_REGISTRY_PATH = "quotes_registry.json"

# Mismo set que GCODE_EXTENSIONS en api/models.py — no se importa de ahí para
# no acoplar un service a un módulo de api (la capa de api depende de
# services, no al revés, en el resto del proyecto).
GCODE_EXTENSIONS = {".gcode", ".gc", ".gco", ".nc", ".tap", ".cnc"}

DEFAULT_MACHINE_WATTS = {"printer": 250, "laser": 150, "cnc": 800}


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _default_config() -> Dict[str, Any]:
    return {
        "materials": [
            {
                "id": _new_id(), "name": "PLA genérico", "kind": "filament",
                "unit_cost": 350.0, "unit": "kg", "density_g_cm3": 1.24, "diameter_mm": 1.75,
            },
            {
                "id": _new_id(), "name": "PETG genérico", "kind": "filament",
                "unit_cost": 450.0, "unit": "kg", "density_g_cm3": 1.27, "diameter_mm": 1.75,
            },
            {
                "id": _new_id(), "name": "MDF 3mm", "kind": "sheet",
                "unit_cost": 120.0, "unit": "m2",
            },
        ],
        # Perfiles de costo por máquina con nombre propio — deliberadamente
        # NO enganchados a los registros reales de impresoras/láser/CNC (eso
        # vive en otro servicio y es "qué máquina controlar", no "cuánto
        # cuesta usarla"). El usuario carga esto una sola vez.
        "machines": [
            {"id": _new_id(), "name": "Impresora 3D genérica", "kind": "printer", "watts": 250.0, "rate_per_hour": 15.0},
            {"id": _new_id(), "name": "Láser genérico", "kind": "laser", "watts": 150.0, "rate_per_hour": 20.0},
            {"id": _new_id(), "name": "CNC genérico", "kind": "cnc", "watts": 800.0, "rate_per_hour": 25.0},
        ],
        # Placeholders razonables — el usuario los ajusta en Configuración
        # apenas prueba la feature, no son valores "correctos" de por sí.
        "settings": {
            "currency": "MXN",
            "price_per_kwh": 3.5,
            "machine_watts_default": dict(DEFAULT_MACHINE_WATTS),
            "margin": {"mode": "percentage", "percentage": 30, "flat_amount": 0},
            "labor_rate_per_hour": 20.0,
            "default_prep_minutes": 15.0,
        },
    }


def _load_config() -> Dict[str, Any]:
    try:
        with open(PRICING_CONFIG_PATH, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, json.JSONDecodeError):
        config = _default_config()
        _save_config(config)
        return config
    config.setdefault("materials", [])
    config.setdefault("machines", _default_config()["machines"])
    config.setdefault("settings", _default_config()["settings"])
    config["settings"].setdefault("machine_watts_default", dict(DEFAULT_MACHINE_WATTS))
    config["settings"].setdefault("margin", {"mode": "percentage", "percentage": 30, "flat_amount": 0})
    config["settings"].setdefault("labor_rate_per_hour", 20.0)
    config["settings"].setdefault("default_prep_minutes", 15.0)
    return config


def _save_config(config: Dict[str, Any]):
    try:
        with open(PRICING_CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2, ensure_ascii=False)
    except OSError:
        pass


# ── Catálogo de materiales ──

def list_materials() -> List[Dict[str, Any]]:
    return _load_config()["materials"]


def upsert_material(
    name: str,
    kind: str,
    unit_cost: float,
    unit: str,
    extra: Optional[Dict[str, Any]] = None,
    material_id: Optional[str] = None,
) -> Dict[str, Any]:
    if kind not in ("filament", "sheet", "consumable"):
        raise ValueError(f"Tipo de material desconocido: {kind}")

    config = _load_config()
    entries = config["materials"]
    existing = next((m for m in entries if m["id"] == material_id), None) if material_id else None

    entry = {
        "id": existing["id"] if existing else _new_id(),
        "name": name,
        "kind": kind,
        "unit_cost": unit_cost,
        "unit": unit,
        **(extra or {}),
    }

    if existing:
        entries[entries.index(existing)] = entry
    else:
        entries.append(entry)

    _save_config(config)
    return entry


def remove_material(material_id: str) -> bool:
    config = _load_config()
    entries = config["materials"]
    filtered = [m for m in entries if m["id"] != material_id]
    changed = len(filtered) != len(entries)
    if changed:
        config["materials"] = filtered
        _save_config(config)
    return changed


# ── Catálogo de máquinas (perfiles de costo, no dispositivos reales) ──

def list_machines() -> List[Dict[str, Any]]:
    return _load_config()["machines"]


def upsert_machine(
    name: str,
    kind: str,
    watts: float,
    rate_per_hour: float,
    machine_id: Optional[str] = None,
) -> Dict[str, Any]:
    if kind not in ("printer", "laser", "cnc"):
        raise ValueError(f"Tipo de máquina desconocido: {kind}")

    config = _load_config()
    entries = config["machines"]
    existing = next((m for m in entries if m["id"] == machine_id), None) if machine_id else None

    entry = {
        "id": existing["id"] if existing else _new_id(),
        "name": name,
        "kind": kind,
        "watts": watts,
        "rate_per_hour": rate_per_hour,
    }

    if existing:
        entries[entries.index(existing)] = entry
    else:
        entries.append(entry)

    _save_config(config)
    return entry


def remove_machine(machine_id: str) -> bool:
    config = _load_config()
    entries = config["machines"]
    filtered = [m for m in entries if m["id"] != machine_id]
    changed = len(filtered) != len(entries)
    if changed:
        config["machines"] = filtered
        _save_config(config)
    return changed


# ── Ajustes globales ──

def get_settings() -> Dict[str, Any]:
    return _load_config()["settings"]


def update_settings(
    currency: Optional[str] = None,
    price_per_kwh: Optional[float] = None,
    machine_watts_default: Optional[Dict[str, float]] = None,
    margin: Optional[Dict[str, Any]] = None,
    labor_rate_per_hour: Optional[float] = None,
    default_prep_minutes: Optional[float] = None,
) -> Dict[str, Any]:
    config = _load_config()
    settings = config["settings"]
    if currency is not None:
        settings["currency"] = currency
    if price_per_kwh is not None:
        settings["price_per_kwh"] = price_per_kwh
    if machine_watts_default is not None:
        settings["machine_watts_default"].update(machine_watts_default)
    if labor_rate_per_hour is not None:
        settings["labor_rate_per_hour"] = labor_rate_per_hour
    if default_prep_minutes is not None:
        settings["default_prep_minutes"] = default_prep_minutes
    if margin is not None:
        settings["margin"].update(margin)
    _save_config(config)
    return settings


# ── Extracción de filamento (impresión 3D) ──

def _read_head_and_tail(filepath: str, head_bytes: int = 65536, tail_bytes: int = 65536) -> str:
    """Lee el principio y el final del archivo, no todo — PrusaSlicer/
    SuperSlicer ponen su bloque de estadísticas cerca del FINAL, no al
    principio como asume el estimador de tiempo existente (que solo lee las
    primeras 200 líneas y por eso casi nunca lo encuentra en archivos reales
    de PrusaSlicer)."""
    try:
        size = os.path.getsize(filepath)
        with open(filepath, "rb") as handle:
            head = handle.read(head_bytes)
            tail = b""
            if size > head_bytes + tail_bytes:
                handle.seek(-tail_bytes, os.SEEK_END)
                tail = handle.read(tail_bytes)
        return head.decode("utf-8", errors="ignore") + "\n" + tail.decode("utf-8", errors="ignore")
    except OSError:
        return ""


_PRUSA_G_RE = re.compile(r";\s*filament used \[g\]\s*=\s*([\d.]+)", re.IGNORECASE)
_PRUSA_MM_RE = re.compile(r";\s*filament used \[mm\]\s*=\s*([\d.]+)", re.IGNORECASE)
_S3D_RE = re.compile(r";\s*filament used\s*=\s*([\d.]+)\s*mm(?:\s*\(([\d.]+)\s*g\))?", re.IGNORECASE)
_CURA_RE = re.compile(r";Filament used:\s*([\d.]+)\s*m\b", re.IGNORECASE)


def _extract_filament_from_metadata(text: str) -> Optional[Dict[str, Any]]:
    """Busca el comentario que el slicer ya deja en el G-code. Devuelve
    gramos directos cuando el slicer los da (preferido — refleja el perfil
    de filamento real usado al laminar), o un largo en mm para que el
    llamador lo convierta con la densidad/diámetro del material elegido acá
    (que puede no coincidir con el perfil del slicer)."""
    match = _PRUSA_G_RE.search(text)
    if match:
        return {"grams": float(match.group(1)), "length_mm": None, "source": "prusaslicer"}

    match = _S3D_RE.search(text)
    if match:
        grams = float(match.group(2)) if match.group(2) else None
        return {"grams": grams, "length_mm": float(match.group(1)), "source": "simplify3d"}

    match = _PRUSA_MM_RE.search(text)
    if match:
        return {"grams": None, "length_mm": float(match.group(1)), "source": "prusaslicer"}

    match = _CURA_RE.search(text)
    if match:
        return {"grams": None, "length_mm": float(match.group(1)) * 1000, "source": "cura"}

    return None


_EXTRUSION_MOTION_WORDS = {"0", "00", "1", "01"}

# Mismo criterio que gcode_geometry._WORD_RE: extrae pares letra+número sin
# depender de espacios entre parámetros — no asumir que "G1 X10Y20E1.5"
# siempre viene separado por espacios.
_WORD_RE = re.compile(r"([A-Za-z])(-?\d*\.?\d+)")


def _extract_filament_from_extrusion(filepath: str) -> Optional[Dict[str, Any]]:
    """Fallback universal: integra el eje E línea por línea cuando no hay
    metadata del slicer. M82/M83 (extrusión absoluta/relativa) es un estado
    modal SEPARADO de G90/G91 (que gobiernan X/Y/Z) — mezclarlos es un bug
    clásico. G92 E... resetea la referencia, no es un movimiento. Solo se
    suman los deltas positivos: una retracción (delta negativo) no debe
    restar del total ya extruido."""
    e_relative = False
    e_prev = 0.0
    total_forward_mm = 0.0
    found_e = False
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                line = line.split(";", 1)[0].strip()
                if not line:
                    continue
                words = [(letter.upper(), value) for letter, value in _WORD_RE.findall(line)]
                if not words:
                    continue

                if any(letter == "M" and value == "82" for letter, value in words):
                    e_relative = False
                    continue
                if any(letter == "M" and value == "83" for letter, value in words):
                    e_relative = True
                    continue
                if words[0] == ("G", "92"):
                    for letter, value in words[1:]:
                        if letter == "E":
                            try:
                                e_prev = float(value)
                            except ValueError:
                                pass
                    continue
                if not (words[0][0] == "G" and words[0][1] in _EXTRUSION_MOTION_WORDS):
                    continue
                for letter, value in words:
                    if letter != "E":
                        continue
                    try:
                        parsed = float(value)
                    except ValueError:
                        continue
                    found_e = True
                    if e_relative:
                        delta = parsed
                        e_prev += parsed
                    else:
                        delta = parsed - e_prev
                        e_prev = parsed
                    if delta > 0:
                        total_forward_mm += delta
    except OSError:
        return None
    if not found_e:
        return None
    return {"grams": None, "length_mm": total_forward_mm, "source": "e_axis_estimate"}


def _length_to_mass(length_mm: float, diameter_mm: float, density_g_cm3: float) -> float:
    radius_mm = diameter_mm / 2
    volume_mm3 = length_mm * math.pi * radius_mm ** 2
    volume_cm3 = volume_mm3 / 1000
    return volume_cm3 * density_g_cm3


def _format_hours_minutes(hours: float) -> str:
    total_minutes = round(hours * 60)
    h, m = divmod(total_minutes, 60)
    return f"{h}h {m}m" if h else f"{m}m"


_TIME_LINE_RE = re.compile(r"estimated", re.IGNORECASE)
_TIME_UNITS_RE = re.compile(r"(\d+)\s*(h|m|s)\b", re.IGNORECASE)
_TIME_COLON_RE = re.compile(r"(\d+)\s*:\s*(\d+)")


def _extract_time_seconds_from_text(text: str) -> Optional[float]:
    """Más amplio que _estimate_print_time (api/models.py): ese solo entiende
    'H:MM', pero PrusaSlicer real escribe 'estimated printing time (normal
    mode) = 2h 15m 30s' — un formato que el estimador viejo directamente no
    reconoce. A propósito un estimador separado: no se toca el existente
    (lo sigue usando la galería tal cual) para no arriesgar esa pantalla."""
    for line in text.splitlines():
        if "time" not in line.lower() or not _TIME_LINE_RE.search(line):
            continue
        pairs = _TIME_UNITS_RE.findall(line)
        if pairs:
            seconds = 0
            for value, unit in pairs:
                value = int(value)
                unit = unit.lower()
                if unit == "h":
                    seconds += value * 3600
                elif unit == "m":
                    seconds += value * 60
                else:
                    seconds += value
            return float(seconds)
        colon = _TIME_COLON_RE.search(line)
        if colon:
            return float(int(colon.group(1)) * 3600 + int(colon.group(2)) * 60)
    return None


_NOZZLE_TEMP_RE = re.compile(r";\s*temperature\s*=\s*(\d+)", re.IGNORECASE)
_BED_TEMP_RE = re.compile(r";\s*bed_temperature\s*=\s*(\d+)", re.IGNORECASE)
_SPEED_RE = re.compile(r";\s*perimeter_speed\s*=\s*([\d.]+)", re.IGNORECASE)
_INFILL_RE = re.compile(r";\s*fill_density\s*=\s*(\d+)%?", re.IGNORECASE)
_SUPPORT_RE = re.compile(r";\s*support_material\s*=\s*(\d+)", re.IGNORECASE)
_BRIM_RE = re.compile(r";\s*brim_width\s*=\s*([\d.]+)", re.IGNORECASE)
_SKIRTS_RE = re.compile(r";\s*skirts\s*=\s*(\d+)", re.IGNORECASE)
_RAFT_RE = re.compile(r";\s*raft_layers\s*=\s*(\d+)", re.IGNORECASE)


def extract_slicer_settings(filepath: str) -> Dict[str, Any]:
    """"Parámetros detectados" para la pantalla del cotizador — mismo
    criterio que el resto del archivo: solo lee el bloque de configuración
    que el propio slicer deja en el G-code (hoy soporta el formato de
    PrusaSlicer/SuperSlicer, el más común en esta app), nunca inventa un
    valor si el slicer no lo escribió. `None` en cualquier campo significa
    "no se encontró", el caller (compute_quote/frontend) lo muestra como
    "—" — no hay fallback numérico razonable para esto como sí lo hay para
    el filamento (eje E)."""
    text = _read_head_and_tail(filepath)

    def _match_float(pattern: "re.Pattern") -> Optional[float]:
        match = pattern.search(text)
        return float(match.group(1)) if match else None

    nozzle_temp = _match_float(_NOZZLE_TEMP_RE)
    bed_temp = _match_float(_BED_TEMP_RE)
    speed = _match_float(_SPEED_RE)
    infill = _match_float(_INFILL_RE)
    support_flag = _match_float(_SUPPORT_RE)
    brim = _match_float(_BRIM_RE)
    skirts = _match_float(_SKIRTS_RE)
    raft = _match_float(_RAFT_RE)

    adhesion = None
    if raft is not None and raft > 0:
        adhesion = "Raft"
    elif brim is not None and brim > 0:
        adhesion = "Brim"
    elif skirts is not None and skirts > 0:
        adhesion = "Skirt"
    elif brim is not None or skirts is not None:
        # Se encontraron los campos pero en 0 — el slicer sí reportó su
        # configuración de adherencia, y es "ninguna", a diferencia de no
        # haber encontrado nada (None), que es "no se sabe".
        adhesion = "Ninguna"

    return {
        "nozzle_temp_c": nozzle_temp,
        "bed_temp_c": bed_temp,
        "print_speed_mm_s": speed,
        "infill_percent": infill,
        "supports": (support_flag == 1) if support_flag is not None else None,
        "adhesion": adhesion,
    }


def estimate_print_gcode_quantities(filepath: str) -> Dict[str, Any]:
    """Cantidades crudas para impresión 3D — independientes del material
    elegido (no convierte a gramos si solo hay un largo en mm; eso lo hace
    compute_quote con la densidad/diámetro del material específico, para
    poder cachear esto una sola vez por archivo sin importar qué material se
    use después)."""
    text = _read_head_and_tail(filepath)
    result = _extract_filament_from_metadata(text)
    if result is None:
        result = _extract_filament_from_extrusion(filepath)

    time_seconds = _extract_time_seconds_from_text(text)

    if result is None:
        return {
            "filament_grams_direct": None,
            "filament_length_mm": None,
            "filament_source": None,
            "estimated_seconds": time_seconds,
        }
    return {
        "filament_grams_direct": result["grams"],
        "filament_length_mm": result["length_mm"],
        "filament_source": result["source"],
        "estimated_seconds": time_seconds,
    }


def estimate_laser_cnc_quantities(filepath: str) -> Dict[str, Any]:
    """Cantidades crudas para láser/CNC — sin tope de líneas: acá truncar
    significa reportar mal el costo, a diferencia de la miniatura de
    galería, donde una imagen aproximada es aceptable."""
    geometry = analyze_gcode_geometry(filepath, max_lines=None)
    points = geometry["points"]
    area_m2 = None
    if len(points) >= 2:
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        width_mm = max(xs) - min(xs)
        height_mm = max(ys) - min(ys)
        area_m2 = (width_mm * height_mm) / 1_000_000

    return {
        "cut_length_mm": geometry["cut_length_mm"],
        "travel_length_mm": geometry["travel_length_mm"],
        "estimated_seconds": geometry["estimated_seconds"],
        "bounding_box_area_m2": area_m2,
        "truncated": geometry["truncated"],
    }


# ── Cache de extracción (por mtime del archivo, no del precio — el costo
# siempre se recalcula con la config vigente) ──

def _cache_path_for(section: str, rel_path: str) -> str:
    return os.path.join(PRICING_CACHE_ROOT, section, rel_path + ".json")


def _get_or_extract(source_path: str, section: str, rel_path: str, extractor) -> Dict[str, Any]:
    cache_path = _cache_path_for(section, rel_path)
    source_mtime = os.path.getmtime(source_path)
    if os.path.isfile(cache_path) and os.path.getmtime(cache_path) >= source_mtime:
        try:
            with open(cache_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError):
            pass

    result = extractor(source_path)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    try:
        with open(cache_path, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
    except OSError:
        pass
    return result


# ── Orquestador ──

def compute_quote(
    section: str,
    rel_path: str,
    material_id: str,
    quantity: float = 1,
    overrides: Optional[Dict[str, Any]] = None,
    machine_id: Optional[str] = None,
    extra_costs: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    overrides = overrides or {}
    extra_costs = extra_costs or []
    config = _load_config()
    material = next((m for m in config["materials"] if m["id"] == material_id), None)
    if material is None:
        raise ValueError(f"Material no encontrado: {material_id}")

    machine = next((m for m in config["machines"] if m["id"] == machine_id), None) if machine_id else None

    source_path = safe_section_path(section, rel_path)
    if not os.path.isfile(source_path):
        raise FileNotFoundError(source_path)

    filename = os.path.basename(rel_path)
    extension = os.path.splitext(filename)[1].lower()
    is_gcode = extension in GCODE_EXTENSIONS

    warnings: List[str] = []
    extracted: Dict[str, Any] = {
        "filament_g": None,
        "cut_length_mm": None,
        "travel_length_mm": None,
        "bounding_box_area_m2": None,
        "estimated_time_minutes": None,
        "time_source": None,
        "slicer_settings": None,
    }

    if material["kind"] == "filament":
        if not is_gcode:
            warnings.append("Subí el G-code laminado (no el modelo sin laminar) para obtener un peso real de filamento.")
        else:
            cached = _get_or_extract(source_path, section, rel_path, estimate_print_gcode_quantities)
            grams = cached["filament_grams_direct"]
            if grams is None and cached["filament_length_mm"] is not None:
                grams = _length_to_mass(
                    cached["filament_length_mm"],
                    material.get("diameter_mm", 1.75),
                    material.get("density_g_cm3", 1.24),
                )
            extracted["filament_g"] = grams
            if cached["estimated_seconds"] is not None:
                extracted["estimated_time_minutes"] = cached["estimated_seconds"] / 60
                extracted["time_source"] = "metadata"
            if grams is None:
                warnings.append("No se encontró metadata de filamento del slicer ni datos de extrusión (eje E) en el archivo.")
            extracted["slicer_settings"] = _get_or_extract(source_path, section, rel_path, extract_slicer_settings)
    elif material["kind"] in ("sheet", "consumable"):
        if is_gcode:
            cached = _get_or_extract(source_path, section, rel_path, estimate_laser_cnc_quantities)
            extracted["cut_length_mm"] = cached["cut_length_mm"]
            extracted["travel_length_mm"] = cached["travel_length_mm"]
            extracted["bounding_box_area_m2"] = cached["bounding_box_area_m2"]
            if cached["estimated_seconds"] is not None:
                extracted["estimated_time_minutes"] = cached["estimated_seconds"] / 60
                extracted["time_source"] = "feed_rate"
            else:
                extracted["time_source"] = "unavailable"
                warnings.append("El archivo nunca fijó una velocidad de avance (F) — no se puede estimar el tiempo real de corte.")
            if cached["truncated"]:
                warnings.append("El archivo es muy grande y el análisis se truncó — el largo de corte y el área son parciales, no exactos.")
        else:
            warnings.append("Este material espera un G-code de corte/grabado, no un modelo 3D sin laminar.")

    material_cost = 0.0
    material_cost_missing = False
    material_detail = material["name"]
    if material["kind"] == "filament":
        if extracted["filament_g"] is None:
            material_cost_missing = True
        else:
            grams_total = extracted["filament_g"] * quantity
            material_cost = (grams_total / 1000) * material["unit_cost"] if material["unit"] == "kg" else grams_total * material["unit_cost"]
            material_detail = f"{material['name']} ({grams_total:.2f} g)"
    elif material["kind"] == "sheet":
        if extracted["bounding_box_area_m2"] is None:
            material_cost_missing = True
        else:
            area_total = extracted["bounding_box_area_m2"] * quantity
            material_cost = area_total * material["unit_cost"]
            material_detail = f"{material['name']} ({area_total:.3f} m²)"
    else:  # consumable
        material_cost = material["unit_cost"] * quantity
        material_detail = f"{material['name']} (x{quantity:g})"

    settings = config["settings"]
    machine_kind = "printer" if material["kind"] == "filament" else "laser"
    watts = overrides.get("machine_watts") or (machine["watts"] if machine else None) or settings["machine_watts_default"].get(machine_kind, 0)
    price_per_kwh = overrides.get("price_per_kwh", settings["price_per_kwh"])

    hours = extracted["estimated_time_minutes"] / 60 if extracted["estimated_time_minutes"] is not None else None

    electricity_cost = 0.0
    electricity_cost_missing = False
    if hours is not None:
        electricity_cost = hours * (watts / 1000) * price_per_kwh
    else:
        electricity_cost_missing = True
        warnings.append("No se pudo estimar el tiempo del trabajo — el costo de electricidad queda sin calcular.")

    machine_usage_cost = 0.0
    machine_usage_cost_missing = False
    if machine is not None:
        if hours is not None:
            machine_usage_cost = hours * machine["rate_per_hour"]
        else:
            machine_usage_cost_missing = True

    labor_cost = settings["labor_rate_per_hour"] * (settings["default_prep_minutes"] / 60)

    consumables_cost = 0.0
    additional_cost = 0.0
    consumable_labels: List[str] = []
    additional_labels: List[str] = []
    for item in extra_costs:
        amount = float(item.get("amount") or 0)
        label = item.get("label") or ""
        if item.get("category") == "consumable":
            consumables_cost += amount
            if label:
                consumable_labels.append(label)
        else:
            additional_cost += amount
            if label:
                additional_labels.append(label)

    subtotal = material_cost + electricity_cost + machine_usage_cost + labor_cost + consumables_cost + additional_cost

    margin_mode = overrides.get("margin_mode", settings["margin"]["mode"])
    if margin_mode == "percentage":
        margin_pct = overrides.get("margin_value", settings["margin"]["percentage"])
        margin_cost = subtotal * (margin_pct / 100)
    else:
        margin_cost = overrides.get("margin_value", settings["margin"]["flat_amount"])

    total = subtotal + margin_cost
    total_is_partial = material_cost_missing or electricity_cost_missing or machine_usage_cost_missing

    cost_lines = [
        {
            "key": "material",
            "label": "Material",
            "amount": round(material_cost, 2),
            "missing": material_cost_missing,
            "detail": material_detail,
        },
        {
            "key": "electricity",
            "label": "Energía",
            "amount": round(electricity_cost, 2),
            "missing": electricity_cost_missing,
            "detail": f"{hours * (watts / 1000):.3f} kWh" if not electricity_cost_missing else None,
        },
        {
            "key": "machine_usage",
            "label": "Uso de máquina",
            "amount": round(machine_usage_cost, 2),
            "missing": machine_usage_cost_missing,
            "detail": f"{_format_hours_minutes(hours)} a ${machine['rate_per_hour']:.2f}/h" if machine and hours is not None else None,
        },
        {
            "key": "labor",
            "label": "Mano de obra",
            "amount": round(labor_cost, 2),
            "missing": False,
            "detail": f"Preparación y supervisión ({settings['default_prep_minutes']:g} min)",
        },
        {
            "key": "consumables",
            "label": "Consumibles",
            "amount": round(consumables_cost, 2),
            "missing": False,
            "detail": ", ".join(consumable_labels) if consumable_labels else None,
        },
        {
            "key": "additional",
            "label": "Costos adicionales",
            "amount": round(additional_cost, 2),
            "missing": False,
            "detail": ", ".join(additional_labels) if additional_labels else None,
        },
    ]

    return {
        "file": {"path": rel_path, "section": section, "name": filename},
        "material": {"id": material["id"], "name": material["name"], "kind": material["kind"]},
        "machine": {"id": machine["id"], "name": machine["name"]} if machine else None,
        "extracted": extracted,
        "cost_lines": cost_lines,
        "costs": {
            "material_cost": round(material_cost, 2),
            "material_cost_missing": material_cost_missing,
            "electricity_cost": round(electricity_cost, 2),
            "electricity_cost_missing": electricity_cost_missing,
            "machine_usage_cost": round(machine_usage_cost, 2),
            "labor_cost": round(labor_cost, 2),
            "consumables_cost": round(consumables_cost, 2),
            "additional_cost": round(additional_cost, 2),
            "margin_cost": round(margin_cost, 2),
            "subtotal": round(subtotal, 2),
            "total": round(total, 2),
            "currency": settings["currency"],
            "total_is_partial": total_is_partial,
            "margin_percentage": margin_pct if margin_mode == "percentage" else None,
        },
        "total_time_minutes": (
            extracted["estimated_time_minutes"] + settings["default_prep_minutes"]
            if extracted["estimated_time_minutes"] is not None else None
        ),
        "warnings": warnings,
    }


# ── Historial de cotizaciones ──

def _load_quotes_registry() -> List[Dict[str, Any]]:
    try:
        with open(QUOTES_REGISTRY_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _save_quotes_registry(entries: List[Dict[str, Any]]):
    try:
        with open(QUOTES_REGISTRY_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2, ensure_ascii=False)
    except OSError:
        pass


def _new_quote_id(existing_ids: set) -> str:
    """Formato Q-{YYYYMMDD}-{HHMM}. Si dos cotizaciones caen en el mismo
    minuto (guardado rápido, o pruebas manuales) se agrega un sufijo -2,
    -3... para no pisar una entrada existente."""
    base = datetime.now().strftime("Q-%Y%m%d-%H%M")
    candidate = base
    suffix = 1
    while candidate in existing_ids:
        suffix += 1
        candidate = f"{base}-{suffix}"
    return candidate


def list_quotes() -> List[Dict[str, Any]]:
    return sorted(_load_quotes_registry(), key=lambda q: q.get("created_at", 0), reverse=True)


def get_quote(quote_id: str) -> Optional[Dict[str, Any]]:
    return next((q for q in _load_quotes_registry() if q.get("id") == quote_id), None)


def save_quote(quote: Dict[str, Any]) -> Dict[str, Any]:
    """Persiste el resultado de compute_quote() tal cual (más los campos de
    encabezado que el frontend ya conoce: cliente, notas, vigencia) — no se
    vuelve a calcular nada acá, esto solo guarda una foto de lo ya cotizado."""
    entries = _load_quotes_registry()
    entry = {
        "id": _new_quote_id({e.get("id") for e in entries}),
        "status": "draft",
        "created_at": time.time(),
        **quote,
    }
    entries.append(entry)
    _save_quotes_registry(entries)
    return entry


def update_quote_status(quote_id: str, status: str) -> Optional[Dict[str, Any]]:
    entries = _load_quotes_registry()
    entry = next((q for q in entries if q.get("id") == quote_id), None)
    if entry is None:
        return None
    entry["status"] = status
    _save_quotes_registry(entries)
    return entry
