# Getting started with Hemlock

[README](../README.md) · [Workspace controls](gui-workspace.md) ·
[Contributing](../CONTRIBUTING.md)

## What you are installing

Hemlock is a source-checkout workstation for macOS on Apple Silicon.
The Python runtime and Electron frontend are installed separately.
`Hemlock.app` is a launcher for the repository beside it, not a bundled
application with its own dependencies or model.

Use native arm64 Node.js and Python on Apple Silicon. The frontend lockfile
records the current dependency set; no Node major is declared by
`dream-chat/package.json`. Check the installed dependencies' engine requirements
if npm reports an unsupported runtime. Do not use a Rosetta terminal for
the frontend install.

## Install from the repository root

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and
[Node.js](https://nodejs.org/en/download) before these commands:

```sh
git clone https://github.com/RasputinKaiser/Hemlock-Local-AI.git
cd Hemlock-Local-AI
./setup.sh
source .venv/bin/activate
uv pip install huggingface_hub
hf download deepgrove/maple-2bit-mlx --local-dir maple-2bit-mlx
cd dream-chat
npm ci
npm run build
cd ..
```

`setup.sh` creates `.venv` with Python 3.12 if it does not exist, then installs
the local mlx-lm package in editable mode and `rich`. It neither installs
frontend dependencies nor builds the UI nor downloads weights. The `hf`
download CLI is installed separately above. Model downloads need network
access, free disk space, and any access required by the model publisher.

Review the checkpoint's code and provenance before running it. The CLI example
and desktop server use `trust_remote_code`, which permits model-supplied code;
local inference does not make downloaded code inherently safe.

## Launch and confirm

Keep `Hemlock.app` alongside `dream-chat/` and `scripts/`, then double-click
it. Alternatively, from the repository root:

```sh
./"Launch Hemlock.command"
```

The default launcher uses `dream-chat/dist/index.html` and the installed Electron
binary. It does not start Vite or rebuild stale output for you. After frontend
source changes, run `npm run build` in `dream-chat/` again.

The launcher automatically starts Maple and checks port 8080 for an existing
`mlx_lm` listener, which it may terminate. Stop any intentional inference
server before using this launcher. Other processes on that port are left alone.

Open Settings to inspect dependency/model status, then try an ordinary chat.
Inspect Activity and Receipts for the resulting evidence. Opening the UI
alone is not evidence that the model loaded or a training run passed.
Start with supervised work and review approvals before allowing repository
edits or training.

For development with hot reload and model autostart, from the repository root:

```sh
./scripts/launch-hemlock.zsh --repo-root "$PWD" --dev
```

`cd dream-chat && npm run desktop` also starts the Vite/Electron development
pair, but does not set the launcher's model-autostart environment by itself.

## Model, interpreter, and data paths

The Electron host checks these interpreter candidates in order and selects
the first existing path:

1. `HEMLOCK_PYTHON`
2. `MAPLE_PYTHON`
3. `~/Models/Hemlock/runtime/bin/python`
4. The checkout's `.venv/bin/python`

It selects the first model candidate that looks like a checkpoint:

1. `HEMLOCK_MODEL_PATH`
2. `MAPLE_MODEL_PATH`
3. `~/Models/Hemlock/maple-2bit-mlx`
4. The checkout's `maple-2bit-mlx/`

The checkpoint probe checks for `config.json`, safetensors weights, and tokenizer
files; actual load/inference can still fail. If an older shared runtime or model
is selected unexpectedly, launch from a terminal with explicit absolute paths:

```sh
HEMLOCK_PYTHON="$PWD/.venv/bin/python" \
HEMLOCK_MODEL_PATH="$PWD/maple-2bit-mlx" \
./"Launch Hemlock.command"
```

Runtime data defaults to `~/Library/Application Support/Hemlock`.
`HEMLOCK_DATA_DIR` overrides the host's data root; the launcher still keeps its
launch lock in the default Application Support location.
Launch output goes to `~/Library/Logs/Hemlock/launch.log`.
Back up runtime data before changing it, and avoid publishing chats, receipts,
private workspaces, adapters, or model weights.

## Troubleshooting

| Symptom | Check and recovery |
| --- | --- |
| `uv not found` | Install uv, reopen the terminal, and run `uv --version` before retrying `./setup.sh`. |
| `hf: command not found` | Activate `.venv`, then install `huggingface_hub` with `uv pip install huggingface_hub`. |
| Finder launch cannot find npm | Read `launch.log`; confirm Node/npm is installed natively. A terminal launch can use `HEMLOCK_NPM` with an absolute npm executable path. |
| Frontend dependencies or Electron missing | Run `npm ci` in `dream-chat/`; do not delete or regenerate the lockfile as a first response. |
| Built UI missing, or changes absent | Run `npm run build` in `dream-chat/`, then relaunch; double-click mode consumes the built bundle. |
| Native bundler architecture error | Check `node -p process.arch` reports `arm64`, use a native terminal, and rerun the locked frontend install. |
| Model fails to load | Check the selected model/interpreter and dependency status in Settings. Confirm download completion and the checkpoint files; inspect the reported server error. |
| Port 8080 busy | Inspect the owner before stopping anything. The launcher leaves non-mlx-lm listeners alone and may terminate mlx-lm listeners. |
| Python test path not found | Run from the repository root: tests are under `tests/`, not `mlx_lm/tests/`. |

## Verification boundaries

See [Contributing](../CONTRIBUTING.md#hemlock-verification) for commands.
`npm run verify:agent` runs host tests, renderer tests, and the UI build.
Optional [GUI smoke checks](gui-workspace.md#verification) use isolated app
data with model autostart disabled.

Inference tests can load a test model from Hugging Face and need compatible
MLX hardware. Kernel and training checks are distinct. The current
`.github/workflows/pull_request.yml` jobs are conditional on the upstream
repository name and skip this fork; do not treat their workflow conclusion
as a passed Hemlock runtime gate.
