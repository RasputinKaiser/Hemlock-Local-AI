#!/usr/bin/env python3
"""Small, local-only SIPS control plane for the Hemlock desktop app.

This is intentionally a bounded app-native subset rather than a copy of the
full SIPS plugin. It owns a provenance-aware local ledger, recall, routes, and
self-loop state. Model training and command execution remain explicitly
invoked by Electron, which records their receipts beside this ledger.
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCHEMA = "hemlock.sips.runtime.v1"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def paths(payload: dict) -> tuple[Path, Path, Path]:
    root = Path(payload["root"]).resolve()
    sips_dir = Path(payload.get("sipsDir") or root / "sips-runs").resolve()
    return root, sips_dir, sips_dir / "memory.jsonl"


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def read_records(memory_path: Path) -> list[dict]:
    if not memory_path.is_file():
        return []
    records = []
    for line in memory_path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def status(payload: dict) -> dict:
    root, sips_dir, memory_path = paths(payload)
    state_path = sips_dir / "selfloop.json"
    cycle_receipts = sorted(sips_dir.glob("*/receipt.json"), key=lambda path: path.stat().st_mtime)
    dataset_rows = 0
    for path in sips_dir.glob("*/data/*.jsonl"):
        dataset_rows += sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    latest = load_json(cycle_receipts[-1], None) if cycle_receipts else None
    selfloop = load_json(state_path, {"status": "idle", "cycle": 0})
    return {
        "schema": SCHEMA,
        "status": "ready",
        "root": str(root),
        "sipsDir": str(sips_dir),
        "records": len(read_records(memory_path)),
        "datasetRows": dataset_rows,
        "cycleCount": len(cycle_receipts),
        "latestReceipt": latest,
        "selfloop": selfloop,
        "claimBoundary": "Local ledger and receipts prove app-observed work only; they do not prove a source patch or model quality gain without verification.",
    }


def routes(payload: dict) -> dict:
    return {
        "schema": "hemlock.sips.routes.v1",
        "routes": [
            {"id": "status", "label": "Status", "description": "Read local receipts, dataset counts, and self-loop state."},
            {"id": "repo-map", "label": "Repo map", "description": "Inspect the scoped worktree and current branch."},
            {"id": "verify", "label": "Verify", "description": "Run one bounded, user-selected verification profile."},
            {"id": "recall", "label": "Recall", "description": "Search candidate lessons captured by Hemlock SIPS."},
            {"id": "selfloop", "label": "Self-loop", "description": "Start, pause, resume, or complete a persistent SIPS objective."},
            {"id": "cycle", "label": "One cycle", "description": "Baseline, collect, train, compare, verify, and write a candidate receipt."},
        ],
        "claimBoundary": "Routes are available in this local app; each route still needs its own runtime receipt.",
    }


def record(payload: dict) -> dict:
    _root, sips_dir, memory_path = paths(payload)
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    record_id = f"mem_{uuid.uuid4().hex[:16]}"
    entry = {
        "schema": "hemlock.sips.memory.v1",
        "id": record_id,
        "title": str(payload.get("title") or "Hemlock SIPS candidate"),
        "body": str(payload.get("body") or "").strip(),
        "scope": str(payload.get("scope") or _root),
        "tags": [tag.strip() for tag in str(payload.get("tags") or "sips").split(",") if tag.strip()],
        "status": str(payload.get("status") or "candidate"),
        "tier": "learning",
        "confidence": str(payload.get("confidence") or "medium"),
        "verifyBeforeUse": bool(payload.get("verifyBeforeUse", True)),
        "provenance": {
            "type": "source_backed_hemlock_cycle",
            "detail": str(payload.get("provenance") or "Hemlock SIPS local cycle"),
            "evidencePath": str(payload.get("evidencePath") or ""),
        },
        "createdAt": now(),
    }
    if not entry["body"]:
        raise ValueError("A SIPS memory record needs a non-empty body.")
    if payload.get("relation"):
        entry["relation"] = payload["relation"]
    with memory_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"schema": SCHEMA, "status": "recorded", "record": entry, "memoryPath": str(memory_path)}


def memory_transition(payload: dict) -> dict:
    _root, _sips_dir, memory_path = paths(payload)
    target_id = str(payload.get("targetId") or "").strip()
    transition = str(payload.get("transition") or "").strip().lower()
    if transition not in {"promote", "demote", "rollback"}:
        raise ValueError(f"Unknown memory transition: {transition}")
    target = next((entry for entry in reversed(read_records(memory_path)) if entry.get("id") == target_id), None)
    if not target:
        raise ValueError(f"Memory record not found: {target_id or 'missing id'}")
    status_by_transition = {"promote": "active", "demote": "demoted", "rollback": "rolled_back"}
    result = record({
        "root": str(_root),
        "sipsDir": str(_sips_dir),
        "title": f"{transition.title()} memory · {target.get('title') or target_id}",
        "body": str(payload.get("note") or f"Memory transition: {transition} {target_id}"),
        "scope": target.get("scope") or str(_root),
        "tags": ",".join(target.get("tags") or ["sips", "memory"]),
        "status": status_by_transition[transition],
        "confidence": target.get("confidence") or "medium",
        "verifyBeforeUse": transition != "promote",
        "evidencePath": payload.get("evidencePath") or "",
        "provenance": payload.get("provenance") or "Hemlock memory transition",
        "relation": {"type": transition, "targetId": target_id, "targetStatus": target.get("status")},
    })
    result["transition"] = transition
    result["targetId"] = target_id
    return result


def recall(payload: dict) -> dict:
    _root, _sips_dir, memory_path = paths(payload)
    query = str(payload.get("query") or "").strip().lower()
    terms = [term for term in query.split() if len(term) > 1]
    scored = []
    for entry in read_records(memory_path):
        haystack = " ".join([str(entry.get("title", "")), str(entry.get("body", "")), " ".join(entry.get("tags", []))]).lower()
        score = sum(1 for term in terms if term in haystack)
        if score or not terms:
            scored.append((score, entry))
    scored.sort(key=lambda item: (item[0], item[1].get("createdAt", "")), reverse=True)
    return {
        "schema": "hemlock.sips.recall.v1",
        "status": "ready",
        "query": query,
        "records": [entry for _score, entry in scored[: int(payload.get("limit") or 8)]],
        "claimBoundary": "Recall is advisory memory; verify a recalled lesson against the current worktree before using it as proof.",
    }


def selfloop(payload: dict) -> dict:
    _root, sips_dir, _memory_path = paths(payload)
    state_path = sips_dir / "selfloop.json"
    current = load_json(state_path, {"status": "idle", "cycle": 0})
    action = str(payload.get("selfloopAction") or "status")
    if action == "start":
        current = {"status": "active", "focus": str(payload.get("focus") or "Improve Hemlock coding capability"), "cycle": 0, "startedAt": now(), "updatedAt": now()}
    elif action == "pause" and current.get("status") == "active":
        current["status"] = "paused"
        current["updatedAt"] = now()
    elif action == "resume" and current.get("status") == "paused":
        current["status"] = "active"
        current["updatedAt"] = now()
    elif action in {"complete", "clear"}:
        current = {"status": "complete" if action == "complete" else "idle", "cycle": int(current.get("cycle") or 0), "updatedAt": now()}
    elif action == "record":
        current["cycle"] = int(current.get("cycle") or 0) + 1
        current["lastOutcome"] = str(payload.get("outcome") or "candidate")
        current["lastReceipt"] = str(payload.get("receiptPath") or "")
        current["updatedAt"] = now()
    elif action != "status":
        raise ValueError(f"Unknown self-loop action: {action}")
    write_json(state_path, current)
    return {"schema": "hemlock.sips.selfloop.v1", "status": "ready", "state": current, "statePath": str(state_path)}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Expected one JSON payload argument")
    payload = json.loads(sys.argv[1])
    action = str(payload.get("action") or "status")
    if action == "status":
        result = status(payload)
    elif action == "routes":
        result = routes(payload)
    elif action == "record":
        result = record(payload)
    elif action == "memory-transition":
        result = memory_transition(payload)
    elif action == "recall":
        result = recall(payload)
    elif action == "selfloop":
        result = selfloop(payload)
    else:
        raise ValueError(f"Unknown SIPS action: {action}")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"schema": SCHEMA, "status": "error", "error": str(error)}), flush=True)
        raise
