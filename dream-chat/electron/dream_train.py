#!/usr/bin/env python3
"""Run one consented local Maple Dream fine-tuning job.

The Electron process owns the lifecycle and displays the JSONL progress emitted
here. The base model is never overwritten: MLX writes a LoRA adapter beneath
the timestamped dream run directory.
"""

import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


MAX_SEQ_LENGTH = 512
# Near-duplicate threshold on word-set Jaccard similarity. Two rows that share
# 85%+ of their normalized tokens teach the same thing; the second copy only
# inflates apparent dataset size.
NEAR_DUPLICATE_THRESHOLD = 0.85
# No single source may contribute more than this share of the final dataset
# when at least two sources are present — keeps a chat-heavy week from
# drowning out experiment and memory rows.
MAX_SOURCE_SHARE = 0.6
# Divergence guard: kill a run whose train loss goes non-finite or exceeds
# max(4x baseline, baseline + 10). The additive floor keeps tiny baselines
# (e.g. 0.001) from tripping on harmless jitter.
DEFAULT_MAX_LOSS_MULTIPLE = 4.0

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
    try:
        iters = max(1, int(payload.get("iters", defaults["iters"])))
    except (TypeError, ValueError):
        iters = defaults["iters"]
    try:
        num_layers = max(1, int(payload.get("numLayers", defaults["num_layers"])))
    except (TypeError, ValueError):
        num_layers = defaults["num_layers"]
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
        r"^\s*(\d+)\s+val\s+([0-9]+(?:\.[0-9]+)?|nan|inf)",
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
        r"^\s*(\d+)\s+([0-9]+(?:\.[0-9]+)?|nan|inf)\s*(?:[▼▲])?",
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


def detect_divergence(metrics, max_multiple=DEFAULT_MAX_LOSS_MULTIPLE):
    """Return a human-readable reason once a run has clearly diverged.

    Checked after every parsed training line. Trips on a non-finite loss, or
    on a train loss that exceeds max(max_multiple x first-observed loss,
    first-observed loss + 10) — the additive floor keeps near-zero baselines
    from tripping on noise. Validation loss only trips the guard when it is
    non-finite; a rising-but-finite val loss is a quality signal, not a crash.
    """
    baseline = None
    for record in metrics:
        for key in ("loss", "valLoss"):
            value = record.get(key)
            if value is None:
                continue
            if not math.isfinite(value):
                return f"non-finite {key} at step {record['step']}"
        value = record.get("loss")
        if value is None:
            continue
        if baseline is None:
            baseline = value
        elif record["step"] > 1 and value > max(baseline * max_multiple, baseline + 10.0):
            return (
                f"train loss {value:.3f} exceeded {max_multiple}x baseline "
                f"{baseline:.3f} at step {record['step']}"
            )
    return None


def metrics_summary(metrics):
    """Compact loss trajectory for receipts — per-step detail stays in metrics."""
    losses = [item["loss"] for item in metrics if math.isfinite(item.get("loss", float("nan")))]
    val_losses = [item["valLoss"] for item in metrics if math.isfinite(item.get("valLoss", float("nan")))]
    first_loss = losses[0] if losses else None
    final_loss = losses[-1] if losses else None
    final_val = val_losses[-1] if val_losses else None
    if first_loss is not None and final_loss is not None:
        loss_trend = "improving" if final_loss < first_loss else "regressing" if final_loss > first_loss else "flat"
    else:
        loss_trend = None
    return {
        "stepsObserved": len(metrics),
        "firstLoss": first_loss,
        "finalLoss": final_loss,
        "bestLoss": min(losses) if losses else None,
        "finalValLoss": final_val,
        # Held-out perplexity (exp of val loss) — the honest "did the valid
        # row get less surprising" signal. Capped at a sane exponent: beyond
        # ~e^20 the number stops meaning anything for a receipt anyway.
        "finalValPerplexity": round(math.exp(final_val), 3) if final_val is not None and final_val <= 20 else None,
        "lossTrend": loss_trend,
        "nonFiniteSteps": sum(
            1
            for item in metrics
            if not math.isfinite(item.get("loss", 0.0))
            or not math.isfinite(item.get("valLoss", 0.0))
        ),
    }


def load_tokenizer(model_path):
    """Best-effort tokenizer for dataset budgeting; None falls back to a
    character estimate. Runs under -S with PYTHONPATH-provided site-packages."""
    try:
        from transformers import AutoTokenizer  # noqa: PLC0415

        return AutoTokenizer.from_pretrained(str(model_path), trust_remote_code=True)
    except Exception:
        return None


def make_token_counter(tokenizer):
    if tokenizer is None:
        def count(messages):
            return sum(len(str(m.get("content", ""))) for m in messages) // 4 + 16
        return count

    def count(messages):
        try:
            return len(tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False))
        except Exception:
            return sum(len(str(m.get("content", ""))) for m in messages) // 4 + 16
    return count


def split_oversize_row(messages, count_tokens, max_tokens, depth=0):
    """Split an oversized conversation at an assistant boundary so every row
    retains supervised content. Mid-row trainer truncation would silently
    drop the tail — and with --mask-prompt a long prompt can yield zero
    supervised tokens entirely."""
    if len(messages) <= 2 or depth >= 4 or count_tokens(messages) <= max_tokens:
        return [messages]
    mid = len(messages) / 2
    boundaries = [i for i in range(1, len(messages)) if messages[i - 1].get("role") == "assistant"]
    if not boundaries:
        return [messages]
    cut = min(boundaries, key=lambda i: abs(i - mid))
    head = split_oversize_row(messages[:cut], count_tokens, max_tokens, depth + 1)
    tail = split_oversize_row(messages[cut:], count_tokens, max_tokens, depth + 1)
    return head + tail


def fit_oversize_row(messages, count_tokens, max_tokens):
    """A row that cannot split further (e.g. one very long message) gets its
    largest message trimmed to fit — recorded honestly in row metadata rather
    than silently cut by the trainer's token truncation."""
    if count_tokens(messages) <= max_tokens:
        return messages, False
    fitted = [dict(m) for m in messages]
    for _ in range(8):
        current = count_tokens(fitted)
        if current <= max_tokens:
            return fitted, True
        longest = max(range(len(fitted)), key=lambda i: len(str(fitted[i].get("content", ""))))
        content = str(fitted[longest].get("content", ""))
        keep = max(64, int(len(content) * (max_tokens / current) * 0.9))
        fitted[longest]["content"] = content[:keep].rstrip() + " …"
    return fitted, True


def normalized_text(text):
    """Lowercase alphanumeric-only text for similarity comparisons."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", str(text).lower())).strip()


def row_word_set(messages):
    return set(normalized_text(" ".join(str(m.get("content", "")) for m in messages)).split())


def jaccard(left, right):
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def has_supervision(messages):
    """A row is only worth training if some assistant message carries real
    content. With --mask-prompt, a row of user/system messages produces zero
    supervised tokens; a near-empty answer ('…', 'ok') teaches truncation."""
    for message in messages:
        if message.get("role") != "assistant":
            continue
        if len(re.sub(r"[^a-z0-9]", "", str(message.get("content", "")).lower())) >= 3:
            return True
    return False


def row_hash(messages):
    canonical = json.dumps(messages, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()[:16]


# ── Agent-spine SFT source ────────────────────────────────────────────────
# The durable agent spine — kernel projection journals
# (workspaces/<id>/projection.jsonl) plus per-session event journals
# (sessions/<id>/events.jsonl) — records every action the host actually
# executed and the observation it produced. These rows teach Maple the JSON
# action contract it runs under: the real structured-action system prompt,
# the step request the host sent, and the EXECUTED action envelope (ground
# truth — never a merely proposed, failed, or blocked action).
AGENT_SPINE_SOURCE = "agent-spine"
TRAINABLE_ACTION_KINDS = {"tool", "answer"}
PASSING_OBSERVATION_STATUSES = {"passed", "observed"}
TERMINAL_ACTION_STATUSES = {"completed", "failed", "cancelled", "blocked", "rejected"}
# Mirrors of the orchestrator's adaptive-selection boundary
# (modelMaySelectCommand in agent_orchestrator.cjs) so a mined row's
# allowedNextCommands matches what the model actually saw at that step.
SAFE_ADAPTIVE_CAPABILITIES = {"read", "context", "verify", "artifact", "preview", "write", "task", "memory"}
FORBIDDEN_ADAPTIVE_CAPABILITIES = {"train", "runtime", "external", "network", "secret"}
GUIDED_AUTO_CAPABILITIES = {"artifact", "preview"}
ACTION_HISTORY_WINDOW = 16
DEFAULT_AGENTIC_MAX_STEPS = 96


def _read_jsonl_records(path):
    records = []
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except (ValueError, json.JSONDecodeError):
                    continue
    except OSError:
        return []
    return records


def _load_agent_spine(journal_paths):
    """Merge every journal into latest-per-id entity maps.

    Both journal schemas carry {type, createdAt, payload}. Projection events
    keep the full action/plan/observation records; session events add the
    explicit actionId -> observation link and task snapshots. The latest
    event (by createdAt) wins per entity id, so a finished action's terminal
    record — including its observationId — is what survives.
    """
    actions = {}
    # Legacy kernels reused fixed action ids ("action-unique", "a") across
    # steps. A `proposed` event for an id whose current record already
    # reached a terminal status is therefore a NEW action — re-key it so
    # later steps do not clobber earlier ones.
    key_alias = {}
    observations = {}
    observations_by_action = {}
    plans = {}
    tasks = []
    operations = {}
    files_read = 0
    for journal_path in journal_paths or []:
        records = _read_jsonl_records(journal_path)
        if records:
            files_read += 1
        for event in records:
            if not isinstance(event, dict):
                continue
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            seen_at = str(event.get("createdAt") or "")
            event_type = str(event.get("type") or "")
            action = payload.get("action")
            if event_type.startswith("action.") and isinstance(action, dict) and action.get("id"):
                action_id = str(action["id"])
                key = key_alias.get(action_id, action_id)
                previous = actions.get(key)
                if event_type == "action.proposed" and previous is not None and str(previous.get("status") or "") in TERMINAL_ACTION_STATUSES:
                    key = f"{action_id}#{seen_at}"
                    key_alias[action_id] = key
                    previous = None
                record = dict(action)
                record["_key"] = key
                record["_proposedAt"] = str(record.get("proposedAt") or seen_at)
                record["_seenAt"] = seen_at
                if previous is None or seen_at >= str(previous.get("_seenAt") or ""):
                    if previous is not None:
                        record["_proposedAt"] = min(str(previous.get("_proposedAt") or seen_at), record["_proposedAt"])
                    actions[key] = record
            observation = payload.get("observation")
            if event_type.startswith("observation.") and isinstance(observation, dict) and observation.get("id"):
                observation_id = str(observation["id"])
                previous = observations.get(observation_id)
                if previous is None or seen_at >= str(previous.get("_seenAt") or ""):
                    observations[observation_id] = {**observation, "_seenAt": seen_at}
                action_id = payload.get("actionId")
                if action_id:
                    observations_by_action[key_alias.get(str(action_id), str(action_id))] = observations[observation_id]
            plan = payload.get("plan")
            if event_type.startswith("plan.") and isinstance(plan, dict) and plan.get("id"):
                plan_id = str(plan["id"])
                previous = plans.get(plan_id)
                if previous is None or seen_at >= previous[0]:
                    plans[plan_id] = (seen_at, plan)
            task = payload.get("task")
            if isinstance(task, dict) and task.get("id"):
                tasks.append((seen_at, task))
            operation = payload.get("operation")
            if event_type.startswith("operation.") and isinstance(operation, dict) and operation.get("id"):
                operation_id = str(operation["id"])
                previous = operations.get(operation_id)
                if previous is None or seen_at >= previous[0]:
                    operations[operation_id] = (seen_at, operation)
    return {
        "actions": actions,
        "observations": observations,
        "observationsByAction": observations_by_action,
        "plans": plans,
        "tasks": tasks,
        "operations": operations,
        "filesRead": files_read,
    }


def _latest_before(pairs, at):
    """Newest (seen_at, value) pair at or before `at`; empty `at` means latest overall."""
    best = None
    best_at = ""
    for seen_at, value in pairs:
        stamp = str(seen_at or "")
        if not stamp:
            continue
        if at and stamp > at:
            continue
        if stamp >= best_at:
            best_at, best = stamp, value
    return best


def _compact_task_snapshot(task):
    """Same shape inferStructuredAction puts in actionRequest.task."""
    task = task if isinstance(task, dict) else {}
    steering = [
        str(item.get("content") or "")[:500]
        for item in (task.get("steering") or [])[-8:]
        if isinstance(item, dict) and item.get("status") != "delivered" and str(item.get("content") or "").strip()
    ]
    return {
        "id": task.get("id"),
        "objective": task.get("objective"),
        "intent": task.get("intent"),
        "interactionMode": task.get("interactionMode"),
        "threadId": task.get("threadId") or None,
        "projectId": task.get("projectId") or None,
        "workspaceRoot": task.get("workspaceRoot") or None,
        "autonomy": task.get("autonomy") or "bounded-local",
        "steering": steering,
    }


def _autonomy_level(task):
    value = str((task or {}).get("autonomy") or "bounded-local").lower()
    if value in ("autonomous", "bounded-campaign"):
        return "autonomous"
    if value == "guided":
        return "guided"
    return "supervised"


def _model_may_select_command(command_id, descriptor, plan, autonomy):
    """Port of agent_orchestrator.cjs modelMaySelectCommand."""
    descriptor = descriptor or {}
    capability = str(descriptor.get("capability") or "").lower()
    planned = any(
        isinstance(step, dict) and step.get("commandId") == command_id
        for step in (plan or {}).get("steps", [])
    )
    if not command_id or not capability or capability in FORBIDDEN_ADAPTIVE_CAPABILITIES:
        return False
    if autonomy == "guided":
        autonomy_opens = capability in GUIDED_AUTO_CAPABILITIES
    else:
        autonomy_opens = autonomy == "autonomous" and capability != "train"
    if not autonomy_opens and capability not in SAFE_ADAPTIVE_CAPABILITIES:
        return False
    if not planned and not autonomy_opens and descriptor.get("auto") is not True and descriptor.get("approval") != "plan":
        return False
    if not planned and not autonomy_opens and descriptor.get("approval") == "explicit":
        return False
    return True


def _allowed_next_commands(registry, plan, prior_action_count, autonomy):
    """Port of agent_orchestrator.cjs allowedNextCommands."""
    registry = registry or {}
    plan_steps = (plan or {}).get("steps") or []

    def hint_of(command_id):
        hint = (registry.get(command_id) or {}).get("inputHint")
        return {"hint": hint.strip()} if isinstance(hint, str) and hint.strip() else {}

    planned = []
    for step in plan_steps[prior_action_count:]:
        if not isinstance(step, dict) or not step.get("commandId"):
            continue
        command_id = step["commandId"]
        entry = {
            "commandId": command_id,
            "capability": (registry.get(command_id) or {}).get("capability") or "planned",
            "source": "approved-plan",
            **hint_of(command_id),
        }
        if step.get("label") is not None:
            entry["label"] = step.get("label")
        planned.append(entry)
    adaptive = []
    for command_id, descriptor in registry.items():
        if not _model_may_select_command(command_id, descriptor or {}, plan or {}, autonomy):
            continue
        adaptive.append({
            "commandId": command_id,
            "label": descriptor.get("label") or command_id,
            "capability": descriptor.get("capability"),
            "source": "adaptive-safe",
            **hint_of(command_id),
        })
    seen = set()
    allowed = []
    for entry in [*planned, *adaptive]:
        if entry["commandId"] in seen:
            continue
        seen.add(entry["commandId"])
        allowed.append(entry)
        if len(allowed) >= 64:
            break
    return allowed


def _action_input_contract(command_id):
    """Port of agent_orchestrator.cjs actionInputContract."""
    command = str(command_id or "")
    if command == "artifact.create":
        return "input may contain only artifactId, title, artifact kind (normally html), entrypoint (normally index.html), and mime. Do not include source, html, data, patches, or a full artifact; authoring is a later step."
    if command in ("artifact.author", "artifact.update"):
        return "input must contain either a complete relative-file source map under source or bounded complete-file replacements under patches. Use the requested visual concept and do not replace it with a fixed template. No external assets or network calls."
    if command in ("artifact.preview.open", "artifact.preview.inspect"):
        return "input should be {} unless the host-provided preview/session identifier is required."
    if command == "code.apply":
        return "input must contain either a complete source map under source or a bounded list of complete-file replacements under patches."
    if command == "experiment.run":
        return "input must contain experiment (one of projectile, pendulum, spring, orbit, collision, terminal) and may contain input (bounded numeric parameters), seed, and hypothesis. The host clamps parameters and runs the deterministic simulation; you do not compute results."
    if command == "experiment.note":
        return "input should contain experimentId (defaults to the latest run receipt) and claim — your interpretation of what the measured result showed. The host attaches the real measurements verbatim."
    if command == "experiment.dataset":
        return "input may contain only limit (max 400)."
    return "input should be {}. The host supplies task identity, command identity, approval, and evidence."


def _summarize_output(value):
    """Port of the orchestrator's observation structuredOutput summarizer."""
    if not isinstance(value, dict):
        return value
    summary = {}
    for key in ("schema", "status", "id", "artifactId", "taskId", "workspaceId", "revision", "digest", "session", "sessionId", "claimBoundary", "summary", "root", "dirty", "exitCode", "error"):
        if key in value:
            summary[key] = value[key]
    issues = value.get("issues")
    if isinstance(issues, list):
        summary["issues"] = [
            item if isinstance(item, str) else {"code": (item or {}).get("code"), "message": (item or {}).get("message")}
            for item in issues[:16]
        ]
    verification = value.get("verification")
    if isinstance(verification, dict):
        verification_issues = verification.get("issues")
        summary["verification"] = {
            "status": verification.get("status"),
            "issues": [
                item if isinstance(item, str) else {"code": (item or {}).get("code"), "message": (item or {}).get("message")}
                for item in (verification_issues[:12] if isinstance(verification_issues, list) else [])
            ],
        }
    refs = value.get("evidenceRefs")
    if isinstance(refs, list):
        summary["evidenceRefs"] = refs[:12]
    if isinstance(value.get("files"), list):
        summary["fileCount"] = len(value["files"])
    if isinstance(value.get("revisions"), list):
        summary["revisionCount"] = len(value["revisions"])
    if isinstance(value.get("artifact"), dict):
        summary["artifact"] = _summarize_output(value["artifact"])
    if isinstance(value.get("observation"), dict):
        summary["observation"] = _summarize_output(value["observation"])
    return summary


def _compact_observation_record(observation):
    """Same shape the orchestrator puts in request.completed.observations."""
    record = {}
    for key in ("id", "operationId", "status", "summary", "outputDigest"):
        if observation.get(key) is not None:
            record[key] = observation[key]
    refs = observation.get("evidenceRefs")
    record["evidenceRefs"] = refs[:12] if isinstance(refs, list) else []
    if "structuredOutput" in observation:
        record["structuredOutput"] = _summarize_output(observation["structuredOutput"])
    return record


def _compact_operation_record(operation):
    record = {}
    for key in ("id", "command", "status", "error"):
        if operation.get(key) is not None:
            record[key] = operation[key]
    refs = operation.get("evidenceRefs")
    record["evidenceRefs"] = refs[:12] if isinstance(refs, list) else []
    return record


def _shrink_agentic_request(request, budget_chars):
    """Bound a reconstructed step request to a char budget by shedding
    history tail-first — mirroring the orchestrator's live context-budget
    compaction (older steps collapse to ids, then drop entirely). Trimming
    the JSON text itself would corrupt the row, so shrink the structure."""
    request = json.loads(json.dumps(request, ensure_ascii=False))
    completed = request.get("completed")
    if not isinstance(completed, dict):
        return request

    def size():
        return len(json.dumps(request, ensure_ascii=False, separators=(",", ":")))

    for key, keep in (
        ("observations", 8), ("actions", 8), ("operations", 4),
        ("observations", 4), ("actions", 4), ("operations", 0),
        ("observations", 0), ("actions", 0),
    ):
        if size() <= budget_chars:
            return request
        entries = completed.get(key)
        completed[key] = (entries[-keep:] if keep else []) if isinstance(entries, list) else []
    allowed = request.get("allowedNextCommands")
    if isinstance(allowed, list) and size() > budget_chars:
        request["allowedNextCommands"] = allowed[:12]
    if isinstance(allowed, list) and size() > budget_chars:
        request["allowedNextCommands"] = allowed[:6]
    return request


def build_agentic_rows(agentic, max_row_chars=None):
    """Mine the durable agent spine into chat-format SFT examples.

    Returns (rows, stats). Every row is
      system    = the real structured-action system prompt (host-supplied),
      user      = the step request the host sent (task/nextStep/
                  allowedNextCommands/progress/completed-history, rebuilt
                  from the durable journal at that step's position),
      assistant = the EXECUTED action envelope (kind/commandId/input/
                  shortRationale), which is ground truth.
    Only steps whose observation passed are eligible — training on failed
    or blocked actions would teach the failure mode.
    """
    stats = {"journalFiles": 0, "filesRead": 0, "actions": 0, "eligible": 0, "skipped": {}, "spinePaths": [], "compacted": 0}
    if not isinstance(agentic, dict):
        return [], stats
    journal_paths = [str(item) for item in (agentic.get("journalPaths") or []) if str(item or "").strip()]
    stats["journalFiles"] = len(journal_paths)
    stats["spinePaths"] = journal_paths[:16]
    registry = agentic.get("registry") if isinstance(agentic.get("registry"), dict) else {}
    system_prompt = str(agentic.get("systemPrompt") or "")
    try:
        max_steps = max(1, int(agentic.get("maxSteps") or DEFAULT_AGENTIC_MAX_STEPS))
    except (TypeError, ValueError):
        max_steps = DEFAULT_AGENTIC_MAX_STEPS
    if not journal_paths:
        return [], stats
    spine = _load_agent_spine(journal_paths)
    stats["filesRead"] = spine["filesRead"]
    stats["actions"] = len(spine["actions"])
    skipped = stats["skipped"]

    def count_skip(reason):
        skipped[reason] = skipped.get(reason, 0) + 1

    rows = []
    by_task = {}
    for action in spine["actions"].values():
        by_task.setdefault(str(action.get("taskId") or ""), []).append(action)
    for task_id, task_actions in by_task.items():
        ordered = sorted(task_actions, key=lambda item: (str(item.get("_proposedAt") or ""), str(item.get("id") or "")))
        plan_pairs = [(seen_at, plan) for seen_at, plan in spine["plans"].values() if str(plan.get("taskId") or "") == task_id]
        task_pairs = [(seen_at, task) for seen_at, task in spine["tasks"] if str(task.get("id") or "") == task_id]
        operation_pairs = [(seen_at, operation) for seen_at, operation in spine["operations"].values() if str(operation.get("taskId") or "") == task_id]
        task_observation_ids = {str(action["observationId"]) for action in task_actions if action.get("observationId")}
        task_operation_ids = {str(operation.get("id")) for _, operation in operation_pairs if operation.get("id")}
        for index, action in enumerate(ordered):
            if str(action.get("status") or "") != "completed":
                count_skip("not-completed")
                continue
            kind = str(action.get("kind") or "")
            if kind not in TRAINABLE_ACTION_KINDS or (kind == "tool" and not str(action.get("commandId") or "").strip()):
                count_skip("unsupported-kind")
                continue
            observation = None
            observation_id = action.get("observationId")
            if observation_id and str(observation_id) in spine["observations"]:
                observation = spine["observations"][str(observation_id)]
            if observation is None:
                observation = spine["observationsByAction"].get(str(action.get("_key") or action.get("id") or ""))
            if observation is None:
                count_skip("no-observation")
                continue
            if str(observation.get("status") or "") not in PASSING_OBSERVATION_STATUSES:
                count_skip("observation-not-passed")
                continue
            proposed_at = str(action.get("_proposedAt") or "")
            task_snapshot = _latest_before(task_pairs, proposed_at) or {}
            plan = _latest_before(plan_pairs, proposed_at) or {"steps": []}
            prior_actions = ordered[:index]
            plan_steps = plan.get("steps") if isinstance(plan.get("steps"), list) else []
            next_step = plan_steps[len(prior_actions)] if len(prior_actions) < len(plan_steps) else None
            if not isinstance(next_step, dict):
                next_step = None
            autonomy = _autonomy_level(task_snapshot)
            allowed = _allowed_next_commands(registry, plan, len(prior_actions), autonomy)
            completed_ids = []
            seen_completed = set()
            for prior in prior_actions:
                command_id = prior.get("commandId")
                if (
                    command_id
                    and command_id not in seen_completed
                    and str(prior.get("kind") or "") != "ask_user"
                    and str(prior.get("status") or "") in TERMINAL_ACTION_STATUSES
                ):
                    seen_completed.add(command_id)
                    completed_ids.append(command_id)
            total_steps = sum(1 for step in plan_steps if isinstance(step, dict) and step.get("commandId"))
            done_steps = sum(1 for step in plan_steps if isinstance(step, dict) and step.get("commandId") in seen_completed)
            progress = {
                "plannedCommand": (next_step or {}).get("commandId") or None,
                "completedCommands": completed_ids,
                "planProgress": f"step {min(done_steps + 1, max(total_steps, 1))} of {max(total_steps, 1)}" + ("" if total_steps else " (no planned tool steps)"),
                "inputContract": _action_input_contract((next_step or {}).get("commandId")),
                "worldFindings": None,
            }
            history_actions = [
                {key: prior[key] for key in ("id", "step", "kind", "commandId", "status", "shortRationale", "observationId") if key in prior}
                for prior in prior_actions[-ACTION_HISTORY_WINDOW:]
            ]
            prior_observations = []
            for observation_key, candidate in spine["observations"].items():
                if observation_key not in task_observation_ids and str(candidate.get("operationId") or "") not in task_operation_ids:
                    continue
                created = str(candidate.get("createdAt") or candidate.get("_seenAt") or "")
                if proposed_at and created and created > proposed_at:
                    continue
                prior_observations.append((created, candidate))
            prior_observations.sort(key=lambda item: item[0])
            history_observations = [
                _compact_observation_record(candidate)
                for _, candidate in prior_observations[-ACTION_HISTORY_WINDOW:]
            ]
            prior_operations = [
                (str(operation.get("createdAt") or seen_at), operation)
                for seen_at, operation in operation_pairs
                if not proposed_at or str(operation.get("createdAt") or seen_at) <= proposed_at
            ]
            prior_operations.sort(key=lambda item: item[0])
            history_operations = [
                _compact_operation_record(operation)
                for _, operation in prior_operations[-ACTION_HISTORY_WINDOW:]
            ]
            request = {
                "task": _compact_task_snapshot(task_snapshot),
                # compileThreadContext is live-only state; it is not durable
                # spine data, so the reconstruction records it honestly null.
                "context": None,
                "nextStep": next_step,
                "allowedNextCommands": allowed,
                "progress": progress,
                "completed": {"actions": history_actions, "observations": history_observations, "operations": history_operations},
                "repair": None,
            }
            envelope = {"kind": kind}
            if str(action.get("commandId") or "").strip():
                envelope["commandId"] = action["commandId"]
            envelope["input"] = action.get("input") if isinstance(action.get("input"), dict) else {}
            envelope["shortRationale"] = str(action.get("shortRationale") or "")
            if max_row_chars:
                envelope_json = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
                request_budget = max(320, max_row_chars - len(system_prompt) - len(envelope_json) - 64)
                before = len(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
                request = _shrink_agentic_request(request, request_budget)
                if len(json.dumps(request, ensure_ascii=False, separators=(",", ":"))) < before:
                    stats["compacted"] += 1
            metadata = {
                "source": AGENT_SPINE_SOURCE,
                "actionId": action.get("id"),
                "taskId": action.get("taskId"),
                "step": action.get("step"),
                "kind": kind,
                "commandId": action.get("commandId") or None,
                "shortRationale": envelope["shortRationale"],
                "observationId": observation.get("id"),
                "observationStatus": observation.get("status"),
                "executedEnvelope": True,
                "parseStatus": action.get("parseStatus") or None,
                "hostSelected": bool(action.get("hostSelection")) or str(action.get("parseStatus") or "") in {"fallback", "redirected"},
                "provider": action.get("provider") or "maple",
            }
            rows.append({
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps(request, ensure_ascii=False, separators=(",", ":"))},
                    {"role": "assistant", "content": json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))},
                ],
                "metadata": metadata,
                "_proposedAt": proposed_at,
            })
    # Newest executed steps first: if the share cap or max_steps trims the
    # source, the freshest contract examples are the ones that survive.
    rows.sort(key=lambda row: row["_proposedAt"], reverse=True)
    rows = rows[:max_steps]
    stats["eligible"] = len(rows)
    for row in rows:
        row.pop("_proposedAt", None)
    return rows, stats


def _agentic_dedup_key(example):
    """Executed-step dedup for spine rows.

    The variable teaching content is (commandId + executed input): two steps
    that ran the same command with the same input teach the same thing,
    while different inputs are legitimately distinct rows. Word-Jaccard is
    wrong here — every row shares the same large system prompt, so pairwise
    similarity would sit near the threshold regardless of content and gut
    the source; exact-dup also never fires because each request embeds
    per-step ids and progress.
    """
    metadata = example.get("metadata") or {}
    if metadata.get("source") != AGENT_SPINE_SOURCE:
        return None
    assistant = next((m for m in reversed(example.get("messages", [])) if m.get("role") == "assistant"), {})
    try:
        envelope = json.loads(str(assistant.get("content") or "{}"))
    except (ValueError, json.JSONDecodeError):
        envelope = {}
    canonical = {"kind": envelope.get("kind"), "commandId": envelope.get("commandId"), "input": envelope.get("input")}
    return json.dumps(canonical, ensure_ascii=False, sort_keys=True)


def write_dataset(run_dir, facts, conversation, examples=None, agentic=None, tokenizer=None, max_tokens=448, max_source_share=MAX_SOURCE_SHARE):
    run_dir = Path(run_dir)
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
            metadata = example.get("metadata") if isinstance(example.get("metadata"), dict) else {}
            prepared_examples.append({"messages": cleaned_messages, "metadata": {**metadata, "source": metadata.get("source") or "example"}})

    # Durable agent-spine source: executed action envelopes paired with the
    # step request the host sent, mined by build_agentic_rows. Rows are
    # already chat-formatted; they flow through the same supervision gate,
    # dedup, share cap, and token budget as every other source.
    agentic_rows, agentic_stats = build_agentic_rows(agentic, max_row_chars=max_tokens * 4)
    prepared_examples.extend(agentic_rows)

    for fact in facts:
        text = str(fact).strip()
        if not text:
            continue
        prepared_examples.extend(
            [
                {"messages": [{"role": "user", "content": "What personal detail should you remember about me?"}, {"role": "assistant", "content": f"You should remember this about the user: {text}"}], "metadata": {"source": "personal-fact"}},
                {"messages": [{"role": "user", "content": "Please use my saved personal details when they are relevant."}, {"role": "assistant", "content": f"I will keep this in mind: {text}"}], "metadata": {"source": "personal-fact"}},
                {"messages": [{"role": "user", "content": "What should you keep in mind for future answers?"}, {"role": "assistant", "content": f"A saved detail is: {text}"}], "metadata": {"source": "personal-fact"}},
            ]
        )

    # Include only recent, explicitly completed local turns. This gives Dream
    # a small amount of conversational style without baking the whole chat.
    for message in conversation[-6:]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        answer = str(message.get("content", "")).strip()
        if answer:
            prepared_examples.append({"messages": [{"role": "user", "content": "Answer in the same helpful style as our recent conversation."}, {"role": "assistant", "content": answer}], "metadata": {"source": "conversation"}})

    if not prepared_examples:
        raise ValueError("Dream needs at least one saved fact, completed coding example, or executed agent step before it can fine-tune.")

    # Quality gate: rows without a substantive assistant message carry no
    # supervised tokens under --mask-prompt and would silently waste the run.
    quality_dropped = 0
    kept = []
    for example in prepared_examples:
        if has_supervision(example["messages"]):
            kept.append(example)
        else:
            quality_dropped += 1
    prepared_examples = kept
    if not prepared_examples:
        raise ValueError("Every candidate row was empty or lacked an assistant answer; nothing trainable remains.")

    # De-duplicate exact prompt/answer pairs before the split. Repeated copies
    # make a tiny run look healthier than it is and can leak into validation.
    unique_examples = []
    seen = set()
    for example in prepared_examples:
        key = json.dumps(example.get("messages", []), ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        unique_examples.append(example)
    exact_removed = len(prepared_examples) - len(unique_examples)
    prepared_examples = unique_examples

    # Near-duplicate removal on normalized word sets. Exact dedup misses rows
    # that differ only in punctuation or a trailing sentence; Jaccard on word
    # sets catches them. O(n^2) is fine at personal-dataset scale.
    # Agent-spine rows dedup on (kind, commandId, executed input) instead —
    # the shared system prompt would otherwise push every pair past the
    # Jaccard threshold and collapse the source to one row.
    near_deduped = []
    word_sets = []
    agentic_keys = set()
    near_removed = 0
    for example in prepared_examples:
        agentic_key = _agentic_dedup_key(example)
        if agentic_key is not None:
            if agentic_key in agentic_keys:
                near_removed += 1
                continue
            agentic_keys.add(agentic_key)
            near_deduped.append(example)
            continue
        words = row_word_set(example["messages"])
        if any(jaccard(words, prior) >= NEAR_DUPLICATE_THRESHOLD for prior in word_sets):
            near_removed += 1
            continue
        word_sets.append(words)
        near_deduped.append(example)
    prepared_examples = near_deduped

    # Balance across sources: when at least two sources contribute, cap any
    # single source at MAX_SOURCE_SHARE of the final rows (kept in arrival
    # order, excess dropped from the tail of the dominant source).
    balance_dropped = 0
    source_names = {str(example.get("metadata", {}).get("source") or "example") for example in prepared_examples}
    if max_source_share and len(source_names) > 1:
        cap = max(1, math.ceil(len(prepared_examples) * max_source_share))
        per_source = {}
        balanced = []
        for example in prepared_examples:
            source = str(example.get("metadata", {}).get("source") or "example")
            used = per_source.get(source, 0)
            if used >= cap:
                balance_dropped += 1
                continue
            per_source[source] = used + 1
            balanced.append(example)
        prepared_examples = balanced
    if not prepared_examples:
        raise ValueError("Dataset balancing removed every row; nothing trainable remains.")

    # Token-budget the rows before the trainer sees them: a row longer than
    # --max-seq-length is hard-truncated downstream, which drops the answer
    # tail (or, with --mask-prompt, can zero out supervision entirely). Split
    # at assistant boundaries instead so no content is silently lost.
    count_tokens = make_token_counter(tokenizer)
    budgeted = []
    rows_split = 0
    for example in prepared_examples:
        pieces = split_oversize_row(example["messages"], count_tokens, max_tokens)
        if len(pieces) > 1:
            rows_split += 1
        for piece in pieces:
            fitted, trimmed = fit_oversize_row(piece, count_tokens, max_tokens)
            metadata = dict(example.get("metadata") or {})
            metadata["splitFromSource"] = len(pieces) > 1
            metadata["contentTrimmed"] = trimmed
            metadata["rowHash"] = row_hash(fitted)
            budgeted.append({"messages": fitted, "metadata": metadata})
    prepared_examples = budgeted
    token_lengths = [count_tokens(row["messages"]) for row in prepared_examples]
    oversized = sum(1 for length in token_lengths if length > max_tokens)

    # Deterministic validation pick: choose by row hash rather than position,
    # so the holdout is not structurally biased toward whichever source was
    # appended last (conversation rows used to land in validation every time).
    validation_holdout = len(prepared_examples) >= 2
    if validation_holdout:
        holdout_index = min(range(len(prepared_examples)), key=lambda i: prepared_examples[i]["metadata"]["rowHash"])
    else:
        holdout_index = len(prepared_examples) - 1
    valid = [prepared_examples[holdout_index]] if prepared_examples else []
    train = [row for i, row in enumerate(prepared_examples) if i != holdout_index] or prepared_examples
    data_dir = run_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    train_blob = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in train)
    valid_blob = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in valid)
    (data_dir / "train.jsonl").write_text(train_blob, encoding="utf-8")
    (data_dir / "valid.jsonl").write_text(valid_blob, encoding="utf-8")
    assistant_lengths = [
        len(str(message.get("content", "")))
        for row in prepared_examples
        for message in row.get("messages", [])
        if message.get("role") == "assistant"
    ]
    source_counts = {}
    for row in prepared_examples:
        source = str(row.get("metadata", {}).get("source") or "example")
        source_counts[source] = source_counts.get(source, 0) + 1
    manifest = {
        "schema": "hemlock.dream.dataset.v1",
        "trainRows": len(train),
        "validRows": len(valid),
        "sourceRows": len(prepared_examples),
        "duplicatesRemoved": exact_removed + near_removed,
        "exactDuplicatesRemoved": exact_removed,
        "nearDuplicatesRemoved": near_removed,
        "qualityDropped": quality_dropped,
        "balanceDropped": balance_dropped,
        "sources": source_counts,
        "agenticSpine": agentic_stats,
        "validationHoldout": validation_holdout,
        "validationRowHash": valid[0]["metadata"]["rowHash"] if valid else None,
        "datasetDigest": hashlib.sha256(train_blob.encode("utf-8")).hexdigest(),
        "assistantCharacters": sum(assistant_lengths),
        "assistantCharacterRange": {
            "min": min(assistant_lengths) if assistant_lengths else 0,
            "max": max(assistant_lengths) if assistant_lengths else 0,
        },
        "tokenBudget": max_tokens,
        "tokenRange": {
            "min": min(token_lengths) if token_lengths else 0,
            "max": max(token_lengths) if token_lengths else 0,
        },
        "rowsSplit": rows_split,
        "oversizedRowsRemaining": oversized,
        "tokenizer": "chat-template" if tokenizer is not None else "char-estimate",
        "claimBoundary": "A one-row or non-holdout validation set measures liveness only; it is not generalization proof.",
    }
    write_json(data_dir / "manifest.json", manifest)
    return data_dir, len(train), len(valid), manifest


def find_resume_checkpoint(run_dir):
    """Find the newest numbered adapter checkpoint under a run directory.

    mlx_lm writes ``{iter:07d}_adapters.safetensors`` snapshots every
    --save-every steps. The highest iteration number wins; ties (identical
    step numbers across adapter dirs) break on modification time. Returns
    (path, step) or None — the bare ``adapters.safetensors`` final artifact is
    intentionally ignored because resume must anchor to a known step.
    """
    run_dir = Path(run_dir)
    best = None
    for candidate in run_dir.glob("**/*_adapters.safetensors"):
        match = re.fullmatch(r"(\d+)_adapters\.safetensors", candidate.name)
        if not match:
            continue
        step = int(match.group(1))
        marker = (step, candidate.stat().st_mtime)
        if best is None or marker > (best[1], best[0].stat().st_mtime):
            best = (candidate, step)
    return best


def resolve_resume_source(run_dir, payload):
    """Decide whether this run warm-starts from a prior adapter checkpoint.

    ``resume`` (bool) auto-picks the newest checkpoint inside the run dir;
    ``resumeFrom`` names an explicit file which must live inside the run dir
    so the whole provenance chain stays scoped and auditable. This is a
    weight warm-start — optimizer state and the step counter restart, which
    the receipt states plainly.
    """
    run_dir = Path(run_dir).resolve()
    explicit = str(payload.get("resumeFrom") or "").strip()
    if explicit:
        candidate = Path(explicit).resolve()
        if run_dir != candidate and run_dir not in candidate.parents:
            raise ValueError("resumeFrom must point inside the Dream run directory.")
        if not candidate.is_file():
            raise FileNotFoundError(f"resumeFrom checkpoint not found: {candidate}")
        step_match = re.fullmatch(r"(\d+)_adapters\.safetensors", candidate.name)
        return {
            "applied": True,
            "adapterFile": str(candidate),
            "step": int(step_match.group(1)) if step_match else None,
            "mode": "explicit",
        }
    if payload.get("resume") is True or str(payload.get("resume") or "").lower() == "true":
        found = find_resume_checkpoint(run_dir)
        if found:
            return {"applied": True, "adapterFile": str(found[0]), "step": found[1], "mode": "auto"}
        return {"applied": False, "adapterFile": None, "step": None, "mode": "auto", "reason": "no prior checkpoint found; training from scratch"}
    return None


def adapter_sequence(run_dir):
    """Ordinal of this run's adapter output — adapter versioning metadata."""
    run_dir = Path(run_dir)
    try:
        existing = [
            path
            for path in run_dir.iterdir()
            if path.is_dir() and (path.name == "adapters" or path.name.startswith("adapters-"))
        ]
    except OSError:
        existing = []
    return len(existing)


def dataset_preview(run_dir, data_dir, manifest, sample_limit=8):
    """Read back the written split files and summarize what a Dream would
    learn: the manifest (source counts, token stats, digest) plus a bounded
    set of row titles for audit. Pure read of files write_dataset produced."""
    try:
        limit = max(0, min(64, int(sample_limit)))
    except (TypeError, ValueError):
        limit = 8
    samples = []
    for split in ("train", "valid"):
        try:
            lines = (Path(data_dir) / f"{split}.jsonl").read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            if len(samples) >= limit:
                break
            try:
                row = json.loads(line)
            except (ValueError, json.JSONDecodeError):
                continue
            metadata = row.get("metadata") or {}
            messages = row.get("messages") or []
            assistant = next((m for m in reversed(messages) if m.get("role") == "assistant"), {})
            samples.append({
                "split": split,
                "source": metadata.get("source") or "example",
                "commandId": metadata.get("commandId"),
                "title": str(metadata.get("shortRationale") or assistant.get("content") or "")[:140],
                "rowHash": metadata.get("rowHash"),
            })
    return {
        "schema": "hemlock.dream.dataset-preview.v1",
        "runDir": str(run_dir),
        "dataDir": str(data_dir),
        "trainPath": str(Path(data_dir) / "train.jsonl"),
        "validPath": str(Path(data_dir) / "valid.jsonl"),
        "manifest": manifest,
        "samples": samples,
        "claimBoundary": "Dataset composition only — no model weights were trained or modified.",
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Expected one JSON payload argument")
    payload = json.loads(sys.argv[1])
    dataset_only = payload.get("datasetOnly") is True
    run_dir = Path(payload["runDir"]).resolve()
    # datasetOnly previews may run without a model (char-estimate tokenizer);
    # training still requires the real base checkpoint.
    model_path = validate_model_path(payload["model"]) if str(payload.get("model") or "").strip() else None
    if model_path is not None:
        run_dir = validate_run_dir(run_dir, model_path)
    elif not dataset_only:
        raise FileNotFoundError("Dream needs the Maple-Preview base model directory for training.")
    model = str(model_path) if model_path else ""
    facts = payload.get("facts", [])
    conversation = payload.get("conversation", [])
    coding_examples = payload.get("examples", [])
    agentic = payload.get("agentic")
    profile, iters, num_layers = resolve_training_config(payload)
    try:
        max_loss_multiple = float(payload.get("maxLossMultiple") or DEFAULT_MAX_LOSS_MULTIPLE)
    except (TypeError, ValueError):
        max_loss_multiple = DEFAULT_MAX_LOSS_MULTIPLE
    divergence_guard = payload.get("divergenceGuard", True) not in (False, 0, "false", "0")
    started = time.monotonic()
    log_path = run_dir / "dream.log"
    run_dir.mkdir(parents=True, exist_ok=True)

    emit("validating local Dream paths", 5, "base weights are read-only; output is a new run", profile=profile)
    if dataset_only:
        # dream.dataset.preview: dataset composition only — no resume
        # resolution, no base-weight hashing, no trainer, no server stop.
        emit("writing consented Dream dataset", 16, "facts, local turns, and the executed agent spine (preview only)")
        tokenizer = load_tokenizer(model_path) if model_path else None
        data_dir, train_count, valid_count, dataset_manifest = write_dataset(run_dir, facts, conversation, coding_examples, agentic=agentic, tokenizer=tokenizer, max_tokens=MAX_SEQ_LENGTH - 64)
        preview = dataset_preview(run_dir, data_dir, dataset_manifest, payload.get("previewSamples", 8))
        preview_path = run_dir / "dataset-preview.json"
        write_json(preview_path, preview)
        emit(
            "dataset.preview",
            100,
            f"{train_count} training rows · {valid_count} validation row(s) — no training ran",
            preview=preview,
            previewPath=str(preview_path),
        )
        return
    resume_info = resolve_resume_source(run_dir, payload)
    emit("hashing Maple base weights", 9, "capturing the before-training integrity manifest")
    before_manifest = base_weight_manifest(model_path)
    write_json(run_dir / "base-weights-before.json", before_manifest)
    emit("writing consented Dream dataset", 16, "facts, recent local turns, and the executed agent spine")
    tokenizer = load_tokenizer(model_path)
    data_dir, train_count, valid_count, dataset_manifest = write_dataset(run_dir, facts, conversation, coding_examples, agentic=agentic, tokenizer=tokenizer, max_tokens=MAX_SEQ_LENGTH - 64)
    adapter_dir = choose_adapter_dir(run_dir)
    adapter_dir.mkdir(parents=True, exist_ok=True)
    emit("loading Maple checkpoint", 22, f"{train_count} training examples · {valid_count} validation example")

    # Save mid-run checkpoints so an interrupted run leaves a resumable
    # artifact instead of nothing. Half-interval keeps even short runs
    # checkpointed once without multiplying safetensors writes.
    save_every = max(1, iters // 2)
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
        str(save_every),
        "--max-seq-length",
        str(MAX_SEQ_LENGTH),
        "--adapter-path",
        str(adapter_dir),
        "--trust-remote-code",
        "--mask-prompt",
        "--grad-checkpoint",
        "--learning-rate",
        "1e-5",
    ]
    if resume_info and resume_info.get("applied"):
        command += ["--resume-adapter-file", resume_info["adapterFile"]]
    emit(
        "MLX fine-tuning is running locally",
        28,
        "the server is paused while the adapter is trained",
        profile=profile,
        iters=iters,
        numLayers=num_layers,
        saveEvery=save_every,
        resumedFrom=resume_info,
        command=" ".join(command[2:]),
    )
    env = python_runtime_env()
    metrics = []
    training_observations = {}
    divergence_reason = None
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
                if divergence_guard and divergence_reason is None:
                    divergence_reason = detect_divergence(metrics, max_loss_multiple=max_loss_multiple)
                    if divergence_reason:
                        emit("Dream divergence detected — stopping run", 70, divergence_reason)
                        process.terminate()
                        break
        if divergence_reason:
            try:
                code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                code = process.wait()
        else:
            code = process.wait()
    if divergence_reason:
        failure = {
            "schema": "hemlock.dream.training-failed.v1",
            "reason": "divergence",
            "detail": divergence_reason,
            "metrics": sorted(metrics, key=lambda item: item["step"]),
            "metricsSummary": metrics_summary(metrics),
            "resumedFrom": resume_info,
            "claimBoundary": "This failure receipt records an early-stopped divergent run; the partial adapter was not activated.",
        }
        write_json(run_dir / "training-failed.json", failure)
        emit("Dream training failed", 100, f"early stop on divergence: {divergence_reason}", divergence=divergence_reason, failureReceipt=str(run_dir / "training-failed.json"))
        raise SystemExit(4)
    if code != 0:
        failure = {
            "schema": "hemlock.dream.training-failed.v1",
            "reason": "trainer-exit",
            "detail": f"mlx_lm exited with code {code}",
            "metrics": sorted(metrics, key=lambda item: item["step"]),
            "metricsSummary": metrics_summary(metrics),
            "resumedFrom": resume_info,
            "claimBoundary": "This failure receipt records the observed trainer exit; no adapter was activated.",
        }
        write_json(run_dir / "training-failed.json", failure)
        emit("Dream training failed", 100, f"exit code {code}; see {log_path}", failureReceipt=str(run_dir / "training-failed.json"))
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
    # Adapter versioning: the ordinal of this adapter output inside the run
    # plus a content-derived id. A resumed run produces a NEW adapter dir —
    # the chain is auditable instead of overwritten.
    sequence = adapter_sequence(run_dir)
    adapter_version = f"dream-{sequence}-{adapter_artifact['sha256'][:12]}"
    checkpoints = sorted(
        path.name
        for path in adapter_dir.glob("*_adapters.safetensors")
        if re.fullmatch(r"\d+_adapters\.safetensors", path.name)
    )
    adapter_manifest = {
        "schema": "hemlock.dream.adapter.v1",
        "adapterVersion": adapter_version,
        "sequence": sequence,
        "adapterDir": str(adapter_dir),
        "adapterSha256": adapter_artifact["sha256"],
        "baseModel": model,
        "baseDigestBefore": before_manifest["digest"],
        "baseDigestAfter": after_manifest["digest"],
        "datasetDigest": dataset_manifest.get("datasetDigest"),
        "profile": profile,
        "iters": iters,
        "numLayers": num_layers,
        "resumedFrom": resume_info,
        "checkpoints": checkpoints,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "claimBoundary": "Adapter metadata links this artifact to its base digest and dataset digest; it does not assert quality.",
    }
    write_json(adapter_dir / "adapter-manifest.json", adapter_manifest)
    training_receipt = {
        "schema": "hemlock.dream.training.v1",
        "profile": profile,
        "iters": iters,
        "numLayers": num_layers,
        "dataset": dataset_manifest,
        "datasetDigest": dataset_manifest.get("datasetDigest"),
        "metrics": sorted(metrics, key=lambda item: item["step"]),
        "metricsSummary": metrics_summary(metrics),
        "trainingProof": {
            "command": command,
            "trainableParameters": training_observations.get("trainableParameters"),
            "optimizerStepsObserved": sorted(set(training_observations.get("optimizerSteps", []))),
            "adapterArtifact": adapter_artifact,
        },
        "adapterPath": str(adapter_dir),
        "adapterVersion": adapter_version,
        "adapterManifestPath": str(adapter_dir / "adapter-manifest.json"),
        "resumedFrom": resume_info,
        "checkpoints": checkpoints,
        "divergenceGuard": {"enabled": divergence_guard, "maxLossMultiple": max_loss_multiple},
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
