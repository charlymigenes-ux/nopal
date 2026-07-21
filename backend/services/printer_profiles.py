"""Catálogo de perfiles de impresora -- capacidades conocidas por modelo
(volumen de impresión, familia de firmware, transportes soportados,
variantes de placa) que hoy no existía para ninguna marca en NOPAL. Un
registro de marlin_printer_service.py puede asociarse a un profile_id de
acá (ver register_printer) para saber, por ejemplo, cuántos extrusores
puede tener o qué revisiones de placa existen -- no cambia en nada el
comportamiento real de la impresora, es metadata para que NOPAL sepa qué
mostrar/ofrecer en el alta y en las tarjetas.

Diccionario estático en código, mismo criterio que otros catálogos ya
curados a mano en NOPAL (ej. materiales/máquinas de Cotizador) -- no hace
falta una base de datos para un puñado de perfiles."""

from typing import Any, Dict, List, Optional

PRINTER_PROFILES: Dict[str, Dict[str, Any]] = {
    "hellbot_magna2_300": {
        "manufacturer": "Hellbot",
        "model": "Magna 2 300",
        "machine_type": "fdm",
        "build_volume": {"x": 300, "y": 300, "z": 400},
        "firmware_family": "marlin",
        "extruders": {"minimum": 1, "maximum": 2, "hotend_type": "2_in_1"},
        # Orden = prioridad recomendada (ver Fase 1 del plan): USB primero
        # (más estable, es el modo principal), WiFi del módulo MKS después,
        # Moonraker al final (conversión avanzada, no hace falta para el
        # alta inicial).
        "transports": ["usb_serial", "mks_wifi", "moonraker"],
        "board_variants": {
            "mks_robin_nano_v1_2": {
                "label": "MKS Robin Nano V1.2 (2021)",
                "mcu": "STM32F103",
                "screen": "3.5in_touch",
            },
            "mks_robin_nano_v3": {
                "label": "MKS Robin Nano V3 (2023)",
                "mcu": "STM32F407",
                "extra_serial": True,
            },
        },
    },
}


def list_profiles() -> List[Dict[str, Any]]:
    """Catálogo completo, con el id de cada perfil incluido en el propio
    dict -- para poblar un selector en el frontend sin que tenga que
    conocer las claves de memoria."""
    return [{"id": profile_id, **profile} for profile_id, profile in PRINTER_PROFILES.items()]


def get_profile(profile_id: str) -> Optional[Dict[str, Any]]:
    return PRINTER_PROFILES.get(profile_id)


def is_valid_board_variant(profile_id: str, board_variant: str) -> bool:
    profile = PRINTER_PROFILES.get(profile_id)
    if profile is None:
        return False
    return board_variant in profile.get("board_variants", {})


def is_valid_extruder_count(profile_id: str, extruder_count: int) -> bool:
    profile = PRINTER_PROFILES.get(profile_id)
    if profile is None:
        return False
    extruders = profile.get("extruders", {})
    return extruders.get("minimum", 1) <= extruder_count <= extruders.get("maximum", 1)
