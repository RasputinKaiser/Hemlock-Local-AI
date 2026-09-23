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
  - `agent_queue.cjs` — serialized intent queue; drains on terminal tasks
    (blocked/cancelled included — parked states still hold the slot); pending
    intents persist into session state and restore as queued on boot.
  - `thread_manager.cjs` — threads: lifecycle, checkpoints/restore, search,
    `forkThread` (new thread with `forkedFrom` provenance — not deep history).
  - `shell_exec.cjs` — bounded `shell.exec`: bare allowlisted executables only
    (no paths/wrappers/shells), workspace-scoped args, 60s + 32KB caps, receipts.
  - `health_monitor.cjs` — polls `/health` only while a task is active; an
    outage feeds the crash budget + bounded respawn, then the task auto-resumes
    once from its last durable action.
  - `physics_sandbox.cjs` — deterministic experiment sims (Maple's world actions)
    + `experimentCoverage`/`suggestExperiments` (coverage-gap-driven
    `experiment.suggest`, hypothesis open→addressed tracking).
  - `sips_runtime.py` / `memory_fitness.cjs` — SIPS memory ledger: `memory.list`
    (staleness/provenance/dupe clusters via rankScore) and plan-gated
    `memory.consolidate` (append-only merge + audit trail).
  - `dream_train.py` — LoRA Dream training (isolated adapters, hashed base
    weights). Dataset sources include the agentic spine (durable action +
    observation journals → executed-action SFT rows; only completed actions
    with passed observations). `dream.dataset.preview` audits composition
    without training.
  - `coding_workspace.cjs` / `coding_autopilot.cjs` — scoped file edits + autopilot.
  - Context budget: `contextMaxTokens` (default 24000,
    `HEMLOCK_CONTEXT_MAX_TOKENS`) — over-budget requests compact the volatile
    prompt region (receipted `context.compacted`, prompt note tells Maple);
    still over → `CONTEXT_BUDGET_EXHAUSTED` block. `conversation.trim` trims
    a thread's log with an archived prefix. Real token accounting lives in
    `task.contextUsage` + `agent.self.context`.
  - Settings: `settings.get/set` (persisted `<dataDir>/settings.json`, honest
    appliesOn live|next-launch), `deps.check` (python3/mlx/mlx_lm/transformers/
    maple-model/node — no torch anywhere in this stack).
- `dream-chat/src/` — React renderer (durable projection consumer; no own task state)
  - `main.jsx` — app shell only: state, ctx bag, window loop, dock, palette, dialogs.
  - `windows/` — extracted window components ({ctx}): ChatWindow, ArtifactStudio,
    CommandCenter, ThreadsWindow (management: search/checkpoints/fork),
    UtilityWindows (sips/memory/dream/activity/receipts/map/grove/settings).
    `windows/shared.jsx` holds the shared helpers — window modules import from it,
    never from main.jsx. `groveScene.js`/`groveBindings.js` — 3D world.
  - `ctxSlices.js` — per-window ctx manifests + memoized slices (windows don't
    re-render on unrelated host events). `eventBuffer.js` — ~16ms event
    coalescing before ctx updates. `workToasts.js` — quiet terminal-event
    toasts; `agentTimeline.js` — pure transcript-receipt row placement.
- `mlx_lm/` — forked mlx-lm; `server.py` adds `POST /v1/score` (teacher-forced
  candidate scoring on a shared prefilled cache; `commit:true` teacher-forces
  the winner + `<|im_end|>` into the KV cache — the orchestrator replays prior
  steps verbatim so each step is a strict-prefix extension, ~20 new tokens
  instead of a full re-prefill. `HEMLOCK_NO_PREFIX_CACHE=1` disables).
  `POST /v1/decide` is the kev-style decision endpoint: `{state, questions}`
  with noul/choice/score types — each question is scored on a fork of the
  prefilled state cache (questions can't see each other), options are
  teacher-forced labels, softmax gives calibrated probabilities + confidence;
  `commitQuestion` commits the winner's `continuation`. The orchestrator
  prefers decide over score for action selection (confidence < 0.35 falls
  back to generation); `HEMLOCK_NO_DECIDE=1` disables.
  `--prompt-cache-file` persists the top-K prompt-cache entries across
  restarts: `{path}.manifest.json` (atomic commit) + `{path}.<i>.safetensors`
  per entry (`HEMLOCK_PROMPT_CACHE_SLOTS`, default 4, <=1 = legacy single
  file; manifest-corrupt falls back to the legacy file). Save rides a
  sentinel through the request queue so it runs on the generation thread —
  its Metal stream is thread-local; warm load mx.evals lazy safetensors on
  the loading thread. `assistant_prefix` pre-bakes `{"command":` into
  structured-action calls (400 → host retries without).
  `HEMLOCK_NO_CACHE_FILE=1` disables persistence.
  Speed: `models/maple.py` builds one shared (pos,eps) array per decode step —
  never `float(cache.offset)` an mx.array per layer (GPU sync per layer per
  token, was ~2× decode cost). `--kv-bits` + `--quantized-kv-start` quantize
  ONLY true `KVCache` entries (the 6 full-attention layers) past the start
  token — `RotatingKVCache.to_quantized` raises and used to kill the Metal
  command buffer; sliding layers must stay exact. Host envs:
  `HEMLOCK_KV_BITS` (0/8/4, default 0) / `HEMLOCK_KV_QUANT_START` (5000);
  Settings exposes kvBits (next-launch). Bench: `scripts/maple_bench.py`.
  Measured: decode ~3× (30.6→~90 tok/s), prefill ~2.3×, score ~2.5× (see
  `.optimize/runs/` + ledger). Next decode frontier: the MoE gather_qmm
  pair is ~7.25ms of the 11.6ms eval — needs simdgroup-matrix expert
  kernels. IMPORTANT: the served model loads `maple.py` from the CHECKPOINT
  dir (`~/Models/Hemlock/maple-2bit-mlx/maple.py`, trust_remote_code), not
  the repo file — keep them in sync or live serving silently loses the
  optimizations. Regenerated checkpoints must ship the repo maple.py.
  Context ceiling: `resolveContextMaxTokens` — stored pin > env > kv-scaled
  default (24000 exact / 61440 kv-bits) > clamp to modelMax−2048; unpinned
  tasks re-resolve per request (settings knob is live).
- `state.yaml` — append-only ledger of verified changes; read the tail first.

## Core invariants — do not break

- Prose is never executed. Actions are JSON envelopes validated against the
  registry — `{"actions":[...]}` batch envelopes run sequentially, each
  validated + receipted; `capability: "train"` always requires explicit
  approval. `artifact.author`/`artifact.update`/`world.place`/`plan.revise`
  are plan-gated.
- Agent introspection: `agent.self` (task/budget/queue/approvals/receipts) and
  `world.state` (grove/experiment projection) are auto + read; `world.place`
  persists agent-authored grove markers.
- Idle-dream scheduler is proposal-only: a `dream.cycle` candidate lands in the
  ambient inbox when ≥8 new findings exist post-queue-drain; acceptance still
  goes through explicit train approval. `HEMLOCK_NO_IDLE_DREAM=1` disables.
- Lane fallback: when structured-action inference dies of transport-death
  (not parse/envelope failures), the step retries once via
  `task.fallbackLane`/`HEMLOCK_FALLBACK_LANE` (codex|claude|none) — every
  fallback is receipted with `provider`/`fallbackFrom`; receipts never claim
  Maple did the work. `maple.warm` + ready/switch hooks prefill the shared
  action-prefix so the first step is cache-hot (60s cooldown; skipped while
  any stream/task is active). `memory.note` (plan-gated) lets the agent
  write candidate lessons.
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
