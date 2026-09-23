const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// AX depth: failure observations that teach (host-authored suggestions),
// agent.self/agent.capabilities depth. Pure contract/kernel tests plus the
// mocked-electron main.cjs harness from host_ux_ipc.test.cjs for the two
// dispatch bodies.

const {
  failureHint,
  resolveFailureClass,
  compactObservation,
  createObservation,
  FAILURE_SUGGESTION_LIMIT,
} = require("./agent_contracts.cjs");
const { AgentKernel } = require("./agent_kernel.cjs");

const EXPECTED_CLASS_HINTS = {
  "deterministic-input": /required input|input\{\}|input-repair/i,
  "malformed-envelope": /JSON action envelope|\{?"?actions"?\s*:\s*\[/i,
  "unknown-command": /allowedNextCommands|agent\.capabilities/i,
  "approval-required": /explicit user approval|auto:true/i,
  "plan-gate": /plan-gated|approved plan/i,
  "budget-exhausted": /budget.*task\.(block|complete)|task\.(block|complete)/i,
  "transport-death": /unreachable|lane fallback|server/i,
  "verification-failed": /receipt|verify/i,
  "scope-violation": /workspaceRoot|scope/i,
};

test("failureHint covers every known failure class within the char bound", () => {
  for (const [cls, pattern] of Object.entries(EXPECTED_CLASS_HINTS)) {
    const hint = failureHint(cls);
    assert.equal(typeof hint, "string", `${cls} produced a hint`);
    assert.ok(hint.length > 0 && hint.length <= FAILURE_SUGGESTION_LIMIT, `${cls} hint is bounded`);
    assert.match(hint, pattern, `${cls} hint teaches the next step`);
  }
  // classifyFailure outputs and error-taxonomy kinds resolve too.
  for (const cls of ["cancelled", "safety-blocked", "retryable-transient", "verification-failure", "runtime-unavailable", "stall", "server-error", "unknown"]) {
    const hint = failureHint(cls);
    assert.ok(typeof hint === "string" && hint.length > 0 && hint.length <= FAILURE_SUGGESTION_LIMIT, `${cls} hint exists`);
  }
});

test("failureHint resolves raw error codes and refines bucket classes by message", () => {
  assert.equal(resolveFailureClass("COMMAND_BUDGET_EXHAUSTED"), "budget-exhausted");
  assert.equal(resolveFailureClass("TRAINING_BUDGET_EXHAUSTED"), "budget-exhausted");
  assert.equal(resolveFailureClass("ACTION_COMMAND_NOT_ALLOWED"), "unknown-command");
  assert.equal(resolveFailureClass("INVALID_ACTION_OUTPUT"), "malformed-envelope");
  assert.equal(resolveFailureClass("SCOPE_OUTSIDE_RUNTIME"), "scope-violation");
  assert.equal(resolveFailureClass("ECONNREFUSED"), "transport-death");
  assert.match(failureHint("safety-blocked", { message: "training.start requires an explicit user action." }), /explicit user approval/);
  assert.match(failureHint("safety-blocked", { message: "command is not allowlisted" }), /allowedNextCommands|capabilities/);
  assert.match(failureHint("deterministic-input", { message: "Hemlock command budget exhausted (40/40)." }), /command budget is spent/);
  assert.match(failureHint("deterministic-input", { message: "connect ECONNREFUSED 127.0.0.1:8080" }), /unreachable/);
});

test("failureHint names required input fields for deterministic-input failures", () => {
  const hint = failureHint("deterministic-input", { inputHint: '{summary, rationale, files?:["repo-relative"]}' });
  assert.match(hint, /summary/);
  assert.match(hint, /rationale/);
  assert.ok(!hint.includes("files"), "optional fields are not named as required");
  const fromFields = failureHint("deterministic-input", { requiredFields: ["path"] });
  assert.match(fromFields, /path/);
  assert.match(fromFields, /input-repair|repair/i);
});

test("failure observations carry commandId, status, summary, evidenceRefs, and a suggestion", () => {
  const observation = compactObservation({ status: "failed", error: "file.read needs a path.", commandId: "file.read" }, { operationId: "op-x" });
  assert.equal(observation.commandId, "file.read");
  assert.equal(observation.status, "failed");
  assert.ok(observation.summary);
  assert.ok(Array.isArray(observation.evidenceRefs));
  assert.match(observation.suggestion, /deterministic|input|required/i);
  assert.equal(observation.errorClass, "deterministic-input");
  assert.ok(observation.suggestion.length <= FAILURE_SUGGESTION_LIMIT);
});

test("kernel.recordObservation backfills commandId from the operation and names required fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-ax-kernel-"));
  const kernel = new AgentKernel({ root, repoRoot: root, task: { id: "task-ax", budget: {} } });
  kernel.attachCommandRegistry({ "file.read": { inputHint: '{path:"repo-relative", maxBytes?}' } });
  const operation = kernel.startOperation({ taskId: "task-ax", command: "file.read", capability: "read" });
  const recorded = kernel.recordObservation({
    id: "obs-ax-1",
    operationId: operation.id,
    status: "failed",
    summary: "Scoped file was not found: nowhere.txt",
    structuredOutput: { status: "failed", error: "Scoped file was not found: nowhere.txt" },
    evidenceRefs: [],
    error: "Scoped file was not found: nowhere.txt",
  });
  assert.equal(recorded.commandId, "file.read", "commandId recovered from the operation record");
  assert.match(recorded.suggestion, /path/, "suggestion names the required field");
  assert.equal(recorded.errorClass, "deterministic-input");
  const projection = kernel.getProjection();
  assert.equal(projection.observations.at(-1).suggestion, recorded.suggestion, "suggestion persisted on the durable record");
});

test("kernel.transitionAction stamps a suggestion onto the failed action payload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-ax-kernel2-"));
  const kernel = new AgentKernel({ root, repoRoot: root, task: { id: "task-ax2", budget: {} } });
  kernel.attachCommandRegistry({ "improve.propose": { inputHint: '{summary, rationale, files?:["repo-relative"]}' } });
  kernel.createAction({
    id: "act-ax-1",
    taskId: "task-ax2",
    step: 1,
    kind: "tool",
    commandId: "improve.propose",
    input: {},
    shortRationale: "Propose a change",
    expectedEvidence: [],
    approval: "none",
    status: "proposed",
  });
  kernel.transitionAction("act-ax-1", "fail", { failureCategory: "deterministic-input", error: "improve.propose needs a summary of the bounded change." });
  const action = kernel.getProjection().actions.find((item) => item.id === "act-ax-1");
  assert.equal(action.status, "failed");
  assert.match(action.suggestion, /summary/);
  assert.match(action.suggestion, /rationale/);
  const journal = fs.readFileSync(kernel.journalPath, "utf-8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const faildEvent = journal.find((event) => event.type === "action.faild");
  assert.ok(faildEvent, "action.faild landed on the durable journal");
  assert.match(faildEvent.payload.action.suggestion, /summary/, "the event payload carries the host-authored hint");
});

// --- main.cjs dispatch bodies (mocked-electron harness, same pattern as
// host_ux_ipc.test.cjs) ---

const ipcHandlers = new Map();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-ax-depth-"));
process.env.HEMLOCK_DATA_DIR = dataDir;

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
    static getAllWindows() {
      return [];
    }
  },
  Notification: class {
    show() {}
  },
  ipcMain: {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true }) },
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

test("agent.self reports recentFailures with class + suggestion and a memory summary", async () => {
  const command = ipcHandlers.get("agent:command");
  // Induce a real blocked-command event on the durable spine first.
  await assert.rejects(() => command({}, { action: "training.start", automatic: true }), /explicit user action/);

  const result = await command({}, { action: "agent.self" });
  assert.equal(result.schema, "hemlock.agent.self.v1");
  assert.ok(Array.isArray(result.recentFailures), "recentFailures is a list");
  const last = result.recentFailures.at(-1);
  assert.equal(last.commandId, "training.start");
  assert.equal(last.errorClass, "approval-required");
  assert.match(last.suggestion, /explicit user approval|auto:true/);
  assert.ok(last.suggestion.length <= FAILURE_SUGGESTION_LIMIT);
  assert.equal(typeof result.memory.records, "number");
  assert.equal(typeof result.memory.demoted, "number");
  assert.ok(result.memory.lastConsolidatedAt === null || typeof result.memory.lastConsolidatedAt === "string");
  assert.ok(result.allowedNow === null || Array.isArray(result.allowedNow));
  assert.ok("lastWarmAt" in result.server && "warmCachedTokens" in result.server);
});

test("agent.capabilities groups selectable commands by capability with inputHints and free reads", async () => {
  const command = ipcHandlers.get("agent:command");
  const result = await command({}, { action: "agent.capabilities" });
  assert.equal(result.schema, "hemlock.agent.capabilities.v1");
  assert.ok(Array.isArray(result.commands) && result.commands.length > 50);
  for (const entry of result.commands) {
    for (const key of ["commandId", "capability", "auto", "approval", "inputHint"]) {
      assert.ok(key in entry, `commands entry ${entry.commandId} carries ${key}`);
    }
  }
  assert.ok(result.byCapability && typeof result.byCapability === "object" && !Array.isArray(result.byCapability));
  const grouped = Object.values(result.byCapability).flat();
  assert.ok(grouped.length > 0);
  for (const entry of grouped) {
    for (const key of ["commandId", "capability", "auto", "approval", "inputHint"]) {
      assert.ok(key in entry, `grouped entry ${entry.commandId} carries ${key}`);
    }
  }
  // agent.self is an auto read — selectable under every autonomy level.
  assert.ok((result.byCapability.read || []).some((entry) => entry.commandId === "agent.self"));
  // Train capability is always forbidden for adaptive selection.
  assert.ok(!grouped.some((entry) => entry.capability === "train"), "train commands are never model-selectable");
  assert.ok(Array.isArray(result.freeReads) && result.freeReads.length > 0);
  assert.ok(result.freeReads.every((entry) => result.commands.find((item) => item.commandId === entry.commandId)?.countsAgainstBudget === false));
  assert.ok(result.freeReads.some((entry) => entry.commandId === "agent.capabilities"));
});
