# HemlockOS — Pinned audit viewport convention (2026-08-22)

## Why

Live-server detector audits (`node ~/.hermes/skills/impeccable/scripts/detect.mjs --json`)
produced drifting counts across runs: **190 → 197 → 226 findings** for the same surface.
The critique archive flagged this as partly viewport-dependent noise
(`.impeccable/critique/2026-08-22T02-43-18Z__dream-chat-src-main-jsx.md`, "Detector count
drift between runs is partly viewport-dependent noise").

## Convention

All future live-server detector audits run at exactly:

```
viewport: 1240 x 820
```

This is the `desktop_viewport` already checked in Electron (state.yaml `gui.ui_overhaul`),
so it matches what users actually see.

## How

When driving headless Chrome over CDP for an audit, set before page load:

```
Emulation.setDeviceMetricsOverride { width: 1240, height: 820, deviceScaleFactor: 1, mobile: false }
```

Record the viewport in any critique snapshot's frontmatter so like-for-like comparison is
possible later. Counts from other viewports are not comparable and should say so.

## Scope

Applies only to *count comparisons* between runs. Individual rule findings are still valid
at any size; the pin exists to make trend lines (e.g. the 17 → 36/40 heuristic trend and
finding-count baselines) trustworthy.
