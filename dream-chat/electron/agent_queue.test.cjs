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
      task.status = "completed";
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
      return new Promise((resolve) => release.push(() => { task.status = "completed"; resolve({ status: "completed", answer: payload.text }); }));
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

test("steering while a request is mid-flight leaves the durable FIFO order untouched", async () => {
  const calls = [];
  let releaseActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  const task = { id: "task-active", status: "ready" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      task.status = "running";
      calls.push(payload.text);
      if (payload.text === "first") await activeGate;
      task.status = "completed";
      return { status: "completed", answer: payload.text };
    },
    steer: async () => ({ content: "steered" }),
    emit: () => {},
  });

  const active = queue.submit({ requestId: "req-first", text: "first" });
  await tick();
  await queue.submit({ requestId: "req-second", text: "second" });
  await queue.submit({ requestId: "req-third", text: "third" });
  const steering = await queue.submit({ requestId: "req-steer", text: "steer me instead", mode: "steer" });

  assert.equal(steering.status, "steered");
  // The steer payload must never enter the durable pending list, and the two
  // queued entries keep their original positions.
  let snapshot = queue.snapshot();
  assert.equal(snapshot.pending.length, 2);
  assert.deepEqual(snapshot.pending.map((entry) => entry.requestId), ["req-second", "req-third"]);
  assert.deepEqual(snapshot.pending.map((entry) => entry.position), [1, 2]);
  assert.equal(snapshot.pending.some((entry) => entry.requestId === "req-steer"), false);

  releaseActive();
  await active;
  for (let attempt = 0; attempt < 20 && calls.length < 3; attempt += 1) await tick();
  assert.deepEqual(calls, ["first", "second", "third"]);
  snapshot = queue.snapshot();
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.pending.length, 0);
});

test("rejects a duplicate queued objective without starting work or reordering the queue", async () => {
  const calls = [];
  let releaseActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  const task = { id: "task-active", status: "ready" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      task.status = "running";
      calls.push(payload.text);
      if (payload.text === "active") await activeGate;
      task.status = "completed";
      return { status: "completed", answer: payload.text };
    },
    emit: () => {},
  });

  const active = queue.submit({ requestId: "req-active", text: "active" });
  await tick();
  const first = await queue.submit({ requestId: "req-original", text: "Summarize the Hemlock repo" });
  assert.equal(first.status, "queued");

  const duplicate = await queue.submit({ requestId: "req-duplicate", text: "  summarize the hemlock repo  " });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.requestId, "req-original");
  assert.equal(duplicate.queueEntry.position, 1);
  const snapshot = queue.snapshot();
  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.pending[0].requestId, "req-original");
  assert.deepEqual(calls, ["active"]);

  releaseActive();
  await active;
});

test("rejects a duplicate of the intent currently running instead of re-executing it", async () => {
  const calls = [];
  let releaseActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  const task = { id: "task-active", status: "ready", objective: "Summarize the Hemlock repo" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      task.status = "running";
      task.objective = payload.objective || payload.text;
      calls.push(payload.text);
      await activeGate;
      task.status = "completed";
      return { status: "completed", answer: payload.text };
    },
    emit: () => {},
  });

  const active = queue.submit({ requestId: "req-active", text: "Summarize the Hemlock repo", objective: "Summarize the Hemlock repo" });
  await tick();
  // Same objective while the original is still in-flight must not stack up
  // behind itself and run twice.
  const duplicate = await queue.submit({ requestId: "req-duplicate", text: " summarize the hemlock repo " });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.requestId, "req-active");
  assert.equal(queue.snapshot().pending.length, 0);

  releaseActive();
  await active;
  assert.deepEqual(calls, ["Summarize the Hemlock repo"]);
});

test("a failed drained entry receipts the failure without an unhandled rejection", async () => {
  const calls = [];
  const events = [];
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  let releaseActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  const task = { id: "task-active", status: "ready" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      task.status = "running";
      calls.push(payload.text);
      if (payload.text === "active") {
        await activeGate;
        task.status = "completed";
        return { status: "completed" };
      }
      task.status = "failed";
      throw new Error("intent blew up");
    },
    emit: (type, status, payload) => events.push({ type, status, payload }),
  });

  const active = queue.submit({ requestId: "req-active", text: "active" });
  await tick();
  await queue.submit({ requestId: "req-bad", text: "bad" });
  releaseActive();
  await active;
  // The drained entry's failure is contained inside the queue — start()
  // receipts task.queue.failed and drain() must not surface a rejection to
  // its fire-and-forget callers.
  for (let attempt = 0; attempt < 10 && calls.length < 2; attempt += 1) await tick();
  assert.deepEqual(calls, ["active", "bad"]);
  assert.equal(events.some((event) => event.type === "task.queue.failed"), true);
  assert.equal(queue.snapshot().pending.length, 0);
  assert.equal(queue.snapshot().active, null);
  // A settle nudge after the failure must resolve, not reject.
  await queue.notifyTaskSettled();
  await tick();
  process.off("unhandledRejection", onRejection);
  assert.deepEqual(rejections, [], "drain failures must be contained inside the queue");
});

test("drain holds while the previous task is alive and releases on terminal", async () => {
  const calls = [];
  const task = { id: "task-active", status: "ready" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      calls.push(payload.text);
      // Plan proposed but not yet approved: the queue must hold, not
      // overwrite agentTask with the next intent.
      task.status = "waiting_for_approval";
      return { status: "accepted" };
    },
    emit: () => {},
  });

  await queue.submit({ requestId: "req-first", text: "first" });
  const second = await queue.submit({ requestId: "req-second", text: "second" });
  assert.equal(second.status, "queued");
  for (let attempt = 0; attempt < 5; attempt += 1) await tick();
  assert.deepEqual(calls, ["first"], "queue holds while the task awaits approval");

  task.status = "paused";
  await queue.notifyTaskSettled();
  assert.deepEqual(calls, ["first"], "a paused task still holds the queue");

  task.status = "completed";
  await queue.notifyTaskSettled();
  for (let attempt = 0; attempt < 10 && calls.length < 2; attempt += 1) await tick();
  assert.deepEqual(calls, ["first", "second"], "terminal status releases the next intent");
});

test("a paused active task counts as active for new submissions", async () => {
  const task = { id: "task-paused", status: "paused" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async () => ({ status: "completed" }),
    emit: () => {},
  });
  const result = await queue.submit({ requestId: "req-queued", text: "queued behind pause" });
  assert.equal(result.status, "queued");
  assert.equal(queue.snapshot().pending.length, 1);
});

test("persistablePending round-trips through restorePending as queued work", async () => {
  const calls = [];
  let releaseActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  const task = { id: "task-active", status: "ready" };
  const queue = new AgentIntentQueue({
    getTask: () => task,
    execute: async (payload) => {
      calls.push(payload.text);
      await activeGate;
      return { status: "completed" };
    },
    emit: () => {},
  });

  const active = queue.submit({ requestId: "req-active", text: "active" });
  await tick();
  await queue.submit({ requestId: "req-pending", text: "queued behind active", objective: "queued behind active" });

  // The serialized form keeps request ids, queued status, and a bounded
  // payload — the same contract snapshot() exposes.
  const persisted = queue.persistablePending();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].requestId, "req-pending");
  assert.equal(persisted[0].status, "queued");
  assert.equal(persisted[0].payload.objective, "queued behind active");

  releaseActive();
  await active;

  // A fresh queue (the "next session") restores the entry without running
  // it, keeps provenance, and still honours the existing cancel path.
  const nextTask = { id: "task-next", status: "ready" };
  const next = new AgentIntentQueue({
    getTask: () => nextTask,
    execute: async (payload) => { calls.push(`restored:${payload.text}`); return { status: "completed" }; },
    emit: () => {},
  });
  const restored = next.restorePending(persisted, { restoredFromSessionId: "session-old" });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, "queued");
  assert.equal(restored[0].startedAt, null);
  assert.equal(restored[0].finishedAt, null);
  assert.equal(restored[0].error, null);
  assert.equal(restored[0].restoredFromSessionId, "session-old");
  assert.equal(next.snapshot().pending.length, 1);
  assert.equal(calls.filter((item) => String(item).startsWith("restored:")).length, 0, "restored intents never auto-execute");
  assert.equal(next.cancelQueued("req-pending").status, "cancelled");
  assert.equal(next.snapshot().pending.length, 0);
});

test("restorePending skips malformed and duplicate entries", async () => {
  const queue = new AgentIntentQueue({
    getTask: () => ({ id: "task-idle", status: "ready" }),
    execute: async () => ({ status: "completed" }),
    emit: () => {},
  });
  const restored = queue.restorePending([
    { id: "intent-1", requestId: "req-1", payload: { text: "first", objective: "Same Objective" }, status: "queued" },
    { id: "intent-2", requestId: "req-2", payload: { text: "dup", objective: "same objective" }, status: "queued" },
    { id: "intent-3", requestId: "req-3", payload: {}, status: "queued" },
    "garbage",
    null,
  ]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].requestId, "req-1");
  // Restoring into a queue that already holds the objective is a no-op.
  const again = queue.restorePending([{ requestId: "req-again", payload: { objective: "same objective" }, status: "queued" }]);
  assert.equal(again.length, 0);
  assert.equal(queue.snapshot().pending.length, 1);
});
