import test from "node:test";
import assert from "node:assert/strict";
import {
  activeJobChip,
  heartbeatChips,
  liveRateChip,
  queueChip,
  runtimeChip,
  warmCacheChip,
} from "./statusChips.js";

test("runtime chip separates cold, warming, ready, and down honestly", () => {
  assert.equal(runtimeChip({}).label, "runtime cold");
  assert.equal(runtimeChip({ serverProcessReady: null, inferenceReady: null }).label, "runtime cold");
  assert.equal(runtimeChip({ serverProcessReady: true, inferenceReady: null }).label, "runtime warming");
  assert.equal(runtimeChip({ serverProcessReady: true, inferenceReady: false }).label, "runtime warming");
  assert.equal(runtimeChip({ serverProcessReady: true, inferenceReady: true }).label, "runtime ready");
  assert.equal(runtimeChip({ serverProcessReady: false }).label, "runtime down");
  assert.equal(runtimeChip({ serverProcessReady: false }).tone, "warn");
  assert.equal(runtimeChip({ serverProcessReady: true, inferenceReady: true }).tone, "ok");
});

test("active job chip prefers long-running work and surfaces parked states", () => {
  assert.equal(activeJobChip({ isDreaming: true, dreamProgress: 42, task: { status: "running" } }).label, "dream 42%");
  assert.equal(activeJobChip({ sipsCycleState: "running", sipsProgress: 10 }).label, "sips 10%");
  assert.equal(activeJobChip({ task: { status: "running" } }).label, "task active");
  assert.equal(activeJobChip({ task: { status: "waiting_for_approval" } }).label, "approval wait");
  assert.equal(activeJobChip({ task: { status: "blocked", blockedReason: "budget" } }).title, "budget");
  assert.equal(activeJobChip({ task: { status: "paused" } }).label, "task paused");
  assert.equal(activeJobChip({ task: { status: "completed" } }), null);
  assert.equal(activeJobChip({}), null, "idle surfaces stay quiet");
});

test("queue chip reports pending intents and hides when the queue is clear", () => {
  assert.equal(queueChip(null), null);
  assert.equal(queueChip({ pending: [] }), null);
  const chip = queueChip({ pending: [{ id: "a" }, { id: "b" }] });
  assert.equal(chip.label, "2 queued");
  assert.equal(chip.tone, "amber");
});

test("live-rate chip only claims a measured rate", () => {
  assert.equal(liveRateChip({ liveStream: false }), null);
  assert.equal(liveRateChip({ liveStream: true, streamFrames: [] }).label, "streaming");
  const frame = {
    streamId: "s1",
    terminal: false,
    startedAt: new Date(0).toISOString(),
    usage: { completion_tokens: 100 },
  };
  const chip = liveRateChip({ liveStream: true, streamFrames: [frame] }, 4000);
  assert.equal(chip.label, "tok/s 25");
  const approx = liveRateChip({ liveStream: true, streamFrames: [{ ...frame, usage: { completionTokensApproximate: true, completion_tokens: 50 } }] }, 4000);
  assert.equal(approx.label, "tok/s ~12.5");
  const stale = liveRateChip({ liveStream: true, streamFrames: [{ streamId: "s2", terminal: true }] });
  assert.equal(stale.label, "streaming", "a terminal frame with no usage is still just streaming");
});

test("warm-cache chip reads defensive fields and stays silent without them", () => {
  assert.equal(warmCacheChip(null), null);
  assert.equal(warmCacheChip({}), null);
  assert.equal(warmCacheChip({ runtime: { warmCachedTokens: 2048, lastWarmAt: new Date(0).toISOString() } }, 120000).label, "warm 2048 tok · 2m ago");
  assert.equal(warmCacheChip({ lastWarmAt: new Date(0).toISOString() }, 90000).label, "warm 2m ago");
  assert.equal(warmCacheChip({ warmCachedTokens: 512 }).label, "warm 512 tok");
});

test("heartbeatChips composes the quiet line", () => {
  const chips = heartbeatChips({
    serverProcessReady: true,
    inferenceReady: true,
    isDreaming: false,
    task: { status: "completed" },
    queueState: { pending: [{ id: "q" }] },
    liveStream: false,
  });
  assert.deepEqual(chips.map((chip) => chip.id), ["runtime", "queue"]);
  assert.equal(chips[0].label, "runtime ready");
});
