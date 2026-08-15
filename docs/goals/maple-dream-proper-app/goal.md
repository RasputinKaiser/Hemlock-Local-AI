# Hemlock proper-app tranche

## Objective

Make Hemlock a proper local-first desktop assistant: preserve the real local MLX LoRA Dream workflow, add a SIPS-like working panel for a ChatGPT/Codex-style task loop, and finish one reviewable production tranche with live verification and a clear handoff for anything larger. Hemlock is named after Pennsylvania's state tree; Maple-Preview remains the underlying model identity.

## Goal Kind

`open_ended`

## Current Tranche

Map the current app and repo, choose the highest-leverage safe slice, implement the SIPS-like workflow panel and any directly necessary Dream hardening, verify the desktop and browser surfaces, and leave the next tranche explicitly recorded. The PM thread is the delegator and acceptance judge for this goal; child Judge tasks are intentionally not used. This is not a promise to reproduce the entire DeepGrove research product or to invent unrestricted agent/tool autonomy.

## Non-Negotiable Constraints

- Maple base weights remain unchanged; personal adaptation stays in timestamped local adapters.
- Dream must show truthful stage, elapsed, log, failure, and server lifecycle state instead of appearing frozen.
- User facts and conversation data remain local to this machine unless the user explicitly adds an external integration later.
- Preserve the current working tree and existing local Dream adapter; do not delete Xcode data or other user files in this tranche.
- Keep deterministic app state and server behavior authoritative; an assistant/task panel may coordinate work but must not imply tools or training succeeded without receipts.
- Rust/Tauri is optional only if it materially improves the current tranche; the MLX runtime remains Python-native.

## Stop Rule

Stop when the tranche audit passes, all safe local work is blocked, or continuing would require owner input, credentials, destructive operations, external publication, or product strategy the board cannot decide.

## Canonical Board

Machine truth lives at:

`docs/goals/maple-dream-proper-app/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/maple-dream-proper-app/goal.md
```

## PM Loop

On every continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Work only on the active board task.
4. Assign Scout, Worker, or PM according to the task; the PM owns acceptance decisions.
5. Write a compact task receipt.
6. Update the board.
7. Select the next active task or finish with a PM audit receipt.
