"""El operador no debe ver las fichas de Configuración que no puede usar.

El backend ya le responde 403 en todas sus acciones; esto es solo
visibilidad en el panel. Test estático: lee app.js/index.html como texto, sin
navegador.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_JS = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")

EXPECTED_ADMIN_ONLY = {
    "ai", "users", "tunascreen", "logsConfig",
    "updates", "devices", "accessories", "backup",
}


def _admin_only_modules():
    match = re.search(r"const ADMIN_ONLY_SETTINGS_MODULES\s*=\s*\[([^\]]*)\]", APP_JS)
    assert match, "app.js debe declarar ADMIN_ONLY_SETTINGS_MODULES"
    return set(re.findall(r"'([^']+)'", match.group(1)))


def _function_body(name):
    match = re.search(r"function " + re.escape(name) + r"\s*\([^)]*\)\s*\{", APP_JS)
    assert match, f"no se encontró la función {name}"
    depth = 0
    for i in range(match.end() - 1, len(APP_JS)):
        if APP_JS[i] == "{":
            depth += 1
        elif APP_JS[i] == "}":
            depth -= 1
            if depth == 0:
                return APP_JS[match.end():i]
    raise AssertionError(f"llaves sin cerrar en {name}")


def test_admin_only_list_has_expected_modules():
    assert _admin_only_modules() == EXPECTED_ADMIN_ONLY


def test_logs_viewer_stays_visible_for_operator():
    # Leer logs es de operador (READ_LOGS); solo la configuración es de admin.
    assert "logs" not in _admin_only_modules()


def test_every_admin_only_module_exists_in_settings():
    for key in EXPECTED_ADMIN_ONLY:
        assert f'data-settings-module="{key}"' in INDEX_HTML, key


def test_update_topbar_user_applies_role_visibility():
    body = _function_body("updateTopbarUser")
    assert "applySettingsModulesRoleVisibility(" in body
    assert "laser-scan-btn" in body
    assert re.search(r"\.hidden\s*=\s*user\.role\s*!==\s*'admin'", body)

    apply_body = _function_body("applySettingsModulesRoleVisibility")
    assert "ADMIN_ONLY_SETTINGS_MODULES" in apply_body
    assert ".hidden" in apply_body


def test_layout_customizer_filters_by_role():
    assert re.search(r"isModuleAllowed:\s*key\s*=>\s*isSettingsModuleAllowedForRole\(key\)", APP_JS)
    scope = _function_body("createModulePageScope")
    # Las filas del editor y la visibilidad de los grupos consultan el filtro.
    assert scope.count("isModuleAllowed(") >= 3
    allowed = _function_body("isSettingsModuleAllowedForRole")
    assert "ADMIN_ONLY_SETTINGS_MODULES" in allowed


def test_logs_config_loader_skips_fetch_for_operator():
    body = _function_body("loadLogsConfigSettings")
    guard = body.find("isSettingsModuleAllowedForRole('logsConfig')")
    fetch = body.find("aiFetchJson('/api/logs/config')")
    assert guard != -1 and fetch != -1 and guard < fetch
