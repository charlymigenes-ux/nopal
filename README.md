# NOPAL

<table>
  <tr>
    <td><img width="630" alt="NOPAL dashboard" src="https://github.com/user-attachments/assets/600beacf-157c-4bd1-a5c0-9307415da5d6" /></td>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/6e6f3622-f5bb-4b16-9e23-166a8d663b4f" /></td>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/5463fedf-8814-4b6b-9ec6-96d551ad5b13" /></td>
  </tr>
  <tr>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/b8ac4145-4832-4090-a647-2408e987b2f2" /></td>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/a84b8abf-4958-4f74-a369-c1d8fcaeeaaa" /></td>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/3b90870f-a46d-4b62-8aec-c0ad5387e812" /></td>
  </tr>
  <tr>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/9c682844-5b96-4828-b52c-0bded137b954" /></td>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/a058caab-656c-47b9-91bb-5a50cbe8c393" /></td>
    <td><img width="630" alt="NOPAL screenshot" src="https://github.com/user-attachments/assets/1d1f7ee0-c43a-425a-beaf-339e33201df7" /></td>
  </tr>
</table>

**Read this in other languages:** [Español](README.es.md)

**NOPAL** is a self-hosted, browser-based control panel that unifies **3D printer management (Klipper/Moonraker)** and **GRBL laser cutter/engraver control** in a single dashboard, on top of a full **3D model / G-code library**. It's built for makers, small print farms, and anyone running a mixed 3D-printing + laser workshop who is tired of juggling Mainsail/Fluidd tabs, LightBurn/LaserGRBL windows, and a file explorer at the same time.

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

NOPAL is designed to solve three problems that show up together in most home/small-shop fabrication setups:

1. **Managing large collections of printable and cuttable files** (STL, 3MF, STEP, G-code) spread across folders and formats.
2. **Monitoring and controlling several 3D printers at once**, without switching between separate Mainsail/Fluidd instances.
3. **Controlling GRBL laser cutters/engravers** — over WiFi (ESP3D-style boards) or directly over USB — from the same place, including multiple lasers side by side.

NOPAL brings all three into one browser-based application: a model/G-code library, a live dashboard for every printer and laser it detects, and per-machine control panels (temperatures, toolhead movement, jog/fire controls, job queues) — all from a single self-hosted service.

---

## Features

### 3D model & G-code library

* Browse and organize printable/cuttable assets: **STL**, **3MF**, **STEP**, **G-code**.
* Folder organization, rename/move/delete, upload from the browser.
* In-browser **3D preview** (Three.js) for models and G-code toolpaths.
* Generate G-code from a model or send a file straight to a printer or the laser queue.

### Unified dashboard

* Auto-detects local **Moonraker** instances and registered **GRBL lasers** (network + USB) and shows them together, sorted by connection/status (printing/engraving first, then idle, then offline).
* Color-coded by machine type and by state, with a quick toggle to hide offline machines.
* Grid or list view.
* Quick actions right on the card: cool down / preheat a printer without opening its detail panel.

### 3D printer control (Klipper/Moonraker)

* Live temperatures (bed/extruder) with a heat-map color scale (blue → white → yellow → orange → red).
* One-click preset heating and cooldown, with editable presets.
* **Toolhead panel**: live position, X/Y/Z jog, home (all or per-axis), motors off, Z-offset babystepping, speed factor.
* Real **active print queue**: current file, live progress and estimated remaining time pulled straight from Moonraker — not a placeholder.
* Print history per printer, with thumbnails when available.
* **Macros**: lists whatever is configured in `printer.cfg` and runs them with one tap.

### GRBL laser control (network + USB)

* Works with **network boards** (ESP3D-style WiFi controllers, e.g. common DLC32-based laser boards) and **USB/serial** boards (CH340, CP210x, ESP32-native) — auto-detects USB laser controllers plugged into the host.
* Manage **multiple lasers simultaneously**, each with its own independent job, connection and settings.
* Manual jog controls, homing, GRBL ($$) settings editor.
* Firing control with a deliberate double-click-to-arm safety pattern, plus an air-assist toggle.
* SD card browser (for boards with onboard storage): browse, upload, delete.
* Reliable G-code streaming using a proper character-counting buffered protocol (keeps GRBL's motion planner fed instead of stalling between lines).
* Live GRBL console.
* Job queue with framing (trace the job's bounding box before firing) and multi-copy runs.

### Interface

* Four themes: light, dark, **NOPAL Style** (green, with its own background art), and a fully **custom theme** (pick your own accent/surface/text colors and upload your own background image).
* Adjustable interface text size.
* Bilingual UI (Spanish / English).
* In-app **Help** section with a quick guide to every part of the app and a link back to this repository.

### Self-hosted deployment

* Designed for Linux environments commonly used with Klipper.
* Installs and runs as a **systemd service**.
* Suitable for **Raspberry Pi OS**, **Debian**, **Ubuntu**, and similar distributions.

---

## Architecture

NOPAL is a lightweight self-hosted web application, no external database required.

### Main components

* **Backend**: Python (FastAPI) served with **Uvicorn**.
* **Frontend**: server-rendered HTML + vanilla JS, no build step; 3D/G-code preview via Three.js.
* **Moonraker integration**: REST calls to every detected local Moonraker instance for printer status, temperatures, jobs and G-code commands.
* **GRBL integration**: HTTP + WebSocket for network (ESP3D-style) boards, direct serial (pyserial) for USB boards — with per-host connection and job state, so several machines can run truly independently at the same time.

### High-level flow

1. NOPAL scans and indexes supported model/G-code files from the local library.
2. The web UI exposes those assets for browsing, previewing, and sending to a machine.
3. NOPAL discovers local Moonraker instances and registered GRBL lasers, and opens a persistent connection to each.
4. The dashboard aggregates model, printer, and laser state into a single interface, refreshed in near real time.

---

## Requirements

### Operating system

* Linux
* Recommended: Debian, Ubuntu, or Raspberry Pi OS

### Runtime

* **Python 3.9+**

### Optional but recommended

* A working **Klipper + Moonraker** installation on the same machine (or reachable on the network) for 3D printer features.
* A **GRBL-based laser controller** (network/ESP3D-style or USB/serial) for laser features.

Neither Moonraker nor a laser controller is required to run NOPAL — the model library and UI work on their own; each integration only activates what it can find.

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

---

## Configuration

NOPAL is designed to work out of the box in a local, self-hosted Klipper/GRBL environment — there's no config file to hand-edit for basic use:

* The model library lives under the app's `uploads/` folder.
* Moonraker instances are auto-discovered on the local host.
* GRBL lasers are found by scanning the local network (network boards) and the system's serial ports (USB boards), then registered from the UI.
* UI preferences (theme, language, interface size) are stored per-browser.

If you plan to expose NOPAL beyond your local network, put it behind a reverse proxy such as **Nginx** or **Caddy** and add authentication at that layer — NOPAL itself does not yet ship with built-in auth (see [Roadmap](#roadmap)).

---

## Usage

Once the service is running, open the NOPAL web interface from a browser on your local network.

### Typical workflow

1. Open the dashboard and check the status of every printer and laser at a glance.
2. Browse your model library, preview a model in 3D, and generate or pick its G-code.
3. Send the job to a printer, or add it to the laser queue and send it to the laser you want.
4. Watch live temperatures, toolhead position, or laser position/feed while the job runs.
5. Review recent jobs and print history per machine.

### Example use cases

* Managing a shared library of printable and laser-ready files.
* Monitoring and controlling several Klipper printers from one dashboard.
* Running a laser cutter/engraver alongside 3D printers without a separate app.
* Switching between two or three registered lasers (network + USB) without unplugging anything.
* Building a small, self-hosted control panel for a home workshop or a small print farm.

---

## Development

To run NOPAL locally in development mode:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8420
```

Then open:

```text
http://localhost:8420
```

### Suggested development workflow

* Use a Python virtual environment for local work.
* Keep Moonraker and/or a GRBL board reachable locally if you're testing printer or laser integration.
* Run with `--reload` during development for faster iteration.

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
* better print/laser job analytics and history
* authentication and multi-user access control
* external storage integration
* discovering the correct SD-card run command for more GRBL/DLC32-style firmware variants (direct-from-SD execution, instead of streaming)

---

## License

This project is licensed under the **GNU General Public License v3.0**. See the [LICENSE](./LICENSE) file for details.
