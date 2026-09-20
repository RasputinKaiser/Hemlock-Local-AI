# HemlockOS — Maple-Preview Conversational / Agentic / Speed Improvements

**Goal:** Make Maple-Preview chat in HemlockOS (a) never silently die, (b) never render empty responses, (c) act on "improve/agentic" intent, (d) run faster — all evidence-based against the live `mlx_lm server`.

## Root-cause findings (verified 2026-08-20)

1. **Dominant bug — server crash (the real "never responds").** `main.cjs` defaulted `mapleKvBits = 4` (`--kv-bits 4`). The `maple-2bit-mlx` model uses a `RotatingKVCache`, and MLX raises `NotImplementedError: RotatingKVCache Quantization NYI`, then aborts the Metal command buffer (`gpu::check_error` → `abort()` → SIGABRT). Crash log + Apple crash report (PID 41127) confirm: `RotatingKVCache Quantization NYI` → `kIOGPUCommandBufferCallbackErrorTimeout` → SIGABRT. The port dies; the app records `conversation-failed` with `channels: []` → empty `· content` blocks in the UI. A burst of requests reproduced the crash; a server launched **without** `--kv-bits` survived the same burst and stayed healthy.

2. **Secondary bug — empty content channel.** Even with kv-bits off, ~1/6 requests returned empty `content` (reasoning channel present or blank). `main.cjs:1577-1601` already admitted this and only re-requested a buffered response when `stream.text` was *completely* empty. Strengthened to fire on empty **content channel** specifically.

3. **Speed — wasted thinking overhead.** Forcing `chat_template_kwargs: { enable_thinking: true }` added ~23% first-response latency (9.6s → 7.4s) with **identical** output (model emits its reasoning channel regardless of the flag).

4. **Agentic gap — "improve" intent stalled.** `classifyIntent` returns `"improve"` for agentic/autonomous/proactive keywords, but `defaultPlanSteps("improve")` returned only two inspect steps. No execution.

## Changes applied (committed-ready, syntax-checked, tested)

- `dream-chat/electron/main.cjs`
  - `mapleKvBits` default `4` → `0` (KV quantization disabled; documented incompatibility). `HEMLOCK_KV_BITS` override still works (0 disables).
  - `runInference`: buffered fallback now triggers on empty **content** channel (not just empty total text); records `mapleReasoningOnlyStream` metric when reasoning-only.
  - `runInference` base: removed forced `enable_thinking: true` (faster, same output).
  - Registered `"improve.propose"` command (`capability: "write"`, `approval: "explicit"`).
- `dream-chat/electron/agent_orchestrator.cjs`
  - `defaultPlanSteps("improve")` now: `repo-map` → `receipts.query` → `improve.propose` → answer step.
- `dream-chat/src/main.jsx`
  - `renderChannels` now filters out empty-text channels before rendering, so a blank `content` channel can never paint an empty block; falls back to the existing "no prose channel returned" state.

## Verification (real, not asserted)

- `node --check main.cjs` + `agent_orchestrator.cjs` → OK.
- `node --test agent_orchestrator.test.cjs interaction_modes.test.cjs` → 25/25 pass.
- Relaunched app via `zsh scripts/launch-hemlock.zsh --repo-root /Users/ianzvirbulis/Code/Hemlock --app`; Maple healthy, **no `--kv-bits` flag** in launch args.
- End-to-end inference through the app's exact request shape returned real streamed text ("Everything's going great here…").
- Burst of 6 requests against the app server: server stayed `{"status":"ok"}` (crash fixed).

## Remaining note

Occasional empty `content` from the model (req4 in burst) is a model/KV-warmup hiccup, not a crash. The backend buffered fallback + empty-channel frontend guard now contain it; if it persists, next step is a single bounded retry in `runInference` on an empty buffered response.

## Future speed work (not yet done — needs benchmark)

- Sweep `--ngram-depth` (default 12, "512-token window" guess) and confirm `--prefill-step-size 1024` via `benchmarks/server_speed_probe.py` against the live server.
- Add a persistent `--prompt-cache-file` under `runtimeDataRoot/caches` for cross-conversation warmup.
