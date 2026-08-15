const crypto = require("node:crypto");

const ACTIVE_STATUSES = new Set([
  "accepted",
  "planning",
  "running",
  "waiting_for_approval",
  "waiting_for_user",
  "verifying",
]);

function id(prefix = "queue") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function isActiveTask(task) {
  return Boolean(task && ACTIVE_STATUSES.has(task.status));
}

function safePayload(payload = {}) {
  return {
    text: String(payload.text || payload.objective || "").slice(0, 1000),
    objective: String(payload.objective || payload.text || "").slice(0, 1000),
    intent: payload.intent || null,
    mode: payload.mode || null,
    source: payload.source || "command-center",
    requestId: payload.requestId || null,
  };
}

class AgentIntentQueue {
  constructor({ execute, steer, getTask, onChange, emit, now = () => new Date().toISOString() }) {
    if (typeof execute !== "function") throw new Error("AgentIntentQueue needs an execute callback.");
    this.execute = execute;
    this.steer = typeof steer === "function" ? steer : async () => null;
    this.getTask = typeof getTask === "function" ? getTask : () => null;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.emit = typeof emit === "function" ? emit : () => {};
    this.now = now;
    this.active = null;
    this.pending = [];
  }

  snapshot() {
    return {
      schema: "hemlock.agent.queue.v1",
      active: this.active ? { ...this.active, payload: safePayload(this.active.payload) } : null,
      pending: this.pending.map((entry, index) => ({ ...entry, position: index + 1, payload: safePayload(entry.payload) })),
      count: this.pending.length + (this.active ? 1 : 0),
    };
  }

  sync() {
    this.onChange(this.snapshot());
    return this.snapshot();
  }

  activeTask() {
    return this.getTask?.() || null;
  }

  async submit(payload = {}) {
    const mode = String(payload.mode || (payload.steer === true ? "steer" : "queue"));
    if (mode === "steer" && isActiveTask(this.activeTask())) {
      const result = await this.steer(payload);
      this.emit("task.steered", "accepted", { taskId: this.activeTask()?.id || null, steering: result });
      return { schema: "hemlock.agent.queue.result.v1", status: "steered", steering: result, queue: this.sync() };
    }

    if (this.active || isActiveTask(this.activeTask())) {
      return this.enqueue(payload);
    }
    return this.start(payload);
  }

  enqueue(payload = {}) {
    const entry = {
      schema: "hemlock.agent.queue.entry.v1",
      id: id("intent"),
      requestId: payload.requestId || id("request"),
      payload: { ...payload },
      status: "queued",
      queuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.pending.push(entry);
    this.emit("task.queued", "queued", { entry: { ...entry, payload: safePayload(entry.payload) }, position: this.pending.length });
    this.sync();
    return Promise.resolve({
      schema: "hemlock.agent.queue.result.v1",
      status: "queued",
      requestId: entry.requestId,
      queueEntry: { ...entry, payload: safePayload(entry.payload), position: this.pending.length },
      queue: this.snapshot(),
      claimBoundary: "The request is queued behind the active local task; it has not started and has not produced an answer.",
    });
  }

  async start(payload = {}, existingEntry = null) {
    const entry = existingEntry || {
      schema: "hemlock.agent.queue.entry.v1",
      id: id("intent"),
      requestId: payload.requestId || id("request"),
      payload: { ...payload },
      status: "queued",
      queuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    entry.status = "running";
    entry.startedAt = this.now();
    this.active = entry;
    this.emit("task.queue.started", "running", { entry: { ...entry, payload: safePayload(entry.payload) } });
    this.sync();
    try {
      const result = await this.execute(entry.payload, entry);
      entry.status = result?.status === "blocked" ? "blocked" : result?.status === "failed" ? "failed" : "completed";
      entry.finishedAt = this.now();
      this.emit("task.queue.completed", entry.status === "completed" ? "passed" : entry.status, { entry: { ...entry, payload: safePayload(entry.payload) }, result: result || null });
      return result;
    } catch (error) {
      entry.status = "failed";
      entry.error = error.message;
      entry.finishedAt = this.now();
      this.emit("task.queue.failed", "failed", { entry: { ...entry, payload: safePayload(entry.payload) }, error: error.message });
      throw error;
    } finally {
      this.active = null;
      this.sync();
      void this.drain();
    }
  }

  async drain() {
    if (this.active || !this.pending.length) return;
    const next = this.pending.shift();
    this.sync();
    await this.start(next.payload, next);
  }

  cancelQueued(requestId) {
    const index = this.pending.findIndex((entry) => entry.requestId === requestId || entry.id === requestId);
    if (index < 0) return { status: "not_found", queue: this.snapshot() };
    const [entry] = this.pending.splice(index, 1);
    entry.status = "cancelled";
    entry.finishedAt = this.now();
    this.emit("task.queue.cancelled", "cancelled", { entry: { ...entry, payload: safePayload(entry.payload) } });
    return { status: "cancelled", queueEntry: { ...entry, payload: safePayload(entry.payload) }, queue: this.sync() };
  }
}

module.exports = { ACTIVE_STATUSES, AgentIntentQueue, isActiveTask, safePayload };
