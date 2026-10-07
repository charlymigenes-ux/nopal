"""Centro de ayuda: contenido estático (HELP_CATEGORIES en app.js + claves en
translations.js). Se valida por texto -- no hay Node para ejecutar el JS."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_JS = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
TRANSLATIONS_JS = (ROOT / "backend/static/js/translations.js").read_text(encoding="utf-8")

COMING_SOON_KEY = "helpCatComingSoonDesc"


def _language_block(lang: str) -> str:
    """Texto del bloque `  <lang>: {` ... `  },` de translations.js."""
    start = TRANSLATIONS_JS.index(f"\n  {lang}: {{\n")
    end = TRANSLATIONS_JS.index("\n  },", start)
    return TRANSLATIONS_JS[start:end]


def _translation_value(block: str, key: str):
    match = re.search(rf"^    {re.escape(key)}: (['\"])(.*)\1,\s*$", block, re.MULTILINE)
    return match.group(2) if match else None


def _help_categories():
    start = APP_JS.index("const HELP_CATEGORIES = [")
    end = APP_JS.index("\n];", start)
    entries = re.findall(r"^    \{ key: '([^']+)'(.*)\},\s*$", APP_JS[start:end], re.MULTILINE)
    assert entries, "No se pudieron leer las categorías de HELP_CATEGORIES"
    categories = []
    for key, rest in entries:
        status = re.search(r"status: '([^']+)'", rest).group(1)
        text_keys = re.findall(r"(?:titleKey|descKey): '([^']+)'", rest)
        items = re.search(r"itemKeys: \[([^\]]*)\]", rest)
        item_keys = re.findall(r"'([^']+)'", items.group(1)) if items else []
        desc_key = re.search(r"descKey: '([^']+)'", rest).group(1)
        categories.append({"key": key, "status": status, "desc_key": desc_key,
                           "text_keys": text_keys + item_keys, "item_keys": item_keys})
    return categories


def test_every_help_text_key_exists_in_es_and_en():
    blocks = {lang: _language_block(lang) for lang in ("es", "en")}
    for category in _help_categories():
        for key in category["text_keys"]:
            for lang, block in blocks.items():
                value = _translation_value(block, key)
                assert value, f"Falta '{key}' ({category['key']}) en el bloque '{lang}' de translations.js"


def test_available_categories_have_real_content():
    available = [c for c in _help_categories() if c["status"] == "available"]
    assert available
    for category in available:
        assert category["desc_key"] != COMING_SOON_KEY, f"{category['key']} está 'available' pero usa {COMING_SOON_KEY}"
        assert category["item_keys"], f"{category['key']} está 'available' pero no tiene puntos (itemKeys)"


def test_outdated_help_texts_are_gone():
    for lang in ("es", "en"):
        block = _language_block(lang)
        about = _translation_value(block, "helpAboutDescription")
        # Ya no se presenta a Klipper/Moonraker como la única impresora soportada.
        for brand in ("Marlin", "Bambu Lab", "Elegoo", "FlashForge"):
            assert brand in about, f"helpAboutDescription ({lang}) no menciona {brand}"
        # El "láser activo" global se retiró: cada vista elige su máquina.
        laser = _translation_value(block, "helpLaserBody").lower()
        assert "cambiar entre ellos" not in laser
        assert "switch between them" not in laser
