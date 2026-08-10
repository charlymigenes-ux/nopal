# Security Policy

NOPAL controls real hardware — printers, lasers, CNC routers, and relays/sensors through its automation plugins. A security issue here isn't just data exposure, it can mean someone remotely triggering a machine. Please report responsibly.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead:

1. Go to the [Security tab](https://github.com/charlymigenes-ux/nopal/security) of this repository.
2. Click **"Report a vulnerability"** to open a private advisory.

This reaches the maintainer directly without exposing the issue publicly while it's being fixed.

## What to include

- The affected component (e.g. a specific machine driver, the plugin loader, the web API, TUNA-Screen's device auth).
- Steps to reproduce, or a proof of concept.
- What an attacker could actually do with it (read data, control a machine, pivot to the host, etc.) — this helps prioritize.

## Supported versions

NOPAL is pre-1.0 and moving quickly; security fixes target the latest release on `main`. There's no long-term-support branch yet.

## Response

There's no formal SLA yet (small project, one maintainer) — but reports are taken seriously and acknowledged as soon as possible.
