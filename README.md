# Hemlock — a local-first AI workstation

Hemlock is a macOS desktop environment where **Maple** — a 20B-A1B ternary MoE
running fully local on MLX — acts as a real agent: it chats, builds artifacts,
reads and edits this repository, runs deterministic physics experiments in a 3D
world it lives in, and improves itself through receipted local training.

The split is deliberate: **the host owns safety, the model owns intent.**
Electron main owns command allowlisting, scoped paths, budgets, receipts, and
kill controls. Maple supplies plans, action selection, and claims. Everything
the agent does lands in a durable, inspectable projection — no hidden state.

## The agent loop

An intent becomes a durable plan; Maple then proposes one structured JSON
action at a time — or a `{"actions":[...]}` batch envelope executed step by
step. The host validates it against a registry of 116 allowlisted commands,
executes one bounded operation, records an observation with evidence
references, and asks for the next step. Prose is never executed.

- **Graduated autonomy** — `supervised` (approve every plan) → `guided` (plans
  auto-approve; sandboxed artifact/preview commands run unclicked) →
  `autonomous`/`campaign:` (everything except training, which always stays
  explicit). Budgets, allowlists, and receipts bind at every level.
- **Full control mid-run** — pause at a step boundary, resume without losing
  state, `steer:` injects guidance into the next decision, cancel is terminal.
- **Scored action selection** — `/v1/score` teacher-forces candidate action
  envelopes against a shared prefilled KV cache and picks the argmax, instead
  of generating JSON autoregressively; `/v1/decide` scores labeled options on
  forked caches for calibrated confidence, with confidence and top1−top2
  margin gates falling back to generation on weak calls. Complete envelopes
  execute with zero generated tokens (structurally incapable of invalid
  JSON); prefix winners fall through to generation only for free fields.
- **Self-describing** — `agent.capabilities` returns the live command registry
  with input contracts; `agent.self` reports task, budget, queue, pending
  approvals, and recent failures with host-authored recovery hints; every
  command carries an `inputHint`.
- **Self-correcting** — a missing required input gets one bounded repair
  inference; `plan.revise` lets Maple replan the unexecuted suffix
  mid-task (validated, receipted); decide divergences are logged, not hidden.
- **Self-improving** — Maple can read this repo, `improve.propose` a bounded
  change (receipt'd, never auto-applied), `code.apply` it under an approved
  plan, `verify` with real build/test profiles, and `remember` the lesson via
  `memory.note`. `shell.exec` runs bounded allowlisted executables against
  the workspace.
- **Resident and warm** — a persistent multi-entry prompt cache survives
  restarts and lane switches, and the host warm-prefills the shared action
  prefix on server-ready and thread-switch, so first steps are cache-hot.
- **Multi-lane** — Maple is the default; Codex and Claude lanes exist, and a
  configured fallback lane retries transport-death inference once — receipted
  with `fallbackFrom` so the record never claims Maple did the work.

## The Grove

Maple exists as a hooded figure in a 3D world (`dream-chat/src/groveScene.js`).
`experiment.run` executes deterministic physics sims (pendulum, projectile,
orbit, spring, collision, terminal) in a bounded sandbox — each run emits a
receipt **and** a trail of real integration samples that the grove replays at
Maple's lab bench while Maple physically works. `experiment.suggest` picks
the next run from coverage gaps and open hypotheses; `world.place` lets Maple
leave persistent markers in the world it inhabits. Findings feed the Dream
dataset. World → experiment → receipt → finding → dataset → adapter → behavior.

## Dream training → graft → fuse

Dream Lab prepares a token-budgeted dataset — facts, conversations, coding
examples, **and durable agentic action traces** (real system-prompt bytes,
step context rebuilt at each action's own timestamp, only completed actions
with passed observations) — with `dream.dataset.preview` auditing the mix
before anything trains. Then real MLX LoRA training runs with isolated
adapters and base-weight provenance. An idle-dream scheduler *proposes* a
cycle when enough new findings have landed; training itself always stays
explicitly approved. A verified adapter can be:

- **grafted** — served via `--adapter-path`, detachable (`dream.detach`),
- **fused** — `dream.fuse` merges it into a *new* checkpoint and serves that;
  the base stays on disk as a free rollback,
- **promoted by SIPS** — after a base-vs-adapter comparison lane decides.

Base weights are hashed before/after every run as provenance; mutation is an
explicit, auditable act — never silent.

## Surfaces

Chat · Artifact Studio (versioned live previews, sandboxed) · Command Center
(host loop, intent queue, metrics, notification history) · **Threads**
(search, checkpoints, fork, full lifecycle) · Understory Grove · Dream Lab ·
Memory Garden (staleness/provenance-ranked recall, near-dupe consolidation) ·
SIPS · Activity · Receipts (expandable, cross-window deep links) · Project
Map · Settings (runtime tuning: KV-cache quantization, context ceiling,
prefill step, prompt-cache slots, fallback lane, dependency probes).
Ordinary conversation stays ordinary — creation verbs alone don't trigger
plans.

## Run it

Requires Apple Silicon and [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/RasputinKaiser/Hemlock-Local-AI.git
cd Hemlock-Local-AI
./setup.sh && source .venv/bin/activate
hf download deepgrove/maple-2bit-mlx --local-dir maple-2bit-mlx
```

Then double-click `Hemlock.app`, or:

```sh
cd dream-chat && npm install && npm run desktop
```

CLI without the app:

```sh
python -m mlx_lm chat --model ./maple-2bit-mlx --trust-remote-code --max-tokens -1 \
  --temp 1.0 --top-p 0.95 --flash-head
```

## Verification

```sh
cd dream-chat
npm run test:agent      # host harness: orchestrator, queue, contracts, receipts,
                      # durable-io recovery, session restore, real-main soak
npm run test:ui         # renderer projection tests
npm run verify:agent    # all of the above + production build
node scripts/gui-electron-smoke.mjs   # real-Electron end-to-end checks
python -m pytest mlx_lm/tests/test_server.py   # inference server incl. kernels
```

Maple is a 20B-A1B ternary MoE — 24 layers, 256 experts, top-8, 512-token
sliding window on 3 of 4 layers, 2-bit packed `{-α, 0, +α}` weights.
Inside Hemlock the decode path additionally runs fused custom Metal kernels
for the expert block (one dispatch for gate+up+SwiGLU across all 8 active
experts, another for weighted down-projection), and `HEMLOCK_KV_BITS=8`
opt-in quantizes the six full-attention KV caches past a configurable start
token — lifting the practical context ceiling from ~24k to ~61k tokens while
sliding-window layers stay exact.

| chip | head | decode tok/s | prefill tok/s | peak |
| --- | --- | --- | --- | --- |
| M4 | exact (default) | 169 | 1075 | 6.51 GB |
| M4 | `--flash-head` | **218** | 1075 | 6.69 GB |
| M5 Pro | exact (default) | 359 | 3773 | 6.73 GB |
| M5 Pro | `--flash-head` | **395** | 3857 | 6.92 GB |

## Convert

```sh
python -m mlx_lm.ternary /path/to/maple-bf16 -o maple-2bit-mlx --flash-head
```

Streams shard by shard — the 38 GB bf16 source is never fully resident.
`--flash-head` runs ~2 min of k-means over vocabulary-cluster centroids and
scores only the top 512 clusters exactly; greedy is exact whenever the true
argmax is in a probed cluster. `--group-scales` expands `row_alpha` per group
(+0.6 GB) for generic quantized-checkpoint tooling.

## Diff vs upstream mlx-lm

| file | what |
| --- | --- |
| `mlx_lm/models/maple.py` | the model (also bundled into every converted checkpoint) |
| `mlx_lm/ternary.py` | bf16 → ternary converter + FlashHead generator |
| `mlx_lm/server.py` | `--flash-head`, `--adapter-path`, `/v1/score` candidate scoring |
| `mlx_lm/speculative*.py`, `maple_draft.py` | speculative decode + draft models |
| `tests/test_maple_kernels.py` | kernel + precision self-check |
| `dream-chat/` | the Hemlock workstation itself |
| `setup.sh` | uv venv + editable install |
