# Maple on mlx-lm

## Hemlock OS local agent surface

The `dream-chat/` application is the Hemlock operating environment for Maple,
SIPS, and local project work. It is an Electron shell with a React/Vite renderer,
but Electron main owns the agent state: tasks, operations, budgets, cancellation,
context policies, candidates, memory transitions, training state, and receipts.
The renderer consumes the durable projection instead of inventing a second task
state from UI booleans.

### One-click macOS launch

Double-click [`Hemlock.app`](Hemlock.app) at the repository root. It starts the
Vite desktop surface, opens the Electron window, and autostarts Maple-Preview
through the local MLX runtime. The app bundle is intentionally kept beside the
worktree so it can resolve `dream-chat/`; a Finder alias is safe if you want a
shortcut elsewhere. The terminal-friendly fallback is [`Launch Hemlock.command`](Launch%20Hemlock.command).
Startup output is recorded at `~/Library/Logs/Hemlock/launch.log`, duplicate
launches are ignored, and Apple Silicon launches the universal Python runtime
as arm64 so the MLX extension and interpreter use the same architecture.

### Host-orchestrated Maple action loop

The current strong-agent tranche adds an Electron-owned `AgentOrchestrator` on
top of the kernel. An intent now creates a durable plan and pauses at
`waiting_for_approval`. After approval, Maple can propose one structured action
at a time. The host validates the action against the registered command IDs,
scope, budget, timeout, and approval class; executes at most one bounded
operation; records a compact observation with an output digest and evidence
references; then asks Maple for the next action. Prose is never interpreted as
an executable command. One invalid action response may be repaired once; a
second invalid response blocks the task.

The durable projection now includes `plans`, `actions`, and `observations` in
addition to tasks, operations, episodes, candidates, sources, memory, and
training state. Cancellation is terminal: late worker callbacks cannot rewrite
cancelled actions or tasks as successful. Default execution budgets are eight
agent steps, twelve commands, two retries per operation, one mutation set, no
automatic training cycles, and a ten-minute wall-clock ceiling.

Ordinary conversation stays ordinary conversation. Creation verbs such as
“make” or “build” do not create a plan by themselves; the intent router waits
for a concrete software or artifact signal such as `animation`, `HTML`,
`canvas`, or `SVG`. Once a coding request is explicit, the plan gate remains
visible and approval-bound. If local Maple returns malformed structured output,
the host records the failure and may continue only with the next already
approved artifact step; a complete revision is marked `previewable` and the
fallback is recorded as `authoring.host_fallback`. The host owns action IDs and
recovers balanced JSON envelopes surrounded by local-model prose, so stale
placeholder IDs and harmless prose cannot corrupt the durable action trace.

Maple output is model-verbatim in Chat. Electron preserves every emitted string
channel from SSE or buffered responses, including `content`, `reasoning`,
`work_note`, and any other field name Maple actually returns. Each channel is
labeled as Maple output, remains visible by default, and is durable beside a
raw-output reference and digest. The host's elapsed time, token usage, adapter,
stop reason, action validation, repair, fallback, command output, observation,
and receipt state are separate host detail; they never replace the model's
response with a generated completion summary. Conversation uses adaptive 320,
512, or 768 token budgets based on the request.

Artifact Studio is a task-local live workspace, not a repository editor. Its
source, diff, isolated preview, output/console, and inspection panels remain
scrollable and resizable, while the preview is a browser-mode visual sandbox
with no network, host access, or arbitrary evaluation. The renderer exposes
the latest complete revision while source is still streaming, and every
revision carries a parent, digest, status, and evidence references.

Read-only coding tools include repository inspection, bounded file read/search,
git status/diff, test discovery, verification profile listing, and receipt
inspection. Personal context uses a common source adapter contract; disabled
lanes return `not_enabled` and contribute no observations. Computer History,
the local project, and OpenChronicle retain source, freshness, confidence,
redaction, and retention metadata.

The fixed tool-use harness is at
`dream-chat/evals/tool-use/benchmark.json` and contains eleven task families,
including plan approval, recovery, source consent, Dream's explicit training
gate, and cancellation/restart recovery. Run its fixture checks and baseline
report with:

```sh
cd dream-chat
npm run test:agent
npm run eval:agent
npm run verify:agent
```

The empty-trace evaluation output is only a harness baseline. Actual Maple
quality is not claimed until a structured-action trace is run against the fixed
holdout. Dream remains actual MLX LoRA weight training, but training is not part
of automatic plan execution and a candidate adapter remains unactivated until
the measured tool-use and safety gates pass.

The deterministic artistic acceptance lane is local and repeatable:

```sh
cd dream-chat
npm run test:e2e:artistic-fixture
```

It records a conversational stream with three Maple channels, an approved
artifact plan, watchable HTML/CSS animation source, desktop and narrow preview
snapshots, inspection and interaction receipts, one detected issue and bounded
repair, revision parent/new digests, a failed revision with the last complete
revision preserved, structured prose around an action envelope, and late-callback
cancellation proof. The real Maple lane is intentionally reported separately:

```sh
npm run test:e2e:artistic-maple
```

That runner never marks the artistic workflow complete unless the actual local
Maple endpoint reaches the full conversation → artifact → preview → revision
terminal receipt. Its raw channels, parse/fallback state, elapsed time, and stop
reason are written under Hemlock Application Support.

The default desktop is organized around the agent's work rather than a chat
transcript:

- `Now / Next / Why` keeps the foreground task, the recommended bounded action,
  and the evidence stack visible together.
- `Ambient Inbox` turns enabled local observations into reviewable candidates.
  Observations, hypotheses, and accepted decisions remain separate.
- `Chat / Code` follows intent → plan → inspect → prepare → verify → approve →
  apply → remember. Prepared change sets are approval-gated and produce a local
  command trace and receipt.
- `Memory Garden` keeps project lessons candidate-first and provenance-bearing.
  Promotion, demotion, conflict, and rollback are append-only transitions.
- `Dream Lab` prepares a dataset and holdout, then waits for explicit training
  initiation before running actual MLX LoRA weight training. Training completion
  remains a candidate result until inference and verification evidence pass.
- `SIPS`, `Activity`, `Receipts`, `Project Map`, `Storage`, and `Settings` are
  real surfaces backed by the same Electron command registry.

Personal context is local and opt-in by source. Computer History and
OpenChronicle provide freshness-checked, redacted context when enabled; local
notes, calendar, and mail/message lanes are disabled until explicitly enabled.
Raw screen content is not silently promoted into project memory or training
data.

Runtime artifacts are kept outside the Git worktree by default:

```text
~/Library/Application Support/Hemlock/
  models/ adapters/ datasets/ receipts/ events/ context/ caches/ workspaces/
```

The application migrates legacy `sips-runs/` data forward without deleting the
old copy. The Settings surface reports model, runtime, and free-space inventory;
cleanup remains an explicit operation and protects active or provenance-linked
artifacts.

Run the renderer build and the focused durable-kernel tests with:

```sh
cd dream-chat
npm run build
npm run test:agent
```

The browser mode is a visual preview. Local inference, context adapters, SIPS,
Dream training, and runtime receipts are Electron-only capabilities.

Maple is a 20B-A1B ternary MoE with 24 layers, 256 experts, top-8, 512-token sliding
window on 3 of every 4 layers. Weights are 2-bit packed `{-α, 0, +α}`, one α per
row. 

This fork runs on the stock MLX build for portability. We intend to release a faster custom
library in the coming days.

## Setup

Requires Apple Silicon and [uv](https://docs.astral.sh/uv/).

```sh
git clone git@github.com:deepgrove-ai/mlx-lm-deepgrove.git
cd mlx-lm-deepgrove
./setup.sh
source .venv/bin/activate
hf download deepgrove/maple-2bit-mlx --local-dir maple-2bit-mlx
```

## Run

```sh
python -m mlx_lm generate --model ./maple-2bit-mlx --trust-remote-code --flash-head \
  --prompt "Write a haiku about a grove." --temp 1.0 --top-p 0.95 --top-k 20

python -m mlx_lm chat --model ./maple-2bit-mlx --trust-remote-code --max-tokens -1 \
  --temp 1.0 --top-p 0.95
```

Enable flash head for extra speed.
```sh
python -m mlx_lm chat --model ./maple-2bit-mlx --trust-remote-code --max-tokens -1 \
  --temp 1.0 --top-p 0.95 --flash-head
``` 

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

Streams and converts shard by shard, so the 38 GB bf16 source is never fully resident.

- `--flash-head` — ~2 min of k-means, score 4748
  vocabulary-cluster centroids, then compute exact logits only for the top 512
  clusters (special tokens always scored). Greedy is exact whenever the true
  argmax is in a probed cluster. Attach to an already-converted
  directory with `python -m mlx_lm.ternary maple-2bit-mlx --flash-head-only`
  (rewrites in place; point it at a real directory, not hardlinks).
- `--group-scales` — repeat each row's α across every group (+0.6 GB), only for
  tools that read MLX quantized checkpoints generically. Default stores the row
  scale once as `row_alpha`; `sanitize()` expands it at load.

## Diff vs upstream mlx-lm

| file | what |
| --- | --- |
| `mlx_lm/models/maple.py` | the model (also copied into every converted checkpoint) |
| `mlx_lm/ternary.py` | bf16 → ternary converter + FlashHead generator |
| `tests/test_maple_kernels.py` | kernel + precision self-check — `pytest tests/test_maple_kernels.py -v` |
| `generate.py`, `chat.py`, `server.py`, `benchmark.py` | support for `--flash-head` flag |
| `setup.sh` | uv venv + editable install |
