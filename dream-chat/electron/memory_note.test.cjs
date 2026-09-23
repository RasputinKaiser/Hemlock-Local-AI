// memory.note — the model-facing mint path for SIPS memory records. Same
// electron-mock harness as experiment_suggest/e2e_autonomy_surface: main.cjs
// loads once with a mocked "electron" and a throwaway HEMLOCK_DATA_DIR, the
// agent:command IPC handler is invoked directly, and a spawn guard lets the
// real sips_runtime.py run while every other child (Maple server, provider
// CLIs, collectors) fails instantly.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const realChildProcess = require("node:child_process");

const { EXEC_ALLOWLIST } = require("./shell_exec.cjs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-memory-note-"));
process.env.HEMLOCK_DATA_DIR = dataDir;
process.env.HEMLOCK_SIPS_DIR = path.join(dataDir, "sips");
delete process.env.HEMLOCK_FALLBACK_LANE;
const sipsDir = process.env.HEMLOCK_SIPS_DIR;

const ipcHandlers = new Map();

function fakeChild(command) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = null;
  child.pid = -1;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.unref = () => child;
  child.ref = () => child;
  process.nextTick(() => {
    child.emit("error", Object.assign(new Error(`spawn ${command} blocked by memory-note harness`), { code: "ENOENT" }));
    child.emit("exit", null, "ENOENT");
    child.emit("close", null, null);
  });
  return child;
}

function guardedSpawn(command, args, options) {
  const isBareName = String(command) === path.basename(String(command));
  if (isBareName && EXEC_ALLOWLIST[command]) return realChildProcess.spawn(command, args, options);
  // The SIPS memory ledger is under test — its python runtime spawns for real.
  if ((args || []).some((arg) => String(arg).includes("sips_runtime.py"))) {
    return realChildProcess.spawn(command, args, options);
  }
  return fakeChild(command);
}

const electronMock = {
  app: {
    name: "Hemlock",
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    on() {},
    quit() {},
    whenReady: () => new Promise(() => {}),
    commandLine: { appendSwitch() {} },
  },
  BrowserWindow: class {
    static getAllWindows() { return []; }
  },
  Notification: class { show() {} },
  ipcMain: {
    handle(channel, handler) { ipcHandlers.set(channel, handler); },
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true }) },
};

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock;
  if (request === "node:child_process") return { ...realChildProcess, spawn: guardedSpawn };
  return originalLoad.call(this, request, parent, isMain);
};
const mainPath = path.resolve(__dirname, "main.cjs");
delete require.cache[mainPath];
try {
  require(mainPath);
} finally {
  Module._load = originalLoad;
}

const command = (payload) => ipcHandlers.get("agent:command")({}, payload);
const memoryPath = path.join(sipsDir, "memory.jsonl");
function readMemoryRecords() {
  try {
    return fs.readFileSync(memoryPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("memory.note mints a candidate record through the real dispatch", async () => {
  const result = await command({
    action: "memory.note",
    title: "Build quirk",
    body: "The UI build needs node_modules installed before vite runs.",
    tags: ["build", "vite"],
    evidenceRefs: ["receipt://verify-app-build"],
  });
  assert.equal(result.schema, "hemlock.sips.memory-note.v1");
  assert.equal(result.status, "recorded");
  const record = result.record;
  assert.equal(record.schema, "hemlock.sips.memory.v1");
  assert.equal(record.status, "candidate", "notes land as candidates — promotion still goes through memory.promote");
  assert.equal(record.title, "Build quirk");
  assert.equal(record.body, "The UI build needs node_modules installed before vite runs.");
  assert.deepEqual(record.tags, ["build", "vite"]);
  assert.equal(record.provenance.evidencePath, "receipt://verify-app-build");

  const onDisk = readMemoryRecords().find((row) => row.id === record.id);
  assert.ok(onDisk, "the record was appended to the durable ledger");
  assert.equal(onDisk.status, "candidate");
});

test("memory.note emits a memory.noted event with the record id and title", async () => {
  const result = await command({ action: "memory.note", title: "Event check", body: "event body" });
  const state = await ipcHandlers.get("agent:state")({});
  const noted = state.events.filter((event) => event.type === "memory.noted").at(-1);
  assert.ok(noted, "memory.noted event recorded");
  assert.equal(noted.payload.recordId, result.record.id);
  assert.equal(noted.payload.title, "Event check");
});

test("memory.note clamps the body to 4000 characters", async () => {
  const result = await command({ action: "memory.note", title: "Long note", body: "x".repeat(6000) });
  assert.equal(result.status, "recorded");
  assert.equal(result.record.body.length, 4000);
});

test("memory.note rejects an empty body before touching the ledger", async () => {
  const count = readMemoryRecords().length;
  await assert.rejects(() => command({ action: "memory.note", title: "Empty", body: "   " }), /non-empty body/);
  assert.equal(readMemoryRecords().length, count, "nothing was appended");
});

test("memory.note is plan-gated like other writes", async () => {
  // Automatic (model-initiated) dispatch of a non-auto command is refused outright.
  await assert.rejects(
    () => command({ action: "memory.note", automatic: true, title: "Auto", body: "auto body" }),
    /requires an explicit user action/,
  );
  // An agent-authored action without an approved plan is refused at the gate.
  await assert.rejects(
    () => command({ action: "memory.note", __fromAgentAction: true, __approvedPlan: true, title: "Ungated", body: "no plan approved" }),
    /approved Hemlock plan action/,
  );
});

test("an approved plan executes memory.note through the real agent dispatch", async () => {
  const submitted = await command({
    action: "intent.submit",
    text: "Remember the build quirk",
    intent: "inspect",
    apiBase: "http://127.0.0.1:9", // dead endpoint: inference fails fast, the deterministic plan step runs
  });
  assert.equal(submitted.status, "accepted");

  const proposed = await command({
    action: "plan.propose",
    steps: [
      { commandId: "memory.note", input: { title: "Plan-approved note", body: "Noted through the approved plan path." }, label: "Record the note" },
      { kind: "answer", label: "Confirm the note" },
    ],
  });
  assert.equal(proposed.status, "waiting_for_approval");
  const approved = await command({ action: "plan.approve", planId: proposed.plan.id });
  assert.equal(approved.status, "completed");

  const record = readMemoryRecords().find((row) => row.title === "Plan-approved note");
  assert.ok(record, "the plan-approved memory.note reached the ledger");
  assert.equal(record.status, "candidate");
  assert.equal(record.body, "Noted through the approved plan path.");
});
