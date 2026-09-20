# HemlockOS — Understory Mode (night variant) Plan

**Goal:** Ship "understory mode" — a dimmed night variant of HemlockOS's warm paper surfaces,
designed for the owner's documented night-owl usage (dark room, 2am sessions). One toggle in
the system bar, persisted across restarts.

## Why

Night-owl critique (2026-08-22T02:43Z) identified the one real night-gap: at 2am in a dark
room, `#fffdf6`/`#f5f0e3` panels glow harder than they need to. A ~12-18% dimming of paper
tokens, keeping every hue relationship intact, is the fix. The brand stays: this is the same
world with the lamps turned down, not a dark theme.

## Design contract (binding)

1. **Token-driven only.** All surface colors flow from CSS custom properties on `:root`.
   Understory mode = a `.understory` class on `<html>` or `.hemlock-os` that overrides ONLY
   custom properties (paper family dimmed toward #ece5d2/#e3dbc6, shadows deepened slightly).
   No per-rule hex edits scattered through styles.css.
2. **Hue relationships preserved.** Ink stays evergreen, gold stays gold, sage stays sage.
   Dim the ground the light falls on, not the light itself. Contrast must stay ≥4.5:1 for
   text on dimmed paper (dimming paper RAISES contrast with dark ink — safe direction).
3. **Toggle:** small lamp icon button in the system bar next to SIPS chip. aria-label
   "Toggle understory mode", aria-pressed state, persists via localStorage
   (`hemlock-understory-v1`). Applies before first paint where possible (inline script or
   early useEffect) to avoid a flash of bright paper.
4. **Scope guard:** dark-surface elements (workstream rail, dream lab, dock) are already dark —
   they may stay untouched except where they sit ON dimmed paper.

## Work split

- **Subagent (renderer lane):** all of `dream-chat/src/`. Token audit + understory overrides +
  toggle UI + persistence. Tests green, esbuild clean. No build/relaunch.
- **Orchestrator (me):** plan file, then after subagent lands: full verification (tests,
  detector, build), visual check of the dimmed surfaces via headless Chrome screenshot,
  integration relaunch.

## Verification

- Both test files green; esbuild clean; static detector clean.
- Headless screenshot in both modes; manual contrast spot-check on dimmed paper (#text ≥4.5:1).
