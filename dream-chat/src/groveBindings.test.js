import assert from "node:assert/strict";
import test from "node:test";

import { GROVE_ROSTER, bindGrove, bindingRows, effectOf, telemetryFor } from "./groveBindings.js";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const at = (iso) => new Date(iso).toISOString();
const event = (type, status = "completed", payload = {}, createdAt = at("2026-09-20T11:59:30Z")) => ({ type, status, payload, createdAt });

test("roster entities carry real model metadata and no invented metrics", () => {
  assert.ok(GROVE_ROSTER.length >= 3);
  for (const entry of GROVE_ROSTER) {
    assert.ok(entry.id && entry.name && entry.directory && entry.params && entry.dtype);
    assert.ok(entry.size > 0 && entry.size <= 1);
    assert.ok(!("score" in entry) && !("iq" in entry), "no fabricated capability metrics");
  }
  assert.equal(GROVE_ROSTER[0].id, "maple");
});

test("inference events light the bound model and stay warm only briefly", () => {
  const events = [event("inference.started", "running", { provider: "maple" })];
  const bound = bindGrove(events, { now: NOW });
  assert.equal(bound.activity.get("maple").level, 1);
  assert.equal(bound.activity.get("lfm25").level, 0);

  const stale = bindGrove([event("inference.started", "running", { provider: "maple" }, at("2026-09-20T09:00:00Z"))], { now: NOW });
  assert.ok(stale.activity.get("maple").level <= 0.2, "old events decay to a quiet ember");
});

test("external provider lanes are not grove residents", () => {
  const bound = bindGrove([event("inference.started", "running", { provider: "claude" })], { now: NOW });
  assert.equal(bound.activity.get("maple").level, 0);
  assert.equal(bound.boundCount, 1, "the event still counts as bound activity");
});

test("dream events grow grafts on maple only", () => {
  const bound = bindGrove([event("dream.adapter.completed", "passed")], { now: NOW });
  assert.equal(bound.grafts.get("maple")?.status, "grown");
  assert.equal(bound.grafts.has("lfm25"), false);
});

test("memory events plant seeds and blooms, never trees", () => {
  const bound = bindGrove([
    event("memory.candidate.created", "candidate", { record: { id: "m1" } }),
    event("memory.promoted", "passed", { targetId: "m1" }),
  ], { now: NOW });
  assert.equal(bound.blooms.length, 2);
  assert.equal(bound.blooms[0].kind, "seed");
  assert.equal(bound.blooms[1].kind, "bloom");
});

test("failures leave an ember trail with real provenance", () => {
  const bound = bindGrove([event("inference.failed", "failed", { provider: "maple" })], { now: NOW });
  assert.equal(bound.ember?.type, "inference.failed");
  assert.equal(bound.ember?.entityId, "maple");
  assert.equal(bound.activity.get("maple").pulses.at(-1)?.kind, "ember");
});

test("sips cycles raise wind, not fabricated growth", () => {
  const bound = bindGrove([event("sips.cycle", "passed")], { now: NOW });
  assert.ok(bound.wind > 0);
  assert.equal(bound.grafts.size, 0);
});

test("experiment events light maple's lab and record honest pulses", () => {
  const bound = bindGrove([
    event("experiment.started", "running", { experimentId: "exp-0", experiment: "pendulum" }),
    event("experiment.completed", "passed", { experimentId: "exp-1", experiment: "pendulum" }),
    event("experiment.note.recorded", "recorded", { findingId: "finding-exp-1", experiment: "pendulum" }),
  ], { now: NOW });
  const maple = bound.activity.get("maple");
  assert.equal(maple.lastType, "experiment.note.recorded");
  assert.ok(maple.level >= 0.9);
  assert.equal(maple.pulses[0].kind, "lab-work");
  assert.equal(maple.pulses[1].kind, "lab-flash");
  assert.equal(maple.pulses[2].kind, "lab-seed");
  assert.equal(bound.activity.get("lfm25").level, 0, "experiments are maple's habitat, not other residents'");
  assert.equal(bound.grafts.size, 0, "experiments do not imply dream growth");
});

test("a failed experiment embers maple without a lab flash", () => {
  const bound = bindGrove([event("experiment.completed", "failed", { experiment: "orbit" })], { now: NOW });
  const maple = bound.activity.get("maple");
  assert.equal(maple.pulses.at(-1)?.kind, "ember");
  assert.equal(bound.ember?.entityId, "maple");
});

test("completed experiments with trails queue a bounded replay of real evidence", () => {
  const trail = { axes: ["theta"], points: [{ t: 0, theta: 0.2 }, { t: 1, theta: -0.2 }] };
  const bound = bindGrove([
    event("experiment.completed", "passed", { experimentId: "exp-1", experiment: "pendulum", input: { length: 1 }, trail, divergence: 0.003 }),
    event("experiment.completed", "passed", { experimentId: "exp-2", experiment: "orbit" }), // no trail — no replay
  ], { now: NOW });
  assert.equal(bound.experiments.length, 1);
  assert.equal(bound.experiments[0].id, "exp-1");
  assert.equal(bound.experiments[0].trail.points.length, 2);
  assert.equal(bound.experiments[0].input.length, 1);
});

test("the replay queue stays bounded to the newest runs", () => {
  const trail = { axes: ["x"], points: [{ t: 0, x: 1 }, { t: 1, x: -1 }] };
  const events = Array.from({ length: 9 }, (_, i) =>
    event("experiment.completed", "passed", { experimentId: `exp-${i}`, experiment: "spring", trail }, at(`2026-09-20T11:5${i}:00Z`)));
  const bound = bindGrove(events, { now: NOW });
  assert.equal(bound.experiments.length, 6);
  assert.equal(bound.experiments.at(-1).id, "exp-8");
});

test("telemetry surfaces only real usage fields", () => {
  const events = [
    event("inference.completed", "passed", {
      provider: "maple",
      telemetry: { elapsedMs: 12000, promptTokens: 900, completionTokens: 300, cacheHitRatio: 0.42, tokensPerSecond: 25 },
      mode: "structured-action",
    }),
  ];
  const telemetry = telemetryFor(events);
  assert.equal(telemetry.tokensPerSecond, 25);
  assert.equal(telemetry.cacheHitRatio, 0.42);
  assert.equal(telemetry.mode, "structured-action");
  assert.equal(telemetryFor([]), null);
});

test("binding rows keep every claim inspectable", () => {
  const rows = bindingRows([event("inference.completed", "passed", { provider: "maple" })], { now: NOW });
  const maple = rows.find((row) => row.id === "maple");
  assert.equal(maple.lastEvent.type, "inference.completed");
  assert.ok(maple.directory.includes("Models/Hemlock"));
  assert.ok(rows.every((row) => row.activity >= 0 && row.activity <= 1));
});
