const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Lane B host-UX IPC tests. main.cjs is a 3.5k-line app bootstrap, so it is
// loaded exactly once with a mocked "electron" module and HEMLOCK_DATA_DIR
// pointed at a throwaway directory; the ipcMain.handle registrations are
// captured so the real handlers can be invoked directly.

const ipcHandlers = new Map();

class FakeNotification {
  constructor(options) {
    this.options = options;
    this.shown = false;
    FakeNotification.instances.push(this);
  }
  show() {
    this.shown = true;
  }
}
FakeNotification.instances = [];

let messageBoxResult = { response: 1, checkboxChecked: false };
const messageBoxCalls = [];

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-host-ux-test-"));
process.env.HEMLOCK_DATA_DIR = dataDir;

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
  Notification: FakeNotification,
  ipcMain: {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
  dialog: {
    showMessageBox: async (options) => {
      messageBoxCalls.push(options);
      return messageBoxResult;
    },
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
let hostUx;
try {
  hostUx = require(mainPath);
} finally {
  Module._load = originalLoad;
}

// NOTE: the throwaway HEMLOCK_DATA_DIR is intentionally NOT deleted at the end
// of the run: main.cjs registers deferred journal writers that may still flush
// into it after the test file exits, and deleting early produces a spurious
// ENOENT unhandledRejection. OS tmpdir reaping handles the leftovers.

test("host-ux IPC channels are registered", () => {
  assert.equal(hostUx.WINDOWS_STORAGE_KEY, "hemlock-os-windows-v2");
  for (const channel of ["dialog:confirm", "notification:show", "windows:list"]) {
    assert.equal(typeof ipcHandlers.get(channel), "function", `missing handler for ${channel}`);
  }
});

test("dialog:confirm maps showMessageBox button 0 to true and 1 to false", async () => {
  const confirmHandler = ipcHandlers.get("dialog:confirm");

  messageBoxResult = { response: 0 };
  assert.equal(await confirmHandler({}, { message: "Restore revision 3?" }), true);

  messageBoxResult = { response: 1 };
  assert.equal(await confirmHandler({}, { message: "Restore revision 3?" }), false);
});

test("dialog:confirm passes tone-mapped buttons and labels to showMessageBox", async () => {
  const confirmHandler = ipcHandlers.get("dialog:confirm");
  messageBoxCalls.length = 0;

  messageBoxResult = { response: 1 };
  await confirmHandler({}, { message: "Delete artifact?", tone: "danger", confirmLabel: "Burn it", detail: "This cannot be undone." });
  assert.equal(messageBoxCalls.length, 1);
  assert.deepEqual(messageBoxCalls[0].buttons, ["Burn it", "Cancel"]);
  assert.equal(messageBoxCalls[0].type, "warning");
  assert.equal(messageBoxCalls[0].defaultId, 0);
  assert.equal(messageBoxCalls[0].cancelId, 1);
  assert.equal(messageBoxCalls[0].detail, "This cannot be undone.");

  messageBoxCalls.length = 0;
  await confirmHandler({}, { message: "Switch thread?", cancelLabel: "Stay" });
  assert.deepEqual(messageBoxCalls[0].buttons, ["Confirm", "Stay"]);
  assert.equal(messageBoxCalls[0].type, "question");
});

test("dialog:confirm rejects an empty message honestly", async () => {
  const confirmHandler = ipcHandlers.get("dialog:confirm");
  await assert.rejects(() => confirmHandler({}, { message: "   " }), /non-empty message/);
  await assert.rejects(() => confirmHandler({}, {}), /non-empty message/);
});

test("notification:show shows a clamped notification and returns shown:true", async () => {
  const notifyHandler = ipcHandlers.get("notification:show");
  FakeNotification.instances.length = 0;

  const longTitle = "x".repeat(130);
  const longBody = "y".repeat(400);
  const result = await notifyHandler({}, { title: `  ${longTitle}  `, body: longBody });
  assert.deepEqual(result, { shown: true });

  assert.equal(FakeNotification.instances.length, 1);
  const notification = FakeNotification.instances[0];
  assert.equal(notification.options.title.length, hostUx.NOTIFICATION_TITLE_MAX_LENGTH);
  assert.equal(notification.options.body.length, hostUx.NOTIFICATION_BODY_MAX_LENGTH);
  assert.ok(notification.shown);
});

test("notification:show collapses whitespace and stamps the app name on darwin", async () => {
  const notifyHandler = ipcHandlers.get("notification:show");
  FakeNotification.instances.length = 0;

  await notifyHandler({}, { title: "Dream\ncycle\t complete", body: "  spaced \n out  " });
  const notification = FakeNotification.instances[0];
  assert.equal(notification.options.title, "Dream cycle complete");
  assert.equal(notification.options.body, "spaced out");
  if (process.platform === "darwin") {
    assert.equal(notification.options.subtitle, "Hemlock");
  }
});

test("notification:show clamps via the exported helper and rejects empty titles with a structured error", async () => {
  const notifyHandler = ipcHandlers.get("notification:show");

  assert.equal(hostUx.clampNotificationText(null, 80), "");
  assert.equal(hostUx.clampNotificationText(42, 80), "");
  assert.equal(hostUx.clampNotificationText("  a\nb  ", 80), "a b");

  const badTitle = await notifyHandler({}, { title: "", body: "hello" });
  assert.equal(badTitle.shown, false);
  assert.match(badTitle.error, /non-empty title/);

  const noArgs = await notifyHandler({}, undefined);
  assert.equal(noArgs.shown, false);
  assert.match(noArgs.error, /non-empty title/);
});

test("windows:list normalizes the renderer snapshot, excludes closed windows, and sorts by zOrder", async () => {
  const snapshot = JSON.stringify({
    center: { windowId: "center", state: "normal", zOrder: 3 },
    chat: { windowId: "chat", state: "closed", zOrder: 2 },
    artifact: { windowId: "artifact", state: "minimized", zOrder: 1 },
    activity: { windowId: "activity", state: "maximized", zOrder: 2 },
    settings: { windowId: "settings", state: "closed" },
  });
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: async (expression) => {
      assert.match(expression, /localStorage\.getItem/);
      return snapshot;
    },
  };
  const result = await hostUx.readWorkspaceWindowList(contents);

  assert.equal(result.schema, "hemlock.window.list.v1");
  assert.equal(result.source, "renderer-localstorage");
  assert.deepEqual(result.windows, [
    { windowId: "artifact", label: "Artifact Studio", state: "minimized", zOrder: 1 },
    { windowId: "activity", label: "Activity", state: "maximized", zOrder: 2 },
    { windowId: "center", label: "Command Center", state: "normal", zOrder: 3 },
  ]);
});

test("windows:list helper tolerates garbage snapshots and missing renderers", async () => {
  const broken = await hostUx.readWorkspaceWindowList({
    isDestroyed: () => false,
    executeJavaScript: async () => "not-json{",
  });
  assert.deepEqual(broken.windows, []);
  assert.equal(broken.source, "renderer-localstorage");

  const failed = await hostUx.readWorkspaceWindowList({
    isDestroyed: () => false,
    executeJavaScript: async () => {
      throw new Error("renderer is gone");
    },
  });
  assert.deepEqual(failed.windows, []);
  assert.equal(failed.source, "unavailable");
  assert.match(failed.error, /renderer is gone/);

  const noWindow = await hostUx.readWorkspaceWindowList(null);
  assert.deepEqual(noWindow.windows, []);
  assert.equal(noWindow.source, "unavailable");
  assert.match(noWindow.error, /No renderer window/);
});

test("windows:list handler degrades honestly when no BrowserWindow exists", async () => {
  // In this harness createWindow() never runs, so mainWindow is null — the
  // handler must answer with an honest unavailable payload, not throw.
  const result = await ipcHandlers.get("windows:list")();
  assert.equal(result.schema, "hemlock.window.list.v1");
  assert.equal(result.source, "unavailable");
  assert.deepEqual(result.windows, []);
  assert.match(result.error, /No renderer window/);
});

test("preload exposes confirmDialog, notify, and windowsList on both surfaces", async () => {
  const exposed = new Map();
  const preloadLoad = Module._load;
  Module._load = function preloadMockedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
        ipcRenderer: {
          invoke: async (channel, ...args) => ({ channel, args }),
          on() {},
          removeListener() {},
        },
      };
    }
    return preloadLoad.call(this, request, parent, isMain);
  };
  const preloadPath = path.resolve(__dirname, "preload.cjs");
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    Module._load = preloadLoad;
  }

  for (const surfaceName of ["mapleDesktop", "hemlockAgent"]) {
    const surface = exposed.get(surfaceName);
    assert.equal((await surface.confirmDialog({ message: "hi" })).channel, "dialog:confirm");
    assert.deepEqual((await surface.notify({ title: "t", body: "b" })).args, [{ title: "t", body: "b" }]);
    assert.equal((await surface.windowsList()).channel, "windows:list");
    assert.equal((await surface.reportRendererError({ component: "X", message: "m" })).channel, "hemlock:renderer-error");
  }
});

test("agent.self returns an honest task/budget/queue snapshot through the command path", async () => {
  const command = ipcHandlers.get("agent:command");
  const result = await command({}, { action: "agent.self" });
  assert.equal(result.schema, "hemlock.agent.self.v1");
  assert.equal(result.status, "ok");
  assert.equal(typeof result.task.id, "string");
  assert.ok(result.task.status && result.task.phase !== undefined);
  for (const key of ["agentStepsUsed", "maxAgentSteps", "commandsUsed", "maxCommands"]) {
    assert.equal(typeof result.budget[key], "number", `budget.${key} is a real number`);
  }
  assert.equal(typeof result.queue.pending, "number");
  assert.ok(Array.isArray(result.pendingApprovals));
  assert.equal(typeof result.server.processReady, "boolean");
  assert.equal(typeof result.counts.artifacts, "number");
  assert.equal(typeof result.counts.memories.promoted, "number");
  assert.equal(typeof result.counts.memories.candidate, "number");
  assert.equal(typeof result.counts.experimentFindings, "number");
  assert.ok(Array.isArray(result.recentReceipts));
});

test("world.state reads durable world records without inventing them", async () => {
  const command = ipcHandlers.get("agent:command");
  const result = await command({}, { action: "world.state" });
  assert.equal(result.schema, "hemlock.world.state.v1");
  assert.equal(result.status, "read");
  assert.equal(typeof result.landmarks.experimentReceipts, "number");
  assert.equal(typeof result.landmarks.markers, "number");
  assert.ok(Array.isArray(result.experiments));
  assert.equal(typeof result.dataset.rows, "number");
  assert.ok(Array.isArray(result.markers));
  assert.equal(typeof result.ambience.dream, "number");
});

test("world.place persists a durable marker, validates input, and dedupes by label", async () => {
  const command = ipcHandlers.get("agent:command");
  await assert.rejects(() => command({}, { action: "world.place", kind: "tower", label: "Bad" }), /marker, monument, or sign/);
  await assert.rejects(() => command({}, { action: "world.place", kind: "marker" }), /needs a label/);

  const placed = await command({}, { action: "world.place", kind: "sign", label: "Test clearing", note: "first stone" });
  assert.equal(placed.status, "placed");
  assert.equal(placed.marker.kind, "sign");
  assert.equal(placed.marker.label, "Test clearing");
  assert.ok(placed.marker.id);
  assert.ok(Number.isFinite(placed.marker.position.x) && Number.isFinite(placed.marker.position.z), "omitted position gets a seeded spot");
  assert.equal(placed.marker.seededPosition, true);

  const again = await command({}, { action: "world.place", kind: "sign", label: "Test clearing" });
  assert.equal(again.status, "existing", "same label returns the standing marker");
  assert.equal(again.marker.id, placed.marker.id);

  const state = await command({}, { action: "world.state" });
  assert.ok(state.markers.some((marker) => marker.id === placed.marker.id), "world.state reflects the durable store");
});

test("hemlock:renderer-error receipts a bounded crash report and dedupes repeats", async () => {
  const handler = ipcHandlers.get("hemlock:renderer-error");
  assert.equal(typeof handler, "function", "renderer error channel is registered");

  const report = { component: "GroveSurface", message: "mesh exploded", stack: "x".repeat(9000), windowId: "grove" };
  const first = await handler({}, report);
  assert.equal(first.status, "recorded");
  assert.ok(first.eventId);

  const repeat = await handler({}, report);
  assert.equal(repeat.status, "deduped", "identical report inside 60s does not multiply receipts");

  const other = await handler({}, { component: "GroveSurface", message: "different crash", windowId: "grove" });
  assert.equal(other.status, "recorded");

  const malformed = await handler({}, { component: { weird: true }, message: null });
  assert.ok(["recorded", "deduped"].includes(malformed.status), "malformed payloads never throw the host");
});
