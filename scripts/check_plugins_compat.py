#!/usr/bin/env python3
"""Compatibilidad de los plugins del catálogo con el Python que lo ejecuta
(en CI: job `plugins-compat`, Python 3.9).

Prueba lo mismo que recibiría un usuario nuevo desde la Galería: la punta de
la rama por defecto de cada `repo_url` de backend/plugin_catalog.json (sin
fijar versiones), y registra el SHA y la versión que terminaron probándose.

Por plugin:
- A: tiene tests y backend → su suite, con NOPAL_CORE_ROOT apuntando a NOPAL.
- T: tiene tests sin backend (contrato del frontend) → su suite.
- C: backend sin tests → carga con el cargador real de NOPAL
  (`load_installed_plugin_routers`, el del arranque) y exige que registre rutas.
- D: sin backend ni tests → N/A (solo frontend).
A y C pasan además por el cargador real.

Resultados: PASS, N/A, COMPAT (falla el job: test fallido, router que no
carga, error de importación) e INFRA (no falla el job: repo inaccesible tras
3 intentos o una herramienta del entorno que falta). Sale con 1 si hay algún
COMPAT. Nunca toca la carpeta plugins/ de NOPAL: clona en --workdir.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG = REPO_ROOT / "backend" / "plugin_catalog.json"
MANIFEST = "nopal-plugin.json"
CLONE_ATTEMPTS = 3
CLONE_TIMEOUT = 120
RETRY_DELAYS = (5, 15)
TEST_TIMEOUT = 900
OUTPUT_TAIL = 25

PASS, COMPAT, INFRA, NA = "PASS", "COMPAT", "INFRA", "N/A"

# Herramientas externas que pide un plugin (Node para sus tests de contrato,
# ffmpeg para las cámaras), detectadas en su código de tests y de backend. Si
# falta, es el entorno (INFRA), no el plugin.
_TOOL_PATTERNS = {tool: re.compile(rf"""["']{tool}["']""") for tool in ("node", "ffmpeg")}

# Carga con el mismo camino que el arranque de NOPAL. Corre en un proceso
# aparte, con PLUGINS_DIR y el estado de instalación apuntando al directorio
# de trabajo (nunca a plugins/ ni data/ del checkout).
_LOADER_SNIPPET = """
import json, logging, sys
from pathlib import Path
from fastapi import FastAPI
from backend.services import plugin_installer_service as installer
from backend.services import plugin_loader_service as loader

plugin_id, plugins_dir = sys.argv[1], Path(sys.argv[2])
logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
installer.PLUGINS_DIR = plugins_dir
installer.read_installed_state = lambda: {plugin_id: {"enabled": True}}
app = FastAPI()
before = len(app.routes)
loader.load_installed_plugin_routers(app)
added = len(app.routes) - before
print(json.dumps({"routes": added}))
sys.exit(0 if added > 0 else 1)
"""


@dataclass
class Result:
    plugin_id: str
    repo_url: str
    kind: str = ""
    ref: str = ""
    sha: str = ""
    version: str = ""
    status: str = ""
    checks: List[str] = field(default_factory=list)
    detail: str = ""
    output: str = ""


Runner = Callable[..., subprocess.CompletedProcess]


def load_catalog(path: Path = CATALOG) -> List[Dict[str, str]]:
    """Plugins con `repo_url` (los "próximamente" no tienen y se omiten)."""
    entries = json.loads(path.read_text(encoding="utf-8"))
    return [{"id": e["id"], "repo_url": e["repo_url"]} for e in entries
            if isinstance(e, dict) and e.get("id") and e.get("repo_url")]


def _tail(text: str, lines: int = OUTPUT_TAIL) -> str:
    return "\n".join(text.strip().splitlines()[-lines:])


def clone(repo_url: str, dest: Path, run: Runner = subprocess.run,
          sleep: Callable[[float], None] = time.sleep) -> Optional[str]:
    """Clona la rama por defecto (como la Galería). Devuelve None si salió
    bien o el último error tras CLONE_ATTEMPTS intentos."""
    error = ""
    for attempt in range(CLONE_ATTEMPTS):
        if dest.exists():
            shutil.rmtree(dest)
        try:
            proc = run(["git", "clone", "--quiet", "--depth", "1", repo_url, str(dest)],
                       capture_output=True, text=True, timeout=CLONE_TIMEOUT,
                       env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
            if proc.returncode == 0:
                return None
            error = _tail(proc.stderr or proc.stdout or f"git salió con {proc.returncode}", 3)
        except subprocess.TimeoutExpired:
            error = f"tiempo agotado ({CLONE_TIMEOUT} s)"
        except OSError as exc:
            error = str(exc)
        if attempt + 1 < CLONE_ATTEMPTS:
            sleep(RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)])
    return error


def _git(plugin_dir: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(plugin_dir), *args], capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else ""


def classify(plugin_dir: Path, manifest: dict) -> str:
    has_backend = bool((manifest.get("backend") or {}).get("entry"))
    has_tests = (plugin_dir / "tests").is_dir() and any((plugin_dir / "tests").rglob("test_*.py"))
    if has_tests:
        return "A" if has_backend else "T"
    return "C" if has_backend else "D"


def required_tools(plugin_dir: Path) -> List[str]:
    tools = set()
    for path in [*(plugin_dir / "tests").rglob("*.py"), *(plugin_dir / "backend").rglob("*.py")]:
        text = path.read_text(encoding="utf-8", errors="replace")
        tools.update(tool for tool, pattern in _TOOL_PATTERNS.items() if pattern.search(text))
    return sorted(tools)


def run_tests(plugin_dir: Path, core_root: Path, run: Runner = subprocess.run):
    """(ok, salida) de la suite propia del plugin."""
    try:
        proc = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"],
                   cwd=str(plugin_dir), capture_output=True, text=True, timeout=TEST_TIMEOUT,
                   env={**os.environ, "NOPAL_CORE_ROOT": str(core_root)})
    except subprocess.TimeoutExpired:
        return False, f"tiempo agotado ({TEST_TIMEOUT} s)"
    output = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, output


def run_loader(plugin_id: str, plugins_dir: Path, core_root: Path, run: Runner = subprocess.run):
    """(ok, salida) de cargar el plugin con el cargador real de NOPAL."""
    pythonpath = os.pathsep.join(filter(None, [str(core_root), os.environ.get("PYTHONPATH")]))
    try:
        proc = run([sys.executable, "-c", _LOADER_SNIPPET, plugin_id, str(plugins_dir)],
                   cwd=str(plugins_dir.parent), capture_output=True, text=True, timeout=TEST_TIMEOUT,
                   env={**os.environ, "PYTHONPATH": pythonpath,
                        "NOPAL_PLUGIN_DATA_DIR": str(plugins_dir.parent / "data")})
    except subprocess.TimeoutExpired:
        return False, f"tiempo agotado ({TEST_TIMEOUT} s)"
    output = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, output


def _summary_line(output: str) -> str:
    for line in reversed(output.strip().splitlines()):
        if re.search(r"\b(passed|failed|error|errors|skipped)\b", line):
            return line.strip("= ").strip()
    return ""


def check_plugin(entry: Dict[str, str], workdir: Path, core_root: Path,
                 run: Runner = subprocess.run, sleep: Callable[[float], None] = time.sleep) -> Result:
    result = Result(entry["id"], entry["repo_url"])
    plugins_dir = workdir / "plugins"
    plugins_dir.mkdir(parents=True, exist_ok=True)
    plugin_dir = plugins_dir / entry["id"]

    error = clone(entry["repo_url"], plugin_dir, run=run, sleep=sleep)
    if error is not None:
        result.status, result.detail = INFRA, f"no se pudo clonar tras {CLONE_ATTEMPTS} intentos: {error}"
        return result
    result.ref = _git(plugin_dir, "rev-parse", "--abbrev-ref", "HEAD")
    result.sha = _git(plugin_dir, "rev-parse", "HEAD")

    try:
        manifest = json.loads((plugin_dir / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        result.status, result.detail = COMPAT, f"{MANIFEST} ausente o ilegible: {exc}"
        return result
    result.version = str(manifest.get("version") or "")
    result.kind = classify(plugin_dir, manifest)

    if result.kind == "D":
        result.status, result.detail = NA, "solo frontend (sin backend Python)"
        return result

    if result.kind in ("A", "T"):
        missing = [tool for tool in required_tools(plugin_dir) if shutil.which(tool) is None]
        if missing:
            result.status = INFRA
            result.detail = f"falta en el entorno: {', '.join(missing)} (la usa el plugin)"
            return result
        ok, output = run_tests(plugin_dir, core_root, run=run)
        result.checks.append(f"tests: {_summary_line(output) or ('ok' if ok else 'fallaron')}")
        if not ok:
            result.status, result.detail, result.output = COMPAT, "falló su suite de tests", _tail(output)
            return result

    if result.kind in ("A", "C"):
        ok, output = run_loader(entry["id"], plugins_dir, core_root, run=run)
        routes = re.search(r'"routes":\s*(\d+)', output)
        result.checks.append(f"cargador de NOPAL: {routes.group(1) + ' rutas' if routes and ok else 'falló'}")
        if not ok:
            result.status, result.detail, result.output = COMPAT, "el cargador de NOPAL no cargó su router", _tail(output)
            return result

    result.status, result.detail = PASS, "; ".join(result.checks)
    return result


def render_summary(results: List[Result], python: str) -> str:
    icons = {PASS: "✅ PASS", COMPAT: "❌ COMPAT", INFRA: "⚠️ INFRA", NA: "➖ N/A"}
    lines = [f"## NOPAL Plugins — Python {python}", "",
             "Punta de la rama por defecto de cada `repo_url` del catálogo (lo que instala la Galería).", "",
             "| Plugin | Tipo | Ref | SHA | Versión | Resultado | Detalle |",
             "|---|---|---|---|---|---|---|"]
    for r in results:
        detail = r.detail.replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r.plugin_id} | {r.kind or '—'} | {r.ref or '—'} | `{r.sha[:7] or '—'}` | "
                     f"{r.version or '—'} | {icons[r.status]} | {detail} |")
    infra = [r for r in results if r.status == INFRA]
    if infra:
        lines += ["", "> ⚠️ **INFRA no es incompatibilidad**: no se pudo probar "
                  + ", ".join(f"`{r.plugin_id}` ({r.repo_url})" for r in infra)
                  + ". No hace fallar el check; la siguiente corrida lo vuelve a intentar."]
    for r in (r for r in results if r.status == COMPAT):
        lines += ["", f"<details><summary>❌ {r.plugin_id} @ {r.sha[:7]} — {r.detail}</summary>", "",
                  "```", r.output or "(sin salida)", "```", "</details>"]
    lines += ["", "Tipos: A = tests + backend · T = tests de contrato (sin backend) · "
              "C = backend sin tests (cargador real) · D = solo frontend."]
    return "\n".join(lines) + "\n"


def _annotate(results: List[Result]) -> None:
    for r in results:
        if r.status == COMPAT:
            print(f"::error title=COMPAT {r.plugin_id}::{r.plugin_id} @ {r.sha[:7]}: {r.detail}")
        elif r.status == INFRA:
            print(f"::warning title=INFRA {r.plugin_id}::{r.repo_url}: {r.detail}")


def main(argv: Optional[List[str]] = None, run: Runner = subprocess.run,
         sleep: Callable[[float], None] = time.sleep) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--core-root", type=Path, default=REPO_ROOT,
                        help="checkout de NOPAL contra el que corren los plugins")
    parser.add_argument("--workdir", type=Path, default=None,
                        help="dónde clonar (por omisión, un directorio temporal)")
    args = parser.parse_args(argv)

    entries = load_catalog(args.catalog)
    if not entries:
        print("El catálogo no tiene plugins con repo_url.", file=sys.stderr)
        return 1
    workdir = args.workdir or Path(tempfile.mkdtemp(prefix="nopal-plugins-"))
    python = ".".join(map(str, sys.version_info[:3]))

    results = []
    for entry in entries:
        result = check_plugin(entry, workdir, args.core_root.resolve(), run=run, sleep=sleep)
        print(f"{result.plugin_id}: {result.status} — {result.detail}", flush=True)
        results.append(result)

    summary = render_summary(results, python)
    print(summary)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(summary)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        _annotate(results)
    return 1 if any(r.status == COMPAT for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
