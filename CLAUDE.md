# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NOPAL: a self-hosted FastAPI dashboard that unifies 3D printer control (Klipper/Moonraker, standalone Marlin, Bambu Lab, Elegoo, FlashForge), GRBL laser cutter control, and a 3D model/G-code library in one app. No external database — persistent state is flat JSON files at the repo root (`*_registry.json`, `pricing_config.json`, `quotes_registry.json`, `temperature_presets.json`, `auth_users.json`, etc.), all gitignored (they're per-installation state, not source).

## Commands

```bash
# Setup
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # includes requirements.txt + pytest/httpx

# Run dev server
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8420

# Tests (pytest.ini sets testpaths=backend/tests, asyncio_mode=auto)
pytest
pytest backend/tests/test_marlin_driver.py
pytest backend/tests/test_marlin_driver.py::test_some_case -v

# Plugin tests live inside each plugin repo, run separately:
pytest plugins/arduino-accessories/tests
pytest plugins/camera-viewer/tests
```

There is no build step (no bundler/JSX) and no linter config in the repo — don't introduce one unprompted. CI (`.github/workflows/smoke-test.yml`) only boots the server and checks the homepage renders; it does not run pytest.

## Architecture

### Entry point and dead files

`backend/main.py` is the real app: FastAPI instance, middleware, router registration, startup hooks (session secret, event-loop capture for serial threads, scheduled-print loop, dynamic plugin loading). **`backend/app.py`, `backend/routes.py`, and `backend/database.py` are empty — do not add code to them or import from them expecting content.**

### `api/` + `services/` pairing

Each feature area is a pair: `backend/api/<name>.py` (thin `APIRouter`, request/response handling) calling into `backend/services/<name>_service.py` (business logic, persistence, external I/O). Follow this split for anything new rather than putting logic in the router.

### Multiple printer brands are parallel, independent modules — not a shared abstraction

Klipper/Moonraker (`klipper_service.py`), standalone Marlin (`marlin_printer_service.py`), Bambu Lab (`bambu_service.py`), Elegoo (`elegoo_service.py`), and FlashForge (`flashforge_service.py`) each have their own service, API router, and `*_printer_registry.json`. This is deliberate, not duplication to clean up: each brand's transport is fundamentally different —

- **Klipper**: REST polling against Moonraker.
- **Marlin standalone**: USB serial or a TCP bridge via an MKS WiFi module (`mks_wifi_transport.py`), both going through the shared `marlin_driver.py` and a common command spooler.
- **Bambu**: MQTT-over-TLS (the printer is the broker) via `paho-mqtt`, which is thread-based, not asyncio — callbacks run on paho's own thread and write into a lock-protected module cache rather than being forced into the event loop.
- **Elegoo**: SDCP protocol over a persistent `websockets` connection; the printer pushes status changes, so there's no polling once connected.
- **FlashForge**: plain HTTP REST request/response (like Klipper's polling model), no persistent connection.

When adding a brand or touching one, match its existing transport pattern rather than trying to unify them. Status-code/state mappings that came from observing real hardware (e.g. Elegoo's `PrintInfo.Status` codes) are documented in each service's module docstring — unmapped values fall back to `"unknown"` rather than being guessed; keep that convention.

`backend/services/printer_profiles.py` is a separate, static catalog of per-model capabilities (build volume, board variants, extruder limits) — metadata for the UI, not live printer state.

### Laser (GRBL) service

`laser_service.py` handles both network (ESP3D-style WiFi, HTTP+WebSocket) and USB/serial GRBL boards independently and concurrently, each laser with its own connection/job state. Streams G-code with a character-counting buffered protocol (keeps GRBL's planner fed instead of stalling). USB device identity is resolved by stable physical location, not `/dev/ttyUSBx` (which renumbers on replug/reboot) — see `_resolve_usb_location`.

### Auth

Session-based via Starlette `SessionMiddleware` (secret persisted to `.session_secret` on disk so `--reload` doesn't kill every session). Two flat roles, no hierarchy: `admin` and `operador` (see `backend/services/auth_service.py::ROLES` — the operator role's internal name is the Spanish word, not `operator`). Use `require_auth` / `require_role("admin")` from `backend/auth_deps.py` as FastAPI dependencies; the role is re-read from the user store on every request (not trusted from the session cookie) so a demotion/deletion takes effect immediately.

### Plugin system

Plugins (`arduino-accessories`, `camera-viewer`, `cotizador`) are **separate git repositories**, cloned into `plugins/<id>/` (gitignored — NOPAL core only tracks a curated catalog) by `plugin_installer_service.py`. Each plugin has a `nopal-plugin.json` manifest declaring `backend.entry` (e.g. `backend/router.py`) and a `frontend/` bundle. `plugin_loader_service.py` dynamically imports the backend entry at app startup and registers its `router` — a broken plugin logs a warning and is skipped, never blocks NOPAL's own startup. Plugins are loaded under a synthetic `nopal_plugins` namespace package so relative imports inside a plugin work the same way `backend/api/*.py` importing `backend/services/*.py` does. Installed/enabled state lives in `data/plugins/installed.json`, deliberately in the service layer (not `api/plugins.py`) so the loader can read it before any router exists.

Frontend code for a plugin never touches NOPAL core's `templates/`/`static/` — plugin JS/CSS is served from `/plugins-static/<id>/frontend/...` and injected separately (see `plugin_loader_service.py` / the plugin gallery in Settings).

### Arduino accessory firmware

The `.ino` sketches live in the **`arduino-accessories` plugin repo**, not in NOPAL core: `plugins/arduino-accessories/firmware/`. Core used to carry a `firmware/nopal_accessory/` copy too; it was removed because the sketches and the plugin's driver logic are the same feature and had drifted apart. Real embedded C++ — no arduino-cli/platformio is available in this environment, so nothing here compiles or flashes; that happens on the user's Windows machine.

Layout, one folder per physical board (Arduino requires the `.ino` basename to match its folder):

- `firmware/nopal_accessory/` — the "FF" full firmware. One sketch for **both** ESP32 and ESP8266; it reports `board` as `esp32_generic_ff` / `esp8266_generic_ff` so the backend can tell the variants apart.
- `firmware/nopal_tcall_sim800l/` — the AM-036 / T-Call SIM800L board (`utilities.h` holds its real pin map).
- `firmware/legacy/` — superseded single-board sketches, kept for reference only. Nothing flashes these.

Two headers are shared verbatim by both live sketches and **must stay byte-identical between the folders** (they're copies, not a shared include path — the Arduino IDE compiles each sketch folder on its own):

- `nopal_cluster.h` — UDP discovery + leader election + heartbeat/failover. Opt-in via `NOPAL_CLUSTER_ENABLE`.
- `nopal_power.h` — MAX17048 battery gauge over I2C, serving `GET /api/power`. Opt-in via `NOPAL_POWER_MONITOR_ENABLE`.

Both are off by default and become no-ops when disabled. Per-board configuration (enable flags, pins, calibration offsets, credentials) lives in each board's `secrets.h`, which is never committed — only `secrets.h.example` is. See the `arduino` subagent for this area.

### Frontend

Server-rendered single page (`backend/templates/index.html`) + vanilla JS (`backend/static/js/app.js`, no build step, no bundler/JSX) + one ~10k-line stylesheet (`style.css`). Three.js (vendored, `three.min.js`/`STLLoader.js`/`3MFLoader.js`) renders model/G-code previews. Theming is a class on `<body>` (`dark`/`green`/`red`/`custom`, light is the classless default) that redefines a fixed set of CSS custom properties — never hardcode colors in new UI. i18n: `translations.js` is the canonical English-sourced catalog; `translations-{de,fr,pt-BR}.js` are machine-generated by `scripts/generate_i18n.py` (`es`/`en` live directly in `translations.js`) — don't hand-edit the generated language files. See the `ui-frontend` subagent for this area; it owns `index.html`/`style.css`/`app.js`/`translations.js` specifically.

### Testing gotcha: registry isolation

`backend/tests/conftest.py` has an `autouse=True` fixture (`isolated_printer_registries`) that monkeypatches every brand's `REGISTRY_PATH` (and the plugin installer's `PLUGINS_DIR`/`INSTALLED_FILE`) to a tmp dir, because forgetting this once already corrupted a real registry in the repo. **If you add a new printer brand or any other module with a module-level `REGISTRY_PATH`-style constant backed by a JSON file, add it to this fixture** — it's not optional per-test opt-in.

### Language convention

User-facing strings, code comments, and log messages are Mexican Spanish (es-MX) throughout the backend and firmware — no Spain regionalisms. Code identifiers (variables, functions) stay in English as in the rest of the codebase.

### Subagents

`.claude/agents/arduino.md` and `.claude/agents/ui-frontend.md` define scoped subagents for the Arduino accessory system and the dashboard frontend respectively — prefer delegating work squarely in their described scope to them.
