# Supabase Design System Specification (DESIGN.md)

This document specifies the design tokens, component architecture, and styling rules for the v2 user interface of the `live-smarthome-agent`. It is modeled directly after Supabase's developer-first, dark-mode-native aesthetic.

---

## 1. Visual Theme & Atmosphere
- **Aesthetic**: Developer-centric, high-precision code editor ambiance.
- **Backgrounds**: Deep, layered near-blacks and charcoals (`#0c0c0d`, `#121214`, `#17171a`).
- **Brand Accent**: Supabase PostgreSQL Emerald (`#3ecf8e`, `#24b47e`).
- **Surfaces**: Translucent card surfaces with subtle backdrop blur, hairline borders, and zero heavy drop shadows.

---

## 2. Color Tokens

### Backgrounds & Surfaces
- `--bg-canvas`: `#0c0c0d` (Deepest canvas background)
- `--bg-surface-1`: `#121214` (Panels, sidebar, topbar)
- `--bg-surface-2`: `#17171a` (Cards, inner containers)
- `--bg-surface-3`: `#1f1f23` (Input fields, active card states, code containers)
- `--bg-overlay`: `rgba(12, 12, 13, 0.85)` (Modal backdrops, translucent overlays)

### Borders & Dividers
- `--border-subtle`: `rgba(255, 255, 255, 0.07)` (Standard hairline border for cards)
- `--border-default`: `rgba(255, 255, 255, 0.12)` (Divider lines, input borders)
- `--border-hover`: `rgba(255, 255, 255, 0.22)` (Hover borders)
- `--border-accent`: `rgba(62, 207, 142, 0.45)` (Focused inputs, active states)

### Brand & Accents
- `--brand-emerald`: `#3ecf8e` (Primary brand color, active indicators, highlights)
- `--brand-emerald-hover`: `#2ebd7b` (Button hover, active lift)
- `--brand-emerald-dark`: `#133827` (Pill backgrounds, badge fills)
- `--brand-emerald-glow`: `0 0 24px rgba(62, 207, 142, 0.25)`

### Semantic Statuses
- `--status-success`: `#3ecf8e` (Online, active, locked, normal)
- `--status-warning`: `#f5a623` (Offline, private mode, caution)
- `--status-error`: `#f75555` (Disconnected, error, failure)
- `--status-info`: `#60a5fa` (Informational, sync, camera feed)

### Typography / Text
- `--text-strong`: `#f4f4f5` (Headings, primary values, titles)
- `--text-default`: `#d4d4d8` (Body text, standard labels)
- `--text-muted`: `#a1a1aa` (Subtitles, helper text, timestamps)
- `--text-faint`: `#52525b` (Placeholders, inactive tabs, dividers)

---

## 3. Typography
- **Primary Font**: `Inter`, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
- **Monospace Font**: "JetBrains Mono", "Fira Code", "Source Code Pro", monospace
- **Line Heights**: Compact vertical rhythm (`1.15` for display, `1.4` for body, `1.3` for code).
- **Letter Spacing**: `-0.015em` for display titles; `+0.05em` with uppercase for technical telemetry labels.

---

## 4. Radii & Spacing
- **Border Radius**:
  - `sm` (4px): Badges, tool tags, inner buttons
  - `md` (6px): Form inputs, action buttons, select dropdowns
  - `lg` (10px): Dashboard cards, telemetry panels, modals
  - `xl` (14px): Outer layout containers
  - `pill` (9999px): Toggle buttons, status pills
- **Grid & Spacing**:
  - Base unit: 4px / 8px grid (`8px`, `12px`, `16px`, `24px`, `32px`).

---

## 5. Component Patterns
- **Header / Navigation**: Sticky topbar with Supabase emerald branding, breadcrumb navigation, live status indicators, and a 1-click v1/v2 version switch.
- **Voice Agent Console**:
  - Emerald glowing pulse ring / audio visualizer for Gemini Live interaction.
  - Live transcription cards with distinct user (`text-muted`) and agent (`brand-emerald`) styling.
  - Clean monospace command/chat input box.
- **Smart Infrastructure Dashboard**:
  - Device grid with categorized cards: Climate (AC), Lighting, Security (Locks), Surveillance (Cameras).
  - Micro-toggles and mode selectors styled with emerald active state.
- **Terminal Tool Execution Feed**:
  - Dark monospace log panel streaming tool invocations (`get_smart_home_devices_info`, `control_airconditioner`, `check_camera`) in real time with syntax badges.
- **Camera Inspection Modal**:
  - Translucent backdrop, framed high-res camera capture, and Gemini Multimodal vision report.
