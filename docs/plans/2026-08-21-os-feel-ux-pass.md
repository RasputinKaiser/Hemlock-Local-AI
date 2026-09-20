# HemlockOS — UX Flow & OS-Feel Improvement Plan

**Goal:** Make HemlockOS feel like a real operating system for the model working inside it —
windows that behave like windows, a dock that tells the truth, a command palette that launches
like Spotlight, and dialogs that never rely on `window.prompt`/`window.confirm` (both broken in
Electron). All changes preserve the brand system in PRODUCT.md (paper/evergreen/gold, Newsreader
+ DM Mono, receipt-and-evidence voice) and the agent-editability principle (plain CSS, semantic
classes, small diffs).

## Context recap (evidence-based)

- Thread-management critique (`.impeccable/critique/2026-08-21T00-42-18Z…`, 17/40): P0s fixed
  (in-app thread dialog, thread-owned context, per-row rename/archive, Escape/outside-click
  popovers, auto-title). Remaining OS-feel gaps below.
- Window-layering bug fixed 2026-08-21: dock clicks re-clamp bounds (`focusWindow` in
  `windowManager.js`); `WindowFrame.jsx` keeps zIndex when maximized.
- `window.confirm` still used for destructive actions (revision restore in Artifact Studio) —
  **throws in Electron**, same class of bug as the old `window.prompt` P0.

## Work lanes (disjoint file ownership, parallelizable)

### Lane A — Renderer OS-feel (`dream-chat/src/` only)

A1. **Command palette → true launcher.** Currently a filter over open-window items. Extend:
    - Sections: Surfaces (all windows), Actions (New thread, New artifact, Toggle Freeze/Pin,
      Export change set), Threads (switch to thread N), Settings (open Settings window).
    - Fuzzy match (subsequence, not substring); Enter runs top hit; ⌘1-⌘9 while palette open
      jumps to the Nth item; arrow-key navigation with `aria-activedescendant`.
    - Keep the existing backdrop/Escape dismissal. Palette stays in `main.jsx` + `styles.css`.

A2. **Dock truthfulness.** Dock items already show open/active state. Add:
    - A small gold dot on dock items whose window has *unread* activity (event fired while
      window closed or not focused). Cleared on focus.
    - `aria-pressed` on dock items; tooltip title already exists — add `aria-label` with state
      ("Artifact Studio, open, inactive").

A3. **⌘1-⌘9 global window switching** (when palette closed): focuses the Nth open window in
    z-order. Mirrors macOS Spaces/mission-control muscle memory. Implemented in the existing
    keydown handler in `main.jsx`.

A4. **In-app confirm dialog component** (replaces `window.confirm`): small centered modal in the
    palette-backdrop style, promise-based `confirmDialog({title, body, confirmLabel, tone})`,
    focus trapped, Escape = cancel, Enter = confirm. First consumer: Artifact revision restore
    (currently `window.confirm` → silently broken in Electron).

A5. **Model context line in chat composer.** One DM Mono line above the input: active model
    name + lane (e.g. `maple-2bit · local lane · 16k ceiling`) so the user always knows what
    they're talking to. Data already in state (`modelSelection`, readiness).

### Lane B — Electron host (`dream-chat/electron/` only)

B1. **`dialog:confirm` IPC** — native `dialog.showMessageBox` wrapper returning boolean;
    preload exposes `mapleDesktop.confirmDialog(opts)`. Renderer may use either this or A4's
    in-app dialog; host dialog works even when the renderer is busy.

B2. **`notification:show` IPC** — `new Notification()` from main with app name/icon; preload
    exposes `mapleDesktop.notify({title, body})`. Consumers (later PR): long inference done,
    dream cycle complete, artifact revision ready.

B3. **`window:list` command** — IPC returning open windows (id, label, state, zOrder) so the
    palette/dock can render authoritative state instead of assuming. Pure read; tests assert
    shape and closed-window exclusion.

B4. **Tests** for each IPC handler in the existing `*.test.cjs` style (mock
    `dialog.showMessageBox`, assert boolean mapping; assert notification options shape; assert
    `window:list` filtering).

## Non-goals (this pass)

- No new windows/surfaces; no visual redesign; no dark theme; no cloud anything.
- No changes to inference paths, thread persistence format, or artifact registry schema.

## Verification

- `node --test dream-chat/electron/*.test.cjs` (all lanes green)
- `node --test dream-chat/src/windowManager.test.js`
- `npx vite build` succeeds; relaunch via launch script; manual pass: palette launcher,
  ⌘1-9, dock dot on Activity while closed + event fires, revision-restore confirm dialog.
