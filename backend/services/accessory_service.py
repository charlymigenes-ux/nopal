import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

REGISTRY_PATH = "accessory_registry.json"
HTTP_TIMEOUT = 5


# ── Drivers ──
#
# Cada accesorio IoT (extractor, ventilador, bomba, compresor...) habla uno
# de estos protocolos. "tasmota" es el recomendado por defecto para el
# usuario final: 100% local (sin depender de una nube ni de tener Home
# Assistant instalado), firmware maduro y barato de conseguir (enchufes tipo
# Sonoff flasheados), y confirma el estado real del relé en la respuesta en
# vez de asumir que si el HTTP no dio error el equipo obedeció.
# "home_assistant" es el de mayor alcance para quien YA tiene HA corriendo:
# en vez de escribir un driver por marca, delega en su API REST, que integra
# Tasmota, Shelly, Tuya, Zigbee, ESPHome, etc.
# "http_relay" es el genérico de respaldo: cualquier placa que prenda/apague
# pegándole a una URL propia, para equipos que no hablan el API de Tasmota.

def _tasmota_command(config: Dict[str, Any], action: str = "") -> str:
    base = f"Power{config['relay']}" if config.get("relay") else "Power"
    return f"{base} {action}".strip()


def _tasmota_power_key(config: Dict[str, Any]) -> str:
    return f"POWER{config['relay']}" if config.get("relay") else "POWER"


def _tasmota_request(config: Dict[str, Any], action: str = "") -> Optional[dict]:
    params = {"cmnd": _tasmota_command(config, action)}
    if config.get("username"):
        params["user"] = config["username"]
        params["password"] = config.get("password", "")
    try:
        response = requests.get(f"http://{config['host']}/cm", params=params, timeout=HTTP_TIMEOUT)
        response.raise_for_status()
        return response.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        logger.debug(f"[{config.get('host')}] Tasmota sin respuesta: {e}")
        return None


def _tasmota_get_state(config: Dict[str, Any]) -> Optional[bool]:
    data = _tasmota_request(config)
    if data is None:
        return None
    return {"ON": True, "OFF": False}.get(data.get(_tasmota_power_key(config)))


def _tasmota_set_state(config: Dict[str, Any], on: bool) -> bool:
    # Se confirma contra el valor que Tasmota devuelve en la misma respuesta
    # (no solo que el HTTP no dio error) — un enchufe atascado o que rechazó
    # el comando responde 200 igual, pero con el estado sin cambiar.
    data = _tasmota_request(config, "On" if on else "Off")
    if data is None:
        return False
    return data.get(_tasmota_power_key(config)) == ("ON" if on else "OFF")


def _ha_get_state(config: Dict[str, Any]) -> Optional[bool]:
    try:
        response = requests.get(
            f"{config['base_url'].rstrip('/')}/api/states/{config['entity_id']}",
            headers={"Authorization": f"Bearer {config['token']}"},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        state = response.json().get("state")
        return {"on": True, "off": False}.get(state)
    except (requests.exceptions.RequestException, ValueError) as e:
        logger.debug(f"[{config.get('entity_id')}] No se pudo leer estado (Home Assistant): {e}")
        return None


def _ha_set_state(config: Dict[str, Any], on: bool) -> bool:
    domain = config["entity_id"].split(".")[0]
    service = "turn_on" if on else "turn_off"
    try:
        response = requests.post(
            f"{config['base_url'].rstrip('/')}/api/services/{domain}/{service}",
            headers={
                "Authorization": f"Bearer {config['token']}",
                "Content-Type": "application/json",
            },
            json={"entity_id": config["entity_id"]},
            timeout=HTTP_TIMEOUT,
        )
        return response.ok
    except requests.exceptions.RequestException as e:
        logger.warning(f"[{config.get('entity_id')}] Fallo al cambiar estado (Home Assistant): {e}")
        return False


def _relay_get_state(config: Dict[str, Any]) -> Optional[bool]:
    status_url = config.get("status_url")
    on_text = config.get("status_on_text")
    if not status_url or not on_text:
        return None
    try:
        response = requests.get(status_url, timeout=HTTP_TIMEOUT)
        response.raise_for_status()
        return on_text in response.text
    except requests.exceptions.RequestException as e:
        logger.debug(f"[{status_url}] No se pudo leer estado (relé HTTP): {e}")
        return None


def _relay_set_state(config: Dict[str, Any], on: bool) -> bool:
    url = config.get("on_url") if on else config.get("off_url")
    if not url:
        return False
    try:
        response = requests.get(url, timeout=HTTP_TIMEOUT)
        return response.ok
    except requests.exceptions.RequestException as e:
        logger.warning(f"[{url}] Fallo al cambiar estado (relé HTTP): {e}")
        return False


DRIVERS: Dict[str, Dict[str, Any]] = {
    "tasmota": {
        "required": ("host",),
        "get_state": _tasmota_get_state,
        "set_state": _tasmota_set_state,
    },
    "home_assistant": {
        "required": ("base_url", "token", "entity_id"),
        "get_state": _ha_get_state,
        "set_state": _ha_set_state,
    },
    "http_relay": {
        "required": ("on_url", "off_url"),
        "get_state": _relay_get_state,
        "set_state": _relay_set_state,
    },
}


def get_driver_names() -> List[str]:
    return list(DRIVERS.keys())


# ── Registro de accesorios (persistido) ──

def _load_registry() -> List[Dict[str, Any]]:
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []


def _save_registry(entries: List[Dict[str, Any]]):
    try:
        with open(REGISTRY_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2)
    except OSError:
        pass


def _public(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Oculta credenciales (ej. token de Home Assistant) antes de devolver la
    entrada — no hay razón para que un token vuelva en cada GET del listado."""
    config = dict(entry.get("config", {}))
    if "token" in config:
        config["token"] = "***"
    return {**entry, "config": config}


def get_accessories() -> List[Dict[str, Any]]:
    return [_public(e) for e in _load_registry()]


def register_accessory(name: str, kind: str, driver: str, config: Dict[str, Any]) -> Dict[str, Any]:
    spec = DRIVERS.get(driver)
    if spec is None:
        raise ValueError(f"Driver desconocido: {driver}")

    missing = [key for key in spec["required"] if not config.get(key)]
    if missing:
        raise ValueError(f"Faltan campos de configuración: {', '.join(missing)}")

    entries = _load_registry()
    entry = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "kind": kind or "other",
        "driver": driver,
        "config": config,
        "registered_at": time.time(),
    }
    entries.append(entry)
    _save_registry(entries)
    logger.info(f"Accesorio registrado: {name} ({driver}, {entry['kind']})")
    return _public(entry)


def unregister_accessory(accessory_id: str) -> bool:
    entries = _load_registry()
    filtered = [e for e in entries if e.get("id") != accessory_id]
    changed = len(filtered) != len(entries)
    if changed:
        _save_registry(filtered)
        logger.info(f"Accesorio eliminado: {accessory_id}")
    return changed


def _get_accessories_status_sync() -> List[Dict[str, Any]]:
    result = []
    for entry in _load_registry():
        spec = DRIVERS.get(entry["driver"])
        state = spec["get_state"](entry["config"]) if spec else None
        result.append({**_public(entry), "on": state})
    return result


async def get_accessories_status() -> List[Dict[str, Any]]:
    """Versión async (en un hilo aparte) — mismo criterio que el probeo de
    red del registro de láseres: no bloquear el event loop de FastAPI
    mientras se esperan los timeouts HTTP de cada accesorio."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _get_accessories_status_sync)


async def set_accessory_power(accessory_id: str, on: bool) -> Optional[bool]:
    """None si el accesorio no existe en el registro; True/False según si el
    driver logró (o no) cambiar el estado."""
    entry = next((e for e in _load_registry() if e.get("id") == accessory_id), None)
    if entry is None:
        return None

    spec = DRIVERS.get(entry["driver"])
    if spec is None:
        return False

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, spec["set_state"], entry["config"], on)
