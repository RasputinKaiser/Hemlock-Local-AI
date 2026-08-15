#!/usr/bin/env python3
"""Run one consented local Maple Dream fine-tuning job.

The Electron process owns the lifecycle and displays the JSONL progress emitted
here. The base model is never overwritten: MLX writes a LoRA adapter beneath
the timestamped dream run directory.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


TRAINING_PROFILES = {
    "smoke": {
        "iters": 1,
        "num_layers": 1,
        "description": "One-step liveness check; useful for plumbing, not quality claims.",
    },
    "balanced": {
        "iters": 4,
        "num_layers": 1,
        "description": "A repeatable local update with enough steps to inspect loss movement.",
    },
    "quality": {
        "iters": 8,
        "num_layers": 1,
        "description": "A longer local pass for a stronger candidate; still requires held-out evaluation.",
    },
}


def emit(stage, progress, log="", **extra):
    print(json.dumps({"stage": stage, "progress": progress, "log": log, **extra}), flush=True)


def validate_model_path(model_path):
    """Return a resolved model directory without ever treating it as an output."""
    model = Path(model_path).resolve()
    if not model.is_dir():
        raise FileNotFoundError(f"Maple-Preview base model directory was not found: {model}")
    return model


def validate_run_dir(run_dir, model):
    """Keep Dream's generated files outside the immutable base model tree."""
    run_dir = Path(run_dir).resolve()
    model = Path(model).resolve()
    if run_dir == model or model in run_dir.parents:
        raise ValueError(
            "Dream run directory must be outside the Maple-Preview base model directory."
        )
    return run_dir


def python_runtime_env():
    """Bypass slow/stale venv .pth startup while keeping the same packages."""
    repo_root = Path(__file__).resolve().parents[2]
    # Do not resolve the venv's python symlink here. With Python 3.12 and
    # ``-S``, resolving it jumps to the system interpreter and silently drops
    # the venv site-packages (including mlx). The launcher path itself is the
    # reliable venv root.
    venv_root = Path(sys.executable).parent.parent
    site_packages = list(sorted((venv_root / "lib").glob("python*/site-packages")))
    # ``-S`` suppresses the normal site initialization, including the
    # system-site-packages path promised by pyvenv.cfg. Add that base path
    # explicitly so MLX and MLX-LM remain available to the child trainer.
    config_path = venv_root / "pyvenv.cfg"
    try:
        config = config_path.read_text(encoding="utf-8")
        include_system = re.search(r"^include-system-site-packages\s*=\s*true\s*$", config, re.IGNORECASE | re.MULTILINE)
        home = re.search(r"^home\s*=\s*(.+)$", config, re.MULTILINE)
        if include_system and home:
            base_root = Path(home.group(1).strip()).resolve().parent
            site_packages.extend(sorted((base_root / "lib").glob("python*/site-packages")))
    except OSError:
        pass
    python_path = [str(repo_root), *(str(item) for item in site_packages)]
    if os.environ.get("PYTHONPATH"):
        python_path.append(os.environ["PYTHONPATH"])
    return {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONPATH": os.pathsep.join(python_path)}


def choose_adapter_dir(run_dir):
    """Choose a fresh adapter output directory without replacing an older adapter."""
    run_dir = Path(run_dir).resolve()
    candidate = run_dir / "adapters"
    if not candidate.exists() or not any(candidate.iterdir()):
        return candidate

    suffix = time.strftime("%Y%m%dT%H%M%S", time.localtime())
    counter = 0
    while True:
        name = f"adapters-{suffix}-{time.time_ns()}"
        if counter:
            name = f"{name}-{counter}"
        fresh = run_dir / name
        if not fresh.exists():
            return fresh
        counter += 1


def write_json(path, payload):
    Path(path).write_text(
        f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def base_weight_manifest(model_path):
    """Hash the immutable base weight files so a run can prove isolation."""
    model_path = Path(model_path).resolve()
    files = sorted(model_path.glob("*.safetensors"))
    if not files:
        raise FileNotFoundError(f"No safetensors base weights were found in {model_path}")
    entries = []
    for file_path in files:
        entries.append(
            {
                "path": str(file_path.relative_to(model_path)),
                "size": file_path.stat().st_size,
                "sha256": sha256_file(file_path),
            }
        )
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "schema": "hemlock.dream.base-weights.v1",
        "model": str(model_path),
        "files": entries,
        "digest": hashlib.sha256(canonical).hexdigest(),
    }


def resolve_training_config(payload):
    profile = str(payload.get("profile", "balanced")).strip().lower()
    if profile not in TRAINING_PROFILES:
        profile = "balanced"
    defaults = TRAINING_PROFILES[profile]
    iters = max(1, int(payload.get("iters", defaults["iters"])))
    num_layers = max(1, int(payload.get("numLayers", defaults["num_layers"])))
    return profile, iters, num_layers


ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def capture_training_metric(line, metrics, observations=None):
    """Collect loss and optimizer telemetry emitted by mlx_lm."""
    observations = observations if observations is not None else {}
    line = ANSI_ESCAPE.sub("", line).replace("\u001b", "").strip()
    trainable = re.search(
        r"Trainable parameters:\s*([0-9.]+)%\s*\(([0-9.]+)M/([0-9.]+)M\)",
        line,
        re.IGNORECASE,
    )
    if trainable:
        observations["trainableParameters"] = {
            "percent": float(trainable.group(1)),
            "trainableMillions": float(trainable.group(2)),
            "totalMillions": float(trainable.group(3)),
        }
        return
    validation = re.search(
        r"^\s*(\d+)\s+val\s+([0-9]+(?:\.[0-9]+)?)",
        line,
        re.IGNORECASE,
    )
    if validation:
        step = int(validation.group(1))
        record = next((item for item in metrics if item["step"] == step), None)
        if record is None:
            record = {"step": step}
            metrics.append(record)
        record["valLoss"] = float(validation.group(2))
        return
    train = re.search(
        r"^\s*(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:[▼▲])?",
        line,
        re.IGNORECASE,
    )
    if train:
        step = int(train.group(1))
        record = next((item for item in metrics if item["step"] == step), None)
        if record is None:
            record = {"step": step}
            metrics.append(record)
        record["loss"] = float(train.group(2))
        observations.setdefault("optimizerSteps", []).append(step)


def write_dataset(run_dir, facts, conversation, examples=None):
    prepared_examples = []
    for example in (examples or []):
        if not isinstance(example, dict):
            continue
        messages = example.get("messages")
        if not isinstance(messages, list) or len(messages) < 2:
            continue
        cleaned_messages = []
        for message in messages[-8:]:
            if not isinstance(message, dict) or message.get("role") not in {"user", "assistant", "system"}:
                continue
            content = str(message.get("content", "")).strip()
            if content:
                cleaned_messages.append({"role": message["role"], "content": content})
        if len(cleaned_messages) >= 2:
            prepared_examples.append({"messages": cleaned_messages, "metadata": example.get("metadata", {})})

    for fact in facts:
        text = str(fact).strip()
        if not text:
            continue
        prepared_examples.extend(
            [
                {"messages": [{"role": "user", "content": "What personal detail should you remember about me?"}, {"role": "assistant", "content": f"You should remember this about the user: {text}"}]},
                {"messages": [{"role": "user", "content": "Please use my saved personal details when they are relevant."}, {"role": "assistant", "content": f"I will keep this in mind: {text}"}]},
                {"messages": [{"role": "user", "content": "What should you keep in mind for future answers?"}, {"role": "assistant", "content": f"A saved detail is: {text}"}]},
            ]
        )

    # Include only recent, explicitly completed local turns. This gives Dream
    # a small amount of conversational style without baking the whole chat.
    for message in conversation[-6:]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        answer = str(message.get("content", "")).strip()
        if answer:
            prepared_examples.append({"messages": [{"role": "user", "content": "Answer in the same helpful style as our recent conversation."}, {"role": "assistant", "content": answer}]})

    if not prepared_examples:
        raise ValueError("Dream needs at least one saved fact or completed coding example before it can fine-tune.")

    # De-duplicate exact prompt/answer pairs before the split. Repeated copies
    # make a tiny run look healthier than it is and can leak into validation.
    source_count = len(prepared_examples)
    unique_examples = []
    seen = set()
    for example in prepared_examples:
        key = json.dumps(example.get("messages", []), ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        unique_examples.append(example)
    prepared_examples = unique_examples

    # Make validation deterministic while retaining enough repeated examples
    # for a tiny personal dataset. A one-example validation set is sufficient
    # for the short local run and avoids an empty validation iterator.
    validation_holdout = len(prepared_examples) >= 2
    valid = [prepared_examples[-1]]
    train = prepared_examples[:-1] or prepared_examples
    data_dir = run_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in (("train.jsonl", train), ("valid.jsonl", valid)):
        with (data_dir / name).open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    assistant_lengths = [
        len(str(message.get("content", "")))
        for row in prepared_examples
        for message in row.get("messages", [])
        if message.get("role") == "assistant"
    ]
    manifest = {
        "schema": "hemlock.dream.dataset.v1",
        "trainRows": len(train),
        "validRows": len(valid),
        "sourceRows": len(prepared_examples),
        "duplicatesRemoved": source_count - len(prepared_examples),
        "validationHoldout": validation_holdout,
        "assistantCharacters": sum(assistant_lengths),
        "assistantCharacterRange": {
            "min": min(assistant_lengths) if assistant_lengths else 0,
            "max": max(assistant_lengths) if assistant_lengths else 0,
        },
        "claimBoundary": "A one-row or non-holdout validation set measures liveness only; it is not generalization proof.",
    }
    write_json(data_dir / "manifest.json", manifest)
    return data_dir, len(train), len(valid), manifest


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Expected one JSON payload argument")
    payload = json.loads(sys.argv[1])
    run_dir = Path(payload["runDir"]).resolve()
    model_path = validate_model_path(payload["model"])
    run_dir = validate_run_dir(run_dir, model_path)
    model = str(model_path)
    facts = payload.get("facts", [])
    conversation = payload.get("conversation", [])
    coding_examples = payload.get("examples", [])
    profile, iters, num_layers = resolve_training_config(payload)
    started = time.monotonic()
    log_path = run_dir / "dream.log"
    run_dir.mkdir(parents=True, exist_ok=True)

    emit("validating local Dream paths", 5, "base weights are read-only; output is a new run", profile=profile)
    emit("hashing Maple base weights", 9, "capturing the before-training integrity manifest")
    before_manifest = base_weight_manifest(model_path)
    write_json(run_dir / "base-weights-before.json", before_manifest)
    emit("writing consented Dream dataset", 16, "facts and recent local turns")
    data_dir, train_count, valid_count, dataset_manifest = write_dataset(run_dir, facts, conversation, coding_examples)
    adapter_dir = choose_adapter_dir(run_dir)
    adapter_dir.mkdir(parents=True, exist_ok=True)
    emit("loading Maple checkpoint", 22, f"{train_count} training examples · {valid_count} validation example")

    command = [
        sys.executable,
        "-S",
        "-m",
        "mlx_lm",
        "lora",
        "--model",
        model,
        "--data",
        str(data_dir),
        "--train",
        "--fine-tune-type",
        "lora",
        "--num-layers",
        str(num_layers),
        "--batch-size",
        "1",
        "--iters",
        str(iters),
        "--val-batches",
        "1",
        "--steps-per-report",
        "1",
        "--steps-per-eval",
        "1",
        "--save-every",
        str(iters),
        "--max-seq-length",
        "256",
        "--adapter-path",
        str(adapter_dir),
        "--trust-remote-code",
        "--mask-prompt",
        "--grad-checkpoint",
        "--learning-rate",
        "1e-5",
    ]
    emit(
        "MLX fine-tuning is running locally",
        28,
        "the server is paused while the adapter is trained",
        profile=profile,
        iters=iters,
        numLayers=num_layers,
        command=" ".join(command[2:]),
    )
    env = python_runtime_env()
    metrics = []
    training_observations = {}
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=run_dir.parent.parent, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in process.stdout:
            clean = line.rstrip()
            log.write(clean + "\n")
            log.flush()
            # The upstream trainer emits progress after each step. Forward it
            # as the live log while the Electron heartbeat keeps the UI alive
            # during slow imports/checkpoint loading.
            if clean:
                capture_training_metric(clean, metrics, training_observations)
                emit("MLX fine-tuning is running locally", 45, clean[:220])
        code = process.wait()
    if code != 0:
        emit("Dream training failed", 100, f"exit code {code}; see {log_path}")
        raise SystemExit(code)
    emit("checking base-weight integrity", 86, "hashing the base checkpoint after training")
    after_manifest = base_weight_manifest(model_path)
    write_json(run_dir / "base-weights-after.json", after_manifest)
    base_weights_unchanged = before_manifest["digest"] == after_manifest["digest"]
    write_json(
        run_dir / "base-weights-unchanged.json",
        {
            "schema": "hemlock.dream.base-integrity.v1",
            "unchanged": base_weights_unchanged,
            "beforeDigest": before_manifest["digest"],
            "afterDigest": after_manifest["digest"],
        },
    )
    if not base_weights_unchanged:
        emit(
            "Dream training failed",
            100,
            "base-weight digest changed during training; adapter was not activated",
            baseWeightsUnchanged=False,
        )
        raise SystemExit(3)
    adapter_file = adapter_dir / "adapters.safetensors"
    adapter_config = adapter_dir / "adapter_config.json"
    missing = [str(path.name) for path in (adapter_file, adapter_config) if not path.is_file()]
    if missing:
        emit(
            "Dream training failed",
            100,
            f"adapter output is incomplete ({', '.join(missing)} missing); see {log_path}",
        )
        raise SystemExit(2)
    elapsed = round(time.monotonic() - started)
    adapter_artifact = {
        "path": str(adapter_file),
        "size": adapter_file.stat().st_size,
        "sha256": sha256_file(adapter_file),
        "nonEmpty": adapter_file.stat().st_size > 0,
    }
    training_receipt = {
        "schema": "hemlock.dream.training.v1",
        "profile": profile,
        "iters": iters,
        "numLayers": num_layers,
        "dataset": dataset_manifest,
        "metrics": sorted(metrics, key=lambda item: item["step"]),
        "trainingProof": {
            "command": command,
            "trainableParameters": training_observations.get("trainableParameters"),
            "optimizerStepsObserved": sorted(set(training_observations.get("optimizerSteps", []))),
            "adapterArtifact": adapter_artifact,
        },
        "adapterPath": str(adapter_dir),
        "baseWeightsUnchanged": True,
        "baseBeforeDigest": before_manifest["digest"],
        "baseAfterDigest": after_manifest["digest"],
        "elapsed": elapsed,
        "claimBoundary": "This proves an isolated local LoRA training run and base-weight integrity. It does not prove a general model-quality improvement.",
    }
    write_json(run_dir / "training-receipt.json", training_receipt)
    emit(
        "Dream complete — local adapter ready",
        92,
        f"saved {adapter_file}",
        elapsed=elapsed,
        adapterPath=str(adapter_dir),
        trainingReceipt=training_receipt,
        trainingReceiptPath=str(run_dir / "training-receipt.json"),
        baseWeightsUnchanged=True,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("Dream training failed", 100, str(error))
        raise
