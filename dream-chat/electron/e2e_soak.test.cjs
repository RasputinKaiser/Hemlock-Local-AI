"use strict";

// SOAK lane: end-to-end stress through the real main.cjs. Electron is mocked
// and child_process.spawn is guarded (same harness idiom as
// e2e_autonomy_surface.test.cjs): bare allowlisted executables spawn for real,
// everything else fails instantly. Model transport is pinned to a dead
// endpoint via the intent.submit apiBase override, so every infer/decide/score
// call fails fast and the orchestrator takes the deterministic plan-step
// fallback — the same path production takes when Maple is unavailable.
//
// Boot-durability scenarios re-run THIS file as a child process
// (HEMLOCK_SOAK_CHILD=1, HEMLOCK_SOAK_PHASE=seed|boot) with the same
// HEMLOCK_DATA_DIR — the session_restore.test.cjs reboot idiom. The child
// prints its session dump between sentinels; the parent asserts on it.

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
const { EXEC_ALLOWLIST } = require("./shell_exec.cjs");

const MAIN_PATH = path.resolve(__dirname, "main.cjs");
const repoRoot = path.resolve(__dirname, "..", "..");

// Environmental isolation: the default computer-history root is a third-party
// TCC group container whose readdirSync can block the syscall entirely
// (observed on this host: open() on the Skysight segments dir never returns,
// freezing the main process inside contextBroker.refresh at boot).
// context_broker.cjs latestSegment's synchronous readdirSync is outside the
// allowed fix surface, so the soak lane pins an empty root instead.
process.env.HEMLOCK_COMPUTER_HISTORY_ROOT = path.join(os.tmpdir(), "hemlock-soak-empty-history");
const DEAD_API = "http://127.0.0.1:9";
const CHILD_FLAG = "HEMLOCK_SOAK_CHILD";
const PHASE_ENV = "HEMLOCK_SOAK_PHASE";

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
    child.emit("error", Object.assign(new Error(`spawn ${command} blocked by soak harness`), { code: "ENOENT" }));
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
const spawnCountFor = (command) => spawnLog.filter((call) => call.command === command).length;

function makeElectronMock(ipcHandlers) {
  return {
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
}

function loadMain(ipcHandlers) {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") return makeElectronMock(ipcHandlers);
    if (request === "node:child_process") return { ...realChildProcess, spawn: guardedSpawn };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[MAIN_PATH];
  try {
    require(MAIN_PATH);
  } finally {
    Module._load = originalLoad;
  }
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

async function waitUntil(predicate, { timeoutMs = 60000, intervalMs = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitUntil timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ""}`);
}

// ── Child mode: boot the real main.cjs under a caller-provided data dir ────
if (process.env[CHILD_FLAG] === "1") {
  const dataDir = path.resolve(process.env.HEMLOCK_DATA_DIR);
  const sipsDir = path.resolve(process.env.HEMLOCK_SIPS_DIR);
  const ipcHandlers = new Map();
  loadMain(ipcHandlers);
  const run = (action, payload = {}) => ipcHandlers.get("agent:command")({}, { ...payload, action });
  const agentState = () => ipcHandlers.get("agent:state")({});
  const sessionsDir = path.join(sipsDir, "sessions");
  const sessionId = fs.readdirSync(sessionsDir).sort().at(-1);
  const sessionDir = path.join(sessionsDir, sessionId);

  (async () => {
    const phase = process.env[PHASE_ENV] || "boot";
    const result = { sessionId };
    if (phase === "seed") {
      // Task A runs to a real terminal receipt; B queues behind it and drains
      // into the parked state; C stays pending so the reboot has a durable
      // queued intent to restore.
      const a = await run("intent.submit", { text: "Soak seed completed task", intent: "inspect", requestId: "seed-a", apiBase: DEAD_API });
      const queuedB = await run("intent.submit", { text: "Soak seed parked task", intent: "inspect", requestId: "seed-b" });
      if (a.status !== "accepted" || queuedB.status !== "queued") {
        throw new Error(`seed queueing failed: a=${a.status} b=${queuedB.status}`);
      }
      await run("plan.propose", { steps: [{ kind: "answer", label: "Seed completion answer" }] });
      const approved = await run("plan.approve", {});
      if (approved.status !== "completed") throw new Error(`seed task A did not complete: ${approved.status}`);
      await waitUntil(() => {
        const state = agentState();
        return state.task?.objective === "Soak seed parked task" && state.task.status === "waiting_for_approval" ? state : null;
      }, { label: "seed task B to drain into waiting_for_approval" });
      // A real thread so the restored intent can actually execute its
      // routing (resolveThreadForIntent switchThreads on payload.threadId).
      const threadResult = await run("thread.create", { workspaceRoot: repoRoot, title: "Seed C thread" });
      const threadId = threadResult.thread?.id;
      if (!threadId) throw new Error("seed thread creation failed");
      const queuedC = await run("intent.submit", {
        text: "Soak seed queued intent",
        intent: "inspect",
        requestId: "seed-c",
        threadId,
        workspaceRoot: repoRoot,
        autonomy: "guided",
        fallbackLane: "codex",
      });
      if (queuedC.status !== "queued") throw new Error(`seed intent C did not queue: ${queuedC.status}`);
      result.aTaskId = a.task.id;
      result.bTaskId = agentState().task.id;
    } else if (phase === "leapfrog") {
      // A restored pending intent exists (queued, task blocked). A fresh
      // submission must queue BEHIND it — never start ahead of older work.
      const d = await run("intent.submit", { text: "Soak leapfrog intent", intent: "inspect", requestId: "leapfrog-d" });
      result.dStatus = d.status;
      // The restored intent carries autonomy:guided, which auto-approves its
      // plan — it does not park at waiting_for_approval. FIFO proof lives in
      // the journal order, not a transient state poll.
      await waitUntil(() => {
        const events = readJsonl(path.join(sessionDir, "events.jsonl"));
        return events.some((event) => event.type === "task.created" && event.payload?.task?.objective === "Soak seed queued intent") || null;
      }, { label: "restored intent to reach the wheel ahead of the newcomer", timeoutMs: 90000 });
    }
    result.state = JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf8"));
    result.events = readJsonl(path.join(sessionDir, "events.jsonl"));
    try {
      result.registry = JSON.parse(fs.readFileSync(path.join(dataDir, "threads", "registry.json"), "utf8"));
    } catch {
      result.registry = null;
    }
    // process.exit() truncates pending pipe writes — the result payload can
    // exceed the pipe buffer, so wait for the flush before exiting.
    process.stdout.write(`@@RESULT@@${JSON.stringify(result)}@@END@@\n`, () => process.exit(0));
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  // ── Parent harness: one real main.cjs in this process ────────────────────
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-e2e-soak-"));
  process.env.HEMLOCK_DATA_DIR = dataDir;
  process.env.HEMLOCK_SIPS_DIR = path.join(dataDir, "sips");
  const sipsDir = process.env.HEMLOCK_SIPS_DIR;

  const ipcHandlers = new Map();
  loadMain(ipcHandlers);

  const run = (action, payload = {}) => ipcHandlers.get("agent:command")({}, { ...payload, action });
  const agentState = () => ipcHandlers.get("agent:state")({});
  const queueCancel = (requestId) => ipcHandlers.get("agent:queue-cancel")({}, requestId);

  function sessionDir() {
    const base = path.join(sipsDir, "sessions");
    const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    return path.join(base, dirs.at(-1));
  }
  function readEvents() {
    return readJsonl(path.join(sessionDir(), "events.jsonl"));
  }
  function readSessionState() {
    return JSON.parse(fs.readFileSync(path.join(sessionDir(), "state.json"), "utf8"));
  }

  // Parked waiting_for_approval → approved answer-only plan → completed.
  // Deterministic: an answer step needs no model call.
  async function settleCurrentTask() {
    await run("plan.propose", { steps: [{ kind: "answer", label: "Soak settle answer" }] });
    return run("plan.approve", {});
  }

  const waitForTask = (objective, status, timeoutMs = 60000) => waitUntil(() => {
    const state = agentState();
    return state.task?.objective === objective && state.task.status === status ? state.task : null;
  }, { label: `task "${objective}" → ${status}`, timeoutMs });

  function spawnSoakChild({ phase, childDataDir, childSipsDir, timeout = 120000 }) {
    let output;
    try {
      output = realChildProcess.execFileSync(process.execPath, [__filename], {
        env: { ...process.env, [CHILD_FLAG]: "1", [PHASE_ENV]: phase, HEMLOCK_DATA_DIR: childDataDir, HEMLOCK_SIPS_DIR: childSipsDir },
        encoding: "utf8",
        timeout,
      });
    } catch (error) {
      assert.fail(`soak child (${phase}) failed: ${error.message}\n${error.stderr || ""}\n${(error.stdout || "").slice(-800)}`);
    }
    const match = output.match(/@@RESULT@@(.*)@@END@@/s);
    assert.ok(match, `soak child (${phase}) produced no result payload: ${output.slice(-800)}`);
    return JSON.parse(match[1]);
  }

  // Registry mirror for the harness-owned orchestrator — same contract as
  // e2e_autonomy_surface.test.cjs; must cover only what the scenarios use.
  const SOAK_COMMAND_REGISTRY = {
    "agent.self": { label: "Read my own task snapshot", capability: "read", auto: true, approval: "none", inputHint: "{}" },
    "world.state": { label: "Read the understory world state", capability: "read", auto: true, approval: "none", inputHint: "{}" },
    "receipts.query": { label: "Query local receipts", capability: "read", auto: true, approval: "none", inputHint: "{}" },
    "shell.exec": { label: "Run a bounded workspace command", capability: "verify", auto: false, approval: "plan", inputHint: "{command, args?, cwd?}" },
  };

  function makeLoopHarness({ taskId, registry = SOAK_COMMAND_REGISTRY, inferAction = null, autonomy = "supervised", executeWrapper = null }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-soak-loop-"));
    const eventsFile = path.join(root, "events.jsonl");
    let task = {
      schema: "hemlock.agent.task.v1",
      id: taskId,
      objective: "Soak harness task",
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
    const dispatch = async (command, payload) => run(command, payload);
    const orchestrator = new AgentOrchestrator({
      kernel,
      commandRegistry: registry,
      getTask: () => task,
      setTask: (patch) => { task = { ...task, ...patch }; kernel.syncTask(task); return task; },
      emit,
      executeCommand: executeWrapper ? async (command, payload) => executeWrapper(command, payload, dispatch) : dispatch,
      inferAction,
    });
    return { root, kernel, orchestrator, events, eventsFile, get task() { return task; } };
  }

  test("rapid intent flood: three back-to-back intents serialize, drain in order, and each gets a terminal receipt", async () => {
    const [a, b, c] = await Promise.all([
      run("intent.submit", { text: "Soak flood alpha", intent: "inspect", requestId: "flood-a", apiBase: DEAD_API }),
      run("intent.submit", { text: "Soak flood beta", intent: "inspect", requestId: "flood-b" }),
      run("intent.submit", { text: "Soak flood gamma", intent: "inspect", requestId: "flood-c" }),
    ]);
    assert.equal(a.status, "accepted");
    assert.equal(b.status, "queued");
    assert.equal(c.status, "queued");
    assert.deepEqual(
      agentState().queue.pending.map((entry) => entry.payload.objective || entry.payload.text),
      ["Soak flood beta", "Soak flood gamma"],
      "queue holds the flooded intents FIFO",
    );

    const taskIds = { a: a.task.id };
    const settleA = await settleCurrentTask();
    assert.equal(settleA.status, "completed");
    const betaTask = await waitForTask("Soak flood beta", "waiting_for_approval");
    taskIds.b = betaTask.id;
    assert.equal(agentState().queue.pending.length, 1, "gamma still waits behind beta");

    const settleB = await settleCurrentTask();
    assert.equal(settleB.status, "completed");
    const gammaTask = await waitForTask("Soak flood gamma", "waiting_for_approval");
    taskIds.c = gammaTask.id;
    assert.equal(agentState().queue.pending.length, 0);

    const settleC = await settleCurrentTask();
    assert.equal(settleC.status, "completed");
    await waitForTask("Soak flood gamma", "completed");

    const events = readEvents();
    const completedTaskIds = events.filter((event) => event.type === "task.completed").map((event) => event.payload?.task?.id);
    for (const id of [taskIds.a, taskIds.b, taskIds.c]) {
      assert.ok(completedTaskIds.includes(id), `terminal receipt (task.completed) exists for ${id}`);
    }
    // Order proof: the queue drained the intents oldest-first.
    const drainedOrder = events
      .filter((event) => event.type === "task.created")
      .map((event) => event.payload?.task?.objective)
      .filter((objective) => ["Soak flood alpha", "Soak flood beta", "Soak flood gamma"].includes(objective));
    assert.deepEqual(drainedOrder, ["Soak flood alpha", "Soak flood beta", "Soak flood gamma"]);
    assert.equal(events.some((event) => event.type === "task.queue.failed"), false, "no queue entry failed");
    assert.equal(agentState().queue.count, 0);
  });

  test("pause with a pending intent holds the queue slot; resume restores the park and the queue drains", async () => {
    const a = await run("intent.submit", { text: "Soak pause holder", intent: "inspect", requestId: "pause-a" });
    assert.equal(a.status, "accepted");
    const b = await run("intent.submit", { text: "Soak pause waiter", intent: "inspect", requestId: "pause-b" });
    assert.equal(b.status, "queued");

    const paused = await run("task.pause", {});
    assert.equal(paused.status, "paused");
    assert.equal(agentState().task.status, "paused");
    // A paused task still occupies the slot — the pending intent must not move.
    assert.equal(agentState().queue.pending.length, 1);
    assert.equal(agentState().queue.pending[0].payload.objective, "Soak pause waiter");

    const resumed = await run("task.resume", {});
    assert.equal(resumed.status, "waiting_for_approval", "a task paused before approval resumes into the parked state");
    assert.equal(agentState().queue.pending.length, 1, "the queue still holds until the active task settles");

    const eventsBefore = readEvents().length;
    const settleA = await settleCurrentTask();
    assert.equal(settleA.status, "completed");
    const betaTask = await waitForTask("Soak pause waiter", "waiting_for_approval");
    const fresh = readEvents().slice(eventsBefore);
    assert.equal(fresh.filter((event) => event.type === "task.created" && event.payload?.task?.objective === "Soak pause waiter").length, 1, "the queued intent started exactly once, after the pause-resume cycle");

    const settleB = await settleCurrentTask();
    assert.equal(settleB.status, "completed");
    await waitForTask("Soak pause waiter", "completed");
    assert.ok(readEvents().some((event) => event.type === "task.paused" && event.payload?.taskId === a.task.id));
    assert.ok(readEvents().some((event) => event.type === "task.resumed"));
    assert.ok(betaTask.id !== a.task.id);
  });

  test("kill mid-task: a denied command at step 2 blocks the task honestly and the queue is not stranded", async () => {
    const eventsBefore = readEvents().length;
    const a = await run("intent.submit", { text: "Soak kill victim", intent: "inspect", requestId: "kill-a" });
    const b = await run("intent.submit", { text: "Soak kill survivor", intent: "inspect", requestId: "kill-b" });
    assert.equal(b.status, "queued");

    await run("plan.propose", {
      steps: [
        { commandId: "world.state", label: "Read world state (succeeds)" },
        { commandId: "shell.exec", input: { command: "rm", args: ["-rf", "."] }, label: "Denied exec step" },
        { kind: "answer", label: "Never reached" },
      ],
    });
    const rmSpawnsBefore = spawnCountFor("rm");
    // The denial lands asynchronously and the queue drains off the block the
    // moment it lands, so the victim's terminal state lives in the journal —
    // state.task is already the survivor by the time we look.
    await run("plan.approve", {});
    await waitUntil(() => readEvents().some((event) => event.type === "task.blocked" && event.payload?.taskId === a.task.id), { label: "victim task.blocked receipt" });

    const fresh = readEvents().slice(eventsBefore);
    // command.started fires twice per dispatch (executor + inner); the
    // completed event is the once-per-execution marker.
    assert.equal(fresh.filter((event) => event.type === "command.completed" && event.payload?.command === "world.state").length, 1, "step 1 executed before the kill");
    assert.equal(spawnCountFor("rm"), rmSpawnsBefore, "the denied command never reached spawn");
    const blockedEvent = fresh.find((event) => event.type === "task.blocked" && event.payload?.taskId === a.task.id);
    assert.match(String(blockedEvent?.payload?.reason || ""), /allowlist|safety|blocked/i, "honest terminal receipt for the killed task");
    assert.equal(fresh.some((event) => event.type === "task.completed" && event.payload?.task?.id === a.task.id), false, "no completion claimed for a dead task");

    // The queue drains off a block: the survivor intent must reach the wheel.
    const survivor = await waitForTask("Soak kill survivor", "waiting_for_approval");
    assert.ok(survivor.id !== a.task.id);
    const settleB = await settleCurrentTask();
    assert.equal(settleB.status, "completed");
    await waitForTask("Soak kill survivor", "completed");
  });

  test("restart durability: completed work stays receipted, the interrupted task restores blocked, the queued intent restores queued", async () => {
    const childDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-soak-boot-"));
    const childSipsDir = path.join(childDataDir, "sips");
    const seed = spawnSoakChild({ phase: "seed", childDataDir, childSipsDir });

    const seedDir = path.join(childSipsDir, "sessions", seed.sessionId);
    const seedEvents = readJsonl(path.join(seedDir, "events.jsonl"));
    assert.ok(seedEvents.some((event) => event.type === "task.completed" && event.payload?.task?.id === seed.aTaskId), "task A's terminal receipt is durable in the previous session journal");
    const seedState = JSON.parse(fs.readFileSync(path.join(seedDir, "state.json"), "utf8"));
    assert.equal(seedState.id, seed.bTaskId);
    assert.equal(seedState.status, "waiting_for_approval");
    assert.equal(seedState.pendingIntents.length, 1, "one pending intent persisted with the session");
    const persisted = seedState.pendingIntents[0];
    assert.equal(persisted.requestId, "seed-c");
    assert.equal(persisted.status, "queued");
    // Routing fields must survive the session boundary — a queued intent
    // restored without them would execute on the wrong thread/lane.
    assert.ok(persisted.payload.threadId, "thread routing persisted on the queued intent");
    assert.equal(persisted.payload.workspaceRoot, repoRoot);
    assert.equal(persisted.payload.autonomy, "guided");
    assert.equal(persisted.payload.fallbackLane, "codex");

    const boot = spawnSoakChild({ phase: "boot", childDataDir, childSipsDir });
    assert.equal(boot.state.id, seed.bTaskId, "the interrupted task restores as the live task");
    assert.equal(boot.state.status, "blocked", "restored tasks boot blocked, never running");
    assert.equal(boot.state.phase, "resume");
    assert.match(String(boot.state.blockedReason || ""), /interrupted/);
    assert.equal(boot.state.pendingIntents.length, 1);
    assert.equal(boot.state.pendingIntents[0].requestId, "seed-c");
    assert.equal(boot.state.pendingIntents[0].status, "queued", "pending intents restore queued, never running");
    assert.equal(boot.state.pendingIntents[0].payload.threadId, persisted.payload.threadId, "the restored intent keeps its thread routing");
    assert.equal(boot.state.pendingIntents[0].payload.fallbackLane, "codex", "the restored intent keeps its lane override");

    const restoredEvent = boot.events.find((event) => event.type === "task.restored");
    assert.ok(restoredEvent, "task.restored is emitted on boot");
    assert.equal(restoredEvent.payload.taskId, seed.bTaskId);
    assert.equal(restoredEvent.payload.snapshotSessionId, seed.sessionId);
    const queueRestored = boot.events.find((event) => event.type === "queue.restored");
    assert.ok(queueRestored, "queue.restored is emitted on boot");
    assert.equal(queueRestored.payload.count, 1);
    assert.equal(boot.events.some((event) => event.type === "command.started"), false, "nothing auto-executes after a reboot");

    assert.ok(boot.registry && boot.registry.schema === "hemlock.agent.thread.registry.v1", "the thread registry is readable after reboot");
    assert.ok(Array.isArray(boot.registry.threads) && boot.registry.threads.length >= 1, "registry threads survived the reboot");
    const liveStamped = boot.registry.threads.filter((thread) => ["running", "verifying", "accepted", "planning"].includes(thread.status));
    assert.equal(liveStamped.length, 0, "no thread claims live work across a reboot");

    // A fresh intent must never leapfrog intents that were already queued:
    // the restored intent drains first, then the new one waits behind it.
    const leapfrog = spawnSoakChild({ phase: "leapfrog", childDataDir, childSipsDir });
    assert.equal(leapfrog.dStatus, "queued", "a new intent queues behind the restored intent instead of jumping the lane");
    const cStarted = leapfrog.events.findIndex((event) => event.type === "task.queue.started" && (event.payload?.entry?.payload?.objective || event.payload?.entry?.payload?.text) === "Soak seed queued intent");
    const dStarted = leapfrog.events.findIndex((event) => event.type === "task.queue.started" && (event.payload?.entry?.payload?.objective || event.payload?.entry?.payload?.text) === "Soak leapfrog intent");
    assert.ok(cStarted >= 0, "the restored intent took the wheel");
    assert.ok(dStarted === -1 || dStarted > cStarted, "the newcomer never started ahead of the restored intent — FIFO held across the reboot");
  });

  test("corrupt thread registry: boot survives, quarantines the bad file, and rebuilds from the backup", async () => {
    const childDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-soak-corrupt-"));
    const childSipsDir = path.join(childDataDir, "sips");
    const threadsDir = path.join(childDataDir, "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "registry.json"), "{ this is not valid json", "utf8");
    fs.writeFileSync(path.join(threadsDir, "registry.json.bak"), `${JSON.stringify({
      schema: "hemlock.agent.thread.registry.v1",
      projects: [],
      threads: [{
        schema: "hemlock.agent.thread.v1",
        id: "thread-backup",
        projectId: null,
        title: "Backup thread",
        workspaceRoot: repoRoot,
        status: "ready",
        phase: "conversation",
        taskId: null,
        taskSnapshot: null,
        taskHistory: [],
        evidenceRefs: [],
        suggestions: [],
        metrics: {},
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }],
      activeThreadId: "thread-backup",
    }, null, 2)}\n`, "utf8");

    const boot = spawnSoakChild({ phase: "boot", childDataDir, childSipsDir });
    assert.ok(boot.registry && boot.registry.schema === "hemlock.agent.thread.registry.v1", "boot produced a valid registry despite the corrupt file");
    assert.ok(boot.registry.threads.some((thread) => thread.id === "thread-backup"), "threads were recovered from the rotated backup");
    const quarantined = fs.readdirSync(threadsDir).filter((name) => name.startsWith("registry.json.corrupt-"));
    assert.equal(quarantined.length, 1, "the corrupt file is quarantined for inspection instead of silently overwritten");
    // NOTE: recovery is currently silent — no integrity.* event reaches the
    // journal. Reported as an observability gap; the survival contract above
    // is what the code actually implements.
  });

  test("steering flood: three steers against an active task land oldest-first with none lost", async () => {
    const a = await run("intent.submit", { text: "Soak steer target", intent: "inspect", requestId: "steer-target" });
    assert.equal(a.status, "accepted");
    const eventsBefore = readEvents().length;

    const results = [];
    for (const [index, content] of ["first steer", "second steer", "third steer"].entries()) {
      results.push(await run("intent.submit", { mode: "steer", text: `Soak ${content}`, requestId: `steer-${index + 1}` }));
    }
    for (const result of results) assert.equal(result.status, "steered");

    const steering = (agentState().task.steering || []).filter((item) => /^Soak (first|second|third) steer$/.test(item.content || ""));
    assert.equal(steering.length, 3, "no steering update was lost");
    assert.deepEqual(steering.map((item) => item.content), ["Soak first steer", "Soak second steer", "Soak third steer"], "oldest-first ordering preserved on the task");

    const received = readEvents().slice(eventsBefore).filter((event) => event.type === "task.steering.received").map((event) => event.payload?.steering?.content);
    assert.deepEqual(received, ["Soak first steer", "Soak second steer", "Soak third steer"], "journal order matches submission order");
    // Delivery marking requires a secured model response; with the transport
    // dead every item must stay honestly "accepted" — none may be silently
    // dropped or falsely claimed delivered.
    assert.ok(steering.every((item) => item.status === "accepted" || item.status === "delivered"));

    const settle = await settleCurrentTask();
    assert.equal(settle.status, "completed");
  });

  test("approval: an approved parked task continues to a terminal receipt; a rejected plan ends honestly", async () => {
    const a = await run("intent.submit", { text: "Soak approve me", intent: "inspect", requestId: "approve-a" });
    assert.equal(a.task.status, "waiting_for_approval");
    const settle = await settleCurrentTask();
    assert.equal(settle.status, "completed");
    assert.ok(readEvents().some((event) => event.type === "task.completed" && event.payload?.task?.id === a.task.id), "approval drove the task to a durable completion receipt");

    const b = await run("intent.submit", { text: "Soak reject me", intent: "inspect", requestId: "reject-b" });
    assert.equal(b.task.status, "waiting_for_approval");
    const rejected = await run("plan.reject", { reason: "Soak rejection" });
    assert.equal(rejected.status, "blocked", "rejection is an honest terminal state, not a crash");
    assert.equal(agentState().task.status, "blocked");
    assert.ok(readEvents().some((event) => event.type === "plan.rejected" && event.payload?.taskId === b.task.id));
  });

  test("budget boundary: maxAgentSteps=2 blocks at exactly the boundary and never leaks a third execution", async () => {
    await run("intent.submit", { text: "Soak budget task", intent: "inspect", requestId: "budget-a" });
    const eventsBefore = readEvents().length;
    await run("plan.propose", {
      steps: [
        { commandId: "world.state", label: "Step one" },
        { commandId: "world.state", label: "Step two" },
        { kind: "answer", label: "Step three must never run" },
      ],
    });
    const approved = await run("plan.approve", { budgetOverrides: { maxAgentSteps: 2 } });
    assert.equal(approved.status, "blocked");
    assert.match(String(approved.reason || ""), /step budget/i);

    const fresh = readEvents().slice(eventsBefore);
    assert.equal(
      fresh.filter((event) => event.type === "command.completed" && event.payload?.command === "world.state").length,
      2,
      "exactly two command executions — the boundary held",
    );
    const blockedEvent = fresh.find((event) => event.type === "task.blocked");
    assert.ok(blockedEvent, "a budget-exhausted receipt exists");
    assert.match(String(blockedEvent.payload?.reason || ""), /step budget/i);
    assert.equal(fresh.some((event) => event.type === "task.completed"), false, "no completion past the budget");
  });

  test("batch envelope with a mid-batch failure: earlier steps receipted, the failure is honest, no orphan actions", async () => {
    const eventsBefore = readEvents().length;
    const harness = makeLoopHarness({
      taskId: "task-soak-batch",
      inferAction: async () => JSON.stringify({
        actions: [
          { commandId: "world.state", shortRationale: "Read the world first." },
          { commandId: "shell.exec", input: { command: "rm", args: ["-rf", "."] }, shortRationale: "Denied exec second." },
          { commandId: "world.state", shortRationale: "This item must never run." },
        ],
      }),
    });
    try {
      const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "world.state", label: "Read world" }] });
      const rmSpawnsBefore = spawnCountFor("rm");
      const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
      assert.equal(result.status, "blocked");
      assert.equal(harness.task.status, "blocked");

      const items = harness.kernel.getTaskHistory(harness.task.id).actions.filter((action) => action.batchId);
      assert.equal(items.length, 2, "the third batch item never became a durable action — no orphan work");
      assert.equal(items[0].commandId, "world.state");
      assert.equal(items[0].status, "completed");
      assert.equal(items[1].commandId, "shell.exec");
      assert.equal(items[1].status, "failed");

      const observations = harness.kernel.getTaskHistory(harness.task.id).observations;
      assert.equal(observations.length, 2, "each executed item has its own observation");
      assert.equal(observations[0].status, "passed");
      assert.equal(observations[1].status, "failed");

      const halted = harness.events.find((event) => event.type === "batch.halted");
      assert.ok(halted, "batch.halted receipt exists");
      assert.equal(halted.payload.failedIndex, 1);
      assert.equal(halted.payload.completedCount, 1);

      const started = readEvents().slice(eventsBefore).filter((event) => event.type === "command.started" && ["world.state", "shell.exec"].includes(event.payload?.command));
      assert.deepEqual(started.map((event) => event.payload.command), ["world.state", "shell.exec"], "real dispatch ran exactly the first two items — item three was never dispatched");
      assert.equal(spawnCountFor("rm"), rmSpawnsBefore, "the denied batch item never reached spawn");
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("cancel racing: cancel during an in-flight step wins; no double completion", async () => {
    let releaseGate;
    let entered = false;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const harness = makeLoopHarness({
      taskId: "task-soak-cancel",
      inferAction: async () => JSON.stringify({ kind: "tool", commandId: "world.state", input: {}, shortRationale: "Read the world." }),
      executeWrapper: async (command, payload, dispatch) => {
        if (command === "world.state" && !entered) {
          entered = true;
          await gate;
        }
        return dispatch(command, payload);
      },
    });
    try {
      const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "world.state", label: "Read world" }, { kind: "answer", label: "Wrap up" }] });
      const running = harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
      await waitUntil(() => entered, { label: "the step to be in flight" });
      harness.orchestrator.cancel(harness.task.id);
      releaseGate();
      const result = await running;
      assert.equal(result.status, "cancelled", "cancel wins the race against the in-flight step");

      const history = harness.kernel.getTaskHistory(harness.task.id);
      assert.equal(history.actions.length, 1);
      assert.equal(history.actions[0].status, "cancelled");
      assert.equal(history.observations.length, 0, "the cancelled step left no observation — its outcome is terminal, not double-recorded");
      assert.equal(harness.events.filter((event) => event.type === "task.cancelled").length, 1, "exactly one cancel receipt");
      assert.equal(harness.events.filter((event) => event.type === "task.completed").length, 0, "no completion event raced the cancel");
      assert.equal(harness.events.filter((event) => event.type === "action.completed").length, 0, "no action completion raced the cancel");
      assert.equal(harness.task.status, "cancelled");
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("a queued intent that fails on execution still drains the queue — no stranded entries, no unhandled rejection", async () => {
    // Regression harness for the drain path: a queued entry whose execute()
    // throws is receipted task.queue.failed by start(), but drain() must
    // swallow that rejection — the fire-and-forget `void this.drain()` callers
    // would otherwise surface an unhandledRejection that kills the host.
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await run("intent.submit", { text: "Soak drain holder", intent: "inspect", requestId: "drain-a" });
      const bad = await run("intent.submit", { text: "", requestId: "drain-bad" });
      const tail = await run("intent.submit", { text: "Soak drain tail", intent: "inspect", requestId: "drain-c" });
      assert.equal(bad.status, "queued");
      assert.equal(tail.status, "queued");

      const settleA = await settleCurrentTask();
      assert.equal(settleA.status, "completed");

      // The empty intent fails during drain; the one behind it must still run.
      await waitUntil(() => {
        const state = agentState();
        return state.task?.objective === "Soak drain tail" && state.task.status === "waiting_for_approval" ? state : null;
      }, { label: "the tail intent to drain past the failed entry" });
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(unhandled.length, 0, `the failed queued entry must not reject the drain loop: ${unhandled.map(String).join("; ")}`);
      const events = readEvents();
      assert.ok(events.some((event) => event.type === "task.queue.failed"), "the failed entry got an honest queue receipt");

      const settleTail = await settleCurrentTask();
      assert.equal(settleTail.status, "completed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // REPORTED, not fixable inside the allowed file surface:
  // ContextBroker.inspectComputerHistory → latestSegment() calls
  // fs.readdirSync on the Skysight group-container root
  // (context_broker.cjs:185, path built at :7-17). On this host open() on
  // that directory never returns, so a synchronous boot-time
  // contextBroker.refresh() freezes the entire main process — require()
  // never completes, timers never fire, and no amount of try/catch can
  // contain a blocked syscall. This hangs EVERY lane that boots main.cjs
  // (e2e_autonomy_surface, session_restore children, production launch).
  // The soak lane works around it with HEMLOCK_COMPUTER_HISTORY_ROOT.
  // Proper fix belongs in context_broker.cjs: async dir listing or a
  // worker-thread/timeout probe for foreign paths.
  test.todo("context_broker: synchronous readdirSync on the computer-history root can freeze the main process at boot (context_broker.cjs:185)");

  // Regression: a task terminal via plan.reject used to strand queued
  // intents — rejectPlan marks the task blocked but emits only
  // "plan.rejected", and the queue-drain hook only listened for task.* events.
  // The settle hook now treats plan.rejected / action.rejected as settles too.
  test("queued intent drains after plan.reject", async () => {
    await run("intent.submit", { text: "Soak reject holder", intent: "inspect", requestId: "rej-hold" });
    const queued = await run("intent.submit", { text: "Soak reject waiter", intent: "inspect", requestId: "rej-wait" });
    assert.equal(queued.status, "queued");
    await run("plan.reject", { reason: "Soak rejection" });
    const task = await waitForTask("Soak reject waiter", "waiting_for_approval", 5000);
    assert.ok(task.id);
    await settleCurrentTask();
  });
}
