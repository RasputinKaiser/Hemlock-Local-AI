const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// THREADS-WINDOW host tests. Same harness as experiment_suggest.test.cjs:
// main.cjs is loaded once with a mocked "electron" module and
// HEMLOCK_DATA_DIR pointed at a throwaway directory; the agent:command
// handler is captured and invoked directly — every assertion below goes
// through the real runAgentCommand dispatch, not the ThreadManager API.

const ipcHandlers = new Map();

class FakeNotification {
  constructor(options) {
    this.options = options;
  }
  show() {}
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-thread-window-test-"));
process.env.HEMLOCK_DATA_DIR = dataDir;

// A real workspace directory for thread.create — the manager resolves and
// fingerprints it, so it must exist on disk.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-thread-window-ws-"));
fs.writeFileSync(path.join(workspace, "README.md"), "threads window fixture\n");

const electronMock = {
  app: {
    name: "Hemlock",
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    on() {},
    quit() {},
    whenReady: () => new Promise(() => {}), // never resolve: no window is created
    commandLine: { appendSwitch() {} },
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  Notification: FakeNotification,
  ipcMain: {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
    showOpenDialog: async () => ({ canceled: true }),
  },
};

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};
const mainPath = path.resolve(__dirname, "main.cjs");
delete require.cache[mainPath];
try {
  require(mainPath);
} finally {
  Module._load = originalLoad;
}

// The throwaway HEMLOCK_DATA_DIR is intentionally not deleted: deferred journal
// writers may still flush into it after this file exits.

const command = (payload) => ipcHandlers.get("agent:command")({}, payload);

test("thread.checkpoints returns the durable checkpoint list for a thread", async () => {
  const created = await command({ action: "thread.create", workspaceRoot: workspace, title: "Checkpoints fixture" });
  assert.equal(created.status, "created");
  const listed = await command({ action: "thread.checkpoints", threadId: created.thread.id });
  assert.equal(listed.schema, "hemlock.agent.thread.checkpoints.v1");
  assert.equal(listed.status, "ok");
  assert.equal(listed.threadId, created.thread.id);
  assert.ok(Array.isArray(listed.checkpoints));
  assert.ok(listed.checkpoints.length >= 1, "thread-created checkpoint exists");
  assert.equal(listed.checkpoints[0].threadId, created.thread.id);
  // An unknown thread id lists nothing rather than throwing.
  const empty = await command({ action: "thread.checkpoints", threadId: "thread-missing" });
  assert.deepEqual(empty.checkpoints, []);
});

test("thread.conversation returns the stored tail and caps limit at 200", async () => {
  const created = await command({ action: "thread.create", workspaceRoot: workspace, title: "Conversation fixture" });
  const forked = await command({ action: "thread.fork", threadId: created.thread.id, title: "Conversation fork" });
  assert.equal(forked.status, "forked");
  const tail = await command({ action: "thread.conversation", threadId: forked.thread.id, limit: 10 });
  assert.equal(tail.status, "ok");
  assert.ok(Array.isArray(tail.conversation));
  assert.ok(tail.conversation.length >= 1, "the fork seed note is in the tail");
  assert.match(tail.conversation[0].content, /[Ff]orked from/);
  assert.equal(tail.conversation[0].threadId, forked.thread.id);
});

test("thread.fork mints a provenance thread without switching the active thread", async () => {
  const created = await command({ action: "thread.create", workspaceRoot: workspace, title: "Fork source", provider: "codex", autonomy: "guided" });
  const before = await command({ action: "thread.list" });
  const activeBefore = before.activeThreadId;
  const forked = await command({ action: "thread.fork", threadId: created.thread.id });
  assert.equal(forked.status, "forked");
  assert.equal(forked.thread.forkedFrom, created.thread.id, "provenance pointer");
  assert.equal(forked.thread.workspaceRoot, created.thread.workspaceRoot);
  assert.equal(forked.thread.provider, created.thread.provider);
  assert.equal(forked.thread.autonomy, created.thread.autonomy);
  assert.notEqual(forked.thread.id, created.thread.id);
  // The active thread does not move — the fork only joins the list.
  const after = await command({ action: "thread.list" });
  assert.equal(after.activeThreadId, activeBefore);
  assert.ok(after.threads.some((item) => item.id === forked.thread.id));
  // Provenance checkpoint + seed conversation note, not copied history.
  const checkpoints = await command({ action: "thread.checkpoints", threadId: forked.thread.id });
  assert.ok(checkpoints.checkpoints.some((item) => String(item.reason || "").includes(created.thread.id)), "fork checkpoint records the source id");
  const conversation = await command({ action: "thread.conversation", threadId: forked.thread.id });
  assert.ok(conversation.conversation.some((item) => String(item.content || "").includes(created.thread.id)), "seed note names the source thread");
  // The forked event rides the event spine for other surfaces.
  const state = await ipcHandlers.get("agent:state")();
  assert.ok(state.events.some((event) => event.type === "thread.forked" && event.payload?.forkedThreadId === forked.thread.id), "thread.forked event recorded");
});

test("thread.checkpoint.restore rolls a thread back and writes a marker", async () => {
  const created = await command({ action: "thread.create", workspaceRoot: workspace, title: "Restore fixture" });
  const threadId = created.thread.id;
  await command({ action: "task.checkpoint", threadId, phase: "executing", status: "paused", reason: "mid-work" });
  const before = await command({ action: "thread.checkpoints", threadId });
  assert.ok(before.checkpoints.length >= 2);
  const target = before.checkpoints[0];
  const restored = await command({ action: "thread.checkpoint.restore", threadId, checkpointId: target.id });
  assert.equal(restored.status, "checkpoint-restored");
  assert.equal(restored.restoredCheckpoint.id, target.id);
  const after = await command({ action: "thread.checkpoints", threadId });
  assert.equal(after.checkpoints.length, before.checkpoints.length + 1, "a restore marker checkpoint was appended");
  assert.ok(String(after.checkpoints.at(-1).reason || "").startsWith("checkpoint-restored:"));
});
