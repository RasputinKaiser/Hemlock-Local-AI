# HemlockOS — Night Shift Improvement Plan

**Goal:** Push past 36/40 toward the detector's ideal while adding the two features with the
highest experiential payoff: a night-friendly surface mode and real utility for the model
working inside the OS. All lanes use disjoint file ownership; orchestrator integrates.

## Backlog basis (from critique archive + audits)

- Detector: ~100 `undersized-ui-text` findings are 9-10px labels (our floor is below its ideal)
- Night-owl lens: paper surfaces glare at 2am in a dark room — no dimmed variant exists
- Primer is Chat-only; Command Center has no teaching surface
- Notification plumbing exists but only covers dream/SIPS — Maple inference itself doesn't ping
- Palette Threads section lists threads but no search/filter for people with many threads
- Glossary tooltips are native-only (invisible on keyboard focus)

## Lanes (disjoint ownership, parallelizable)

### Lane N — Understory Mode (`dream-chat/src/` — styles.css + main.jsx theme slice)

Night-friendly dimmed variant of the app:
1. Add a `data-surface="understory"` attribute toggle on `.hemlock-os` root, persisted in
   localStorage (`hemlock-understory-v1`). Toggle lives in the system bar (small moon/leaf icon
   button, aria-pressed) and via command palette action "Toggle understory mode".
2. CSS custom-property overrides under `.hemlock-os[data-surface="understory"]`: dim paper tokens
   ~15% (#fffdf6 → #efe9da family), soften window shadows slightly darker, keep all contrast
   ratios ≥4.5:1 (verify muted text tokens still pass on dimmed paper — recompute, don't guess).
3. Do NOT touch font sizes or layout. Pure token swap. The dark desktop backdrop stays as-is.
4. Tests: extend src/styles.test.js if it asserts token values; otherwise add one test asserting
   the override block exists and the toggle helper round-trips localStorage.

### Lane M — Inference notifications + palette thread search (`dream-chat/electron/` — main.cjs + work_notifications.cjs + tests)

1. Wire the existing workNotifier into the Maple inference boundary: long chat completions
   (>30s threshold, same policy) notify on completion when the window is unfocused. Find where
   runInference resolves/rejects in main.cjs and call onJobStarted/onJobFinished with label
   "Maple response". Suppress when streaming to an actively focused window (same guard).
2. Add `thread.search` IPC command: given {query}, returns matching threads (id, title,
   updatedAt, provider) using case-insensitive substring match over the registry — read-only.
   Preload exposes mapleDesktop.searchThreads(query). Bounded results (max 10).
3. Tests: extend work_notifications.test.cjs or new file for the inference hook (mock timing);
   thread.search shape + empty-query behavior + max-results bound.

### Lane P — Palette threads upgrade + primer polish (`dream-chat/src/` — main.jsx palette section ONLY + styles.css palette/primer sections)

COORDINATION NOTE: Lane N owns styles.css globally EXCEPT palette/primer sections; Lane P owns
ONLY the palette/primer CSS sections and the palette JSX in main.jsx. Both touch main.jsx —
Lane P must make surgical edits near the `paletteSections` definition and PrimerCard component
only; Lane N touches the system-bar toggle + root attribute + theme CSS. If a conflict arises,
Lane P yields (its changes are smaller).

1. Palette THREADS section becomes searchable: typing filters thread items by title substring;
   show "no matching threads" state inside the section rather than dropping it silently.
   (The fuzzy matcher already applies — ensure thread items participate and hint shows
   relative time via formatRelativeTime.)
2. Primer card gets a second mount point option: if Command Center is focused on first-run
   (chat never opened yet), show the primer there instead. Same dismissal key.
3. Primer gains a "Reopen tips" affordance: a small link in Settings surface that clears the
   dismissed flag so the primer shows again (useful when the mental model is forgotten).

## Non-goals

- No new windows/surfaces; no redesign of existing panes; no cloud anything.
- No changes to inference request shapes or thread persistence formats.

## Verification

- Full electron suite green (105+), renderer suites green (16+)
- esbuild clean, vite build succeeds, relaunch healthy
- Manual: understory toggle persists across restart; long Maple reply notifies when unfocused;
  palette thread search narrows correctly; primer reappears after Settings reset
