---
target: the whole HemlockOS desktop surface (main.jsx + styles.css)
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-21T21-09-21Z
slug: dream-chat-src-main-jsx
---
Method: dual-agent (A: sa-0-c4153c69 · B: sa-0-e874db37)

# Critique — HemlockOS Desktop Surface (dream-chat/src/main.jsx + styles.css)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Best-in-class: phase-narrated thinking notes, elapsed timer, reasoning-token count, mid-inference /health probes, tok/s, composer model-context line |
| 2 | Match System / Real World | 2 | Garden/Dream metaphors work; "bounded plan", "receipt-backed claim", "HOST EXECUTION LOOP", "allowlisted" fire insider jargon at first-session users |
| 3 | User Control and Freedom | 3 | Stop/retry/restore/archive/freeze all present — undercut by Esc silently killing Dream training and no undo on thread archive |
| 4 | Consistency and Standards | 2 | Two dock dot systems; foreign blue step-card family; wrong icons on rename/archive; confirm dialog used for revision restore but not thread archive or dock Close |
| 5 | Error Prevention | 3 | Plan approval gate, danger-tone confirm focusing Cancel — undermined by provider-cap inputs committing every keystroke and Esc-cancels-training |
| 6 | Recognition Rather Than Recall | 3 | Dock labels + stateful aria-labels, model-context line — but ⌘1-9 and ⌃⌥-arrow tiling are completely undocumented |
| 7 | Flexibility and Efficiency | 3 | Sectioned fuzzy palette, quick asks, quick-command grids — shortcut discovery depends on luck |
| 8 | Aesthetic and Minimalist Design | 2 | Command Center ~12 competing regions; 7px DM Mono type in ≥8 places pretends to be information |
| 9 | Error Recovery | 3 | Honest failure copy, stale-adapter self-recovery — but one global `error` string overwrites itself |
| 10 | Help and Documentation | 3 | Empty states teach exceptionally well; zero proactive help surface, no shortcut legend |
| **Total** | | **28/40** | **Fair — solid bones, consistency and density hold it back** |

*Trend context: the archived thread-management critique scored **17/40** (2026-08-21T00:42Z). This pass covers a much wider surface (whole desktop OS), so it is not a like-for-like comparison — but every P0 from that critique is verified fixed in this one.*

## Design Specificity Verdict

**LLM assessment:** Authored, not interchangeable. Newsreader serif headlines over a deep-green night gradient with dotted grain and CSS-drawn ambient branches; warm-paper windows floating on the dark backdrop; DM Mono kickers everywhere; gold as the single accent; a metaphor system nobody else has — Memory *Garden* (seed-dots vs rooted lessons), *Dream Lab* (moon glyph, violet night surface), Receipts as proof store, the UNDERSTORY desktop strip. Copy voice is distinctive and consistent ("Blocked honestly:", "No inference success is claimed").

Specificity erodes at the edges: PRODUCT.md brand tokens (#fffdf6 paper, #2e4e38 ink, #cf9e42 gold) don't match implemented variables (`--paper:#f5f0e3`, `--ink:#1b3029`, `--gold:#dfb45f`); ~40 hardcoded one-off hexes mean each window's "paper" is subtly different; and the Command Center imports a **foreign blue family** (`.active-step-card`: #9baed1 border, #6883b4 node, #1b3659 button) that belongs to no other surface — it reads as pasted in from another product.

**Deterministic scan:** Static CLI scan of main.jsx is **clean** (exit 0, zero findings). But the live rendered DOM triggers **197 detector findings**, dominated by runtime-only manifestations:
- `undersized-ui-text` ~153 (7-10px functional text: "Maple-Preview", "SIPS" chips, status lamps)
- `low-contrast` 37 (worst pairs down to 1.8:1 `#f0ead7` on `#d2a95d`, 2.3:1 `#9aa397` on `#f5efe2`)
- `tiny-text` 15, `nested-cards` 9, `clipped-overflow-container` 4, `all-caps-body` 4
- singletons: skipped heading (`<h1>`→`<h3>`), line-length (115-139 chars), gpt-thin-border-wide-shadow ×2

Detector and LLM review **converge** on typography floor and contrast; the detector additionally caught the contrast failures and card-in-card patterns the review only partially named. No false positives identified beyond dedupe noise (215 raw lines → 197 authoritative). Overlay evidence was visible in the headless browser tab (screenshot: `/tmp/hemlock-detect-evidence.png`) but no user-visible overlay exists in your running app.

## Overall Impression

The status machinery is genuinely excellent — rare phase-narrated honesty during long local inference that converts anxiety into orientation. What holds HemlockOS back from excellent is self-inflicted: an unreadable type floor, two competing badge languages, one off-brand blue component, and a home screen that hides its primary action inside a collapsed trace. The single biggest opportunity: make the Command Center orient instead of report.

## What's Working

1. **Status honesty as design language.** The composer model-context line, process-vs-inference distinction ("A healthy process is not the same as a completed inference response"), and phase-narrated waits form a coherent promise: we tell you exactly what the machine is doing.
2. **Empty states that teach.** "The first renderable revision will peek here." Every empty state explains the model, not just absence.
3. **Identity through craft details**: pointer-capture window dragging with gold active borders, keyboard-resizable Artifact panes with persisted layout, `prefers-reduced-motion` respected twice, focus-visible gold rings globally.

## Priority Issues

1. **[P0] Command Center's primary CTA is hidden inside a collapsed `<details>`.** The `.active-step-card` with the next-action button sits inside "Full trace"; PROVIDER SCHEDULER concurrency caps sit fully visible above it. The home screen fails its one job — orienting to the next action.
   *Fix:* hoist the active-step card and NOW/NEXT/WHY ribbon to the top of `.workbench-main`; demote provider caps to Settings or a collapsed section. → Suggested command: `/impeccable shape`
2. **[P0] Escape kills running Dream training without confirmation.** The global keydown handler cancels MLX training instantly; Esc elsewhere closes overlays, so users press it reflexively. Hours of work destroyed by habit.
   *Fix:* Esc closes overlays only; route training cancellation through `confirmDialog({ tone: "danger" })`. → `/impeccable harden`
3. **[P1] Runtime typography floor + contrast failures (197 detector findings).** 7px functional text in ≥8 places; contrast pairs as low as 1.8:1. Direct accessibility failure, confirmed independently by both assessments.
   *Fix:* hard floor 9px for text / 10px for read-copy; lift low-contrast pairs above 4.5:1; delete labels that only survive at 7px. → `/impeccable typeset` + `/impeccable audit`
4. **[P1] Two competing dock badge systems.** `.dock-notification` (5px presence dot) and `.dock-unread` (7px gold unseen-activity dot) can render simultaneously at nearly the same spot with different unexplained meanings.
   *Fix:* keep one unread dot; express presence through icon tint/lamp. → `/impeccable polish`
5. **[P2] Destructive-action inconsistency.** Revision restore uses danger-tone confirmDialog (good); thread archive, dock-menu Close, memory Demote execute immediately. Users learn danger handling is arbitrary.
   *Fix:* one rule — anything discarding user-visible state goes through confirmDialog. Also fix wrong icons on thread rename/archive (chat/chevron glyphs). → `/impeccable harden`

## Persona Red Flags

**Alex (power user):** Loves the palette — then never learns ⌘1-9 because z-order targeting is undiscoverable. Gets burned once by Esc-canceling a Dream run and stops trusting shortcuts. Annoyed that Command Center's "Inspect/Improve/Remember" buttons look like commands but merely prefill text.

**Jordan (first-timer):** Lands on Command Center: "PROVIDER SCHEDULER," "EVIDENCE LEDGER," "AMBIENT INBOX." Nothing says *type here to begin* — the console is a 42px textarea in a dark bottom strip with placeholder "Command Hemlock…" (vague). In browser preview, nearly every interesting control says "available in the Hemlock desktop app."

**Sam (accessibility):** Good bones — palette listbox semantics, stateful dock aria-labels, keyboard resize handles, reduced-motion honored. Failures: no focus trap or focus return in palette/confirm alertdialog (Tab walks into frozen background); 7px type unusable at low vision; status lamps sometimes color-only (`.workstream-state` renders text at `font-size: 0`); hover-only message actions, and "retry" always retries the *last* message regardless of which row it sits on — a trap.

## Minor Observations

- `.workstream-list` / `.workstream-icon` defined twice (styles.css ~569-585) — drift risk
- Duplicate `setThinkingStartedAt(null)` lines (main.jsx ~1631-32)
- `.window-center` hides its own titlebar yet participates in window management — metaphor leak
- Console footer advertises "Tab complete"; no tab-completion exists
- Status bar hardcodes "Electron Runtime" even in browser preview
- Desktop-strip clock only updates on re-render — visibly stale when quiet
- Artifact "More" menu doesn't close after choosing an item
- Palette foot's "Only allowlisted local actions appear here" is excellent trust copy — keep it
- `stopGeneration()` injects a synthetic "Generation stopped." bubble styled identically to model output — violates the verbatim-trust ethic

## Questions to Consider

1. If the Command Center showed nothing but the NEXT button, one sentence of WHY, and the composer, would visitors complete tasks faster than with today's twelve-region cockpit?
2. Is the receipt/boundary vocabulary earning trust or taxing comprehension?
3. Why is the most destructive shortcut in the OS (Esc → kill training) the only undocumented one?
