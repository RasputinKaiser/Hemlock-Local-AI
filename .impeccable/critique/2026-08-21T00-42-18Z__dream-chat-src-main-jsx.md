---
target: Hemlock chat/thread management
total_score: 17
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-21T00-42-18Z
slug: dream-chat-src-main-jsx
---
# Critique — Hemlock Chat / Thread Management
Method: dual-agent (A: design review · B: detector + static evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Rich lamps/counters, but thread creation fails with zero feedback |
| 2 | Match System / Real World | 2 | "Durable threads", "bounded-local" — internal vocabulary unexplained |
| 3 | User Control and Freedom | 1 | Backend supports rename/archive/cancel; UI exposes none of it |
| 4 | Consistency and Standards | 2 | `window.prompt` in Electron (broken); plan card rendered twice |
| 5 | Error Prevention | 1 | Raw path entry from memory; no confirmation for destructive ops |
| 6 | Recognition Rather Than Recall | 1 | Type a path from memory; every thread titled "New Hemlock thread" |
| 7 | Flexibility and Efficiency | 2 | ⌘⇧M exists; no thread shortcuts, no search, manual refresh |
| 8 | Aesthetic and Minimalist Design | 2 | Authored look, but very dense; duplicated plan card |
| 9 | Error Recovery | 2 | Good IPC-error stripping; worst failure is silent |
| 10 | Help and Documentation | 1 | Jargon micro-copy; prompt copy contradicts UI |
| **Total** | | **17/40** | **Poor — major UX work required on this path** |

## Design Specificity Verdict

**Split personality: authored chat surface, generic-and-broken thread IA.** The chat itself is strongly Hemlock — verbatim model channels beside host evidence, receipts, plan boundaries, distinctive paper/botanical palette. Thread management is an afterthought: a broken OS-native prompt, identically-titled rows, and durable backend machinery (checkpoints, leases, projects) with no visible counterpart. The data model says "durable workspace threads"; the UI says "a dropdown and a plus button."

**Deterministic scan**: detector exit 0, zero findings — the defects here are behavioral/architectural, not mechanical.

## Root cause of "new thread keeps the same chat context" (both agents agree)

1. **The New thread button is broken in the desktop app — silently.** `createThread()` calls `window.prompt()`, which **Electron does not support** — it throws. The call is fire-and-forget with no catch, so it dies as an unhandled rejection before `thread.create` is ever sent. Click "New thread" → nothing happens, old chat stays. No error anywhere.
2. **Model context comes from local React state, not the thread.** `messages` is one `useState([])`; every send builds the LLM payload from that local array, never from `threadManager.readConversation()`. Incoming `conversation.response` events are appended **without checking threadId** — a reply from thread A can stream into thread B's view and ride along as context. Cross-thread bleed is structural.
3. Switching threads *does* replace the transcript (`runCommand("thread.switch")` sets messages from the backend conversation) — but since creation is broken, users rarely get that far, and the payload-context bleed remains regardless.

## Overall Impression

The chat surface is a genuinely distinctive product idea executed with care. Thread management is the same app's blind spot: the backend is *durable* (registry.json, JSONL conversations, checkpoints, archive/cancel/rename all implemented) and the UI exposes almost none of it, with the one entry point it does expose silently broken. The single biggest opportunity: make the thread model the source of truth for chat context, and surface the management verbs the backend already has.

## What's Working

1. **Authored trust architecture** — verbatim model output visually separated from host actions/evidence/telemetry; receipts and raw-output references are distinctive and consistent.
2. **Progressive disclosure discipline** — reasoning, telemetry, envelopes collapse behind honest summaries with token counts.
3. **Thoughtful error text where it exists** — IPC-wrapper stripping and stale-session recovery copy show real care; it just never reached the thread path.

## Priority Issues

1. **[P0] New thread is broken and silent** — `window.prompt` throws in Electron; no error handling. Fix: in-app new-thread dialog (recent projects + `dialog.showOpenDialog` directory picker + optional title), try/catch, surface via the error banner.
2. **[P0] Conversation state is local, not thread-owned (context bleed)** — LLM payload built from local state; `conversation.response` events appended without threadId filter. Fix: make `readConversation(activeThreadId)` the source of truth for payloads; filter stream events by threadId; clear messages on `thread.switched`.
3. **[P1] No thread management surface** — backend has rename/archive/cancel/resume; UI has none. Fix: per-row actions in the thread popover (rename inline, archive with confirm+undo toast, cancel for running threads), collapsed "Archived (n)" section with restore.
4. **[P1] Thread identity is unreadable** — identical titles, no timestamps, no preview. Fix: auto-title from first user message (~60 chars), show relative `updatedAt` + last-message snippet per row.
5. **[P2] New-thread flow demands a raw directory path** — intimidating, error-prone; backend already models Projects. Fix: make project selection primary, thread creation a child action.

## Persona Red Flags

- **Jordan (first-timer)**: dead "New thread" button immediately; then a CLI-era "Project directory" prompt with no picker; jargon everywhere.
- **Alex (power user)**: no shortcuts for thread ops, no search/filter, can't rename/archive/delete, manual refresh — the durable-thread story is unreachable.
- **Sam (accessibility)**: 9px metadata text; popover has no Escape/outside-click close, no focus management; active thread marked by CSS only (no `aria-current`).

## Minor Observations

- `planCard` rendered twice in the same layout (main column + work rail).
- Prompt copy claims the path "is not shown in Hemlock UI" — the thread bar displays it.
- Archived threads vanish with no count or restore path.
- `thread.create` doesn't update `activeThreadId`; a failed switch leaves registry and view disagreeing.
- No unread indicator per thread row.

## Questions to Consider

- If a thread is durable enough to have checkpoints, leases, and writer locks, why does its visible transcript live in one fragile `useState` array any event can contaminate?
- Should "New thread" ask for a directory at all — or is the *project* the primary object and threads its children?
- When a user says "delete this chat," do they mean the transcript, the workspace artifacts, or the checkpoints — and is archive-only honesty, or a question the UI should answer once?
