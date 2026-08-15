# Maple · dream chat

Local desktop-style chat UI for the Maple MLX server. It is intentionally
separate from the Python model package so UI work does not modify model code.

## Hemlock Agent Cockpit

The default Electron surface is an agent-first operating environment rather
than a chat transcript. The Command Center opens as a persistent cockpit with
workstreams on the left, the active \`Intent → Recall → Work → Verify →
Remember\` lifecycle in the central workbench, and a right-side evidence/context
ledger. A bottom command console, event spine, Dream/SIPS activity panel, and
runtime heartbeat keep the next bounded action visible while work continues.

The cockpit is a projection of the Electron-owned runtime: task state,
context quality, Computer History/OpenChronicle observations, receipts, memory
candidates, SIPS state, Dream state, and local inference readiness. It does not
invent completion from window state. Secondary surfaces remain available from
the Understory dock and command palette, and the narrow layout stacks the same
surfaces at the app's minimum desktop width.

Chat/Code keeps the familiar conversational flow inside that operating surface.
Casual requests such as `hey how are ya?` become durable conversation tasks and
run without an unnecessary plan-approval ceremony; coding and operational
requests use the bounded plan gate. New intents are serialized through the
Electron FIFO queue, while `steer:` updates are recorded immediately against the
active task and take effect at the next bounded decision. The live chat pane
shows Maple's exact emitted channels by default, labeled as `content`,
`reasoning`, `work_note`, or the original field name Maple returned. Host
telemetry, exact structured action proposals, raw-output references, repair and
fallback decisions, command output, observations, and receipts appear beside
the model response rather than replacing it. Any manual collapse is presentation
only: the full channel text and raw record remain durable. Conversation uses
adaptive 320/512/768 token budgets, and ordinary conversation focuses Chat
instead of opening the Command Center. Chat metadata, trace rows, timestamps,
status labels, and the composer placeholder use a darker moss hierarchy against
the paper surface so supporting text remains legible without competing with the
conversation title.

## Hemlock OS Live Workspace v3

The current live-workspace slice keeps Hemlock's free-floating desktop while
moving the risky seams into bounded, testable contracts:

- `src/windowManager.js` owns `hemlock.window.state.v2`: preferred/minimum
  dimensions, canvas clamping, all-edge/corner resizing, collision-aware
  opening, 16px snapping with Option bypass, compact z-order, exact
  maximize/restore bounds, keyboard placement, legacy v2 migration, and the
  narrow stacked fallback. `WindowFrame.jsx` renders a full title bar and
  pointer-capture resize handles rather than a single corner handle.
- Normal Maple conversation requests use Electron-owned OpenAI-compatible SSE
  streaming. `stream_protocol.cjs` handles split UTF-8/SSE records through
  `[DONE]`; the bridge exposes ordered `hemlock.agent.stream.v1` frames and
  durable stream lifecycle/checkpoint events. Unsupported streaming responses
  are marked as buffered fallback. Cancellation and `steer:` abort late work;
  steering restarts within the same task context without duplicating displayed
  text. Child verification output uses the same ordered stdout/stderr lanes.
- Artifact Studio is task-scoped. `artifact_registry.cjs` stores source and
  revision manifests below Hemlock Application Support, records parent/digest/
  evidence, keeps source out of the repository, and exports only to the
  existing approval-gated change-set boundary. The renderer peeks the first
  complete artifact without changing the active composer focus and keeps the
  last complete revision while a new source revision is incomplete. Desktop
  layout gives Live Preview the primary column, keeps Output/Inspection in a
  bounded evidence row, and offers a Focus preview mode. The whole Studio
  surface scrolls when the frame is shorter than the complete workspace; the
  Source/Diff and Diff/Preview dividers are draggable, the Output/Inspection
  divider is draggable, and all three dividers also support arrow-key resizing.
  Narrow layouts use Source/Diff/Preview/Output/Inspect tabs and keep the same
  scrollable surface without trapping the user in clipped lower panels.
- Preview is an isolated iframe with a restrictive CSP and only typed harness
  messages. Electron's `preview_policy.cjs` authorizes registered actions,
  enforces action/retry/screenshot/time budgets, records DOM/accessibility
  digests and preview-only interaction receipts, blocks hidden screenshots, and
  has no arbitrary JavaScript evaluation path. Browser mode is labeled as a
  non-runtime visual preview.
- Newsreader, DM Sans, and DM Mono are bundled through `@fontsource`; there is
  no runtime Google Fonts request. Readable paper surfaces are opaque, Dream
  retains its dark indigo treatment, operational body copy is raised to a
  readable size, dynamic numbers use tabular numerals, and interactive motion
  uses specific interruptible transitions with reduced-motion coverage.

The focused contract checks are:

```sh
cd dream-chat
npm run test:agent
npm run test:ui
npm run build
npm run test:e2e:artistic-fixture
npm run test:e2e:artistic-maple
```

Runtime artifacts, model weights, adapters, datasets, receipts, preview
evidence, and event ledgers remain under
`~/Library/Application Support/Hemlock/`; this worktree only contains source,
tests, documentation, and generated build output ignored by Git. The full
Maple-backed artistic task proof and target-M1 timing gates are tracked in the
root `state.yaml` and are not considered complete until the Electron runtime
audit produces their receipts.

## Run in a browser

From this directory:

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>.

## Run as an Electron window

With the Maple server already running on `127.0.0.1:8080`:

```bash
npm run desktop
```

The app uses the local OpenAI-compatible `/v1/chat/completions` endpoint. Facts
are stored in browser/Electron local storage. In the Electron desktop build,
Dream pauses the local server, creates a timestamped supervised dataset from
the facts you explicitly saved and a small recent conversation slice, runs MLX
LoRA fine-tuning, then restarts Maple. The base checkpoint is never overwritten;
the resulting adapter is sent on later chat requests and remains local to this
Mac. The Dream overlay shows live stage, elapsed time, trainer output, and a
heartbeat while the checkpoint is loading.

Dream has three explicit local training profiles: `smoke` (one step for
liveness), `balanced` (four steps for the normal update), and `quality` (eight
steps for a slower candidate). Each desktop run writes a dataset manifest,
loss/validation telemetry, and before/after SHA-256 manifests for the base
`.safetensors` files. The adapter is not activated unless the training receipt
proves that the base-weight digest stayed unchanged. A training receipt is
isolation and execution proof, not a general claim that the model got better.

The browser build keeps a memory-only preview because a browser tab cannot
spawn the local MLX trainer. For the real Dream workflow, run the desktop app
with the model environment available:

```bash
MAPLE_AUTOSTART_SERVER=1 npm run desktop
```

The desktop runtime keeps large artifacts out of the Git worktree. By default
it looks for the MLX checkpoint at `~/Models/Hemlock/maple-2bit-mlx` and the
small local Python runtime at `~/Models/Hemlock/runtime`. Override either
location with `HEMLOCK_MODEL_PATH` or `HEMLOCK_PYTHON`. Dream refuses to begin
when the volume has less than 10 GiB free; configure that floor with
`HEMLOCK_MIN_FREE_BYTES` if the local machine needs a different budget.

For model downloads, use one-worker HTTPS hydration when XET is unavailable or
causes a stalled transfer:

```bash
HF_HUB_DISABLE_XET=1 hf download deepgrove/maple-preview-2bit-mlx \
  --local-dir "$HOME/Models/Hemlock/maple-2bit-mlx" --max-workers 1
```

The full-precision `deepgrove/maple-preview` and GGUF variants are not used by
this MLX Dream path; they are much larger and would unnecessarily duplicate
storage on a local development machine.

## Hemlock SIPS control center

The desktop app also includes a local, Hemlock-native SIPS subset. Open the
`SIPS` control center to inspect the current worktree, recall candidate lessons,
run a bounded verification profile, and start or pause a persistent self-loop
focus. The `Run one local SIPS cycle` action is the real coding-adaptation path:

1. capture the latest completed user/assistant coding turns as a dataset;
2. run the selected baseline command;
3. fine-tune a new LoRA adapter with Dream;
4. compare base and candidate responses on the improvement target;
5. run the verification command again and write a receipt under `sips-runs/`.

The SIPS cycle defaults to the `balanced` Dream profile. The control center
shows the chosen profile, dataset holdout status, final loss values, base-weight
integrity, model-response comparison, and verification result together so a
candidate can be judged on more than “training finished.”

SIPS receipts and lessons are local and candidate-first. They do not claim that
the model improved generally, that a source patch was applied, or that a lesson
is safe to reuse until the associated evidence supports that claim. The browser
surface renders the control center for review but does not expose local file or
command execution.
