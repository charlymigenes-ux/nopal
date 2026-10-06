"""scripts/check_plugins_compat.py: vigilancia de los plugins en Python 3.9.

Sin red: los "repos" de plugins son repos git locales creados en tmp_path y el
catálogo es un archivo temporal. La carga de tipo C usa el cargador real de
NOPAL sobre esas copias (nunca la carpeta plugins/ del checkout).
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from backend.tests.isolation import REPO_ROOT

_spec = importlib.util.spec_from_file_location("check_plugins_compat", REPO_ROOT / "scripts" / "check_plugins_compat.py")
compat = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = compat  # dataclass busca su módulo aquí
_write_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # sin __pycache__ en scripts/
_spec.loader.exec_module(compat)
sys.dont_write_bytecode = _write_bytecode

ROUTER_OK = "from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get('/api/falso')\ndef falso():\n    return {}\n"
ROUTER_BROKEN = "from fastapi import APIRouter\nimport modulo_que_no_existe\nrouter = APIRouter()\n"
TEST_OK = "def test_ok():\n    assert 1 + 1 == 2\n"
TEST_FAIL = "def test_falla():\n    assert 'py39' == 'py310', 'API incompatible'\n"
TEST_NODE = "import subprocess\n\ndef test_frontend():\n    subprocess.run(['node', '--check', 'x.js'], check=True)\n"


def manifest(plugin_id, backend=True, version="1.0.0"):
    data = {"id": plugin_id, "version": version}
    if backend:
        data["backend"] = {"entry": "backend/router.py"}
    return json.dumps(data)


def make_repo(root: Path, name: str, files: dict) -> str:
    repo = root / "remotos" / name
    for relative, content in files.items():
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    subprocess.run(git + ["add", "."], check=True)
    subprocess.run(git + ["commit", "-q", "-m", "inicial"], check=True)
    return str(repo)


def plugin_a(root, name="plugin-a", test=TEST_OK):
    return make_repo(root, name, {compat.MANIFEST: manifest(name), "backend/router.py": ROUTER_OK,
                                  "tests/test_plugin.py": test})


def plugin_c(root, name="plugin-c", router=ROUTER_OK):
    return make_repo(root, name, {compat.MANIFEST: manifest(name), "backend/router.py": router})


def plugin_d(root, name="plugin-d"):
    return make_repo(root, name, {compat.MANIFEST: manifest(name, backend=False), "frontend/x.js": "1;\n"})


def write_catalog(root, entries):
    path = root / "catalog.json"
    path.write_text(json.dumps(entries), encoding="utf-8")
    return path


def check(root, repo_url, plugin_id, **kwargs):
    return compat.check_plugin({"id": plugin_id, "repo_url": repo_url}, root / "trabajo", REPO_ROOT,
                               sleep=lambda s: None, **kwargs)


# ── Catálogo ──

def test_catalog_only_entries_with_repo_url(tmp_path):
    path = write_catalog(tmp_path, [{"id": "a", "repo_url": "https://x/a.git"},
                                    {"id": "pronto", "availability": "coming_soon", "repo_url": None},
                                    {"id": "b", "repo_url": "https://x/b.git"}])
    assert compat.load_catalog(path) == [{"id": "a", "repo_url": "https://x/a.git"},
                                         {"id": "b", "repo_url": "https://x/b.git"}]


def test_real_catalog_is_readable():
    entries = compat.load_catalog()
    assert entries and all(e["repo_url"] for e in entries)


# ── Clasificación ──

@pytest.mark.parametrize("files, backend, kind", [
    ({"tests/test_x.py": TEST_OK, "backend/router.py": ROUTER_OK}, True, "A"),
    ({"tests/test_x.py": TEST_OK}, False, "T"),
    ({"backend/router.py": ROUTER_OK}, True, "C"),
    ({"frontend/x.js": "1;"}, False, "D"),
])
def test_classify(tmp_path, files, backend, kind):
    for relative, content in files.items():
        (tmp_path / relative).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / relative).write_text(content)
    assert compat.classify(tmp_path, json.loads(manifest("x", backend=backend))) == kind


# ── Resultados ──

def test_type_a_pass_runs_tests_and_real_loader(tmp_path):
    result = check(tmp_path, plugin_a(tmp_path), "plugin-a")
    assert result.status == compat.PASS and result.kind == "A"
    assert "1 passed" in result.detail and "cargador de NOPAL: 1 rutas" in result.detail
    assert result.ref == "main" and len(result.sha) == 40 and result.version == "1.0.0"


def test_type_a_failing_test_is_compat(tmp_path):
    result = check(tmp_path, plugin_a(tmp_path, test=TEST_FAIL), "plugin-a")
    assert result.status == compat.COMPAT and result.detail == "falló su suite de tests"
    assert "API incompatible" in result.output


def test_type_c_pass_with_real_loader(tmp_path):
    result = check(tmp_path, plugin_c(tmp_path), "plugin-c")
    assert result.status == compat.PASS and result.kind == "C"
    assert result.detail == "cargador de NOPAL: 1 rutas"


def test_type_c_broken_router_is_compat(tmp_path):
    result = check(tmp_path, plugin_c(tmp_path, router=ROUTER_BROKEN), "plugin-c")
    assert result.status == compat.COMPAT and "cargador" in result.detail
    assert "modulo_que_no_existe" in result.output


def test_type_d_is_not_applicable(tmp_path):
    result = check(tmp_path, plugin_d(tmp_path), "plugin-d")
    assert result.status == compat.NA and result.kind == "D" and "solo frontend" in result.detail


def test_plugin_requiring_newer_python_is_not_applicable(tmp_path):
    """matriz-led declara python_requires ">=3.10": en el job de 3.9 es N/A
    (NOPAL no lo instala ni lo carga ahí), no COMPAT."""
    data = json.loads(manifest("plugin-py"))
    data["python_requires"] = ">=99.0"
    repo = make_repo(tmp_path, "plugin-py", {compat.MANIFEST: json.dumps(data), "backend/router.py": ROUTER_BROKEN,
                                             "tests/test_plugin.py": TEST_FAIL})
    result = check(tmp_path, repo, "plugin-py")
    assert result.status == compat.NA and "python_requires >=99.0" in result.detail
    assert "requiere Python 99.0" in result.detail


def test_unreachable_repo_is_infra_not_compat(tmp_path):
    result = check(tmp_path, str(tmp_path / "no-existe"), "caido")
    assert result.status == compat.INFRA
    assert f"tras {compat.CLONE_ATTEMPTS} intentos" in result.detail and result.sha == ""


def test_missing_environment_tool_is_infra(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, "plugin-t", {compat.MANIFEST: manifest("plugin-t", backend=False),
                                            "tests/test_contrato.py": TEST_NODE})
    monkeypatch.setattr(compat.shutil, "which", lambda tool: None)
    result = check(tmp_path, repo, "plugin-t")
    assert result.status == compat.INFRA and "node" in result.detail


def test_tool_required_by_backend_is_detected(tmp_path):
    """Caso real: camera-viewer llama a ffmpeg desde su backend; sin ffmpeg en
    el entorno un test suyo falla, y eso no es incompatibilidad del plugin."""
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "timelapse.py").write_text('FFMPEG_BIN = "ffmpeg"\n')
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_contrato.py").write_text(TEST_NODE)
    assert compat.required_tools(tmp_path) == ["ffmpeg", "node"]


def test_corrupt_manifest_is_compat(tmp_path):
    repo = make_repo(tmp_path, "roto", {compat.MANIFEST: "{no es json", "frontend/x.js": "1;"})
    assert check(tmp_path, repo, "roto").status == compat.COMPAT


# ── Reintentos ──

def test_clone_retries_then_succeeds(tmp_path):
    calls, sleeps = [], []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0 if len(calls) == 3 else 128, "", "fatal: unable to access")

    assert compat.clone("https://x/a.git", tmp_path / "a", run=run, sleep=sleeps.append) is None
    assert len(calls) == 3 and sleeps == list(compat.RETRY_DELAYS)
    assert calls[0][:5] == ["git", "clone", "--quiet", "--depth", "1"]  # rama por defecto, sin ref fija


def test_clone_gives_up_after_three_attempts(tmp_path):
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        raise subprocess.TimeoutExpired(cmd, compat.CLONE_TIMEOUT)

    error = compat.clone("https://x/a.git", tmp_path / "a", run=run, sleep=lambda s: None)
    assert len(calls) == compat.CLONE_ATTEMPTS and "tiempo agotado" in error


# ── Código de salida y resumen ──

def test_exit_code_and_summary(tmp_path, monkeypatch):
    summary_file = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    ok = write_catalog(tmp_path, [{"id": "plugin-c", "repo_url": plugin_c(tmp_path)},
                                  {"id": "plugin-d", "repo_url": plugin_d(tmp_path)},
                                  {"id": "caido", "repo_url": str(tmp_path / "no-existe")}])

    assert compat.main(["--catalog", str(ok), "--workdir", str(tmp_path / "w1")], sleep=lambda s: None) == 0
    text = summary_file.read_text(encoding="utf-8")
    assert "## NOPAL Plugins — Python" in text
    assert "| plugin-c | C | main |" in text and "✅ PASS" in text
    assert "➖ N/A" in text and "⚠️ INFRA" in text and "INFRA no es incompatibilidad" in text

    bad = write_catalog(tmp_path, [{"id": "plugin-a", "repo_url": plugin_a(tmp_path, test=TEST_FAIL)}])
    assert compat.main(["--catalog", str(bad), "--workdir", str(tmp_path / "w2")], sleep=lambda s: None) == 1
    assert "❌ COMPAT" in summary_file.read_text(encoding="utf-8")


def test_empty_catalog_fails(tmp_path):
    empty = write_catalog(tmp_path, [{"id": "pronto", "repo_url": None}])
    assert compat.main(["--catalog", str(empty), "--workdir", str(tmp_path / "w")]) == 1


def test_render_summary_shows_sha_ref_and_compat_detail():
    results = [compat.Result("x", "https://x/x.git", kind="A", ref="master", sha="a" * 40, version="2.0",
                             status=compat.COMPAT, detail="falló su suite de tests", output="E   SyntaxError"),
               compat.Result("y", "https://x/y.git", status=compat.INFRA, detail="no se pudo clonar")]
    text = compat.render_summary(results, "3.9.25")
    assert "Python 3.9.25" in text and "| x | A | master | `aaaaaaa` | 2.0 | ❌ COMPAT |" in text
    assert "<details><summary>❌ x @ aaaaaaa" in text and "E   SyntaxError" in text
    assert "`y` (https://x/y.git)" in text
