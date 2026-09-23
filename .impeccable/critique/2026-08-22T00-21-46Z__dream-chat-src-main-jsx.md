---
target: the whole HemlockOS desktop surface (main.jsx + styles.css), re-score after fix passes
total_score: 35
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-22T00-21-46Z
slug: dream-chat-src-main-jsx
---
Method: dual-agent (A: sa-0-17889b77 · B: sa-0-64544dbc)

# Critique (re-score) — HemlockOS Desktop Surface

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Per-lane lamps, phase-narrated thinking, live health probe while waiting, dream/SIPS stage+log+elapsed |
| 2 | Match System / Real World | 3 | Garden dialect coherent; "bounded/receipt/verbatim" repeated ~40× is house jargon a new user must absorb |
| 3 | User Control and Freedom | 4 | Escape can't destroy training; restorable archive, confirms on destructive paths, stop-as-host-note |
| 4 | Consistency and Standards | 3 | DM Mono + Newsreader rigorous; but CSS accretion (double `.workstream-*` blocks), undefined `--ink-muted`, control-height variance |
| 5 | Error Prevention | 4 | Confirms with danger-tone Cancel focus; confirm owns the keyboard; caps commit on blur with revert; browser-mode guards give reasons |
| 6 | Recognition Rather Than Recall | 3 | Shortcut legend, state-aware palette hints, composer model line — but the NOW/NEXT/WHY ribbon is collapsed by default |
| 7 | Flexibility and Efficiency | 4 | True launcher palette, ⌘1-9/⌘`, tiling, keyboard-resizable artifact panes |
| 8 | Aesthetic and Minimalist Design | 3 | Authored parchment/evergreen/gold system — but four overlapping status narrators and a duplicate console composer in Command Center |
| 9 | Error Recovery | 4 | Stale-adapter recovery explains exactly what was/wasn't deleted; IPC wrapper stripped from errors; honest stop reasons |
| 10 | Help and Documentation | 3 | Teaching empty states; no glossary or first-run for the receipts/bounded/verbatim mental model |
| **Total** | | **35/40** | **Good — a real point of view, executed** |

> **Trend for `dream-chat-src-main-jsx` (last 3 runs): 17 → 28 → 35 (out of 40)**
> Wrote `.impeccable/critique/<snapshot>`.

## Design Specificity Verdict

**LLM assessment:** The honesty system is the product — model-verbatim channels vs host notes vs receipts is enforced in code (stream filter, system-note styling, "no silent fallback"), not just copy. Parchment workbench, evergreen rail, gold accent: no other app looks like this.

**Deterministic scan:** Static CLI scan clean. Live rendered DOM: **190 findings, down from 197** (delta −7; per-rule breakdown unavailable this run — the subagent timed out mid-analysis, but its saved console evidence and screenshot at `/tmp/hemlockos-assessment-b.png` confirm a full render). The modest delta is expected: the typography pass lifted sizes but the detector also counts nested-cards and line-length patterns that are structural, not cosmetic. Assessment A independently verified the 7px/8px floor is fully gone except one straggler (`.chat-plan-meta` at 8px).

## Overall Impression

The fix passes were real, not cosmetic. Every claimed fix was verified against source — with two honest partials: the NOW/NEXT/WHY ribbon is still inside the collapsed "Full trace" details, and the provider-cap panel is now dead code (`renderProviderCapacityPanel() && null`), so concurrency caps became invisible host state. Held back from 38+ by one self-inflicted functional regression, one buried fix, and contrast/CSS-accretion stragglers.

## What's Working

1. **The honesty system is the product** — enforced in code, not copy.
2. **Status narration during inference** — phase-aware, probe-backed, stall-honest.
3. **The palette is a real launcher** — state-aware hints put recognition in the shortcut layer.

## Priority Issues (remaining)

1. **[P1] Provider-cap UI is unreachable** — `renderProviderCapacityPanel() && null` evaluates and discards; mounted nowhere. Caps are invisible host state. *Fix:* mount the panel in Settings or delete the function (and its orphaned `.scheduler-panel` CSS + undefined `--ink-muted` var).
2. **[P1] NOW/NEXT/WHY ribbon is inside collapsed "Full trace"** — an attention ribbon collapsed by default is not attention. *Fix:* hoist it directly under the objective block.
3. **[P2] Typography floor has one hole** — `.chat-plan-meta` still 8px. *Fix:* lift to 9px.
4. **[P2] Contrast stragglers** — alpha-composited microtext (`.system-health-chip > span` at 48% alpha, `.strip-time` 45%, `.block-label time` ~2.2:1) missed by the hex remap. *Fix:* raise alpha floors to ~0.75+ or use solid passing tones.
5. **[P2] CSS accretion** — `.workstream-*` rules still defined twice via "Accepted via impeccable live" override blocks; future edits will patch the dead copy. *Fix:* merge the override blocks into the base rules.

## Persona Red Flags

- **Alex (senior dev):** would live here — receipts, evidence refs, action envelopes, ⌘K everything. The target user, and it lands.
- **Jordan (PM/designer):** seduced by the aesthetic, then quietly lost by "bounded-local autonomy", "change-set prepared", and four narrators saying similar things.
- **Sam (novice):** clicks "Run" in the bottom console and doesn't understand why the reply appears in Chat, or what a "Dream adapter" is. No glossary, no first-run.

## Minor Observations

- `setThinkingStartedAt(null)` twice in sendMessage's finally
- `.cockpit-error` absolutely positioned over the bottom console's last panel
- `surfaceBadge` counts system notes as "messages"
- Retry on an old message resends as newest prompt — branch-vs-continue mental model unexplained
- Dream loss chart is decorative hardcoded data labeled "preview" — trains users to ignore the only chart
- `formatRelativeTime` exists for thread rows but isn't reused elsewhere

## Questions to Consider

1. Should the Command Center console and the Chat composer both exist, or is the console redundant now that the palette launches everything?
2. What single sentence would explain "receipts" to a first-session user — and where does it live?
3. Is the Dream loss chart earning its pixels as a preview, or should it show real training data or nothing?
