#!/usr/bin/env python3
"""Generate static NOPAL language packs from the canonical English catalog.

The generated files are committed assets; NOPAL never translates at runtime
and therefore does not need Internet access in production.

The per-language cache (`.i18n-cache-<lang>.json`) stores, for every key, the
English text it was translated from (`{"en": ..., "text": ...}`). When the
English text changes the key is translated again; an entry without that
source (older cache format) is treated the same way.

Machine translations that are wrong or awkward are corrected in
`i18n_overrides.json` (`{lang: {key: {"en": ..., "text": ...}}}`), applied on
top of the cache. An override also records the English it was written for;
if that English changes, generation stops until the override is reviewed, so
a correction never silently outlives its source text.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROJECT_ASSETS = ROOT.parent / "backend" / "static" / "js"
ASSET_DIR = PROJECT_ASSETS if PROJECT_ASSETS.exists() else ROOT
SOURCE = ASSET_DIR / "translations.js"
OVERRIDES = ROOT / "i18n_overrides.json"
ENDPOINT = "https://translate.googleapis.com/translate_a/single"
LANGUAGES = {"pt-BR": "pt", "fr": "fr", "de": "de"}
MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get"
PROTECTED_TERMS = (
    "NOPAL", "G-Code", "GRBL", "CNC", "SVG", "USB", "WiFi", "Klipper",
    "Marlin", "Moonraker", "LightBurn", "STL", "3MF", "DXF", "HTTP",
    "WebSocket", "WhatsApp", "Arduino", "FluidNC", "ESP32", "CH340",
)


def read_english_catalog() -> dict[str, str]:
    source = SOURCE.read_text(encoding="utf-8")
    start = source.index("  en: {")
    end = source.index("\n  },\n};", start)
    catalog: dict[str, str] = {}
    line_pattern = re.compile(r"^    ([A-Za-z0-9_]+):\s*(.+),$", re.MULTILINE)
    for match in line_pattern.finditer(source[start:end]):
        key, literal = match.groups()
        try:
            catalog[key] = ast.literal_eval(literal)
        except (SyntaxError, ValueError) as exc:
            raise RuntimeError(f"Cannot parse translation {key}: {literal}") from exc
    return catalog


def protect(text: str) -> tuple[str, dict[str, str]]:
    values: list[str] = []

    def replace(match: re.Match[str]) -> str:
        token = f"ZXQPH{len(values)}QXZ"
        values.append(match.group(0))
        return token

    masked = re.sub(r"\{[^{}]+\}", replace, text)
    for term in PROTECTED_TERMS:
        masked = re.sub(re.escape(term), replace, masked, flags=re.IGNORECASE)
    return masked, {f"ZXQPH{i}QXZ": value for i, value in enumerate(values)}


def restore(text: str, replacements: dict[str, str]) -> str:
    for token, value in replacements.items():
        text = re.sub(re.escape(token), value, text, flags=re.IGNORECASE)
    return text


def request_translation(text: str, target: str, attempts: int = 1) -> str:
    payload = urllib.parse.urlencode(
        {"client": "gtx", "sl": "en", "tl": target, "dt": "t", "q": text}
    ).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={"User-Agent": "NOPAL-i18n-builder/1.0"},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
            return "".join(part[0] for part in data[0] if part and part[0])
        except (OSError, urllib.error.URLError, json.JSONDecodeError, IndexError):
            if attempt + 1 == attempts:
                return request_mymemory_translation(text, target)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("translation request failed")


def request_mymemory_translation(text: str, target: str) -> str:
    if len(text) > 480:
        raise RuntimeError("fallback translation batch is too large")
    target_code = "pt-BR" if target == "pt" else target
    query = urllib.parse.urlencode({
        "q": text,
        "langpair": f"en|{target_code}",
        "de": "nopal-i18n@users.noreply.github.com",
    })
    request = urllib.request.Request(
        f"{MYMEMORY_ENDPOINT}?{query}",
        headers={"User-Agent": "NOPAL-i18n-builder/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
    translated = data.get("responseData", {}).get("translatedText")
    if not translated:
        raise RuntimeError("fallback translation request failed")
    return translated


def translate_catalog(catalog: dict[str, str], language: str,
                      overrides: dict[str, str] | None = None) -> dict[str, str]:
    """Pack for `language`: manual overrides win, and a key with an override
    is never sent to the translation service."""
    overrides = overrides or {}
    target = LANGUAGES[language]
    cache_path = ROOT / f".i18n-cache-{language}.json"
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = {}

    # Only entries translated from the current English text are reused.
    pending = [(key, value) for key, value in catalog.items() if key not in overrides
               and not (isinstance(cache.get(key), dict) and cache[key].get("en") == value)]
    batch_size = 12
    for offset in range(0, len(pending), batch_size):
        batch = pending[offset:offset + batch_size]
        masked_items: list[str] = []
        replacements: list[dict[str, str]] = []
        for _key, value in batch:
            masked, item_replacements = protect(value)
            masked_items.append(masked)
            replacements.append(item_replacements)

        separators = [f"ZXQSEP{i:02d}QXZ" for i in range(len(batch) - 1)]
        combined = masked_items[0]
        for separator, item in zip(separators, masked_items[1:]):
            combined += f"\n{separator}\n{item}"
        try:
            translated = request_translation(combined, target)
            parts = re.split(r"\s*ZXQSEP\d{2}QXZ\s*", translated, flags=re.IGNORECASE)
        except RuntimeError:
            parts = []

        if len(parts) != len(batch):
            parts = [request_mymemory_translation(item, target) for item in masked_items]

        for (key, value), part, item_replacements in zip(batch, parts, replacements):
            cache[key] = {"en": value, "text": restore(part.strip(), item_replacements)}

        cache_path.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"{language}: {min(offset + len(batch), len(pending))}/{len(pending)}", flush=True)

    return {key: overrides[key] if key in overrides else cache[key]["text"] for key in catalog}


def load_overrides(catalog: dict[str, str], path: Path = OVERRIDES) -> dict[str, dict[str, str]]:
    """Manual corrections per language. Raises if one targets a key that no
    longer exists or was written for an English text that has changed."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    problems: list[str] = []
    overrides: dict[str, dict[str, str]] = {}
    for language, entries in raw.items():
        if language not in LANGUAGES:
            problems.append(f"{language}: unknown language")
            continue
        for key, entry in entries.items():
            if key not in catalog:
                problems.append(f"{language}.{key}: key no longer exists")
            elif entry.get("en") != catalog[key]:
                problems.append(f"{language}.{key}: English changed; review the override "
                                f"(was {entry.get('en')!r}, now {catalog[key]!r})")
            else:
                overrides.setdefault(language, {})[key] = entry["text"]
    if problems:
        raise RuntimeError("Stale i18n overrides:\n  " + "\n  ".join(problems))
    return overrides


def write_pack(language: str, translations: dict[str, str]) -> Path:
    output = ASSET_DIR / f"translations-{language}.js"
    payload = json.dumps(translations, ensure_ascii=False, indent=2)
    output.write_text(
        "// Generated static language pack. See scripts/generate_i18n.py.\n"
        f"window.NopalTranslations[{json.dumps(language)}] = {payload};\n",
        encoding="utf-8",
    )
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    # Languages are validated by hand: nargs="*" combined with `choices`
    # breaks differently across Python versions (3.13 rejects a list
    # default; 3.9-3.12 reject the empty list when no language is given).
    parser.add_argument("languages", nargs="*", metavar="LANG",
                        help=f"one or more of {', '.join(LANGUAGES)} (default: all)")
    args = parser.parse_args()
    unknown = [language for language in args.languages if language not in LANGUAGES]
    if unknown:
        parser.error(f"unknown language(s): {', '.join(unknown)}")
    catalog = read_english_catalog()
    overrides = load_overrides(catalog)
    print(f"English catalog: {len(catalog)} keys", flush=True)
    for language in args.languages or list(LANGUAGES):
        output = write_pack(language, translate_catalog(catalog, language, overrides.get(language)))
        print(f"Wrote {output.name}", flush=True)


if __name__ == "__main__":
    main()
