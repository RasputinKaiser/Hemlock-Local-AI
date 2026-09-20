---
name: HemlockOS
description: A local-first AI workstation styled as a warm, botanical control room — night-forest chrome around paper-light work surfaces.
colors:
  night: "#071d18"
  night-deep: "#04110e"
  evergreen: "#0d3b2d"
  evergreen-light: "#1d6149"
  leaf: "#8eb889"
  moss: "#b7caa5"
  gold: "#dfb45f"
  gold-bright: "#f0cf87"
  paper: "#f5f0e3"
  paper-warm: "#ebe4d3"
  ink: "#1b3029"
  muted-ink: "#728174"
  violet: "#9c9fe4"
  red: "#e49377"
typography:
  display:
    fontFamily: "Newsreader, Georgia, serif"
    fontWeight: 500
  body:
    fontFamily: "DM Sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontWeight: 400
  label:
    fontFamily: "DM Mono, monospace"
    fontWeight: 500
    letterSpacing: "0.06em-0.12em"
    textTransform: uppercase
rounded:
  xs: "3px"
  sm: "5px"
  md: "7px"
  lg: "9px"
  xl: "11px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
components:
  status-lamp:
    textColor: "{colors.moss}"
    backgroundColor: transparent
  primary-action:
    backgroundColor: "{colors.evergreen}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
---

# Design System: HemlockOS

## Overview

**Creative North Star: "The Night Forest Control Room."**

HemlockOS is a two-world system. The **chrome** — system bar, desktop strip, dock — is a deep night forest: near-black evergreen gradients, faint gold starlight stippling, ambient branch arcs, moss-green labels. The **work surfaces** that float above it are warm paper: cream panels (#fffdf6 family) with botanical-green ink, thin sage borders, and gold accents. The contrast is the identity — you work on paper in a forest at night. Density is high but disciplined: every block carries an uppercase DM Mono kicker label, and detail collapses behind honest summaries rather than disappearing.

**Key Characteristics:**
- Two-world contrast: dark evergreen chrome, warm paper surfaces
- DM Mono uppercase kicker labels on every block (7-10px, letter-spaced)
- Newsreader serif for display headings; DM Sans for body
- Gold (#dfb45f) as the single accent — status, focus, highlights
- Thin 1px sage borders, small radii (3-11px), near-flat with soft ambient shadows
- Status conveyed by colored lamp dots (ready/working/down), never color alone in text

## Colors

The palette is a botanical night: deep evergreens and near-blacks hold the chrome, warm papers hold the work, and gold is the only voice that raises itself.

### Primary
- **Evergreen Ink** (#2e4e38 / #31543b): headings and primary text on paper surfaces; primary action buttons.
- **Night Chrome** (#071d18 → #04110e): app background gradient; system bar at rgba(4,17,14,.86) with blur.

### Secondary
- **Lamplight Gold** (#dfb45f, bright #f0cf87): the accent — brand chip, focus outlines, working-state lamps, gold kicker labels, highlights. Used sparingly; its rarity is the point.

### Tertiary
- **Sage Leaf** (#8eb889) and **Moss** (#b7caa5): chrome labels, borders, secondary text on dark; sage-tinted borders (#c7d6c1, #dce3d6) on paper.
- **Violet** (#9c9fe4): reserved for Dream/training metrics only.
- **Ember Red** (#e49377): down/error states and alert banners only.

### Neutral
- **Warm Paper** (#fffdf6, #fffdf5, #fffefa): work-surface panels.
- **Parchment** (#f5f0e3, #ebe4d3): secondary panels, inputs, chrome-adjacent surfaces.
- **Ink** (#1b3029): body text on paper. **Muted Ink** (#728174): secondary text, timestamps.

### Named Rules
**The Lamplight Rule.** Gold marks attention: focus, working state, brand, and highlights — never large fills. If gold covers more than ~10% of a view, it has stopped being light.
**The Two Worlds Rule.** Dark chrome never bleeds into paper surfaces and vice versa; a panel is either night (translucent evergreen, blur) or paper (opaque cream), never a mid-tone blend.

## Typography

**Display Font:** Newsreader (Georgia fallback) — serif, 400/500
**Body Font:** DM Sans (system fallbacks) — 400-700
**Label/Mono Font:** DM Mono — 400/500, the metadata voice

**Character:** A naturalist's field journal set in a terminal — serif headings give warmth and literary calm; DM Mono labels give instrument-panel precision.

### Hierarchy
- **Display** (Newsreader 500, 16-28px): window headings, thread titles, hero statements.
- **Title** (DM Sans 600, 13-14px): card headings, strong labels inside paper panels.
- **Body** (DM Sans 400, 11-13px, line-height 1.45): conversation text, copy.
- **Label** (DM Mono 500, 7-10px, letter-spacing .06-.12em, uppercase): kickers, metadata, timestamps, status text. The dominant type voice by count.

### Named Rules
**The Kicker Rule.** Every content block opens with an uppercase DM Mono kicker label. If a block has no kicker, it hasn't been finished.

## Layout

Floating-window workspace: draggable paper panels over the night background, managed by a 58px system bar (brand · context · health) and a 76px icon dock at the bottom. Inside panels, content flows in a single column with generous 20-23px side padding; rails and grids (live-task-grid, sips metrics) split at roughly 2:1. Spacing steps are tight (4/8/12/20) — density comes from typography scale, not cramped boxes.

## Elevation & Depth

Near-flat. Depth is conveyed by layering (chrome z-20, windows z-10, panels stacked inside) and hairline borders, with soft ambient shadows only on floating elements: `0 4px 12px rgba(48,76,55,.05)` for bars, `0 15px 35px rgba(34,57,42,.17)` for popovers. Dark chrome uses inset 1px light borders and blur instead of shadow.

### Shadow Vocabulary
- **Bar shadow** (`0 4px 12px rgba(48,76,55,.05)`): thread bar, docked bars.
- **Popover shadow** (`0 15px 35px rgba(34,57,42,.17)`): anything floating over a panel.

## Shapes

Small, quiet radii: 3-5px for chips and inline elements, 7-9px for cards and inputs, 10-11px for panels and the compose bar. 1px borders everywhere in sage (#c4d3bf, #c7d6c1) on paper or translucent light lines on dark. No large radii, no pill shapes except circular lamp dots.

## Components

### Buttons
- **Shape:** 6-8px radius, compact padding (6-12px).
- **Primary:** Evergreen (#2e4e38/#31543b) fill, Paper text, DM Mono or DM Sans 11-12px.
- **Quiet/Secondary:** transparent on paper with 1px sage border; hover fills #eef5ea.
- **Focus:** 2px solid #f0cf87 outline, 3px offset — the gold focus ring is global.

### Status Lamps
- 7px dot with a 3px tinted halo; ready = green (#8fcf92), working = gold (pulsing 1.4s), down = ember red. Always paired with an uppercase DM Mono label.

### Cards / Containers
- Paper fill (#fffdf6), 1px sage border, 8-10px radius, 9-12px internal padding, kicker label top-left.

### Inputs / Fields
- Paper-warm fill (#fffdf6 on #f5f0e3 contexts), 1px #b7cbb4 border, 6px radius; focus shifts border to gold via the global focus ring.

### Navigation
- Dock: 76px bottom bar, icon buttons with tiny uppercase DM Mono captions; active state gold-tinted. System bar links are moss-colored mono text with gold strong highlights.

### Signature: The Receipt Block
Every consequential action renders as an evidence/trace row — kicker label, mono summary, timestamp — collapsible via `<details>`. This pattern (summary line hiding exact envelopes) is the system's signature move.

## Do's and Don'ts

### Do:
- **Do** open every block with an uppercase DM Mono kicker (7-10px, letter-spaced).
- **Do** keep gold for attention only: focus rings, working lamps, brand, highlights.
- **Do** use Newsreader for anything display-scale; DM Mono for anything machine-scale.
- **Do** collapse detail behind `<details>` with honest summaries.

### Don't:
- **Don't** use pure black or pure white; ink is #1b3029, paper is #fffdf6.
- **Don't** mix dark-chrome styling into paper panels or vice versa.
- **Don't** set essential text below 9px (7-8px is reserved for decorative kickers only).
- **Don't** introduce new accent hues; violet and red are reserved (Dream metrics, errors).
