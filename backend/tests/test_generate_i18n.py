"""scripts/generate_i18n.py: caché con la fuente en inglés y correcciones
manuales. Sin red: el traductor es un doble que antepone el idioma.

Caso real: la caché guardaba solo la traducción por clave; cuando el inglés
cambiaba (p. ej. marlinPrintersDescription ganó "or MKS WiFi") se seguía
usando la traducción vieja para siempre.
"""

import importlib.util
import json
import sys

import pytest

from backend.tests.isolation import REPO_ROOT

_spec = importlib.util.spec_from_file_location("generate_i18n", REPO_ROOT / "scripts" / "generate_i18n.py")
gen = importlib.util.module_from_spec(_spec)
_write_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # sin __pycache__ en scripts/
_spec.loader.exec_module(gen)
sys.dont_write_bytecode = _write_bytecode


@pytest.fixture
def translator(tmp_path, monkeypatch):
    """Traduce cada texto como `<idioma>:<texto>` y cuenta qué se pidió."""
    asked = []

    def fake(text, target, attempts=1):
        items = text.split("\n")
        asked.extend(item for item in items if not item.startswith("ZXQSEP"))
        return "\n".join(item if item.startswith("ZXQSEP") else f"{target}:{item}" for item in items)

    monkeypatch.setattr(gen, "ROOT", tmp_path)
    monkeypatch.setattr(gen, "request_translation", fake)
    return asked


def cache(tmp_path, language="de"):
    return json.loads((tmp_path / f".i18n-cache-{language}.json").read_text(encoding="utf-8"))


def test_cache_records_the_english_source(tmp_path, translator):
    result = gen.translate_catalog({"hello": "Hello"}, "de")
    assert result == {"hello": "de:Hello"}
    assert cache(tmp_path) == {"hello": {"en": "Hello", "text": "de:Hello"}}


def test_unchanged_english_is_not_translated_again(tmp_path, translator):
    gen.translate_catalog({"hello": "Hello"}, "de")
    translator.clear()
    gen.translate_catalog({"hello": "Hello"}, "de")
    assert translator == []


def test_changed_english_is_translated_again(tmp_path, translator):
    gen.translate_catalog({"desc": "Printers over USB"}, "de")
    result = gen.translate_catalog({"desc": "Printers over USB or MKS WiFi"}, "de")
    assert result["desc"] == "de:Printers over USB or MKS WiFi"
    assert cache(tmp_path)["desc"]["en"] == "Printers over USB or MKS WiFi"


def test_entry_without_source_is_translated_again(tmp_path, translator):
    """Formato viejo (solo el texto): no se sabe de qué inglés salió."""
    (tmp_path / ".i18n-cache-de.json").write_text(json.dumps({"desc": "alte Übersetzung"}), encoding="utf-8")
    assert gen.translate_catalog({"desc": "New text"}, "de") == {"desc": "de:New text"}


def test_placeholders_and_protected_terms_survive(tmp_path, translator):
    result = gen.translate_catalog({"n": "{count} NOPAL events"}, "de")
    assert "{count}" in result["n"] and "NOPAL" in result["n"]


# ── Correcciones manuales ──

def write_overrides(tmp_path, data):
    path = tmp_path / "i18n_overrides.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_overrides_apply_when_english_matches(tmp_path):
    path = write_overrides(tmp_path, {"de": {"devCool": {"en": "Cool down", "text": "Abkühlen"}}})
    assert gen.load_overrides({"devCool": "Cool down"}, path) == {"de": {"devCool": "Abkühlen"}}


def test_missing_overrides_file_is_fine(tmp_path):
    assert gen.load_overrides({"a": "A"}, tmp_path / "no-existe.json") == {}


@pytest.mark.parametrize("data, message", [
    ({"de": {"devCool": {"en": "Cool down", "text": "Abkühlen"}}}, "English changed"),
    ({"de": {"gone": {"en": "x", "text": "y"}}}, "no longer exists"),
    ({"xx": {}}, "unknown language"),
])
def test_stale_overrides_stop_generation(tmp_path, data, message):
    path = write_overrides(tmp_path, data)
    with pytest.raises(RuntimeError, match=message):
        gen.load_overrides({"devCool": "Cool heaters"}, path)


def test_repo_overrides_are_valid():
    """Las correcciones del repo corresponden al inglés vigente."""
    gen.load_overrides(gen.read_english_catalog())


def test_cli_without_languages_does_not_crash(monkeypatch):
    """Python 3.13: nargs="*" + choices + default lista hacía fallar argparse."""
    calls = []
    monkeypatch.setattr(sys, "argv", ["generate_i18n.py"])
    monkeypatch.setattr(gen, "read_english_catalog", lambda: {"a": "A"})
    monkeypatch.setattr(gen, "load_overrides", lambda catalog: {})
    monkeypatch.setattr(gen, "translate_catalog", lambda catalog, language, overrides=None: calls.append(language) or {"a": "x"})
    monkeypatch.setattr(gen, "write_pack", lambda language, translations: gen.Path(f"{language}.js"))
    gen.main()
    assert sorted(calls) == sorted(gen.LANGUAGES)


def test_committed_packs_include_every_override():
    """Los paquetes del repo salen del generador con las correcciones
    aplicadas (p. ej. "Resume" no es "Lebenslauf"/"CV"/"Currículo")."""
    catalog = gen.read_english_catalog()
    for language, entries in gen.load_overrides(catalog).items():
        source = (gen.ASSET_DIR / f"translations-{language}.js").read_text(encoding="utf-8")
        pack = json.loads(source[source.index("= ") + 2:source.rindex(";")])
        wrong = {key: pack.get(key) for key, text in entries.items() if pack.get(key) != text}
        assert not wrong, f"{language}: {wrong}"


def test_overridden_key_is_not_sent_to_the_service(tmp_path, translator):
    result = gen.translate_catalog({"resume": "Resume", "hello": "Hello"}, "de", {"resume": "Fortsetzen"})
    assert result == {"resume": "Fortsetzen", "hello": "de:Hello"}
    assert translator == ["Hello"]
