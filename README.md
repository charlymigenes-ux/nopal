# NOPAL

<table>
  <tr>
    <td><img width="630" alt="NOPAL dashboard" src="docs/images/dashboard.png" /></td>
    <td><img width="630" alt="3D printers panel" src="docs/images/printers.png" /></td>
    <td><img width="630" alt="Laser / CNC panel" src="docs/images/laser-cnc.png" /></td>
  </tr>
  <tr>
    <td><img width="630" alt="Materials (Spoolman) panel" src="docs/images/materials.png" /></td>
    <td><img width="630" alt="Quoting tool" src="docs/images/cotizador.png" /></td>
    <td><img width="630" alt="Camera viewer" src="docs/images/cameras.png" /></td>
  </tr>
  <tr>
    <td><img width="630" alt="Plugin gallery" src="docs/images/plugins.png" /></td>
    <td><img width="630" alt="TUNA-Screen Android app" src="docs/images/tunascreen.png" /></td>
    <td><img width="630" alt="Model / G-code library" src="docs/images/library.png" /></td>
  </tr>
</table>

**Read this in other languages:** [Español](README.es.md)

**NOPAL** is a self-hosted, browser-based control panel that unifies **3D printer management** (Klipper/Moonraker, standalone Marlin, Bambu Lab, Elegoo, FlashForge), **GRBL laser and CNC control**, and a full **3D model / G-code library** in one dashboard — with a **plugin system** for material inventory, job quoting, cameras, and Arduino-based workshop automation, plus **TUNA-Screen**, a companion Android app to control any of it from a tablet or phone. It's built for makers, small print farms, and anyone running a mixed workshop who is tired of juggling Mainsail/Fluidd tabs, brand-specific apps, LightBurn/LaserGRBL windows, and a file explorer at the same time.

---

## Table of Contents

* [Overview](#overview)
* [Features](#features)
* [Architecture](#architecture)
* [Requirements](#requirements)
* [Installation](#installation)
* [Configuration](#configuration)
* [Usage](#usage)
* [Development](#development)
* [Updating](#updating)
* [Uninstall](#uninstall)
* [Roadmap](#roadmap)
* [License](#license)

---

## Overview

NOPAL is designed to solve the problems that show up together in most home/small-shop fabrication setups:

1. **Managing large collections of printable and cuttable files** (STL, 3MF, STEP, G-code) spread across folders and formats.
2. **Monitoring and controlling several 3D printers at once** — across five different brands/protocols — without switching between separate vendor apps.
3. **Controlling GRBL laser cutters/engravers and CNC routers** — over WiFi (ESP3D-style boards) or directly over USB — from the same place, including multiple machines side by side.
4. **Tracking material, cost, and job history** without a spreadsheet on the side, through an optional plugin layer.
5. **Operating the whole shop from a phone or a tablet mounted on a machine**, not just from a desktop browser.

NOPAL brings all of this into one browser-based application: a model/G-code library, a live dashboard for every printer/laser/CNC it detects, per-machine control panels, an installable plugin gallery, and a mobile client — all from a single self-hosted service, no external database required.

---

## Features

### 3D model & G-code library

* Browse and organize printable/cuttable assets: **STL**, **3MF**, **STEP**, **G-code**.
* Folder organization, rename/move/delete, upload from the browser, bulk actions.
* In-browser **3D preview** (Three.js) for models and G-code toolpaths.
* Generate G-code from a model or send a file straight to a printer or the laser/CNC queue.

### Unified dashboard

* Auto-detects local **Moonraker** instances and registered **Marlin, Bambu Lab, Elegoo, FlashForge** printers, plus **GRBL lasers and CNCs** (network + USB), and shows them together, sorted by connection/status.
* Color-coded by machine type and by state, with a quick toggle to hide offline machines.
* Grid or list view, four themes (light, dark, NOPAL Style, and a fully custom theme).

### 3D printer control — five brands, one interface

* **Klipper/Moonraker**: live temperatures with a heat-map color scale, one-click preset heating/cooldown, full toolhead panel (jog, home, motors off, Z-offset babystepping, speed factor), real active print queue with live progress pulled from Moonraker, print history with thumbnails, and macros straight from `printer.cfg`.
* **Standalone Marlin** printers over USB serial or an MKS WiFi bridge, sharing a common command spooler and driver.
* **Bambu Lab** printers over MQTT (the printer acts as the broker).
* **Elegoo** printers over the SDCP WebSocket protocol.
* **FlashForge** printers over their HTTP REST API.

Each brand is its own independent driver — matched to how that hardware actually talks — not a lowest-common-denominator abstraction, so brand-specific features aren't sanded down to fit a generic model.

### Laser and CNC control (GRBL, network + USB)

* Works with **network boards** (ESP3D-style WiFi controllers) and **USB/serial** boards (CH340, CP210x, ESP32-native) — auto-detects USB controllers plugged into the host.
* The same GRBL hardware can be registered and panelled as a **laser** (power/air-assist) or a **CNC router** (spindle/coolant) — NOPAL shows the right controls for the role you assign it.
* Manage **multiple machines simultaneously**, each with its own independent job, connection, and settings.
* Manual jog controls, homing, GRBL ($$) settings editor, live GRBL console.
* Firing control with a deliberate double-click-to-arm safety pattern.
* Reliable G-code streaming using a character-counting buffered protocol (keeps GRBL's motion planner fed instead of stalling between lines).
* SD card browser for boards with onboard storage, job queue with framing (trace the job's bounding box before firing) and multi-copy runs.

### Plugins

NOPAL ships a small core and an installable **plugin gallery** (Configuration → Plugins) for everything else. Each plugin is a separate repository, cloned and loaded on demand:

* **Materials** (Spoolman integration): connects to a Spoolman server to read your real filament inventory, assign an active spool per printer, reserve material for a job, and feed real per-gram costs into the quoting tool.
* **Quoting tool** (Cotizador): estimates the cost of a 3D printing, laser, or CNC job from your own material/machine cost profiles, with global settings (currency, kWh price, margin, labor) and a quote history with printable/PDF output and WhatsApp resend.
* **Cameras**: add camera feeds by MJPEG/ONVIF/URL or a locally connected USB webcam, and watch them live per machine.
* **Workshop automation** (Arduino/ESP32 accessories): map the pins on a generic Arduino/ESP32 board and build per-machine automation scenes (lights, relays, sensors) without third-party WiFi plugs.

More plugins (shape generation, G-code optimization, SVG cleanup, a shared material-parameter library) are in the gallery as "coming soon."

### TUNA-Screen (companion Android app)

A separate Android app (Kotlin + Jetpack Compose) that acts purely as a **remote screen** for NOPAL — it never talks to Klipper/Marlin/GRBL/Bambu/Elegoo/FlashForge directly, only to NOPAL's own API. Pair a phone or tablet with a 6-digit code generated from Configuration → TUNA-Screen, then:

* See every machine's live status in a "workshop" view, updated over a WebSocket.
* Open a single machine's screen for temperatures, job progress, and Home/Pause/Resume/Cancel.
* Mount a cheap tablet directly on a printer as a dedicated status screen for that one machine (kiosk mode).

See the [TUNA-Screen repository](https://github.com/charlymigenes-ux/TUNA-Screen) and [docs/TUNASCREEN_API.md](docs/TUNASCREEN_API.md) for the client-facing API contract.

### Accounts & access

* Session-based login with two roles: **Admin** (manages users, devices, and settings) and **Operator** (operates the machines).
* A role change or account removal takes effect immediately, not just on next login.

### Interface

* Four themes: light, dark, **NOPAL Style** (green, with its own background art), and a fully **custom theme** (pick your own accent/surface/text colors and upload your own background image).
* Adjustable interface text size.
* Bilingual UI (Spanish / English), with community-contributed machine translations for German, French, and Brazilian Portuguese.
* In-app **Help** section with a quick guide to every part of the app.

### Self-hosted deployment

* Designed for Linux environments commonly used with Klipper.
* Installs and runs as a **systemd service**.
* Suitable for **Raspberry Pi OS**, **Debian**, **Ubuntu**, and similar distributions — including the Linux boards bundled inside some 3D printers.

---

## Architecture

NOPAL is a lightweight self-hosted web application, no external database required — persistent state is flat JSON files.

### Main components

* **Backend**: Python (FastAPI) served with **Uvicorn**.
* **Frontend**: server-rendered HTML + vanilla JS, no build step; 3D/G-code preview via Three.js.
* **Printer drivers**: five independent integrations (Klipper/Moonraker REST polling, Marlin over USB/MKS-WiFi, Bambu over MQTT, Elegoo over SDCP WebSocket, FlashForge over HTTP REST) — matched to each brand's real transport, not unified behind a shared abstraction.
* **Laser/CNC integration**: HTTP + WebSocket for network (ESP3D-style) boards, direct serial (pyserial) for USB boards, with per-host connection and job state so several machines run truly independently at the same time.
* **Plugin system**: plugins are separate git repositories cloned into `plugins/<id>/` and loaded dynamically at startup; a broken plugin logs a warning instead of blocking NOPAL.
* **TUNA-Screen API**: a versioned, unified `/api/tunascreen/*` REST surface + a `/ws/tunascreen` WebSocket that normalizes every machine (regardless of brand) to a common set of capabilities/actions for the Android client.

### High-level flow

1. NOPAL scans and indexes supported model/G-code files from the local library.
2. The web UI exposes those assets for browsing, previewing, and sending to a machine.
3. NOPAL discovers local Moonraker instances and registered printers/lasers/CNCs, and opens a connection to each using that brand's own protocol.
4. The dashboard aggregates model, printer, laser/CNC, and plugin state into a single interface, refreshed in near real time — and the same normalized state is what TUNA-Screen consumes over its own API.

---

## Requirements

### Operating system

* Linux
* Recommended: Debian, Ubuntu, or Raspberry Pi OS

### Runtime

* **Python 3.9+**

### Optional but recommended

* A working **Klipper + Moonraker** installation (or a Bambu Lab/Elegoo/FlashForge/standalone Marlin printer) reachable on the network, for 3D printer features.
* A **GRBL-based laser or CNC controller** (network/ESP3D-style or USB/serial) for laser/CNC features.
* A **Spoolman** server on the network, for the Materials plugin.

Nothing above is required to run NOPAL — the model library and UI work on their own; each integration and plugin only activates what it can find.

---

## Installation

Clone the repository and run the installer:

```bash
git clone https://github.com/charlymigenes-ux/nopal.git ~/nopal
cd ~/nopal
./install.sh
```

### What the installer does

1. Installs required system packages (`python3-venv`, `python3-pip`).
2. Creates a Python virtual environment.
3. Installs Python dependencies from `requirements.txt`.
4. Registers and starts a `systemd` service (`nopal.service`) so NOPAL starts automatically on boot.

After installation, NOPAL is available at:

```text
http://<your-machine-ip>:8420
```

The first time you open it, you'll be asked to create the initial **Admin** account.

---

## Configuration

NOPAL is designed to work out of the box in a local, self-hosted environment — there's no config file to hand-edit for basic use:

* The model library lives under the app's `uploads/` folder.
* Moonraker instances are auto-discovered on the local host; other printer brands, lasers, and CNCs are registered from the UI.
* Plugins are installed and enabled from Configuration → Plugins.
* TUNA-Screen pairing codes are generated from Configuration → TUNA-Screen (Admin only).
* UI preferences (theme, language, interface size) are stored per-browser.

Access is controlled by NOPAL's own Admin/Operator login. If you plan to expose NOPAL beyond your local network, still put it behind a reverse proxy such as **Nginx** or **Caddy** for TLS.

---

## Usage

Once the service is running, open the NOPAL web interface from a browser on your local network.

### Typical workflow

1. Open the dashboard and check the status of every printer, laser, and CNC at a glance.
2. Browse your model library, preview a model in 3D, and generate or pick its G-code.
3. Send the job to a printer, or add it to the laser/CNC queue and send it to the machine you want.
4. Watch live temperatures, toolhead position, or laser/CNC position/feed while the job runs.
5. Quote the job's cost, track the material it used, and check the camera feed — if those plugins are installed.
6. Check the same status, or act on a job, from TUNA-Screen on a phone or a tablet mounted on the machine.

### Example use cases

* Managing a shared library of printable and laser/CNC-ready files.
* Monitoring and controlling a mixed fleet of Klipper, Bambu Lab, Elegoo, FlashForge, and standalone Marlin printers from one dashboard.
* Running a laser cutter and a CNC router alongside 3D printers without a separate app for each.
* Quoting a job and tracking real filament cost through Spoolman before you commit to printing it.
* Mounting a small tablet on a printer as its dedicated status screen via TUNA-Screen.
* Building a small, self-hosted control panel for a home workshop or a small print farm.

---

## Development

To run NOPAL locally in development mode:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8420
```

Then open:

```text
http://localhost:8420
```

### Suggested development workflow

* Use a Python virtual environment for local work.
* Keep at least one printer brand and/or a GRBL board reachable locally if you're testing printer or laser/CNC integration.
* Run with `--reload` during development for faster iteration.
* `pytest` runs the backend test suite (`pytest.ini` points it at `backend/tests`); plugin tests live inside each plugin's own repository under `plugins/<id>/tests`.

---

## Updating

To update an existing installation:

```bash
cd ~/nopal
git pull
./install.sh
sudo systemctl restart nopal
```

---

## Uninstall

To remove NOPAL from the system:

```bash
sudo systemctl disable --now nopal
sudo rm /etc/systemd/system/nopal.service
sudo systemctl daemon-reload
rm -rf ~/nopal
```

---

## Roadmap

Potential future areas for NOPAL include:

* richer metadata for model libraries — tags, collections, and search filters
* better print/laser/CNC job analytics and history
* external storage integration
* mDNS advertising so TUNA-Screen can discover a NOPAL server automatically, without typing an IP
* TUNA-Screen's Advanced Machine mode (temperature graphs, fine jog, console, macros) and a real kiosk/dedicated-screen mode
* discovering the correct SD-card run command for more GRBL/DLC32-style firmware variants (direct-from-SD execution, instead of streaming)

---

## License

This project is licensed under the **GNU General Public License v3.0**. See the [LICENSE](./LICENSE) file for details.
