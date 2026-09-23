const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Boot-restore harness. main.cjs runs its whole session boot at require time,
// so each scenario seeds a fake previous session under a throwaway
// HEMLOCK_DATA_DIR/HEMLOCK_SIPS_DIR and re-runs THIS file as a child process
// (HEMLOCK_BOOT_CHILD=1) with the electron module mocked. The child prints the
// freshly written session state + event journal between sentinels; the parent
// asserts on it. The throwaway dirs are intentionally left for OS tmp reaping
// for the same reason as host_ux_ipc.test.cjs (deferred writers may flush late).

const MAIN_PATH = path.join(__dirname, "main.cjs");
const PREVIOUS_SESSION_ID = "session-2020-01-01T00-00-00-000Z-1";

if (process.env.HEMLOCK_BOOT_CHILD === "1") {
  const Module = require("node:module");
  const electronMock = {
    app: {
      name: "Hemlock",
      isPackaged: true, // keep the dev-only remote-debugging branch inert
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
    Notification: class {
      show() {}
    },
    ipcMain: { handle() {} },
    shell: { openExternal: async () => {}, showItemInFolder: () => {} },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showOpenDialog: async () => ({ canceled: true }),
    },
  };
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, ...rest) {
    if (request === "electron") return electronMock;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    require(MAIN_PATH);
  } finally {
    Module._load = originalLoad;
  }
  const sessionsDir = path.join(path.resolve(process.env.HEMLOCK_SIPS_DIR), "sessions");
  const sessionId = fs.readdirSync(sessionsDir).sort().at(-1);
  const state = JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionId, "state.json"), "utf8"));
  const events = fs.readFileSync(path.join(sessionsDir, sessionId, "events.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(path.resolve(process.env.HEMLOCK_DATA_DIR), "threads", "registry.json"), "utf8"));
  } catch { /* no registry is fine */ }
  process.stdout.write(`@@RESULT@@${JSON.stringify({ sessionId, state, events, registry })}@@END@@\n`);
  process.exit(0);
}

function bareTask(overrides = {}) {
  return {
    schema: "hemlock.agent.task.v1",
    id: "task-previous-session",
    objective: "Restore me",
    intent: "conversation",
    interactionMode: "explore",
    status: "running",
    phase: "executing",
    sessionId: PREVIOUS_SESSION_ID,
    startedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function bootWithPreviousSession({ state = null, events = [], registry = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-boot-test-"));
  const sipsDir = path.join(dataDir, "workspace-runtime");
  const previousDir = path.join(sipsDir, "sessions", PREVIOUS_SESSION_ID);
  fs.mkdirSync(previousDir, { recursive: true });
  if (state) fs.writeFileSync(path.join(previousDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  if (events.length) fs.writeFileSync(path.join(previousDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  if (registry) {
    const threadsDir = path.join(dataDir, "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }
  let output;
  try {
    output = execFileSync(process.execPath, [__filename], {
      env: { ...process.env, HEMLOCK_BOOT_CHILD: "1", HEMLOCK_DATA_DIR: dataDir, HEMLOCK_SIPS_DIR: sipsDir },
      encoding: "utf8",
      timeout: 60000,
    });
  } catch (error) {
    assert.fail(`boot child failed: ${error.message}\n${error.stderr || ""}`);
  }
  const match = output.match(/@@RESULT@@(.*)@@END@@/s);
  assert.ok(match, `boot child produced no result payload: ${output.slice(-500)}`);
  return { ...JSON.parse(match[1]), dataDir, previousSessionId: PREVIOUS_SESSION_ID };
}

test("restores a bare-shape non-terminal task as blocked and emits task.restored", () => {
  const boot = bootWithPreviousSession({
    state: {
      ...bareTask(),
      // pendingIntents rides the bare snapshot; it must not break the reader
      // and must come back queued, never auto-executed.
      pendingIntents: [{ id: "intent-1", requestId: "req-1", payload: { objective: "queued follow-up" } }],
    },
  });
  assert.equal(boot.state.id, "task-previous-session");
  assert.equal(boot.state.status, "blocked");
  assert.equal(boot.state.phase, "resume");
  assert.equal(boot.state.blockedReason, "The previous session was interrupted; inspect and resume the task.");
  assert.equal(boot.state.objective, "Restore me");
  assert.equal(boot.state.sessionId, boot.sessionId);
  assert.notEqual(boot.state.sessionId, PREVIOUS_SESSION_ID);
  assert.equal(boot.state.pendingIntents.length, 1);
  assert.equal(boot.state.pendingIntents[0].status, "queued");
  assert.equal(boot.state.pendingIntents[0].payload.objective, "queued follow-up");
  const restored = boot.events.find((event) => event.type === "task.restored");
  assert.ok(restored, "expected a task.restored event");
  assert.equal(restored.status, "blocked");
  assert.equal(restored.payload.taskId, "task-previous-session");
  assert.equal(restored.payload.restoredFromSessionId, PREVIOUS_SESSION_ID);
  assert.equal(restored.payload.snapshotSessionId, PREVIOUS_SESSION_ID);
  // Never auto-runs: nothing dispatched a command for the restored task.
  assert.ok(!boot.events.some((event) => event.type === "command.started"));
});

test("envelope-shape state.json ({task: ...}) still restores for compat", () => {
  const boot = bootWithPreviousSession({ state: { task: bareTask({ status: "waiting_for_approval" }) } });
  assert.equal(boot.state.id, "task-previous-session");
  assert.equal(boot.state.status, "blocked");
  assert.ok(boot.events.some((event) => event.type === "task.restored"));
});

test("a terminal previous task stays dead — fresh task boots ready", () => {
  const boot = bootWithPreviousSession({ state: bareTask({ status: "completed" }) });
  assert.equal(boot.state.status, "ready");
  assert.equal(boot.state.id, `task-${boot.sessionId}`);
  assert.ok(!boot.events.some((event) => event.type === "task.restored"));
});

test("reaps preview sessions the previous journal left open", () => {
  const boot = bootWithPreviousSession({
    state: bareTask({ status: "cancelled" }),
    events: [
      { type: "artifact.preview.ready", payload: { session: { id: "preview-1" } } },
      { type: "artifact.preview.ready", payload: { session: { id: "preview-2" } } },
      { type: "artifact.preview.stopped", payload: { session: { id: "preview-2" } } },
    ],
  });
  const reaped = boot.events.find((event) => event.type === "preview.sessions.reaped");
  assert.ok(reaped, "expected a preview.sessions.reaped event");
  assert.equal(reaped.payload.count, 1);
  assert.deepEqual(reaped.payload.sessionIds, ["preview-1"]);
});

test("no reap event when every previous preview session was stopped", () => {
  const boot = bootWithPreviousSession({
    events: [
      { type: "artifact.preview.ready", payload: { session: { id: "preview-1" } } },
      { type: "artifact.preview.stopped", payload: { session: { id: "preview-1" } } },
    ],
  });
  assert.ok(!boot.events.some((event) => event.type === "preview.sessions.reaped"));
});

test("a registry thread stamped live by the dead session parks as paused on boot", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const boot = bootWithPreviousSession({
    state: bareTask({ threadId: "thread-prev" }),
    registry: {
      schema: "hemlock.agent.thread.registry.v1",
      projects: [],
      threads: [
        {
          schema: "hemlock.agent.thread.v1",
          id: "thread-prev",
          projectId: null,
          title: "Crashed thread",
          workspaceRoot: repoRoot,
          status: "running",
          phase: "executing",
          taskId: "task-previous-session",
          taskSnapshot: bareTask({ threadId: "thread-prev" }),
          taskHistory: [],
          evidenceRefs: [],
          suggestions: [],
          metrics: {},
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      activeThreadId: "thread-prev",
    },
  });
  const thread = boot.registry.threads.find((item) => item.id === "thread-prev");
  assert.ok(thread, "expected the seeded thread in the restored registry");
  assert.equal(thread.status, "paused");
  assert.equal(thread.phase, "paused");
  assert.equal(thread.blockedReason, "The previous session was interrupted; inspect and resume the task.");
  assert.equal(thread.taskSnapshot.status, "paused");
  assert.ok(boot.events.some((event) => event.type === "thread.parked_on_boot" && event.payload.threadIds.includes("thread-prev")));
  // The task itself still restores blocked, never running.
  assert.equal(boot.state.status, "blocked");
});
