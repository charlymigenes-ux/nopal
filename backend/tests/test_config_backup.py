"""Exportar e importar configuración.

Lo que más importa acá es que un respaldo con datos sensibles no pueda salir
sin cifrar, y que importar nunca sea irreversible.
"""

import json
import os

import pytest

from backend.services import config_backup_service as backup
from backend.services.config_backup_service import BackupError


@pytest.fixture(autouse=True)
def en_carpeta_temporal(tmp_path, monkeypatch):
    """Las rutas del servicio son relativas al directorio de trabajo, igual
    que el resto de los registros de NOPAL."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _crear(nombre, contenido):
    carpeta = os.path.dirname(nombre)
    if carpeta:
        os.makedirs(carpeta, exist_ok=True)
    with open(nombre, "w", encoding="utf-8") as f:
        json.dump(contenido, f)


def test_los_grupos_reportan_lo_que_existe():
    _crear("laser_registry.json", [{"host": "192.168.0.61"}])
    grupos = {g["id"]: g for g in backup.list_groups()["groups"]}
    assert grupos["laser_cnc"]["available"] is True
    assert grupos["printers"]["available"] is False


def test_no_se_puede_exportar_sensible_sin_frase():
    """Un respaldo con contraseñas o la API key no debe poder salir en claro."""
    _crear("auth_users.json", [{"username": "admin", "password_hash": "x"}])
    with pytest.raises(BackupError, match="frase de cifrado"):
        backup.export_config(["users"])


def test_frase_demasiado_corta():
    _crear("auth_users.json", [{"username": "admin"}])
    with pytest.raises(BackupError, match="al menos 8"):
        backup.export_config(["users"], "corta")


def test_ida_y_vuelta_cifrada():
    _crear("ai_config.json", {"providers": [{"api_key": "sk-secreta"}]})
    archivo = backup.export_config(["ai"], "frase-larga-y-secreta")

    # La clave NO debe aparecer en claro dentro del archivo exportado
    assert b"sk-secreta" not in archivo

    os.remove("ai_config.json")
    backup.import_config(archivo, ["ai"], "frase-larga-y-secreta")
    with open("ai_config.json", encoding="utf-8") as f:
        assert json.load(f)["providers"][0]["api_key"] == "sk-secreta"


def test_frase_incorrecta_no_escribe_nada():
    _crear("ai_config.json", {"marca": "original"})
    archivo = backup.export_config(["ai"], "frase-correcta-123")
    _crear("ai_config.json", {"marca": "vigente"})

    with pytest.raises(BackupError, match="Frase incorrecta"):
        backup.import_config(archivo, ["ai"], "frase-equivocada-99")

    # Lo que había sigue intacto: no se llegó a escribir
    with open("ai_config.json", encoding="utf-8") as f:
        assert json.load(f)["marca"] == "vigente"


def test_archivo_alterado_se_detecta():
    _crear("ai_config.json", {"x": 1})
    archivo = json.loads(backup.export_config(["ai"], "frase-larga-123").decode())
    archivo["payload"] = archivo["payload"][:-8] + "AAAAAAAA"
    with pytest.raises(BackupError, match="alterado|dañado"):
        backup.import_config(json.dumps(archivo).encode(), ["ai"], "frase-larga-123")


def test_sin_datos_sensibles_la_frase_es_opcional():
    _crear("laser_registry.json", [{"host": "192.168.0.61"}])
    archivo = backup.export_config(["laser_cnc"])
    assert backup.inspect_backup(archivo)["encrypted"] is False


def test_importar_respalda_antes_de_sobrescribir():
    """Importar el respaldo equivocado no debe ser irreversible."""
    _crear("laser_registry.json", [{"host": "viejo"}])
    archivo = backup.export_config(["laser_cnc"])
    _crear("laser_registry.json", [{"host": "actual"}])

    resultado = backup.import_config(archivo, ["laser_cnc"])
    assert resultado["backed_up"] == ["laser_registry.json" + backup.BACKUP_SUFFIX]
    with open("laser_registry.json" + backup.BACKUP_SUFFIX, encoding="utf-8") as f:
        assert json.load(f)[0]["host"] == "actual"


def test_solo_se_importan_los_grupos_elegidos():
    """El punto de la selección múltiple: traer las impresoras sin pisar los
    usuarios."""
    _crear("laser_registry.json", [{"host": "laser"}])
    _crear("temperature_presets.json", {"pla": 200})
    archivo = backup.export_config(["laser_cnc", "presets"])

    os.remove("laser_registry.json")
    os.remove("temperature_presets.json")
    resultado = backup.import_config(archivo, ["presets"])

    assert resultado["restored"] == ["temperature_presets.json"]
    assert "laser_registry.json" in resultado["skipped"]
    assert not os.path.exists("laser_registry.json")


def test_el_secreto_de_sesion_nunca_se_exporta():
    """Con él, quien tenga el respaldo podría falsificar sesiones."""
    assert ".session_secret" in backup.NEVER_EXPORT
    for spec in backup.GROUPS.values():
        assert ".session_secret" not in spec["files"]


def test_un_archivo_cualquiera_no_pasa_por_respaldo():
    with pytest.raises(BackupError, match="no es un respaldo"):
        backup.import_config(b'{"hola": 1}', ["ai"])
    with pytest.raises(BackupError, match="no es un respaldo"):
        backup.import_config(b'no soy json', ["ai"])


def test_inspeccionar_no_escribe_ni_pide_frase_para_ver_el_sobre():
    _crear("ai_config.json", {"x": 1})
    archivo = backup.export_config(["ai"], "frase-larga-123")
    info = backup.inspect_backup(archivo)     # sin frase
    assert info["needs_passphrase"] is True
    assert info["groups"] == ["ai"]
    assert info["files"] == []                # no se abre sin la frase
