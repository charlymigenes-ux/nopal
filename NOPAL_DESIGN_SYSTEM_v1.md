# NOPAL Design System v1.0

## Brand Philosophy

NOPAL is an industrial, modern and elegant interface inspired by:

- Mexican identity
- Digital fabrication
- Industrial automation
- Circuit boards
- Clean minimalism

The UI should never feel "gaming" or "RGB". Instead it should communicate precision, reliability and technology.

## Official Themes

NOPAL officially supports four themes.

### 1. NOPAL Green (Default)

**Purpose:** Official brand appearance.

**Palette:**

| Token | Value |
|---|---|
| Background | `#050708` |
| Sidebar | `#0A0D10` |
| Surface | `#11161B` |
| Card | `#171D23` |
| Border | `#2B3542` |
| Accent | `#25D366` |
| Accent Hover | `#31E06F` |
| Accent Active | `#17B754` |
| Primary Text | `#F5F7FA` |
| Secondary Text | `#B7C1CC` |
| Muted | `#7A8795` |
| Disabled | `#5A6674` |

### 2. White Theme

**Purpose:** Bright professional environments.

**Palette:**

| Token | Value |
|---|---|
| Background | `#F7F8FA` |
| Sidebar | `#FFFFFF` |
| Surface | `#F1F4F7` |
| Card | `#FFFFFF` |
| Border | `#D8DEE5` |
| Accent | `#25D366` |
| Primary Text | `#1E293B` |
| Secondary | `#64748B` |

### 3. Black Theme

**Purpose:** OLED displays.

**Palette:**

| Token | Value |
|---|---|
| Background | `#050505` |
| Sidebar | `#0C0C0C` |
| Surface | `#101010` |
| Card | `#181818` |
| Border | `#2F2F2F` |
| Accent | `#25D366` |
| Primary Text | `#FFFFFF` |
| Secondary | `#B8B8B8` |

### 4. Red Theme

**Purpose:** High contrast.

**Palette:**

| Token | Value |
|---|---|
| Background | `#120809` |
| Sidebar | `#1A0C0D` |
| Surface | `#241214` |
| Card | `#2E171A` |
| Border | `#4A2326` |
| Accent | `#E5484D` |
| Primary Text | `#FFFFFF` |
| Secondary | `#D2B8BA` |

## Component Rules

### Background

Always uses `Background`. Never use pure black.

### Sidebar

Always darker than the background. Contains: Logo, Navigation, Settings.

### Cards

Cards must always have:

- Radius: `18px`
- Border: `1px solid Border`
- Shadow: `0 8px 24px rgba(0,0,0,.18)`

### Buttons

| Variant | Uses |
|---|---|
| Primary | Accent |
| Secondary | Surface |
| Danger | Red |
| Disabled | Border |

### Status Colors

| State | Color |
|---|---|
| Online | `#22C55E` |
| Idle | `#9CA3AF` |
| Offline | `#6B7280` |
| Warning | `#F59E0B` |
| Error | `#EF4444` |
| Printing | `#25D366` |
| Paused | `#7B61FF` |

### Dashboard Cards

| Card | Accent |
|---|---|
| Models | Green |
| Storage | Amber |
| Printers | Purple |
| Temperature | Red |
| Memory | Orange |
| CPU | Green |

### Typography

| Role | Weight |
|---|---|
| Headers | 700 |
| Body | 400 |
| Buttons | 600 |

## Brand Rules

These elements **NEVER** change color regardless of theme:

- NOPAL logo
- NOPAL cactus
- Connection indicators
- Progress bars
- Main positive actions

**NOPAL Green (`#25D366`) is the permanent brand color.**

## Claude Instructions

When designing any screen:

- ✓ Respect the selected theme.
- ✓ Preserve spacing.
- ✓ Never invent new colors.
- ✓ Always use the palette defined above.
- ✓ Follow the NOPAL aesthetic: Industrial • Clean • Modern • Minimal • Technological
