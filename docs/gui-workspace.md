# Hemlock desktop workspace

## Navigation

- **Windows** in the workspace bar opens the searchable window overview. It distinguishes focused, open, minimized, and unopened apps.
- **⌘⇧O** opens the overview in Electron. Arrow keys navigate; Enter opens; Escape returns to the previous control.
- **⌘K** opens the command palette. Arrow navigation keeps the selected result visible.
- **F1**, the keyboard button in the workspace bar, or **All shortcuts** in the overview opens the shortcut guide. Its app entries are also launchers; Escape returns focus to the opener.
- The dock prioritizes Command Center, Chat, Artifacts and Settings, plus other open/minimized windows. **All apps** keeps the complete searchable library available, grouped into Work, Knowledge, System and Training. Left/Right arrows, Home and End move dock focus.
- **⌘`** cycles visible windows. Numeric app shortcuts are stable: **⌘1** Command Center, **⌘2** Chat, **⌘3** Artifacts, **⌘4** Memory, **⌘5** Activity, **⌘6** Receipts, **⌘7** Project Map, **⌘8** SIPS, **⌘9** Dream and **⌘0** Settings. The command palette retains its own numbered result shortcuts while open.

## Window behavior

- Command Center is a managed window, not an immovable full-canvas layer.
- Drag titlebars to move windows; double-click a titlebar to maximize/restore.
- Drag toward the left or right workspace edge to preview a half-width tile. Drag to the top to preview filling the workspace. Placement applies on release; hold Option to suppress snapping.
- All eight resize edges/corners work with the pointer. Focus a resize handle and use arrow keys for 10px changes, or Shift+arrows for 50px changes.
- Resizing against a boundary keeps the opposite edge anchored.
- **⌘⌥←/→** tiles; **⌘⌥↑/↓** maximizes/restores; **⌘⌥M** minimizes.
- Minimized windows leave the canvas and restore from the dock, including their prior maximized state. Closing or minimizing the focused window hands focus to the next visible window.
- Closing a window does not cancel running work or discard its saved state. **Never show this again** on the close warning suppresses future window-close prompts. Re-enable them in **Settings → Workspace → Window behavior → Ask before closing a window**. This preference does not suppress destructive-operation confirmations.
- Right-click an open dock item for explicit tile, fill/restore, focus, minimize and close actions.
- The **…** button on every window opens the same icon-labeled actions menu. It also offers **Center window** and **Reset size & position**. Use Up/Down, Home/End, first-letter navigation, Enter and Escape; **Shift+F10** opens it from a focused dock item. Menus stay inside the viewport.
- **Show desktop / ⌘⌥D** temporarily minimizes visible windows and restores them as a group. It preserves maximization, leaves previously minimized windows minimized, never cancels work, and keeps the restore snapshot across reloads. **⌘⌥W** closes the active workspace window through the normal preference-aware confirmation.

## Icons and message actions

Application and action icons share a 24px grid but have distinct meanings: repository topology for Project Map, iterative arrows for SIPS, a code canvas for Artifacts, separate Windows/All apps glyphs, and distinct maximize/restore controls. The theme button shows the next action with sun/moon icons. Icon-only controls retain accessible names and tooltips; decorative SVGs do not add screen-reader noise.

**Copy** preserves message whitespace and line breaks, shows progress/success, and reports failures with manual-copy guidance. Option-click still includes provenance. Retry has its own icon and remains disabled while inference is active. Clipboard UI tests use an explicit isolated test double; they do not read or overwrite the user's clipboard.

## Layout

The idle Command Center offers Open Chat, Configure models and actual recent work instead of empty monitoring panels. Running, blocked and approval states retain their detailed cockpit.

Chat keeps a compact, growing composer beneath the transcript. Neither Explore nor Build automatically opens evidence; **Activity & evidence** explicitly toggles it. Wide windows use a secondary column. Compact evidence temporarily replaces only the transcript region, never the composer or thread controls; closing it restores conversation, and Escape/outside-click support predictable focus recovery. Model/context details and getting-started guidance are collapsed until requested. A 180px reading floor remains available when text is enlarged; the parent scrolls when necessary rather than clipping controls.

Settings is grouped into **Models & accounts**, **Workspace**, **Context & memory**, and **Advanced/runtime**. Dream Lab shows no loss curve without recorded samples; its observations and receipts remain the source of truth.

Panels adapt to their own width, not just the application viewport. The native 760px minimum width retains floating windows; smaller browser previews use a stacked layout. Updated minimum chat dimensions also apply to restored sessions.

## Verification

From `dream-chat`:

```sh
npm run test:ui
node --test electron/*.test.cjs
npm run build
```

Optional GUI smoke tests use Playwright installed outside the repository and the locally installed Google Chrome:

```sh
npm install --prefix /tmp/hemlock-gui-qa playwright
npm run dev -- --port 5178
# In another terminal:
HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/gui-smoke.mjs
HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/gui-electron-smoke.mjs
HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/gui-audit-regression.mjs
HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/gui-controls-smoke.mjs
HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/render-icon-sheet.mjs
```

Browser smoke covers layout at 1440×900, 1024×768, 760×620, and 390×844, window interactions, keyboard navigation, theme persistence, and close-warning preferences. Native smoke loads the production bundle in real Electron with an isolated temporary data directory and model-server autostart disabled. Neither smoke test submits model prompts or starts training.

Audit regressions additionally test click hit targets, inspector focus/Escape/pointer dismissal, minimum-window reading space, 200% text-only scaling, both-theme state contrast, grouped Settings and honest Dream empty states. They do not certify a screen reader or every populated live-model state.

Controls smoke exercises titlebar/dock menus, keyboard focus and placement, center/reset sizing, Show desktop restoration/persistence, shortcut-guide navigation, theme state glyphs, and fallback-icon absence. The icon sheet is generated from the actual SVG registry at small and standard sizes, not a separate mockup. Controls evidence defaults to `/tmp/hemlock-controls-evidence`.

Smoke results default to `/tmp/hemlock-gui-evidence`; audit regressions to `/tmp/hemlock-audit-fixed`. Override with `HEMLOCK_GUI_OUTPUT`. The browser URL can be overridden with `HEMLOCK_GUI_URL`; Chrome's executable with `HEMLOCK_CHROME`.
