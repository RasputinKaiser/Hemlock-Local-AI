import test from "node:test";
import assert from "node:assert/strict";
import { createEphemeralStreamStore, createFrameCoalescer, hasLiveStream } from "./streamStore.js";

test("deduplicates out-of-order frames and batches updates", async () => {
  let flushed = [];
  const store = createEphemeralStreamStore({ onFlush: (value) => { flushed = value; } });
  store.apply({ streamId: "s", sequence: 0, delta: "a" });
  store.apply({ streamId: "s", sequence: 0, delta: "duplicate" });
  store.apply({ streamId: "s", sequence: 1, delta: "b" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(flushed[0].text, "ab");
});

test("keeps non-content Maple channels visible without changing the content compatibility field", async () => {
  let flushed = [];
  const store = createEphemeralStreamStore({ onFlush: (value) => { flushed = value; } });
  store.apply({ streamId: "channels", sequence: 0, channel: "reasoning", delta: "checking" });
  store.apply({ streamId: "channels", sequence: 1, channel: "content", delta: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(flushed[0].text, "hello");
  assert.deepEqual(flushed[0].channels, { reasoning: "checking", content: "hello" });
});

test("terminal streams do not keep the live badge active", () => {
  assert.equal(hasLiveStream([{ streamId: "s", terminal: false, status: "running" }]), true);
  assert.equal(hasLiveStream([{ streamId: "s", terminal: true, status: "completed" }]), false);
});

test("coalescer flushes buffered frames in order without dropping any", async () => {
  const flushes = [];
  const coalescer = createFrameCoalescer({ onFlush: (batch) => flushes.push(batch) });
  for (let sequence = 0; sequence < 50; sequence += 1) coalescer.push({ streamId: "s", sequence, delta: String.fromCharCode(97 + (sequence % 26)) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(flushes.length, 1, "a burst drains as one flush");
  const batch = flushes[0];
  assert.equal(batch.length, 50, "no frames dropped");
  assert.deepEqual(batch.map((frame) => frame.sequence), Array.from({ length: 50 }, (_, index) => index), "frames stay in order");
});

test("coalescer flushes a terminal frame synchronously", () => {
  let flushed = null;
  const coalescer = createFrameCoalescer({ onFlush: (batch) => { flushed = batch; } });
  coalescer.push({ streamId: "s", sequence: 0, delta: "partial" });
  assert.equal(flushed, null, "non-terminal frames wait for the coalescing window");
  coalescer.push({ streamId: "s", sequence: 1, delta: " done", terminal: true });
  assert.ok(Array.isArray(flushed), "terminal frame drains immediately");
  assert.equal(flushed.at(-1).terminal, true);
});

test("coalescer caps latency when animation frames never tick", async () => {
  let flushed = null;
  const coalescer = createFrameCoalescer({ onFlush: (batch) => { flushed = batch; }, maxLatencyMs: 25, requestAnimationFrame: null });
  coalescer.push({ streamId: "s", sequence: 0, delta: "stalled-tab text" });
  assert.equal(flushed, null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(Array.isArray(flushed), "latency cap fires even with no rAF");
  assert.equal(flushed[0].delta, "stalled-tab text");
});

test("stream store flushes a terminal frame synchronously and keeps prior frames", () => {
  let flushed = [];
  const store = createEphemeralStreamStore({ onFlush: (value) => { flushed = value; } });
  store.apply({ streamId: "s", sequence: 0, delta: "hello " });
  store.apply({ streamId: "s", sequence: 1, delta: "world", status: "completed" });
  assert.equal(flushed.length, 1, "terminal status flushes without waiting");
  assert.equal(flushed[0].text, "hello world");
  assert.equal(flushed[0].terminal, true);
});
