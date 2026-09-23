import test from "node:test";
import assert from "node:assert/strict";
import {
  authoringEvidence,
  AUTHORING_FLAG_COPY,
  buildTranscriptTimeline,
  inputContract,
  isTimelineEvent,
  planProgress,
  planStepStates,
  scoreReceipt,
  TRANSCRIPT_EVENT_TYPES,
} from "./agentTimeline.js";

test("isTimelineEvent accepts only durable receipt-bearing types", () => {
  assert.equal(isTimelineEvent({ type: "action.scored" }), true);
  assert.equal(isTimelineEvent({ type: "plan.adapted" }), true);
  assert.equal(isTimelineEvent({ type: "inference.started" }), false);
  assert.equal(isTimelineEvent({ type: "context.quality.updated" }), false);
  assert.equal(isTimelineEvent(null), false);
  assert.equal(isTimelineEvent({}), false);
});

test("timeline buckets events between dated messages in stable order", () => {
  const messages = [
    { id: "m1", createdAt: "2026-08-24T10:00:00Z" },
    { id: "m2", createdAt: "2026-08-24T10:05:00Z" },
  ];
  const events = [
    { id: "e-old", type: "task.created", createdAt: "2026-08-24T09:59:00Z" },
    { id: "e-plan", type: "plan.proposed", createdAt: "2026-08-24T10:01:00Z" },
    { id: "e-score", type: "action.scored", createdAt: "2026-08-24T10:02:00Z" },
    { id: "e-obs", type: "observation.recorded", createdAt: "2026-08-24T10:07:00Z" },
  ];
  const timeline = buildTranscriptTimeline(messages, events, "task-1");
  assert.deepEqual(timeline.before.map((event) => event.id), ["e-old"]);
  assert.deepEqual((timeline.after.get(0) || []).map((event) => event.id), ["e-plan", "e-score"]);
  // An event newer than every dated message attaches after the last one —
  // same transcript position as tail, rendered before the live stream.
  assert.deepEqual((timeline.after.get(1) || []).map((event) => event.id), ["e-obs"]);
  assert.deepEqual(timeline.tail, []);
});

test("timeline never leaks another task's events, and keeps taskless events", () => {
  const messages = [{ id: "m1", createdAt: "2026-08-24T10:00:00Z" }];
  const events = [
    { id: "mine", type: "action.completed", taskId: "task-1", createdAt: "2026-08-24T10:01:00Z" },
    { id: "theirs", type: "action.completed", taskId: "task-2", createdAt: "2026-08-24T10:01:00Z" },
    { id: "theirs-nested", type: "action.completed", payload: { taskId: "task-2" }, createdAt: "2026-08-24T10:01:00Z" },
    { id: "session", type: "dream.adapter.grafted", createdAt: "2026-08-24T10:01:00Z" },
  ];
  const timeline = buildTranscriptTimeline(messages, events, "task-1");
  assert.deepEqual(timeline.after.get(0).map((event) => event.id), ["mine", "session"]);
  // And with no active task at all, task-scoped events still stay out.
  const empty = buildTranscriptTimeline(messages, events, null);
  assert.deepEqual(empty.after.get(0).map((event) => event.id), ["session"]);
});

test("undated messages never swallow events; undated events land in tail", () => {
  const messages = [{ id: "m1" }, { id: "m2", createdAt: "2026-08-24T10:00:00Z" }];
  const events = [
    { id: "e-nodate", type: "task.paused" },
    { id: "e-dated", type: "task.resumed", createdAt: "2026-08-24T10:05:00Z" },
  ];
  const timeline = buildTranscriptTimeline(messages, events, "task-1");
  assert.deepEqual(timeline.tail.map((event) => event.id), ["e-nodate"]);
  // A dated event still lands after the last dated message, even though the
  // first message carries no timestamp at all.
  assert.deepEqual(timeline.after.get(1).map((event) => event.id), ["e-dated"]);
});

test("inputContract renders bounded scalar previews and summarizes objects", () => {
  assert.deepEqual(inputContract(null), []);
  assert.deepEqual(inputContract("raw"), []);
  const chips = inputContract({ path: "src/main.jsx", mode: "replace", lines: 120, meta: { a: 1, b: 2 }, empty: "", skip: null });
  assert.deepEqual(chips.map((chip) => chip.key), ["path", "mode", "lines", "meta"]);
  assert.equal(chips[3].value, "{a,b}");
  const long = inputContract({ note: "x".repeat(80) }, { valueLength: 10 });
  assert.equal(long[0].value.length, 10);
  assert.ok(long[0].value.endsWith("…"));
  assert.equal(inputContract({ a: 1, b: 2, c: 3, d: 4, e: 5 }).length, 4);
});

test("scoreReceipt normalizes an action.scored payload without inventing fields", () => {
  const receipt = scoreReceipt({
    winner: { commandId: "code.apply", kind: "command" },
    runnerUp: { commandId: "git.diff" },
    margin: 1.25,
    candidateCount: 3,
    cachedTokens: 512,
    elapsedMs: 840,
    complete: true,
  });
  assert.equal(receipt.winner, "code.apply");
  assert.equal(receipt.runnerUp, "git.diff");
  assert.equal(receipt.margin, 1.25);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.degraded, false);
  const degraded = scoreReceipt({ status: "degraded", error: "scorer offline" });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.margin, null);
  assert.equal(degraded.winner, null);
});

test("planStepStates mirrors the orchestrator progression rule", () => {
  const steps = [{ commandId: "repo-map" }, { commandId: "code.apply" }, { commandId: "verify" }];
  assert.deepEqual(planStepStates(steps, 0, { taskStatus: "running" }), ["current", "queued", "queued"]);
  assert.deepEqual(planStepStates(steps, 1, { taskStatus: "running" }), ["done", "current", "queued"]);
  assert.deepEqual(planStepStates(steps, 3, { taskStatus: "running" }), ["done", "done", "done"]);
  assert.deepEqual(planStepStates(steps, 1, { taskStatus: "blocked" }), ["done", "blocked", "queued"]);
  assert.deepEqual(planStepStates(steps, 0, { taskStatus: "waiting_for_approval" }), ["current", "queued", "queued"]);
  assert.deepEqual(planStepStates(steps, 0, { planStatus: "completed" }), ["done", "done", "done"]);
  // An idle (not yet approved) plan marks its first step ready, not running.
  assert.deepEqual(planStepStates(steps, 0, { taskStatus: "ready" }), ["ready", "queued", "queued"]);
  assert.deepEqual(planStepStates([], 0), []);
});

test("planProgress reports honest done/total from completed actions", () => {
  assert.equal(planProgress([], 0), null);
  assert.deepEqual(planProgress([{ a: 1 }, { b: 2 }], 1, "approved"), { done: 1, total: 2, label: "1/2 steps", ratio: 0.5 });
  assert.deepEqual(planProgress([{ a: 1 }, { b: 2 }], 0, "completed"), { done: 2, total: 2, label: "2/2 steps", ratio: 1 });
  // A stale action count can never overrun the plan boundary.
  assert.equal(planProgress([{ a: 1 }], 9, "approved").done, 1);
});

test("TRANSCRIPT_EVENT_TYPES stays aligned with host-emitted receipts", () => {
  for (const required of ["action.scored", "plan.adapted", "observation.recorded", "task.paused", "task.resumed", "artifact.repair.exhausted", "artifact.author.repaired"]) {
    assert.ok(TRANSCRIPT_EVENT_TYPES.has(required), `missing ${required}`);
  }
});

test("authoringEvidence surfaces placeholder/repaired markers wherever they ride", () => {
  const flags = authoringEvidence({
    payload: {
      action: {
        input: {
          evidence: [
            { type: "authoring.host_fallback", reason: "Maple returned malformed source" },
            { type: "authoring.host_fallback", reason: "Maple returned malformed source" },
            { type: "unrelated", reason: "ignored" },
          ],
        },
      },
      input: { evidence: [{ type: "authoring.repaired_source", reason: "bounded repair wrote it" }] },
    },
  });
  assert.deepEqual(flags, [
    { type: "authoring.repaired_source", reason: "bounded repair wrote it" },
    { type: "authoring.host_fallback", reason: "Maple returned malformed source" },
  ]);
  assert.deepEqual(authoringEvidence(null), []);
  assert.deepEqual(authoringEvidence({ payload: {} }), []);
  assert.deepEqual(authoringEvidence({ payload: { evidence: ["string-entry"] } }), []);
  assert.ok(AUTHORING_FLAG_COPY["authoring.host_fallback"].includes("Placeholder content"));
  assert.ok(AUTHORING_FLAG_COPY["authoring.repaired_source"].includes("Repaired content"));
});
