#!/usr/bin/env python3
"""Small, local-only SIPS control plane for the Hemlock desktop app.

This is intentionally a bounded app-native subset rather than a copy of the
full SIPS plugin. It owns a provenance-aware local ledger, recall, routes, and
self-loop state. Model training and command execution remain explicitly
invoked by Electron, which records their receipts beside this ledger.
"""

from __future__ import annotations

import json
import os
import re
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
    with temp.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(path)


def append_jsonl(path: Path, entry: dict) -> None:
    """fsync'd append: a journal line is on disk before the call returns; a
    torn tail line is what read_records' dropped-line accounting is for."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def quarantine_corrupt(path: Path) -> Path | None:
    """Rename a corrupt file aside — never delete. Returns the quarantine
    path or None when the rename itself failed."""
    target = path.with_name(f"{path.name}.corrupt-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}")
    try:
        path.rename(target)
        return target
    except OSError:
        return None


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
    dropped = 0
    for line in memory_path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            dropped += 1
            continue
        if isinstance(value, dict):
            records.append(value)
    if dropped:
        # Evidence is preserved: valid lines are kept, and a file whose every
        # line is unparseable is quarantined aside rather than silently read
        # as "no memories". The host's own read of memory.jsonl journals the
        # durable integrity.recovered event for the same corruption.
        sys.stderr.write(
            f"[sips] dropped {dropped} unparseable line(s) from {memory_path}\n"
        )
        if not records:
            quarantine_corrupt(memory_path)
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
    append_jsonl(memory_path, entry)
    return {"schema": SCHEMA, "status": "recorded", "record": entry, "memoryPath": str(memory_path)}


def read_feedback(feedback_path: Path) -> list[dict]:
    if not feedback_path.is_file():
        return []
    entries = []
    for line in feedback_path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            entries.append(value)
    return entries


def aggregate_feedback_counts(entries: list, record_id: str | None = None) -> dict:
    """Pure: count useful/irrelevant votes per record id from ledger lines.

    Unknown kinds and blank record ids are ignored, never counted as votes.
    With record_id set, returns just that record's {useful, irrelevant}
    counts (zeroed when unseen); otherwise returns every record's counts.
    """
    counts: dict[str, dict] = {}
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("recordId") or "")
        kind = str(entry.get("kind") or "")
        if not entry_id or kind not in {"useful", "irrelevant"}:
            continue
        bucket = counts.setdefault(entry_id, {"useful": 0, "irrelevant": 0})
        bucket[kind] += 1
    if record_id is not None:
        return dict(counts.get(str(record_id), {"useful": 0, "irrelevant": 0}))
    return counts


# Fitness scoring mirrors memory_fitness.cjs exactly (base 50, +8/useful
# capped at +30, -12/irrelevant floored at -40, clamped 0..100) so the Python
# recall path and the host's demote policy rank the same records the same way.
FITNESS_BASE = 50
FITNESS_USEFUL_STEP = 8
FITNESS_USEFUL_CAP = 30
FITNESS_IRRELEVANT_STEP = 12
FITNESS_IRRELEVANT_FLOOR = 40

# A record whose effective status lands here has been curated out — it must
# not keep surfacing in recall or feed training-data selection.
EXCLUDED_STATUSES = {"demoted", "rolled_back"}

# Audit records written by memory-transition are ledger notes about other
# records, not lessons — they never belong in a recall pool or dataset.
TRANSITION_KINDS = {"promote", "demote", "rollback"}

# Consolidation writes one "consolidate" overlay note per merged cluster; like
# the transition notes it is audit metadata, not a lesson.
MERGE_KIND = "consolidate"
AUDIT_KINDS = TRANSITION_KINDS | {MERGE_KIND}

# Recency mirrors memory_fitness.cjs: up to +10 on the freshest of
# promotedAt / lastUsedAt / createdAt, full inside 7 days, linear to 0 at 90.
# Deliberately gentle — smaller than two useful votes — so a stale lesson
# fades behind a fresh confirmed one without freshness crowning an unvoted
# record.
RECENCY_BONUS_MAX = 10.0
RECENCY_FULL_DAYS = 7
RECENCY_ZERO_DAYS = 90
DAY_SECONDS = 24 * 60 * 60

# Near-duplicate threshold for memory consolidation, word-set Jaccard on
# normalized title+body (same measure as dream_train.py's dataset dedup).
# dream_train uses 0.85 on full chat rows; memory lessons repeat a fixed
# title stem ("SIPS cycle failed · …") plus domain vocabulary, so 0.85
# misses real dupes while ~0.5 would merge distinct lessons on one topic.
MEMORY_NEAR_DUPLICATE_THRESHOLD = 0.7
MERGED_BODY_MAX_CHARS = 4000


def fitness_score(useful: int, irrelevant: int) -> int:
    raw = FITNESS_BASE + min(useful * FITNESS_USEFUL_STEP, FITNESS_USEFUL_CAP)
    raw -= min(irrelevant * FITNESS_IRRELEVANT_STEP, FITNESS_IRRELEVANT_FLOOR)
    return max(0, min(100, round(raw)))


def should_auto_demote(useful: int, irrelevant: int) -> bool:
    """Parity with memory_fitness.shouldAutoDemote: 3+ irrelevant votes AND
    more irrelevant than useful means the record is net noise."""
    return irrelevant >= 3 and irrelevant > useful


def parse_iso(value) -> datetime | None:
    """Best-effort ISO timestamp parse; anything unparseable returns None."""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def transition_replay(records: list) -> tuple[dict, dict, dict]:
    """Replay append-only transition records into per-record state.

    Returns (statuses, promoted_at, last_transition):
      - statuses: effective status per record id — the record's own status
        unless a later transition re-points it (promote→active,
        demote→demoted, rollback→rolled_back);
      - promoted_at: createdAt of the latest promote transition per target
        (cleared by a later demote/rollback), so records gain a real
        promotedAt even though their own fields are never rewritten;
      - last_transition: the newest transition relation per target, for
        provenance (e.g. a demote carrying consolidatedInto).
    """
    statuses: dict[str, str] = {}
    promoted_at: dict[str, str] = {}
    last_transition: dict[str, dict] = {}
    for entry in records:
        if not isinstance(entry, dict):
            continue
        record_id = entry.get("id")
        if record_id:
            statuses.setdefault(str(record_id), str(entry.get("status") or "candidate"))
        relation = entry.get("relation") or {}
        target = str(relation.get("targetId") or "")
        kind = str(relation.get("type") or "")
        if target and kind in TRANSITION_KINDS:
            statuses[target] = {"promote": "active", "demote": "demoted", "rollback": "rolled_back"}[kind]
            last_transition[target] = {
                "type": kind,
                "at": entry.get("createdAt"),
                "recordId": entry.get("id"),
                "consolidatedInto": relation.get("consolidatedInto"),
            }
            if kind == "promote":
                promoted_at[target] = entry.get("createdAt")
            else:
                promoted_at.pop(target, None)
    return statuses, promoted_at, last_transition


def effective_statuses(records: list) -> dict:
    """Resolve each record's current status by replaying transition records.

    Transitions are append-only: a demote lands as a NEW record carrying
    relation={type,targetId}; the target's own ``status`` field is never
    rewritten. Effective status = the record's own status unless a later
    transition record re-points it (promote→active, demote→demoted,
    rollback→rolled_back).
    """
    statuses, _promoted_at, _last_transition = transition_replay(records)
    return statuses


def merge_overlays(records: list, statuses: dict) -> dict:
    """Collect active consolidation overlays per kept-record id.

    A "consolidate" note carries relation={type:"consolidate", targetId,
    mergedFrom, mergedBody?, mergedFeedback?}. It applies only while the note
    itself is live — demoting or rolling back the note id removes the overlay,
    which is what makes consolidation undoable without rewriting history.
    Overlays accumulate: a record merged into twice unions every mergedFrom.
    """
    overlays: dict[str, dict] = {}
    for entry in records:
        if not isinstance(entry, dict):
            continue
        relation = entry.get("relation") or {}
        if str(relation.get("type") or "") != MERGE_KIND:
            continue
        audit_id = str(entry.get("id") or "")
        if audit_id and statuses.get(audit_id, "candidate") in EXCLUDED_STATUSES:
            continue
        target = str(relation.get("targetId") or "")
        if not target:
            continue
        overlay = overlays.setdefault(target, {"mergedFrom": [], "auditIds": [], "mergedBody": None, "consolidatedAt": None})
        for merged_id in relation.get("mergedFrom") or []:
            merged_id = str(merged_id)
            if merged_id and merged_id not in overlay["mergedFrom"]:
                overlay["mergedFrom"].append(merged_id)
        if audit_id:
            overlay["auditIds"].append(audit_id)
        merged_body = str(relation.get("mergedBody") or "").strip()
        if merged_body:
            overlay["mergedBody"] = merged_body
        if entry.get("createdAt"):
            overlay["consolidatedAt"] = entry.get("createdAt")
    return overlays


def feedback_last_used(entries: list) -> dict:
    """Latest feedback timestamp per record id — the record's lastUsedAt."""
    last: dict[str, str] = {}
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        record_id = str(entry.get("recordId") or "")
        at = str(entry.get("at") or "")
        if record_id and at and (record_id not in last or at > last[record_id]):
            last[record_id] = at
    return last


def recency_bonus(timestamps: list, now_dt: datetime) -> float:
    """Mild freshness bonus on the freshest timestamp — parity with
    memory_fitness.recencyBonus (max +10, full ≤7 days, zero ≥90 days)."""
    freshest = None
    for value in timestamps:
        parsed = parse_iso(value)
        if parsed is not None and (freshest is None or parsed > freshest):
            freshest = parsed
    if freshest is None:
        return 0.0
    age_days = max(0.0, (now_dt - freshest).total_seconds() / DAY_SECONDS)
    if age_days <= RECENCY_FULL_DAYS:
        return RECENCY_BONUS_MAX
    if age_days >= RECENCY_ZERO_DAYS:
        return 0.0
    span = RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS
    return RECENCY_BONUS_MAX * (1 - (age_days - RECENCY_FULL_DAYS) / span)


def is_audit_record(entry: dict) -> bool:
    relation = entry.get("relation")
    return isinstance(relation, dict) and str(relation.get("type") or "") in AUDIT_KINDS


def scored_memory_records(records: list, counts: dict, include_demoted: bool = False, include_audit: bool = False, feedback_entries: list | None = None) -> list:
    """Annotate each usable record with its effective status, feedback counts,
    fitness score, and staleness/provenance fields. Demoted/rolled-back
    records and transition/consolidation audit notes are excluded by default;
    callers opt back in explicitly.

    Per record, on top of the ledger fields:
      - effectiveStatus, feedback {useful, irrelevant}, fitness (0..100,
        feedback-only parity with memory_fitness.fitness_score);
      - rankScore: fitness + recencyBonus — the ordering signal for recall and
        selection, so a stale lesson cannot outrank a fresh confirmed one;
      - recencyBonus, ageDays (floor days since createdAt, null if unknown),
        lastUsedAt (latest feedback vote timestamp or null), sourceRefs
        ([provenance.evidencePath] when the creating receipt is derivable);
      - promotedAt derived from the latest live promote transition when the
        record's own field is absent;
      - mergedFrom/consolidatedAt when a consolidation overlay applies (its
        mergedBody replaces body, absorbed feedback counts fold into the
        keeper's), lastTransition/consolidatedInto on transition targets.
    """
    statuses, promoted_at, last_transition = transition_replay(records)
    overlays = merge_overlays(records, statuses)
    last_used = feedback_last_used(feedback_entries)
    now_dt = datetime.now(timezone.utc)
    scored = []
    for entry in records:
        if not isinstance(entry, dict):
            continue
        record_id = str(entry.get("id") or "")
        effective = statuses.get(record_id, str(entry.get("status") or "candidate"))
        if not include_demoted and effective in EXCLUDED_STATUSES:
            continue
        if not include_audit and is_audit_record(entry):
            continue
        feedback = dict(counts.get(record_id, {"useful": 0, "irrelevant": 0}))
        overlay = overlays.get(record_id)
        if overlay:
            # Absorbed records keep their own ledger votes; the keeper
            # inherits them so consolidation preserves earned fitness.
            for merged_id in overlay["mergedFrom"]:
                absorbed = counts.get(merged_id) or {}
                feedback["useful"] += int(absorbed.get("useful") or 0)
                feedback["irrelevant"] += int(absorbed.get("irrelevant") or 0)
        created = parse_iso(entry.get("createdAt"))
        last_used_at = last_used.get(record_id)
        promoted = entry.get("promotedAt") or promoted_at.get(record_id)
        provenance = entry.get("provenance") or {}
        source_refs = []
        evidence_path = str(provenance.get("evidencePath") or "")
        if evidence_path:
            source_refs.append(evidence_path)
        annotated = dict(entry)
        annotated["effectiveStatus"] = effective
        annotated["feedback"] = feedback
        annotated["fitness"] = fitness_score(feedback.get("useful", 0), feedback.get("irrelevant", 0))
        annotated["recencyBonus"] = round(recency_bonus([promoted, last_used_at, entry.get("createdAt")], now_dt), 2)
        annotated["rankScore"] = round(annotated["fitness"] + annotated["recencyBonus"], 2)
        annotated["ageDays"] = max(0, int((now_dt - created).total_seconds() // DAY_SECONDS)) if created else None
        annotated["lastUsedAt"] = last_used_at or None
        annotated["sourceRefs"] = source_refs
        if promoted and not annotated.get("promotedAt"):
            annotated["promotedAt"] = promoted
        if overlay:
            annotated["mergedFrom"] = list(overlay["mergedFrom"])
            annotated["consolidatedAt"] = overlay["consolidatedAt"]
            if overlay["mergedBody"]:
                annotated["body"] = overlay["mergedBody"]
        transition = last_transition.get(record_id)
        if transition:
            annotated["lastTransition"] = {"type": transition["type"], "at": transition["at"]}
            if transition.get("consolidatedInto"):
                annotated["consolidatedInto"] = transition["consolidatedInto"]
        scored.append(annotated)
    return scored


def normalized_text(text) -> str:
    """Lowercase alphanumeric-only text — same normalization as
    dream_train.py's near-dedup so "duplicate" means the same thing here."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", str(text).lower())).strip()


def record_word_set(entry: dict) -> set:
    return set(normalized_text(f"{entry.get('title') or ''} {entry.get('body') or ''}").split())


def jaccard(left: set, right: set) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def duplicate_clusters(pool: list, threshold: float) -> list:
    """Group near-duplicate records by word-set Jaccard on title+body.

    The pool is walked in keeper order (fitness desc, newest first, id asc) so
    each cluster's first member is the record consolidation keeps. Membership
    is single-linkage: a record joins the first cluster it is similar to any
    member of, which catches the repeated-stem case ("SIPS cycle failed · X"
    with a slightly different error tail) without a separate clustering pass.
    """
    def order_key(entry: dict):
        created = parse_iso(entry.get("createdAt"))
        created_ts = created.timestamp() if created else float("-inf")
        return (-(int(entry.get("fitness") or 0)), -created_ts, str(entry.get("id") or ""))

    clusters = []
    for entry in sorted(pool, key=order_key):
        words = record_word_set(entry)
        for cluster in clusters:
            if any(jaccard(words, prior) >= threshold for prior in cluster["wordSets"]):
                cluster["members"].append(entry)
                cluster["wordSets"].append(words)
                break
        else:
            clusters.append({"members": [entry], "wordSets": [words]})
    return [cluster["members"] for cluster in clusters if len(cluster["members"]) > 1]


def merge_bodies(kept_body: str, absorbed_bodies: list) -> str:
    """Merge complementary detail into the keeper's body.

    Only sentences/fragments whose normalized text is not already covered by
    the merged result are appended — true duplicates contribute nothing, so
    the merged body stays readable instead of doubling.
    """
    merged = str(kept_body or "").strip()
    covered = normalized_text(merged)
    for body in absorbed_bodies or []:
        for piece in re.split(r"(?<=[.!?])\s+|[\n;]+", str(body or "")):
            piece = piece.strip()
            norm = normalized_text(piece)
            if len(norm) < 8 or norm in covered:
                continue
            merged = f"{merged}\n{piece}" if merged else piece
            covered = normalized_text(merged)
        if len(merged) >= MERGED_BODY_MAX_CHARS:
            break
    if len(merged) > MERGED_BODY_MAX_CHARS:
        merged = merged[:MERGED_BODY_MAX_CHARS].rstrip() + " …"
    return merged


def memory_feedback(payload: dict) -> dict:
    """Append one recall-usefulness vote to the sidecar feedback ledger.

    Additive only: existing memory.jsonl records are never rewritten; votes
    land in sipsDir/feedback.jsonl so old ledgers stay byte-identical. The
    demote decision itself stays with the host (memory_fitness.shouldAutoDemote
    + the existing demote transition), which reads `counts` and `recordStatus`.
    """
    _root, sips_dir, memory_path = paths(payload)
    record_id = str(payload.get("recordId") or "").strip()
    kind = str(payload.get("kind") or "").strip().lower()
    if not record_id:
        raise ValueError("Memory feedback needs a non-empty recordId.")
    if kind not in {"useful", "irrelevant"}:
        raise ValueError(f"Unknown recall feedback kind: {kind or 'missing'}")
    feedback_path = sips_dir / "feedback.jsonl"
    entry = {
        "schema": "hemlock.sips.feedback.v1",
        "recordId": record_id,
        "kind": kind,
        "query": str(payload.get("query") or ""),
        "at": now(),
    }
    append_jsonl(feedback_path, entry)
    records = read_records(memory_path)
    target = next((item for item in reversed(records) if item.get("id") == record_id), None)
    # The host gates auto-demote on recordStatus === "active"; that must be the
    # EFFECTIVE status. A record promoted via transition keeps status
    # "candidate" in its own fields — replaying transitions is the only way to
    # see it as active, so without this a promoted lesson could never
    # auto-demote on bad recall feedback.
    effective = transition_replay(records)[0].get(record_id) if target else None
    return {
        "schema": SCHEMA,
        "status": "recorded",
        "feedback": entry,
        "recordId": record_id,
        "counts": aggregate_feedback_counts(read_feedback(feedback_path), record_id),
        "recordStatus": effective,
        "feedbackPath": str(feedback_path),
        "claimBoundary": "Feedback counts are advisory; auto-demotion stays a separate host decision using the existing demote transition.",
    }


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
    _root, sips_dir, memory_path = paths(payload)
    query = str(payload.get("query") or "").strip().lower()
    terms = [term for term in query.split() if len(term) > 1]
    feedback_entries = read_feedback(sips_dir / "feedback.jsonl")
    counts = aggregate_feedback_counts(feedback_entries)
    pool = scored_memory_records(
        read_records(memory_path),
        counts,
        include_demoted=bool(payload.get("includeDemoted")),
        include_audit=bool(payload.get("includeAudit")),
        feedback_entries=feedback_entries,
    )
    scored = []
    for entry in pool:
        haystack = " ".join([str(entry.get("title", "")), str(entry.get("body", "")), " ".join(entry.get("tags", []))]).lower()
        score = sum(1 for term in terms if term in haystack)
        if score or not terms:
            scored.append((score, entry))
    # Term hits first, then rankScore = fitness + mild recency (a stale lesson
    # sinks below an equal-relevance fresh one), then creation freshness.
    scored.sort(key=lambda item: (item[0], item[1]["rankScore"], item[1].get("createdAt", "")), reverse=True)
    return {
        "schema": "hemlock.sips.recall.v1",
        "status": "ready",
        "query": query,
        "records": [entry for _score, entry in scored[: int(payload.get("limit") or 8)]],
        "claimBoundary": "Recall is advisory memory; verify a recalled lesson against the current worktree before using it as proof.",
    }


def memory_select(payload: dict) -> dict:
    """Rank memory records as Dream training-data candidates.

    The host decides what actually reaches a dataset; this action supplies the
    evidence: fitness from accumulated recall feedback, net-noise exclusion
    (auto-demote parity), and a ready-to-use chat row per record so a
    selection receipt can show exactly which lesson text would train.
    """
    _root, sips_dir, memory_path = paths(payload)
    feedback_entries = read_feedback(sips_dir / "feedback.jsonl")
    counts = aggregate_feedback_counts(feedback_entries)
    limit = max(1, int(payload.get("limit") or 8))
    min_fitness = int(payload.get("minFitness") or 0)
    status_filter = str(payload.get("status") or "").strip().lower()
    pool = scored_memory_records(read_records(memory_path), counts, feedback_entries=feedback_entries)
    selected = []
    for entry in pool:
        feedback = entry["feedback"]
        if should_auto_demote(feedback.get("useful", 0), feedback.get("irrelevant", 0)):
            continue
        if entry["fitness"] < min_fitness:
            continue
        if status_filter and entry["effectiveStatus"] != status_filter:
            continue
        body = str(entry.get("body") or "").strip()
        if not body:
            continue
        row = dict(entry)
        row["suggestedExample"] = {
            "messages": [
                {"role": "user", "content": "What verified lessons should guide your answer here?"},
                {"role": "assistant", "content": f"{entry.get('title') or 'Saved lesson'}: {body}"},
            ],
            "metadata": {
                "source": "memory",
                "recordId": entry.get("id"),
                "fitness": entry["fitness"],
                "memoryStatus": entry["effectiveStatus"],
            },
        }
        selected.append(row)
    selected.sort(key=lambda item: (item["rankScore"], item.get("createdAt", "")), reverse=True)
    return {
        "schema": "hemlock.sips.memory-select.v1",
        "status": "ready",
        "records": selected[:limit],
        "poolSize": len(pool),
        "minFitness": min_fitness,
        "memoryPath": str(memory_path),
        "claimBoundary": "Selection is advisory: fitness reflects recall feedback counts only and does not verify a lesson's current truth.",
    }


def memory_list(payload: dict) -> dict:
    """Annotated inventory of the memory store for the Memory Garden view.

    Read-only: every record comes back with effective status, feedback,
    fitness, and the staleness/provenance fields (ageDays, lastUsedAt,
    sourceRefs, promotedAt, lastTransition/consolidatedInto, mergedFrom).
    Live near-duplicate clusters are marked per record — nearDuplicateOf
    points a would-be absorbed record at the cluster's keeper and clusterSize
    counts members — so the UI can render dupes without consolidating them.
    """
    _root, sips_dir, memory_path = paths(payload)
    feedback_entries = read_feedback(sips_dir / "feedback.jsonl")
    counts = aggregate_feedback_counts(feedback_entries)
    include_demoted = payload.get("includeDemoted")
    include_demoted = True if include_demoted is None else bool(include_demoted)
    records = scored_memory_records(
        read_records(memory_path),
        counts,
        include_demoted=include_demoted,
        include_audit=bool(payload.get("includeAudit")),
        feedback_entries=feedback_entries,
    )
    try:
        threshold = float(payload.get("threshold") or MEMORY_NEAR_DUPLICATE_THRESHOLD)
    except (TypeError, ValueError):
        threshold = MEMORY_NEAR_DUPLICATE_THRESHOLD
    pool = [entry for entry in records if entry["effectiveStatus"] in {"candidate", "active"}]
    for members in duplicate_clusters(pool, threshold):
        kept_id = str(members[0].get("id") or "")
        for member in members:
            member["clusterSize"] = len(members)
            member["nearDuplicateOf"] = None if str(member.get("id") or "") == kept_id else kept_id
    records.sort(key=lambda item: (item["rankScore"], str(item.get("createdAt") or ""), str(item.get("id") or "")), reverse=True)
    return {
        "schema": "hemlock.sips.memory-list.v1",
        "status": "ready",
        "records": records,
        "count": len(records),
        "threshold": threshold,
        "memoryPath": str(memory_path),
        "claimBoundary": "The listing is an annotated read of the local ledger; nearDuplicateOf marks similarity, not a confirmed duplicate.",
    }


def memory_consolidate(payload: dict) -> dict:
    """Merge near-duplicate memory records into their fittest cluster member.

    Append-only and rollback-safe: for each cluster the keeper gains a
    "consolidate" overlay note (mergedFrom provenance, merged body, absorbed
    feedback totals) and every absorbed record gets a normal demote
    transition carrying reason "consolidated-into-<keptId>". Nothing is
    deleted — a promote transition restores an absorbed record, and a
    rollback/demote on the overlay note drops the merge. dryRun previews the
    same clusters without writing anything.
    """
    _root, sips_dir, memory_path = paths(payload)
    try:
        threshold = float(payload.get("threshold") or MEMORY_NEAR_DUPLICATE_THRESHOLD)
    except (TypeError, ValueError):
        threshold = MEMORY_NEAR_DUPLICATE_THRESHOLD
    threshold = max(0.05, min(1.0, threshold))
    dry_run = bool(payload.get("dryRun"))
    feedback_entries = read_feedback(sips_dir / "feedback.jsonl")
    counts = aggregate_feedback_counts(feedback_entries)
    records = read_records(memory_path)
    pool = [
        entry
        for entry in scored_memory_records(records, counts, feedback_entries=feedback_entries)
        if entry["effectiveStatus"] in {"candidate", "active"}
    ]
    clusters = []
    for members in duplicate_clusters(pool, threshold):
        kept = members[0]
        absorbed = members[1:]
        kept_id = str(kept.get("id") or "")
        kept_words = record_word_set(kept)
        links = [
            {"id": str(entry.get("id") or ""), "similarity": round(jaccard(kept_words, record_word_set(entry)), 3)}
            for entry in absorbed
        ]
        merged_body = merge_bodies(kept.get("body"), [entry.get("body") for entry in absorbed])
        cluster = {
            "keptId": kept_id,
            "absorbedIds": [str(entry.get("id") or "") for entry in absorbed],
            "links": links,
            "mergedBody": merged_body if merged_body != str(kept.get("body") or "").strip() else None,
        }
        if not dry_run:
            merged_feedback = {
                "useful": sum(int((counts.get(str(entry.get("id") or "")) or {}).get("useful") or 0) for entry in absorbed),
                "irrelevant": sum(int((counts.get(str(entry.get("id") or "")) or {}).get("irrelevant") or 0) for entry in absorbed),
            }
            audit = record({
                "root": str(_root),
                "sipsDir": str(sips_dir),
                "title": f"Consolidate memory · {kept.get('title') or kept_id}",
                "body": str(payload.get("note") or f"Merged {len(absorbed)} near-duplicate record(s) into {kept_id}: {', '.join(cluster['absorbedIds'])}"),
                "scope": kept.get("scope") or str(_root),
                "tags": ",".join(kept.get("tags") or ["sips", "memory"]),
                "status": "active",
                "confidence": kept.get("confidence") or "medium",
                "verifyBeforeUse": True,
                "evidencePath": payload.get("evidencePath") or "",
                "provenance": "Hemlock memory consolidate",
                "relation": {
                    "type": MERGE_KIND,
                    "targetId": kept_id,
                    "mergedFrom": cluster["absorbedIds"],
                    "mergedBody": cluster["mergedBody"],
                    "mergedFeedback": merged_feedback,
                },
            })
            cluster["auditId"] = audit["record"]["id"]
            demote_ids = []
            for entry in absorbed:
                absorbed_id = str(entry.get("id") or "")
                reason = f"consolidated-into-{kept_id}"
                demoted = record({
                    "root": str(_root),
                    "sipsDir": str(sips_dir),
                    "title": f"Demote memory · {entry.get('title') or absorbed_id}",
                    "body": reason,
                    "scope": entry.get("scope") or str(_root),
                    "tags": ",".join(entry.get("tags") or ["sips", "memory"]),
                    "status": "demoted",
                    "confidence": entry.get("confidence") or "medium",
                    "verifyBeforeUse": True,
                    "evidencePath": payload.get("evidencePath") or "",
                    "provenance": "Hemlock memory consolidate",
                    "relation": {
                        "type": "demote",
                        "targetId": absorbed_id,
                        "targetStatus": entry.get("effectiveStatus") or entry.get("status"),
                        "consolidatedInto": kept_id,
                        "reason": reason,
                    },
                })
                demote_ids.append(demoted["record"]["id"])
            cluster["demoteIds"] = demote_ids
        clusters.append(cluster)
    return {
        "schema": "hemlock.sips.memory-consolidate.v1",
        "status": "preview" if dry_run else "consolidated",
        "threshold": threshold,
        "scanned": len(pool),
        "clusters": clusters,
        "merged": len(clusters),
        "keptIds": [cluster["keptId"] for cluster in clusters],
        "memoryPath": str(memory_path),
        "claimBoundary": "Absorbed records are demoted, never deleted; promote restores them and rolling back the consolidate note drops the merge overlay.",
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
    elif action == "memory-feedback":
        result = memory_feedback(payload)
    elif action == "recall":
        result = recall(payload)
    elif action == "memory-select":
        result = memory_select(payload)
    elif action == "memory-list":
        result = memory_list(payload)
    elif action == "memory-consolidate":
        result = memory_consolidate(payload)
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
