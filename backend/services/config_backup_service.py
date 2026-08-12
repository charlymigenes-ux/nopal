"""Exportar e importar la configuración de NOPAL.

Sirve para levantar una instalación nueva sin reconfigurar todo a mano, y
para respaldar antes de tocar algo. El usuario elige qué grupos se llevan:
respaldar todo cuando solo querías las impresoras es tan molesto como no
tener respaldo.

Cifrado, no "codificado"
------------------------
El respaldo puede incluir `auth_users.json` (hashes de contraseña) y
`ai_config.json` (la API key del proveedor de IA, en claro). Base64 no es
protección: cualquiera lo decodifica. Por eso, cuando el respaldo incluye
algún grupo sensible se **exige una frase de cifrado** y el archivo se cifra
con Fernet (AES-128-CBC + HMAC) usando una clave derivada con scrypt y una
sal aleatoria por archivo.

Fernet además autentica: una frase equivocada o un archivo alterado fallan
con un error claro en vez de producir basura que luego se escribiría encima
de la configuración buena.

Lo que NUNCA se exporta
-----------------------
`.session_secret` — con él, quien tenga el respaldo podría falsificar
cookies de sesión de esa instalación. No hay razón para moverlo entre
instalaciones: se regenera solo.
"""

import base64
import json
import logging
import os
import shutil
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

FORMAT_VERSION = 1
MAGIC = "NOPAL-CONFIG"

# Grupos exportables. `sensitive` marca los que obligan a poner frase de
# cifrado. Los archivos que no existan se omiten sin ruido: una instalación
# sin láser simplemente no tiene laser_registry.json.
GROUPS: Dict[str, Dict[str, Any]] = {
    "printers": {
        "label": "Impresoras 3D",
        "files": [
            "marlin_printer_registry.json",
            "elegoo_printer_registry.json",
            "flashforge_printer_registry.json",
            "bambu_printer_registry.json",
        ],
        "sensitive": False,
    },
    "laser_cnc": {"label": "Láser y CNC", "files": ["laser_registry.json"], "sensitive": False},
    "accessories": {
        "label": "Accesorios y placas",
        "files": ["accessory_registry.json", "arduino_boards_config.json"],
        "sensitive": False,
    },
    "cameras": {"label": "Cámaras", "files": ["camera_registry.json"], "sensitive": False},
    "presets": {"label": "Presets de temperatura", "files": ["temperature_presets.json"], "sensitive": False},
    "pricing": {
        "label": "Cotizador (precios y cotizaciones)",
        "files": ["pricing_config.json", "quotes_registry.json"],
        "sensitive": False,
    },
    "spoolman": {
        "label": "Materiales (Spoolman)",
        "files": ["spoolman_config.json", "spoolman_printer_links.json", "spoolman_reservations.json"],
        "sensitive": False,
    },
    "tunascreen": {"label": "TUNA-Screen", "files": ["tunascreen_devices.json"], "sensitive": False},
    "plugins": {"label": "Plugins instalados", "files": ["data/plugins/installed.json"], "sensitive": False},
    # --- sensibles ---
    "users": {
        "label": "Usuarios y contraseñas",
        "files": ["auth_users.json"],
        "sensitive": True,
        "warning": "Incluye los hashes de contraseña de todas las cuentas.",
    },
    "ai": {
        "label": "NOPAL Intelligence",
        "files": ["ai_config.json"],
        "sensitive": True,
        "warning": "Incluye la clave de API de tu proveedor de IA, en claro dentro del archivo.",
    },
    "ai_conversations": {
        "label": "Historial de conversaciones con la IA",
        "files": ["ai_conversations.json"],
        "sensitive": True,
        "warning": "Puede contener detalles del taller y de sus fallas.",
    },
}

# Jamás se exporta: quien lo tuviera podría falsificar sesiones.
NEVER_EXPORT = {".session_secret"}

BACKUP_SUFFIX = ".pre-import.bak"


class BackupError(RuntimeError):
    """Falla al exportar o importar. El router la traduce a un 400."""


def list_groups() -> Dict[str, Any]:
    """Grupos disponibles, con cuáles existen realmente en esta instalación."""
    salida = []
    for group_id, spec in GROUPS.items():
        presentes = [f for f in spec["files"] if os.path.isfile(f)]
        salida.append({
            "id": group_id,
            "label": spec["label"],
            "sensitive": spec["sensitive"],
            "warning": spec.get("warning"),
            "available": bool(presentes),
            "file_count": len(presentes),
        })
    return {"groups": salida}


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    """scrypt: deliberadamente caro, para que una frase corta no se rompa a
    fuerza bruta en un rato."""
    import hashlib

    clave = hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return base64.urlsafe_b64encode(clave)


def _collect(groups: List[str]) -> Tuple[Dict[str, Any], List[str]]:
    contenido: Dict[str, Any] = {}
    incluidos: List[str] = []
    for group_id in groups:
        spec = GROUPS.get(group_id)
        if spec is None:
            raise BackupError(f"Grupo desconocido: {group_id}")
        for ruta in spec["files"]:
            if os.path.basename(ruta) in NEVER_EXPORT:
                continue
            if not os.path.isfile(ruta):
                continue
            try:
                with open(ruta, "r", encoding="utf-8") as handle:
                    contenido[ruta] = json.load(handle)
            except (json.JSONDecodeError, OSError) as exc:
                raise BackupError(f"No se pudo leer {ruta}: {exc}")
            incluidos.append(ruta)
    return contenido, incluidos


def export_config(groups: List[str], passphrase: str = "") -> bytes:
    """Devuelve el archivo de respaldo listo para descargar."""
    if not groups:
        raise BackupError("Elige al menos un grupo para exportar")

    sensibles = [g for g in groups if GROUPS.get(g, {}).get("sensitive")]
    if sensibles and not passphrase:
        etiquetas = ", ".join(GROUPS[g]["label"] for g in sensibles)
        raise BackupError(
            f"Ese respaldo incluye datos sensibles ({etiquetas}). "
            "Pon una frase de cifrado para protegerlo."
        )
    if passphrase and len(passphrase) < 8:
        raise BackupError("La frase de cifrado debe tener al menos 8 caracteres")

    contenido, incluidos = _collect(groups)
    if not contenido:
        raise BackupError("Ninguno de los grupos elegidos tiene datos en esta instalación")

    cuerpo = json.dumps({"files": contenido}, ensure_ascii=False).encode("utf-8")
    sobre: Dict[str, Any] = {
        "magic": MAGIC,
        "version": FORMAT_VERSION,
        "created_at": time.time(),
        "groups": groups,
        "encrypted": bool(passphrase),
    }

    if passphrase:
        from cryptography.fernet import Fernet

        salt = os.urandom(16)
        token = Fernet(_derive_key(passphrase, salt)).encrypt(cuerpo)
        sobre["salt"] = base64.b64encode(salt).decode("ascii")
        sobre["payload"] = base64.b64encode(token).decode("ascii")
    else:
        # Sin datos sensibles la frase es opcional; el cuerpo va en base64
        # por comodidad de transporte, y eso NO es protección: por eso solo
        # se permite cuando no hay nada sensible dentro.
        sobre["payload"] = base64.b64encode(cuerpo).decode("ascii")

    logger.info(f"Respaldo de configuración generado: {len(incluidos)} archivos, cifrado={bool(passphrase)}")
    return json.dumps(sobre, ensure_ascii=False, indent=2).encode("utf-8")


def _open_envelope(raw: bytes, passphrase: str = "") -> Dict[str, Any]:
    try:
        sobre = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BackupError("Ese archivo no es un respaldo de NOPAL")

    if not isinstance(sobre, dict) or sobre.get("magic") != MAGIC:
        raise BackupError("Ese archivo no es un respaldo de NOPAL")
    if sobre.get("version") != FORMAT_VERSION:
        raise BackupError(f"Respaldo de una versión distinta del formato ({sobre.get('version')})")

    try:
        payload = base64.b64decode(sobre["payload"])
    except Exception:
        raise BackupError("El respaldo está dañado")

    if sobre.get("encrypted"):
        if not passphrase:
            raise BackupError("Ese respaldo está cifrado: hace falta la frase")
        from cryptography.fernet import Fernet, InvalidToken

        try:
            salt = base64.b64decode(sobre["salt"])
            payload = Fernet(_derive_key(passphrase, salt)).decrypt(payload)
        except (InvalidToken, KeyError, ValueError):
            # Fernet autentica: una frase mala o un archivo alterado se
            # detectan acá y no se llega a escribir nada.
            raise BackupError("Frase incorrecta, o el archivo fue alterado")

    try:
        cuerpo = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BackupError("El respaldo está dañado")

    archivos = cuerpo.get("files")
    if not isinstance(archivos, dict):
        raise BackupError("El respaldo no trae archivos")
    return {"envelope": sobre, "files": archivos}


def inspect_backup(raw: bytes, passphrase: str = "") -> Dict[str, Any]:
    """Qué trae el respaldo, sin escribir nada. La persona tiene derecho a
    ver qué va a sobrescribir antes de aceptarlo."""
    try:
        sobre = json.loads(raw.decode("utf-8"))
    except Exception:
        raise BackupError("Ese archivo no es un respaldo de NOPAL")

    if sobre.get("magic") != MAGIC:
        raise BackupError("Ese archivo no es un respaldo de NOPAL")

    # Si está cifrado y no hay frase, se informa lo del sobre sin abrirlo.
    if sobre.get("encrypted") and not passphrase:
        return {
            "encrypted": True,
            "needs_passphrase": True,
            "created_at": sobre.get("created_at"),
            "groups": sobre.get("groups", []),
            "files": [],
        }

    abierto = _open_envelope(raw, passphrase)
    return {
        "encrypted": bool(sobre.get("encrypted")),
        "needs_passphrase": False,
        "created_at": sobre.get("created_at"),
        "groups": sobre.get("groups", []),
        "files": sorted(abierto["files"].keys()),
    }


def import_config(raw: bytes, groups: List[str], passphrase: str = "") -> Dict[str, Any]:
    """Restaura solo los grupos elegidos.

    Antes de sobrescribir cada archivo se guarda una copia `.pre-import.bak`:
    importar el respaldo equivocado no debe ser irreversible.
    """
    if not groups:
        raise BackupError("Elige al menos un grupo para importar")

    abierto = _open_envelope(raw, passphrase)
    archivos = abierto["files"]

    permitidos = set()
    for group_id in groups:
        spec = GROUPS.get(group_id)
        if spec is None:
            raise BackupError(f"Grupo desconocido: {group_id}")
        permitidos.update(spec["files"])

    restaurados, respaldados, omitidos = [], [], []
    for ruta, contenido in archivos.items():
        if ruta not in permitidos:
            omitidos.append(ruta)
            continue
        if os.path.basename(ruta) in NEVER_EXPORT:
            omitidos.append(ruta)
            continue

        carpeta = os.path.dirname(ruta)
        if carpeta:
            os.makedirs(carpeta, exist_ok=True)

        if os.path.isfile(ruta):
            copia = ruta + BACKUP_SUFFIX
            try:
                shutil.copy2(ruta, copia)
                respaldados.append(copia)
            except OSError as exc:
                raise BackupError(f"No se pudo respaldar {ruta} antes de sobrescribirlo: {exc}")

        # Escritura atómica: una interrupción a media escritura dejaría el
        # registro corrupto, que ya pasó una vez en este proyecto.
        tmp = ruta + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(contenido, handle, indent=2, ensure_ascii=False)
        os.replace(tmp, ruta)
        restaurados.append(ruta)

    logger.info(f"Configuración importada: {len(restaurados)} archivos restaurados")
    return {
        "restored": sorted(restaurados),
        "backed_up": sorted(respaldados),
        "skipped": sorted(omitidos),
        # Varios registros se leen al arrancar; sin reiniciar, lo importado
        # convive con lo que ya estaba en memoria.
        "restart_recommended": True,
    }
