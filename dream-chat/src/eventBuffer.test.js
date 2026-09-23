import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_BUFFER_CAP, createEventBuffer } from "./eventBuffer.js";

test("a burst drains as one ordered flush", async () => {
  const flushes = [];
  const buffer = createEventBuffer({ onFlush: (batch) => flushes.push(batch), flushMs: 5 });
  for (let index = 0; index < 40; index += 1) buffer.push({ id: index });
  assert.equal(buffer.size(), 40);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(flushes.length, 1, "one flush for the whole burst");
  assert.deepEqual(flushes[0].map((event) => event.id), Array.from({ length: 40 }, (_, index) => index), "order preserved, nothing dropped");
});

test("the queue drains immediately once it reaches the cap", () => {
  const flushes = [];
  const buffer = createEventBuffer({ onFlush: (batch) => flushes.push(batch), cap: 10, flushMs: 60000 });
  for (let index = 0; index < 10; index += 1) buffer.push(index);
  assert.equal(flushes.length, 1, "cap hit flushes synchronously, no timer wait");
  assert.equal(flushes[0].length, 10);
  assert.equal(buffer.size(), 0);
});

test("manual flush delivers pending events and clears the timer", async () => {
  const flushes = [];
  const buffer = createEventBuffer({ onFlush: (batch) => flushes.push(batch), flushMs: 60000 });
  buffer.push("a");
  buffer.push("b");
  buffer.flush();
  assert.deepEqual(flushes, [["a", "b"]]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(flushes.length, 1, "no second flush after the timer was cancelled");
});

test("dispose flushes the remaining queue then ignores new pushes", () => {
  const flushes = [];
  const buffer = createEventBuffer({ onFlush: (batch) => flushes.push(batch), flushMs: 60000 });
  buffer.push(1);
  buffer.push(2);
  buffer.dispose();
  assert.deepEqual(flushes, [[1, 2]], "unmount drains what was buffered");
  buffer.push(3);
  assert.equal(buffer.size(), 0);
  assert.equal(flushes.length, 1);
});

test("an empty dispose is a no-op", () => {
  const buffer = createEventBuffer({ onFlush: () => assert.fail("nothing to flush") });
  buffer.dispose();
});

test("default cap constant stays at the documented bound", () => {
  assert.equal(EVENT_BUFFER_CAP, 200);
});
