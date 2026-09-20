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
action at a time. The host validates it against a registry of ~90 allowlisted
commands, executes one bounded operation, records an observation with evidence
references, and asks for the next step. Prose is never executed.

- **Graduated autonomy** — `supervised` (approve every plan) → `guided` (plans
  auto-approve; sandboxed artifact/preview commands run unclicked) →
  `autonomous`/`campaign:` (everything except training, which always stays
  explicit). Budgets, allowlists, and receipts bind at every level.
- **Full control mid-run** — pause at a step boundary, resume without losing
  state, `steer:` injects guidance into the next decision, cancel is terminal.
- **Scored action selection** — `/v1/score` teacher-forces candidate action
  envelopes against a shared prefilled KV cache and picks the argmax, instead
  of generating JSON autoregressively. Complete envelopes execute with zero
  generated tokens (structurally incapable of invalid JSON); prefix winners
  fall through to generation only for free fields.
- **Self-describing** — `agent.capabilities` returns the live command registry
  with input contracts; every command carries an `inputHint`; failed actions
  return actionable recovery hints, not dead ends.
- **Self-improving** — Maple can read this repo, `improve.propose` a bounded
  change (receipt'd, never auto-applied), `code.apply` it under an approved
  plan, `verify` with real build/test profiles, and `remember` the lesson.

## The Grove

Maple exists as a hooded figure in a 3D world (`dream-chat/src/groveScene.js`).
`experiment.run` executes deterministic physics sims (pendulum, projectile,
orbit, spring, collision, terminal) in a bounded sandbox — each run emits a
receipt **and** a trail of real integration samples that the grove replays at
Maple's lab bench while Maple physically works. Findings feed the Dream
dataset. World → experiment → receipt → finding → dataset → adapter → behavior.

## Dream training → graft → fuse

Dream Lab prepares a token-budgeted dataset (splits oversized rows, records
trimming metadata, deterministic holdout) and runs real MLX LoRA training with
isolated adapters and base-weight provenance. A verified adapter can be:

- **grafted** — served via `--adapter-path`, detachable (`dream.detach`),
- **fused** — `dream.fuse` merges it into a *new* checkpoint and serves that;
  the base stays on disk as a free rollback,
- **promoted by SIPS** — after a base-vs-adapter comparison lane decides.

Base weights are hashed before/after every run as provenance; mutation is an
explicit, auditable act — never silent.

## Surfaces

Chat · Artifact Studio (versioned live previews, sandboxed) · Command Center
(host loop, intent queue, metrics) · Understory Grove · Dream Lab · Memory
Garden · SIPS · Activity · Receipts · Project Map · Settings. Ordinary
conversation stays ordinary — creation verbs alone don't trigger plans.

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
npm run test:agent      # host harness: orchestrator, queue, contracts, receipts
npm run test:ui         # renderer projection tests
npm run verify:agent    # all of the above + production build
node scripts/gui-electron-smoke.mjs   # real-Electron end-to-end checks
```

Maple is a 20B-A1B ternary MoE — 24 layers, 256 experts, top-8, 512-token
sliding window on 3 of 4 layers, 2-bit packed `{-α, 0, +α}` weights.

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
