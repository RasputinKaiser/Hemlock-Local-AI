const assert = require("node:assert/strict");
const test = require("node:test");
const { AgentIntentQueue } = require("./agent_queue.cjs");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("serializes intents, preserves FIFO order, and lets steering bypass the queue", async () => {
  const calls = [];
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const task = { id: "task-active", status: "ready" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      task.status = "running";
      calls.push(payload.text);
      if (payload.text === "first") await firstGate;
      return { status: "completed", answer: payload.text };
    },
    steer: async (payload) => ({ content: payload.text, taskId: task.id }),
    emit: (type, status) => events.push({ type, status }),
  });

  const first = queue.submit({ requestId: "req-first", text: "first" });
  await tick();
  const second = await queue.submit({ requestId: "req-second", text: "second" });
  const steering = await queue.submit({ requestId: "req-steer", text: "focus on the greeting", mode: "steer" });

  assert.equal(second.status, "queued");
  assert.equal(second.queueEntry.position, 1);
  assert.equal(steering.status, "steered");
  assert.deepEqual(calls, ["first"]);
  assert.equal(queue.snapshot().pending.length, 1);

  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.answer, "first");
  for (let attempt = 0; attempt < 10 && calls.length < 2; attempt += 1) await tick();
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(events.some((event) => event.type === "task.queued"), true);
  assert.equal(events.some((event) => event.type === "task.steered"), true);
});

test("cancels a queued request without touching the active request", async () => {
  const release = [];
  const task = { id: "task-active", status: "ready" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      task.status = "running";
      return new Promise((resolve) => release.push(() => resolve({ status: "completed", answer: payload.text })));
    },
  });
  const active = queue.submit({ requestId: "req-active", text: "active" });
  await tick();
  const queued = await queue.submit({ requestId: "req-queued", text: "queued" });
  const cancelled = queue.cancelQueued(queued.requestId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(queue.snapshot().pending.length, 0);
  assert.equal(queue.snapshot().active.requestId, "req-active");
  release[0]();
  await active;
});
