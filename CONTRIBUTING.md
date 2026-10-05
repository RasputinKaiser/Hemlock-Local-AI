# Contributing to Hemlock

We want to make contributing to this project as easy and transparent as
possible. Hemlock includes both the Electron workstation in `dream-chat/`
and a fork of mlx-lm in `mlx_lm/`; choose checks for the area you change.

## Local setup

Use the [getting-started guide](docs/getting-started.md) for the Apple Silicon
Python environment, model download, and separate frontend installation.
The [workspace guide](docs/gui-workspace.md) covers UI behavior and optional GUI
smoke setup. A frontend-only change can run host/renderer tests without
downloading Maple; live inference and training are separate checks.

## Hemlock verification

From the repository root, install the frontend lockfile and run its gate:

```sh
cd dream-chat
npm ci
npm run verify:agent
```

`verify:agent` runs host tests, renderer tests, and the production UI build.
For a focused iteration, use `npm run test:agent` or `npm run test:ui`.
Optional real-Electron smoke instructions are in
[workspace verification](docs/gui-workspace.md#verification).

For Python changes, activate the repository `.venv` and run the relevant tests
from the repository root, not from `dream-chat/`. The server suite uses
`requests`, MLX, and a Hugging Face test model:

```sh
source .venv/bin/activate
uv pip install requests
python -m unittest discover -s tests -p 'test_server.py'
```

Use broader Python coverage when the change needs it; the existing model-porting
instructions below include full discovery. Apple Silicon inference, Metal
kernels, and training need their own actual results. The current GitHub
`Build and Test` jobs are restricted to `ml-explore/mlx-lm` and skip this fork.

Keep changes scoped. Preserve the host-owned command validation, workspace
boundaries, explicit training approval, and receipt provenance. Do not include
local chats, receipts, adapters, model weights, private paths, or credentials
in a PR or public bug report. Report command, exit status, hardware where
relevant, and skipped checks; a build alone is not a live-model test.

## Pull Requests

1. Fork and submit pull requests to the repo.
2. If you've added code that should be tested, add tests.
3. Every PR should have passing tests and at least one review.
4. For code formatting install `pre-commit` using something like `pip install pre-commit` and run `pre-commit install`.
   The checked-in configuration runs `black` and `isort` for Python code.

   You can also run the formatters manually as follows on individual files:

     ```bash
     black file.py
     ```

     or,

     ```bash
     # single file
     pre-commit run --files file1.py

     # specific files
     pre-commit run --files file1.py file2.py
     ```

   or run `pre-commit run --all-files` to check all files in the repo.
5. Describe which Hemlock/Python checks ran and which still need hardware or GUI verification.

## Issues

We use GitHub issues to track public bugs. Please ensure your description is
clear and has sufficient instructions to be able to reproduce the issue.

## License

By contributing to mlx-lm, you agree that your contributions will be licensed
under the LICENSE file in the root directory of this source tree.

## Adding New Models

Below are some tips to port LLMs available on Hugging Face to MLX.

From this directory, do an editable install:

```shell
pip install -e .
```

Then check if the model has weights in the
[safetensors](https://huggingface.co/docs/safetensors/index) format. If not
[follow instructions](https://huggingface.co/spaces/safetensors/convert) to
convert it.

After that, add the model file to the
[`mlx_lm/models`](mlx_lm/models)
directory. You can see other examples there. We recommend starting from a model
that is similar to the model you are porting.

Make sure the name of the new model file is the same as the `model_type` in the
`config.json`, for example
[starcoder2](https://huggingface.co/bigcode/starcoder2-7b/blob/main/config.json#L17).

To determine the model layer names, we suggest either:

- Refer to the Transformers implementation if you are familiar with the
  codebase.
- Load the model weights and check the weight names which will tell you about
  the model structure.
- Look at the names of the weights by inspecting `model.safetensors.index.json`
  in the Hugging Face repo.

To add LoRA support edit
[`mlx_lm/tuner/utils.py`](mlx_lm/tuner/utils.py)

Finally, add a test for the new model type to the [model
tests](tests/test_models.py).

You can run the tests with:

```shell
python -m unittest discover tests/
```
