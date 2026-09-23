"use strict";

// End-to-end coverage for the agent features that were unit-tested in
// isolation but never exercised together: real AgentOrchestrator + AgentKernel
// + the real main.cjs runAgentCommand dispatch, driven through the captured
// "agent:command" IPC handler.
//
// Model inference is pinned to a dead endpoint via the intent.submit apiBase
// override, so every infer/decide/score call fails fast and the orchestrator
// falls back to the deterministic plan step — the same path production takes
// when Maple is unavailable. A spawn guard delegates only bare allowlisted
// executable names (the shell.exec surface) to the real child_process.spawn;
// everything else (python runtime, the Maple server, provider CLIs, context
// collectors) fails instantly as if the binary were missing, which keeps the
// suite deterministic whether or not a Maple server is running on :8080.
// Plan-gated commands get a genuinely approved plan in the real kernel before
// the __fromAgentAction/__approvedPlan dispatch flags are exercised.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const realChildProcess = require("node:child_process");

const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator } = require("./agent_orchestrator.cjs");
const { AgentIntentQueue } = require("./agent_queue.cjs");
const { EXEC_ALLOWLIST } = require("./shell_exec.cjs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-e2e-surface-"));
process.env.HEMLOCK_DATA_DIR = dataDir;
process.env.HEMLOCK_SIPS_DIR = path.join(dataDir, "sips");
const sipsDir = process.env.HEMLOCK_SIPS_DIR;
const repoRoot = path.resolve(__dirname, "..", "..");
const ipcHandlers = new Map();

// Bare allowlisted names spawn for real — the shell.exec path is part of what
// is under test. Absolute paths (python runtime, server launch, chronicle
// collectors) and denied executables return a child that fails instantly.
const spawnLog = [];
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
    child.emit("error", Object.assign(new Error(`spawn ${command} blocked by e2e harness`), { code: "ENOENT" }));
    child.emit("exit", null, "ENOENT");
    child.emit("close", null, null);
  });
  return child;
}
function guardedSpawn(command, args, options) {
  spawnLog.push({ command: String(command), args: (args || []).map(String) });
  const isBareName = String(command) === path.basename(String(command));
  if (isBareName && EXEC_ALLOWLIST[command]) return realChildProcess.spawn(command, args, options);
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

// NOTE: the throwaway HEMLOCK_DATA_DIR is intentionally not deleted; deferred
// journal writers can still flush after the file exits (same convention as
// host_ux_ipc.test.cjs).

const run = (action, payload = {}) => ipcHandlers.get("agent:command")({}, { ...payload, action });

function sessionDir() {
  const base = path.join(sipsDir, "sessions");
  const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return path.join(base, dirs.at(-1));
}
function readEvents() {
  try {
    return fs.readFileSync(path.join(sessionDir(), "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function readSessionState() {
  return JSON.parse(fs.readFileSync(path.join(sessionDir(), "state.json"), "utf8"));
}
const markersPath = path.join(sipsDir, "world-markers.jsonl");
const datasetPath = path.join(sipsDir, "experiment-dataset.jsonl");
function readMarkers() {
  try {
    return fs.readFileSync(markersPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
const spawnCountFor = (command) => spawnLog.filter((call) => call.command === command).length;

// A failed structured-action inference leaves its agent_action stream open in
// main's activeStreams map (startStream runs before fetch, and a refused
// connection throws before finishStream). Those stale streams count as
// "work in flight" for the idle-dream quiet gate, so tests that need a
// settled host drain them through the same stream-cancel IPC a renderer uses.
async function drainLeakedStreams() {
  const state = await ipcHandlers.get("agent:state")({});
  const streams = state?.runtime?.workspace?.activeStreams || [];
  for (const stream of streams) {
    if (!stream.streamId || stream.terminal) continue;
    await ipcHandlers.get("agent:stream-cancel")({}, { streamId: stream.streamId });
  }
}

// Eight durable findings so the idle-dream proposer has a grown dataset the
// first time a task settles.
fs.mkdirSync(sipsDir, { recursive: true });
fs.writeFileSync(datasetPath, Array.from({ length: 8 }, (_, index) => JSON.stringify({
  schema: "hemlock.world.finding.v1",
  id: `finding-e2e-${index}`,
  experiment: "pendulum",
  claim: `E2E fixture finding ${index}`,
  recordedAt: new Date().toISOString(),
})).join("\n") + "\n", "utf8");

// Registry mirror for the harness-owned orchestrator — must match the
// descriptors in main.cjs (the wiring guard test enforces that drift fails).
const E2E_COMMAND_REGISTRY = {
  "agent.self": { label: "Read my own task snapshot", capability: "read", auto: true, approval: "none", inputHint: "{}" },
  "world.state": { label: "Read the understory world state", capability: "read", auto: true, approval: "none", inputHint: "{}" },
  "receipts.query": { label: "Query local receipts", capability: "read", auto: true, approval: "none", inputHint: "{}" },
  "world.place": { label: "Place a grove marker", capability: "write", auto: false, approval: "plan", inputHint: "{kind:\"marker|monument|sign\", label, note?, position?:{x,z}}" },
  "shell.exec": { label: "Run a bounded workspace command", capability: "verify", auto: false, approval: "plan", inputHint: "{command, args?, cwd?}" },
  "improve.propose": { label: "Propose bounded local improvement", capability: "write", auto: false, approval: "explicit", inputHint: "{summary, rationale, files?:[\"repo-relative\"], change?:\"patch/spec <=32KB\", confidence?:0-1}" },
};

// A second orchestrator wired the same way main.cjs wires its own — the
// executeCommand bridge lands each agent action on the real dispatch.
function makeLoopHarness({ taskId, registry = E2E_COMMAND_REGISTRY, inferAction = null, scoreActions = null, autonomy = "supervised" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-e2e-loop-"));
  const eventsFile = path.join(root, "events.jsonl");
  let task = {
    schema: "hemlock.agent.task.v1",
    id: taskId,
    objective: "E2E harness task",
    intent: "inspect",
    phase: "plan",
    status: "planning",
    autonomy,
    budget: { maxAgentSteps: 16, maxCommands: 32, maxRetriesPerOperation: 1, maxMutationSets: 4, maxTrainingCycles: 0, commandsUsed: 0, agentStepsUsed: 0, mutationSetsUsed: 0 },
  };
  const kernel = new AgentKernel({ root, repoRoot, task });
  const events = [];
  const emit = (type, status, payload, options = {}) => {
    const event = { schema: "hemlock.agent.event.v1", id: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, taskId: task.id, type, status, payload, evidenceRefs: options.evidenceRefs || [], reversible: options.reversible === true, createdAt: new Date().toISOString() };
    events.push(event);
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, "utf8");
  };
  const observationCounts = [];
  const orchestrator = new AgentOrchestrator({
    kernel,
    commandRegistry: registry,
    getTask: () => task,
    setTask: (patch) => { task = { ...task, ...patch }; kernel.syncTask(task); return task; },
    emit,
    executeCommand: async (command, payload) => {
      observationCounts.push({ command, observations: kernel.getTaskHistory(task.id).observations.length });
      return run(command, payload);
    },
    inferAction,
    scoreActions,
  });
  return { root, kernel, orchestrator, events, eventsFile, observationCounts, get task() { return task; } };
}

test("agent.self returns the documented snapshot shape through the real command path", async () => {
  const result = await run("agent.self");
  assert.equal(result.schema, "hemlock.agent.self.v1");
  assert.equal(result.status, "ok");
  assert.equal(typeof result.task.id, "string");
  assert.equal(typeof result.task.status, "string");
  assert.equal(typeof result.budget.maxAgentSteps, "number");
  assert.equal(typeof result.queue.pending, "number");
  assert.ok(Array.isArray(result.pendingApprovals));
  assert.equal(typeof result.server.processReady, "boolean");
  assert.equal(typeof result.counts.artifacts, "number");
  assert.equal(typeof result.counts.experimentFindings, "number");
  assert.ok(Array.isArray(result.recentReceipts));
  assert.ok(Array.isArray(result.evidenceRefs) && result.evidenceRefs.length);
});

test("world.place rejects an agent-authored placement when no plan is approved", async () => {
  const markerCount = readMarkers().length;
  await assert.rejects(
    () => run("world.place", { __fromAgentAction: true, __approvedPlan: true, kind: "sign", label: "Gate-check sign" }),
    /approved Hemlock plan action/,
  );
  assert.equal(readMarkers().length, markerCount, "the gate rejected before a marker was written");
  assert.equal(readEvents().some((event) => event.type === "world.placed" && event.payload?.marker?.label === "Gate-check sign"), false);
});

test("shell.exec runs allowlisted argv commands for real and denies wrappers before spawn", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-e2e-workspace-"));
  fs.writeFileSync(path.join(workspace, "check-me.js"), "const answer = 42;\n", "utf8");
  realChildProcess.execFileSync("git", ["init", "-q"], { cwd: workspace });

  const submitted = await run("intent.submit", {
    text: "Set up the e2e workspace lane",
    intent: "inspect",
    apiBase: "http://127.0.0.1:9", // pin model inference to a dead endpoint for the rest of the file
    workspaceRoot: workspace,
  });
  assert.equal(submitted.status, "accepted");
  assert.equal(fs.realpathSync(submitted.task.workspaceRoot), fs.realpathSync(workspace));
  assert.equal(submitted.task.status, "waiting_for_approval");

  const git = await run("shell.exec", { command: "git", args: ["status", "--short", "--branch"] });
  assert.equal(git.schema, "hemlock.agent.exec.v1");
  assert.equal(git.exitCode, 0);
  assert.match(git.stdout, /##/);
  assert.ok(fs.existsSync(git.receiptPath));
  const receipt = JSON.parse(fs.readFileSync(git.receiptPath, "utf8"));
  assert.equal(receipt.argv, "git status --short --branch");
  assert.equal(fs.realpathSync(receipt.workspaceRoot), fs.realpathSync(workspace));

  const nodeCheck = await run("shell.exec", { command: "node", args: ["--check", "check-me.js"] });
  assert.equal(nodeCheck.exitCode, 0);

  const listing = await run("shell.exec", { command: "ls", args: [] });
  assert.equal(listing.exitCode, 0);
  assert.match(listing.stdout, /check-me\.js/);

  const deniedBefore = spawnLog.length;
  await assert.rejects(() => run("shell.exec", { command: "rm", args: ["-rf", "."] }), /not allowlisted/);
  await assert.rejects(() => run("shell.exec", { command: "sudo", args: ["ls"] }), /never runs shells/);
  await assert.rejects(() => run("shell.exec", { command: "cat", args: ["/etc/passwd"] }), /workspace/);
  await assert.rejects(() => run("shell.exec", { command: "node", args: ["-e", "process.exit(1)"] }), /not allowlisted|flag args/);
  await assert.rejects(() => run("shell.exec", { command: "/bin/ls", args: [] }), /bare executable name/);
  assert.equal(spawnLog.length, deniedBefore, "no denied invocation reached spawn");
  assert.equal(spawnCountFor("rm"), 0);
  assert.equal(spawnCountFor("sudo"), 0);
  assert.equal(spawnCountFor("cat"), 0);
});

test("an approved plan executes world.place through the real dispatch and persists the marker", async () => {
  const proposed = await run("plan.propose", {
    steps: [
      { commandId: "world.place", input: { kind: "sign", label: "E2E understory sign", note: "placed by the e2e harness" }, label: "Place a grove marker" },
      { kind: "answer", label: "Report the placement" },
    ],
  });
  assert.equal(proposed.status, "waiting_for_approval");
  const approved = await run("plan.approve", { planId: proposed.plan.id });
  assert.equal(approved.status, "completed");

  const markers = readMarkers();
  const marker = markers.find((row) => row.label === "E2E understory sign");
  assert.ok(marker, "marker record persisted to the durable store");
  assert.equal(marker.schema, "hemlock.world.marker.v1");
  assert.equal(marker.kind, "sign");

  const placed = readEvents().filter((event) => event.type === "world.placed");
  assert.ok(placed.some((event) => event.payload?.marker?.id === marker.id), "world.placed is durable in the session journal");

  const world = await run("world.state");
  assert.ok(world.markers.some((row) => row.id === marker.id), "world.state reads back the placed marker");
});

test("plan.revise rewrites the remaining suffix after a blocked step and the task completes", async () => {
  const intent = await run("intent.submit", { text: "Survey the grove markers", intent: "inspect" });
  assert.equal(intent.status, "accepted");
  const taskId = intent.task.id;

  const proposed = await run("plan.propose", {
    steps: [
      { commandId: "shell.exec", input: { command: "rm", args: ["-rf", "."] }, label: "Denied exec step" },
      { commandId: "world.state", label: "Read world state" },
      { kind: "answer", label: "Summarize findings" },
    ],
  });
  const approved = await run("plan.approve", { planId: proposed.plan.id });
  assert.equal(approved.status, "blocked", "the denied shell.exec blocks the task mid-plan");
  assert.equal(spawnCountFor("rm"), 0, "the denied plan step never spawned");

  const eventsSoFar = readEvents();
  assert.ok(eventsSoFar.some((event) => event.type === "task.blocked" && event.status === "blocked"));

  const rejected = await run("plan.revise", { taskId, steps: [{ commandId: "invented.command", label: "Not real" }], rationale: "Bogus revision" });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.reason, /unknown commandId/);
  assert.equal(eventsSoFar.some((event) => event.type === "plan.revised" && event.payload?.planId === proposed.plan.id), false);

  const revised = await run("plan.revise", {
    taskId,
    steps: [
      { commandId: "world.state", label: "Read world state" },
      { kind: "answer", label: "Summarize findings" },
    ],
    rationale: "Replace the denied exec with a world read.",
  });
  assert.equal(revised.status, "revised");
  assert.equal(revised.diff.keptCount, 1, "the executed (failed) prefix is immutable");
  assert.deepEqual(revised.diff.removed.map((step) => step.commandId || step.kind), ["world.state", "answer"]);
  assert.deepEqual(revised.diff.added.map((step) => step.commandId || step.kind), ["world.state", "answer"]);
  assert.ok(readEvents().some((event) => event.type === "plan.revised" && event.payload?.planId === proposed.plan.id), "plan.revised is durable");

  const resumed = await run("task.resume", { taskId });
  assert.equal(resumed.status, "completed", "the task continues on the revised suffix and completes");
  assert.ok(readEvents().some((event) => event.type === "task.completed" && event.payload?.task?.id === taskId), "task.completed is durable in the session journal");
});

test("a batch envelope runs its actions sequentially with per-action receipts", async () => {
  const eventsBefore = readEvents().length;
  const harness = makeLoopHarness({
    taskId: "task-batch-e2e",
    inferAction: async () => JSON.stringify({
      actions: [
        { commandId: "world.place", input: { kind: "marker", label: "Batch grove marker" }, shortRationale: "Place a marker first." },
        { commandId: "world.state", shortRationale: "Read the world after placing." },
        { commandId: "agent.self", shortRationale: "Snapshot self last." },
      ],
    }),
  });
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "world.state", label: "Read world" }] });
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "completed");

    const actions = harness.kernel.getTaskHistory(harness.task.id).actions;
    const items = actions.filter((action) => action.batchId);
    assert.equal(items.length, 3, "each batch item is its own durable action");
    assert.deepEqual(items.map((item) => item.commandId), ["world.place", "world.state", "agent.self"]);
    assert.ok(items.every((item) => item.status === "completed"));

    const observations = harness.kernel.getTaskHistory(harness.task.id).observations;
    assert.equal(observations.length, 3);
    assert.ok(observations.every((item) => item.status === "passed"));
    assert.ok(observations.every((item) => Array.isArray(item.evidenceRefs)));

    // Sequential proof: the world.state item observed the marker that the
    // world.place item just wrote through the real durable store.
    const worldStateObs = observations[1].structuredOutput;
    assert.equal(worldStateObs.schema, "hemlock.world.state.v1");
    assert.ok(worldStateObs.markers.some((row) => row.label === "Batch grove marker"), "item 2 saw item 1's durable effect");
    assert.deepEqual(harness.observationCounts.map((entry) => entry.observations), [0, 1, 2], "each item executed after the prior observation was recorded");

    // Real-dispatch ordering proof: the command.started entries emitted by
    // main's runAgentCommand during this test appear in item order.
    const started = readEvents().slice(eventsBefore).filter((event) => event.type === "command.started" && ["world.place", "world.state", "agent.self"].includes(event.payload?.command));
    assert.deepEqual(started.map((event) => event.payload.command), ["world.place", "world.state", "agent.self"], "real dispatch executed the items in order");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a deterministic-input failure triggers exactly one bounded input repair and the action succeeds", async () => {
  const prompts = [];
  const harness = makeLoopHarness({
    taskId: "task-input-repair-ok",
    // improve.propose is approval:"explicit" — an autonomous task executes it
    // without parking (same lane production uses for explicit-but-sandboxed).
    autonomy: "autonomous",
    inferAction: async (prompt) => {
      prompts.push(prompt);
      if (prompt.repair?.schema === "hemlock.agent.input.repair.v1") {
        return JSON.stringify({ kind: "tool", commandId: "improve.propose", input: { summary: "Keep the autonomy surface coverage honest", rationale: "The e2e harness proves improve.propose is reachable end to end." }, shortRationale: "Repaired input" });
      }
      return JSON.stringify({ kind: "tool", commandId: "improve.propose", input: {}, shortRationale: "Propose the improvement." });
    },
  });
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "improve.propose", label: "Propose a bounded improvement" }] });
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "completed");

    const repairPrompts = prompts.filter((prompt) => prompt.repair?.schema === "hemlock.agent.input.repair.v1");
    assert.equal(repairPrompts.length, 1, "exactly one input-repair inference ran");
    assert.equal(repairPrompts[0].repair.commandId, "improve.propose");
    assert.equal(repairPrompts[0].repair.attempt, 1);
    assert.deepEqual(repairPrompts[0].repair.requiredFields, ["summary", "rationale"]);

    const repairedEvents = harness.events.filter((event) => event.type === "action.input.repaired");
    assert.equal(repairedEvents.length, 1);
    const actions = harness.kernel.getTaskHistory(harness.task.id).actions.filter((item) => item.commandId === "improve.propose");
    assert.equal(actions.length, 2, "the failed action and its repaired retry are both durable");
    assert.equal(actions[1].inputRepairsUsed, 1);
    assert.equal(actions[1].input.summary, "Keep the autonomy surface coverage honest");
    assert.equal(actions[1].status, "completed");

    const proposalsDir = path.join(sipsDir, "proposals");
    const proposalReceipts = fs.readdirSync(proposalsDir).filter((name) => name.endsWith(".receipt.json"));
    assert.ok(proposalReceipts.length >= 1, "improve.propose wrote a durable proposal receipt through the real dispatch");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a repaired input that still fails produces an honest blocked task, not a second repair", async () => {
  const prompts = [];
  const harness = makeLoopHarness({
    taskId: "task-input-repair-blocked",
    autonomy: "autonomous",
    inferAction: async (prompt) => {
      prompts.push(prompt);
      if (prompt.repair?.schema === "hemlock.agent.input.repair.v1") {
        return JSON.stringify({ kind: "tool", commandId: "improve.propose", input: { summary: "Still missing the rationale" }, shortRationale: "Partial repair" });
      }
      return JSON.stringify({ kind: "tool", commandId: "improve.propose", input: {}, shortRationale: "Propose the improvement." });
    },
  });
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "improve.propose", label: "Propose a bounded improvement" }] });
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "blocked");
    assert.equal(harness.task.status, "blocked");
    assert.match(harness.task.blockedReason, /deterministic-input.*rationale/i);
    assert.equal(prompts.filter((prompt) => prompt.repair?.schema === "hemlock.agent.input.repair.v1").length, 1, "the repair budget is exactly one attempt");
    assert.ok(harness.events.some((event) => event.type === "task.blocked"));
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a high-confidence decide pick that the plan overrides records a durable divergence", async () => {
  const harness = makeLoopHarness({
    taskId: "task-divergence-e2e",
    scoreActions: {
      decide: async (_prompt, candidates) => {
        const probabilities = {};
        let blockedKey = "cand-0";
        candidates.forEach((candidate, index) => {
          probabilities[`cand-${index}`] = candidate.kind === "blocked" ? 0.9 : 0.1 / Math.max(1, candidates.length - 1);
          if (candidate.kind === "blocked") blockedKey = `cand-${index}`;
        });
        return { answers: { "q-action": { type: "choice", probabilities, choice: blockedKey, confidence: 0.9 } }, committedQuestion: "q-action" };
      },
    },
    inferAction: async () => JSON.stringify({ kind: "tool", commandId: "world.state", input: {}, shortRationale: "Execute the approved plan step." }),
  });
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "world.state", label: "Read world" }] });
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "completed", "the approved planned step executes despite the advisory blocked pick");

    const divergence = harness.events.find((event) => event.type === "action.scored.divergence");
    assert.ok(divergence, "action.scored.divergence was emitted");
    assert.equal(divergence.payload.decidedKind, "blocked");
    assert.equal(divergence.payload.executedKind, "tool");
    assert.equal(divergence.payload.executedCommandId, "world.state");
    assert.equal(divergence.payload.confidence, 0.9);
    const durable = fs.readFileSync(harness.eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(durable.some((event) => event.type === "action.scored.divergence" && event.payload.executedCommandId === "world.state"), "the divergence record is durable on disk");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the idle-dream proposer surfaces one reviewable candidate when the queue settles on a grown dataset", async () => {
  // The earlier tests' refused structured-action calls leaked agent_action
  // streams; the proposer's quiet gate requires none in flight.
  await drainLeakedStreams();
  const intent = await run("intent.submit", { text: "Settle the queue for idle-dream coverage", intent: "inspect" });
  assert.equal(intent.status, "accepted");
  // An answer-only plan never calls the model — the task settles
  // deterministically with zero new streams.
  const proposed = await run("plan.propose", { steps: [{ kind: "answer", label: "Report readiness" }] });
  assert.equal(proposed.status, "waiting_for_approval");
  const approved = await run("plan.approve", { planId: proposed.plan.id });
  assert.equal(approved.status, "completed");

  const proposalEvents = readEvents().filter((event) => event.type === "dream.proposal.created");
  assert.equal(proposalEvents.length, 1, "exactly one dream proposal for the settled host");
  assert.equal(proposalEvents[0].payload.trigger, "task-settled");
  assert.ok(proposalEvents[0].payload.newRows >= 8, "the proposer saw the grown findings dataset");
  const scheduler = JSON.parse(fs.readFileSync(path.join(sipsDir, "dream-scheduler.json"), "utf8"));
  assert.ok(scheduler.lastProposalAt > 0, "the proposal watermark persisted durably");
});

test("queued intents persist into session state and restore as cancellable queued entries that never auto-run", async () => {
  const first = await run("intent.submit", { text: "Hold the queue slot for persistence coverage", intent: "inspect" });
  assert.equal(first.status, "accepted");
  assert.equal(first.task.status, "waiting_for_approval", "the parked task holds the queue slot");

  const alpha = await run("intent.submit", { text: "Queued intent alpha", intent: "inspect", requestId: "e2e-queue-alpha" });
  const beta = await run("intent.submit", { text: "Queued intent beta", intent: "inspect", requestId: "e2e-queue-beta" });
  assert.equal(alpha.status, "queued");
  assert.equal(beta.status, "queued");

  const state = readSessionState();
  const persisted = (state.pendingIntents || []).filter((entry) => ["e2e-queue-alpha", "e2e-queue-beta"].includes(entry.requestId));
  assert.equal(persisted.length, 2, "pending intents ride the session state file");
  assert.equal(persisted[0].status, "queued");
  assert.equal(persisted[0].payload.objective, "Queued intent alpha");

  const executions = [];
  const restoredQueue = new AgentIntentQueue({
    getTask: () => null,
    execute: async (payload) => { executions.push(payload); return { status: "completed" }; },
    onChange: () => {},
    emit: () => {},
  });
  const restored = restoredQueue.restorePending(state.pendingIntents, { restoredFromSessionId: "e2e-previous-session" });
  assert.equal(restored.length, 2);
  assert.ok(restored.every((entry) => entry.status === "queued" && entry.restoredFromSessionId === "e2e-previous-session"));
  assert.equal(restoredQueue.snapshot().pending.length, 2);
  assert.equal(executions.length, 0, "restored entries never auto-execute");

  const cancelled = restoredQueue.cancelQueued("e2e-queue-alpha");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(restoredQueue.snapshot().pending.length, 1);
  assert.equal(executions.length, 0);

  const cancel = ipcHandlers.get("agent:queue-cancel");
  for (const requestId of ["e2e-queue-alpha", "e2e-queue-beta"]) await cancel({}, requestId);
});

test("main.cjs keeps the production wiring this suite depends on", () => {
  const source = fs.readFileSync(mainPath, "utf8");
  assert.match(source, /command === "agent\.self"\) result = agentSelfSnapshot\(\)/);
  assert.match(source, /command === "world\.state"\) result = worldStateSnapshot\(\)/);
  assert.match(source, /Placing a grove marker requires an approved Hemlock plan action/);
  assert.match(source, /command === "shell\.exec"\) result = await runShellExec\(payload, operation\.id\)/);
  assert.match(source, /command === "plan\.revise"\) result = agentOrchestrator\.revisePlan/);
  assert.match(source, /command === "task\.resume"\) result = await agentOrchestrator\.resumeTask/);
  assert.match(source, /executeCommand: \(command, payload\) => runAgentCommand\(command, payload\)/);
  assert.match(source, /persistablePending\?\.\(\)/);
  assert.match(source, /restorePending\(previousPendingIntents/);
  assert.match(source, /maybeProposeIdleDream\("task-settled"\)/);
  for (const commandId of Object.keys(E2E_COMMAND_REGISTRY)) {
    assert.match(source, new RegExp(`"${commandId.replace(".", "\\.")}": \\{`), `registry entry for ${commandId}`);
  }
  assert.match(source, /"world\.place": \{[^}]*approval: "plan"/);
  assert.match(source, /"shell\.exec": \{[^}]*approval: "plan"/);
  assert.match(source, /"agent\.self": \{[^}]*auto: true[^}]*approval: "none"/);
  assert.match(source, /"improve\.propose": \{[^}]*approval: "explicit"/);
});
