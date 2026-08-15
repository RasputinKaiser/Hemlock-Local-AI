import test from "node:test";
import assert from "node:assert/strict";
import { createEphemeralStreamStore, hasLiveStream } from "./streamStore.js";

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
