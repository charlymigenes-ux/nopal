"""Catálogo de perfiles de dispositivo -- capacidades conocidas por modelo
(volumen de impresión o área de trabajo, familia de firmware, transportes
soportados, variantes de placa) que hoy no existía para ninguna marca en
NOPAL. Un registro de marlin_printer_service.py/laser_service.py puede
asociarse a un profile_id de acá (ver register_printer) para saber, por
ejemplo, cuántos extrusores puede tener o qué revisiones de placa existen
-- no cambia en nada el comportamiento real del equipo, es metadata para
que NOPAL sepa qué mostrar/ofrecer en el alta y en las tarjetas.

Cubre impresoras 3D, láser y CNC en el mismo diccionario a propósito --
"machine_type" distingue fdm/laser/cnc, y "nopal_brand" dice con qué
servicio de NOPAL conecta cada uno (klipper_service, marlin_printer_service,
bambu_service, flashforge_service, o laser_service -- que ya maneja tanto
láser como CNC, ver su docstring). Esto es la contraparte de datos de la
separación por marca que ya existe en el código real: acá es un solo
catálogo estático porque es lectura, no transporte en vivo.

Diccionario estático en código, mismo criterio que otros catálogos ya
curados a mano en NOPAL (ej. materiales/máquinas de Cotizador) -- no hace
falta una base de datos para un puñado de perfiles.

Los datos de specs vienen de fichas técnicas públicas del fabricante o
reseñas de terceros (no de pruebas propias contra hardware real, salvo el
perfil de Anet ET4 Pro, ya validado en el probe de
marlin_printer_service._probe_marlin_sync). Donde la fuente no daba un
número exacto se marca con un comentario "verificar" -- mejor dejarlo
explícito que inventar precisión que no hay."""

from typing import Any, Dict, List, Optional

PRINTER_PROFILES: Dict[str, Dict[str, Any]] = {
    "hellbot_magna2_300": {
        "manufacturer": "Hellbot",
        "model": "Magna 2 300",
        "machine_type": "fdm",
        "nopal_brand": "marlin",
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

    # ── Impresoras 3D (FDM) ──

    "bambulab_a1_mini": {
        "manufacturer": "Bambu Lab",
        "model": "A1 mini",
        "machine_type": "fdm",
        "nopal_brand": "bambu",
        "build_volume": {"x": 180, "y": 180, "z": 180},
        "firmware_family": "bambu_proprietary",
        "extruders": {"minimum": 1, "maximum": 1, "hotend_type": "single"},
        # La impresora es el broker MQTT (ver bambu_service.py) -- no hay
        # modo serie/USB real para control remoto.
        "transports": ["mqtt_tls"],
    },
    "bambulab_a1": {
        "manufacturer": "Bambu Lab",
        "model": "A1",
        "machine_type": "fdm",
        "nopal_brand": "bambu",
        "build_volume": {"x": 256, "y": 256, "z": 256},
        "firmware_family": "bambu_proprietary",
        "extruders": {"minimum": 1, "maximum": 1, "hotend_type": "single"},
        "transports": ["mqtt_tls"],
    },
    "flashforge_ad5x": {
        "manufacturer": "FlashForge",
        "model": "AD5X",
        "machine_type": "fdm",
        "nopal_brand": "flashforge",
        "build_volume": {"x": 220, "y": 220, "z": 220},
        "firmware_family": "flashforge_proprietary",
        # Módulo de 4 carretes con hub sobre el extrusor -- no es IDEX real
        # (dos cabezales), es un solo hotend con selector de filamento.
        "extruders": {"minimum": 1, "maximum": 1, "hotend_type": "multi_material_single_nozzle"},
        "transports": ["http_rest"],
    },
    "creality_k1c": {
        "manufacturer": "Creality",
        "model": "K1C",
        "machine_type": "fdm",
        "nopal_brand": "klipper",
        "build_volume": {"x": 220, "y": 220, "z": 250},
        # "Creality OS" es un fork de Klipper -- necesita exponer la API de
        # Moonraker para que klipper_service.py lo pueda usar tal cual; no
        # verificado contra hardware real todavía (verificar).
        "firmware_family": "klipper",
        "extruders": {"minimum": 1, "maximum": 1, "hotend_type": "single"},
        "transports": ["moonraker"],
    },
    "anet_et4_pro": {
        "manufacturer": "Anet",
        "model": "ET4 Pro",
        "machine_type": "fdm",
        "nopal_brand": "marlin",
        "build_volume": {"x": 220, "y": 220, "z": 250},
        "firmware_family": "marlin",
        "extruders": {"minimum": 1, "maximum": 1, "hotend_type": "single"},
        "transports": ["usb_serial"],
        # Único perfil ya validado contra hardware real -- ver el comentario
        # de _probe_marlin_sync en marlin_printer_service.py: esta placa
        # responde M115 pero no M105 durante el alta.
        "board_variants": {
            "mks_robin_nano_v2": {
                "label": "MKS Robin Nano V2 / placa Anet STM32F407VGT6",
                "mcu": "STM32F407",
                "steppers": "TMC2208_standalone",
            },
        },
    },
    "snapmaker_artisan": {
        "manufacturer": "Snapmaker",
        "model": "Artisan",
        "machine_type": "fdm",
        # Módulo intercambiable 3-en-1 (impresión/láser 10-40W/CNC 200W) --
        # cada módulo es un "dispositivo" distinto en la práctica; acá se
        # describe solo el módulo de impresión. firmware/transporte exacto
        # sin confirmar contra hardware real (verificar).
        "nopal_brand": "marlin",
        "build_volume": {"x": 350, "y": 400, "z": 400},
        "firmware_family": "marlin",
        "extruders": {"minimum": 1, "maximum": 2, "hotend_type": "dual_swappable"},
        "transports": ["usb_serial"],
    },

    # ── Láser ──

    "sculpfun_s30_pro": {
        "manufacturer": "Sculpfun",
        "model": "S30 Pro",
        "machine_type": "laser",
        "nopal_brand": "laser",
        "work_area": {"x": 400, "y": 400},
        "firmware_family": "grbl",
        "laser_power_w": 10,
        "transports": ["usb_serial"],
    },
    "twotrees_tts55_pro": {
        "manufacturer": "Two Trees",
        "model": "TTS-55 Pro",
        "machine_type": "laser",
        "nopal_brand": "laser",
        "work_area": {"x": 300, "y": 300},
        "firmware_family": "grbl",
        "laser_power_w": 5.5,
        # La versión V2.0 suma control offline por WiFi -- el V1 es solo USB.
        "transports": ["usb_serial", "esp3d_wifi"],
    },
    "xtool_d1_pro": {
        "manufacturer": "xTool",
        "model": "D1 Pro",
        "machine_type": "laser",
        "nopal_brand": "laser",
        "work_area": {"x": 430, "y": 400},
        # GRBL "hardcodeado" propio de xTool -- LightBurn lo reconoce como
        # GRBL estándar, pero el WiFi va por su propia app (XCS), no
        # necesariamente el protocolo ESP3D que ya soporta laser_service.py
        # (verificar antes de ofrecer el transporte WiFi acá).
        "firmware_family": "grbl",
        "laser_power_w": 10,  # módulos intercambiables 5/10/20/40W
        "transports": ["usb_serial"],
    },
    "atomstack_a5_pro": {
        "manufacturer": "Atomstack",
        "model": "A5 Pro",
        "machine_type": "laser",
        "nopal_brand": "laser",
        # Specs generales de la familia A5 Pro -- no verificado contra ficha
        # oficial actual (verificar work_area/potencia exactos).
        "work_area": {"x": 410, "y": 400},
        "firmware_family": "grbl",
        "laser_power_w": 40,  # potencia de salida óptica real ronda 5W
        "transports": ["usb_serial"],
    },
    "ortur_laser_master_3": {
        "manufacturer": "Ortur",
        "model": "Laser Master 3",
        "machine_type": "laser",
        "nopal_brand": "laser",
        # Área base -- extensible con rieles adicionales (verificar rango
        # exacto según variante Ultra/Extendida).
        "work_area": {"x": 400, "y": 400},
        "firmware_family": "grbl",
        "laser_power_w": 10,
        "transports": ["usb_serial"],
    },

    # ── CNC ──

    "sainsmart_genmitsu_3018_prover": {
        "manufacturer": "SainSmart",
        "model": "Genmitsu 3018-PROVer",
        "machine_type": "cnc",
        "nopal_brand": "laser",  # laser_service.py maneja láser Y CNC (GRBL)
        "work_area": {"x": 300, "y": 180, "z": 45},
        "firmware_family": "grbl",
        "transports": ["usb_serial"],
        # Trae controlador offline con pantalla TFT propio -- no pasa por
        # NOPAL, es un modo de uso alterno del mismo equipo.
    },
    "sainsmart_genmitsu_4030_prover": {
        "manufacturer": "SainSmart",
        "model": "Genmitsu 4030-PROVer",
        "machine_type": "cnc",
        "nopal_brand": "laser",
        # Hermano grande del 3018 -- mismo firmware/electrónica, área mayor
        # (verificar cifra exacta, no confirmada en esta pasada).
        "work_area": {"x": 400, "y": 300, "z": 55},
        "firmware_family": "grbl",
        "transports": ["usb_serial"],
    },
    "carbide3d_shapeoko4_standard": {
        "manufacturer": "Carbide 3D",
        "model": "Shapeoko 4 (Standard)",
        "machine_type": "cnc",
        "nopal_brand": "laser",
        # No se confirmó el área de corte exacta en esta pasada -- cifra de
        # referencia de la línea Shapeoko 4, verificar contra la ficha
        # oficial antes de confiar en ella para límites de software.
        "work_area": {"x": 425, "y": 425},
        "firmware_family": "grbl",
        "transports": ["usb_serial"],
        # Carbide Motion es el software oficial (no NOPAL) pero el firmware
        # de la placa es GRBL 1.1 estándar -- por eso encaja con laser_service.
    },
    "carbide3d_nomad": {
        "manufacturer": "Carbide 3D",
        "model": "Nomad",
        "machine_type": "cnc",
        "nopal_brand": "laser",
        # CNC de escritorio cerrada, mucho más chica que el Shapeoko --
        # cifra de referencia, verificar según la generación (3/883 Pro).
        "work_area": {"x": 203, "y": 203, "z": 76},
        "firmware_family": "grbl",
        "transports": ["usb_serial"],
    },
    "generic_cnc_3018": {
        "manufacturer": "Genérico",
        "model": "CNC 3018 (clon)",
        "machine_type": "cnc",
        "nopal_brand": "laser",
        # La familia "3018" se vende casi idéntica bajo muchas marcas
        # (SainSmart, Twotrees, genéricos de Amazon/AliExpress) -- mismo
        # firmware GRBL y electrónica, cambia el nombre. Este perfil es a
        # propósito genérico para cuando el equipo no calza con ningún
        # perfil de marca (p.ej. un "CNC 3018 Pro" sin marca clara).
        "work_area": {"x": 300, "y": 180, "z": 45},
        "firmware_family": "grbl",
        "transports": ["usb_serial"],
    },
}


def list_profiles(machine_type: Optional[str] = None) -> List[Dict[str, Any]]:
    """Catálogo completo (o filtrado por "fdm"/"laser"/"cnc"), con el id de
    cada perfil incluido en el propio dict -- para poblar un selector en el
    frontend sin que tenga que conocer las claves de memoria. Cada alta
    (Marlin, láser/CNC) solo quiere los perfiles de su propio tipo."""
    profiles = [{"id": profile_id, **profile} for profile_id, profile in PRINTER_PROFILES.items()]
    if machine_type is None:
        return profiles
    return [profile for profile in profiles if profile.get("machine_type") == machine_type]


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
