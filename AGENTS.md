# Hemlock — agent navigation guide

Local-first AI workstation. Maple is a local MLX model (`mlx_lm/models/maple.py`,
weights in `~/Models/Hemlock/maple-2bit-mlx`) driven by a host-owned agent loop in
the Electron main process. The host owns safety: allowlisted commands, scoped
paths, budgets, receipts. The model supplies intent and action selection.

## Layout

- `dream-chat/electron/` — main process + agent harness (the brain)
  - `main.cjs` — everything wired here: command registry (`agentCommands`),
    dispatch (`runAgentCommand`), task/plan lifecycle, Dream/SIPS runs, IPC.
  - `agent_orchestrator.cjs` — the recursive loop: approvePlan → proposeNextAction
    → executeAction → recurse. Autonomy gating, pause/resume, repair.
  - `agent_contracts.cjs` — action schema, parse/repair, `allowedNextCommands`,
    `buildScoreCandidates` (RLCD-style parallel constrained scoring).
  - `agent_queue.cjs` — serialized intent queue; drains only on terminal tasks.
  - `physics_sandbox.cjs` — deterministic experiment sims (Maple's world actions).
  - `dream_train.py` — LoRA Dream training (isolated adapters, hashed base weights).
  - `coding_workspace.cjs` / `coding_autopilot.cjs` — scoped file edits + autopilot.
- `dream-chat/src/` — React renderer (durable projection consumer; no own task state)
  - `main.jsx` — the whole app shell. `groveScene.js`/`groveBindings.js` — 3D world.
- `mlx_lm/` — forked mlx-lm; `server.py` adds `POST /v1/score` (teacher-forced
  candidate scoring on a shared prefilled cache).
- `state.yaml` — append-only ledger of verified changes; read the tail first.

## Core invariants — do not break

- Prose is never executed. Actions are JSON envelopes validated against the
  registry; `capability: "train"` commands always require explicit approval.
- Workspace writes go through `assertScopedPath(thread.workspaceRoot)` — an
  improvement lane for Hemlock itself = a thread whose workspaceRoot is this repo.
- Training verifies base-weight integrity (SHA-256) as provenance; mutation is
  allowed via `dream.fuse`, which writes a NEW checkpoint dir — the base stays
  on disk and `dream.detach` rolls back. Never edit weights in place.
- Every action ends in a receipt/observation with evidenceRefs — claims need them.
- Cancellation is terminal; paused tasks still occupy the queue slot.
- `task.autonomy`: supervised | guided | autonomous/bounded-campaign — graduates
  plan auto-approval and adaptive selection of explicit-but-sandboxed commands.

## Commands

- `cd dream-chat && npm run verify:agent` — full gate (host tests + UI + build)
- `npm run test:agent` — `node --test electron/*.test.cjs`
- `npm run test:ui` — `node --test src/*.test.js src/components/*.test.js`
- `node scripts/gui-electron-smoke.mjs` — real-Electron smoke (slow if server down)

## Self-improvement loop (intended)

`improve` intent → map repo → recall receipts → `improve.propose` (bounded
proposal, receipt'd) → `code.apply` into the scoped workspace → `verify` →
`remember` a lesson. Findings/experiments feed `experiment-dataset.jsonl` →
Dream adapter → graft via `startServer(adapterPath)` or SIPS promote →
optionally `dream.fuse` into new served weights (detach rolls back to base).
