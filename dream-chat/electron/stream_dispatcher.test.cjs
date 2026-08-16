const test = require("node:test");
const assert = require("node:assert/strict");
const { createStreamFrameCoalescer } = require("./stream_dispatcher.cjs");

test("coalesces same-channel deltas while preserving the latest receipt fields", () => {
  const emitted = [];
  const dispatcher = createStreamFrameCoalescer({ emit: (frame) => emitted.push(frame), intervalMs: 60_000 });

  dispatcher.push({ streamId: "stream-1", channel: "content", delta: "Hel", sequence: 4, time: "t1" });
  dispatcher.push({ streamId: "stream-1", channel: "content", delta: "lo", sequence: 5, time: "t2", usage: { completion_tokens: 2 }, stopReason: "length" });
  assert.equal(emitted.length, 0);
  assert.equal(dispatcher.pendingCount(), 1);

  dispatcher.flush();

  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    streamId: "stream-1",
    channel: "content",
    delta: "Hello",
    time: "t2",
    usage: { completion_tokens: 2 },
    stopReason: "length",
    terminal: false,
  });
  dispatcher.dispose();
});

test("flushes channels in first-seen order and does not leak pending timers", () => {
  const emitted = [];
  const dispatcher = createStreamFrameCoalescer({ emit: (frame) => emitted.push(frame), intervalMs: 60_000 });

  dispatcher.push({ channel: "work_note", delta: "plan" });
  dispatcher.push({ channel: "content", delta: "answer" });
  dispatcher.push({ channel: "work_note", delta: " more" });
  dispatcher.flush();

  assert.deepEqual(emitted.map(({ channel, delta }) => ({ channel, delta })), [
    { channel: "work_note", delta: "plan more" },
    { channel: "content", delta: "answer" },
  ]);
  assert.equal(dispatcher.pendingCount(), 0);
  dispatcher.dispose();
});

test("dispose drops queued frames without emitting them", () => {
  const emitted = [];
  const dispatcher = createStreamFrameCoalescer({ emit: (frame) => emitted.push(frame), intervalMs: 60_000 });
  dispatcher.push({ channel: "content", delta: "discard me" });
  dispatcher.dispose();
  assert.equal(emitted.length, 0);
  assert.equal(dispatcher.pendingCount(), 0);
});
