# HemlockOS Tranche 9 — Chat + Build Hardening

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
> Plan-only artifact: nothing here executed yet.

**Goal:** Close the remaining failure classes seen in live use: readiness deadlocks on server start, missing error taxonomy for chat failures, artifact-build robustness (the model-facing authoring loop), and renderer state hygiene.

**Evidence base (launch.log, 2026-08-24):**
- 28 `agent:intent` handler errors: 13 "terminated" (server death, now retried), 5 user cancels, **4 "fetch failed"**, **2 "exited before becoming ready"** + **2 "did not become ready: fetch failed"** — readiness path still has gaps
- 2 `agent:cancel` clone errors (old but the handler should be hardened anyway)
- 1 HTTP 404 "No safetensors found in …/LFM2.5-8B-A1B-mlx" — a bad model path was selected with no validation before spawn
- Artifact build blocked earlier by model-supplied garbage IDs (fixed in a1ad5ba) — but the create→author→preview chain deserves its own regression tests

---

## Tasks (4 subagents, disjoint file lanes)

### H1 — Readiness hardening (`electron/main.cjs` spawn/readiness region + new test)
The two "not ready" errors show ensureMapleRuntime can give up while the server is actually fine (slow first weight load) or leave no diagnostics.
1. Extract readiness polling into pure helper `electron/readiness_probe.cjs`: `nextReadinessDelay({ attempt, startedAt, timeoutMs })` → `{ done, delayMs, reason }` with exponential backoff capped at 2s and an honest deadline reason. 5 tests.
2. In the readiness wait: log each health-check failure reason to the maple log line (connection refused vs timeout vs non-200) so "did not become ready" always says WHY.
3. If the child exits during readiness, fail fast with the exit signal in the error message instead of polling the full timeout.
4. Validate the configured model path BEFORE spawn: if the directory lacks `*.safetensors` or `config.json`, throw "Model at <path> is not a valid MLX checkpoint (missing weights/config)" — prevents the LFM2.5 404 class.
**Gate:** node --check, full electron suite, readiness tests pass. Diff ≤60 lines outside the new module.

### H2 — Error taxonomy + cancel hygiene (`electron/maple_runtime.cjs` + `electron/error_taxonomy.cjs` NEW)
1. New pure module `error_taxonomy.cjs`: `classifyInferenceError(error) → { kind, retryable, userMessage }` covering: transport-death (terminated/reset/refused), stall, gpu-500, cancelled-by-user, model-invalid, server-not-ready, unknown. Every kind gets a short honest userMessage. 8+ tests.
2. Refactor `isMapleTransportError` to delegate to the taxonomy (single source of truth; keep the exported function signature).
3. `agent:cancel` handler: wrap IPC payload construction so any object that fails structured-clone is replaced with a plain-data snapshot (id/status/timestamps only) — kills the clone-error class permanently.
**Gate:** taxonomy tests, full suite green, node --check both files.

### H3 — Build-mode artifact flow regression tests (`electron/agent_orchestrator.cjs` READ-ONLY + new `electron/artifact_flow.test.cjs`)
No product changes — this task locks down the create→author→preview chain with tests so future refactors can't regress it.
1. Test: model-supplied garbage artifactId ("artifact://manifest", "", "scratch artifact", 42) is stripped and the prior-artifact fallback fills the real id (covers the a1ad5ba fix).
2. Test: author without any prior create falls back to host scaffold source (fallbackAnimationSource path).
3. Test: preview.inspect returning blocked triggers repairArtifact exactly once per action (mock executeCommand).
4. Test: budget clamp — approvePlan with overrides {maxAgentSteps: 9999} clamps to 24; {0} clamps to 1.
Mock kernel/executeCommand; no live Maple needed. If a test EXPOSES a real bug, stop and report it rather than fixing (parent decides).
**Gate:** all new tests pass; full electron suite green.

### H4 — Renderer chat-state hygiene (`src/main.jsx` + `src/styles.css` small)
Live-use papercuts from tonight's session:
1. When a stream ends failed/cancelled AND a partial was persisted, the live-stream panel must clear (currently a stale panel can linger above the partial message).
2. The re-run button on dead replies must be disabled while `isThinking` (double-submit guard) — same guard as composer send.
3. Error banner auto-dismisses after 12s (still manually dismissible); today errors linger forever and bury the composer.
4. `.partial-note` and `.chat-error` get `flex: 0 0 auto` so they can't compress the scroll area.
Keep total diff ≤30 lines across both files.
**Gate:** esbuild, vite build, renderer 26/26, full electron suite untouched-green.

## Waves
- Wave 1 (parallel): H1 + H2 + H3 + H4 — file lanes strictly disjoint (H3 is read-only + new files).
- Wave 2: batched spec+quality review of all four.
- Final: parent fixes findings → full gates → state.yaml receipt → one commit.

## Whole-tranche verification
```bash
cd dream-chat
node --test electron/*.test.cjs   # expect ≥ 230
node --test src/*.test.js          # 26
npx esbuild src/main.jsx --loader:.jsx=jsx --jsx=automatic --outfile=/dev/null
node node_modules/vite/bin/vite.js build
node --check electron/main.cjs electron/agent_orchestrator.cjs electron/maple_runtime.cjs
```
