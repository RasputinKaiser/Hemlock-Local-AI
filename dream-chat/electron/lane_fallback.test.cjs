// Lane fallback for structured-action inference. A transport-class Maple
// death may retry the step ONCE on a configured external lane (env
// HEMLOCK_FALLBACK_LANE or per-task task.fallbackLane); parse failures,
// unconfigured lanes, and non-maple tasks keep the pre-existing behavior.
// Harness mirrors agent_orchestrator.test.cjs — a stubbed inferAction sees
// prompt.fallbackProvider the way inferStructuredAction would.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator, fallbackLaneForTask } = require("./agent_orchestrator.cjs");

function makeHarness({ inferAction = null, taskPatch = {}, commandRegistry = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-lane-fallback-"));
  const task = {
    schema: "hemlock.agent.task.v1",
    id: "task-lane",
    objective: "Inspect the Hemlock project",
    intent: "inspect",
    provider: "maple",
    phase: "plan",
    status: "planning",
    budget: { maxAgentSteps: 8, maxCommands: 12, maxRetriesPerOperation: 1, maxMutationSets: 1, maxTrainingCycles: 0, commandsUsed: 0, agentStepsUsed: 0 },
    ...taskPatch,
  };
  const kernel = new AgentKernel({ root, repoRoot: "/tmp/hemlock-project", task });
  let currentTask = task;
  const events = [];
  const orchestrator = new AgentOrchestrator({
    kernel,
    commandRegistry: commandRegistry || { "repo-map": { capability: "read" }, "repo.inspect": { capability: "read" } },
    getTask: () => currentTask,
    setTask: (patch) => { currentTask = { ...currentTask, ...patch }; kernel.syncTask(currentTask); return currentTask; },
    emit: (type, status, payload) => events.push({ type, status, payload }),
    executeCommand: async (command) => ({ status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] }),
    inferAction,
  });
  return { root, kernel, orchestrator, events, get task() { return currentTask; } };
}

function transportDeath() {
  return Object.assign(new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
}

function withFallbackEnv(lane, fn) {
  const prior = process.env.HEMLOCK_FALLBACK_LANE;
  if (lane == null) delete process.env.HEMLOCK_FALLBACK_LANE;
  else process.env.HEMLOCK_FALLBACK_LANE = lane;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prior == null) delete process.env.HEMLOCK_FALLBACK_LANE;
      else process.env.HEMLOCK_FALLBACK_LANE = prior;
    });
}

const approveTwoStepPlan = async (harness) => {
  const proposed = harness.orchestrator.proposePlan(harness.task, {
    steps: [
      { commandId: "repo-map", label: "Map repo" },
      { kind: "answer", label: "Report findings" },
    ],
  });
  return harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
};

test("fallbackLaneForTask resolves task override, env default, and explicit none", () => withFallbackEnv(null, () => {
  assert.equal(fallbackLaneForTask({}), null, "no config anywhere means no lane");
  process.env.HEMLOCK_FALLBACK_LANE = "codex";
  assert.equal(fallbackLaneForTask({}), "codex");
  assert.equal(fallbackLaneForTask({ fallbackLane: "claude" }), "claude", "per-task lane wins over env");
  assert.equal(fallbackLaneForTask({ fallbackLane: "none" }), null, "explicit none disables fallback for the task");
  assert.equal(fallbackLaneForTask({ fallbackLane: "bogus" }), "codex", "unrecognized task value falls back to the env default");
  process.env.HEMLOCK_FALLBACK_LANE = "nonsense";
  assert.equal(fallbackLaneForTask({}), null, "unrecognized env value disables fallback");
}));

test("transport death retries the step once on the configured lane and receipts it honestly", () => withFallbackEnv("codex", async () => {
  const calls = [];
  const harness = makeHarness({
    inferAction: async (prompt) => {
      calls.push(prompt.fallbackProvider || "maple");
      if (prompt.fallbackProvider) {
        return {
          content: JSON.stringify({ kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map repo via the fallback lane" }),
          channels: [],
          rawOutputRef: "/tmp/fallback-raw.json",
          provider: "codex",
        };
      }
      throw transportDeath();
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["maple", "codex"], "one Maple attempt, exactly one fallback attempt — no in-lane repair burn");

    const fallbackEvents = harness.events.filter((event) => event.type === "action.lane.fallback");
    assert.equal(fallbackEvents.length, 1, "the lane switch is receipted exactly once");
    assert.deepEqual(
      {
        originalProvider: fallbackEvents[0].payload.originalProvider,
        fallbackProvider: fallbackEvents[0].payload.fallbackProvider,
        errorClass: fallbackEvents[0].payload.errorClass,
      },
      { originalProvider: "maple", fallbackProvider: "codex", errorClass: "transport-death" },
    );

    const action = harness.kernel.getProjection().actions.find((item) => item.commandId === "repo-map");
    assert.equal(action.provider, "codex", "the durable action names the provider that did the work");
    assert.equal(action.fallbackFrom, "maple", "the durable action records the lane it fell back from");

    const observation = harness.kernel.getProjection().observations[0];
    assert.equal(observation.provider, "codex");
    assert.equal(observation.fallbackFrom, "maple");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));

test("a per-task task.fallbackLane applies even when the env default is unset", () => withFallbackEnv(null, async () => {
  const calls = [];
  const harness = makeHarness({
    taskPatch: { fallbackLane: "claude" },
    inferAction: async (prompt) => {
      calls.push(prompt.fallbackProvider || "maple");
      if (prompt.fallbackProvider) {
        return { content: JSON.stringify({ kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map repo" }), provider: "claude" };
      }
      throw transportDeath();
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["maple", "claude"]);
    const action = harness.kernel.getProjection().actions.find((item) => item.commandId === "repo-map");
    assert.equal(action.provider, "claude");
    assert.equal(action.fallbackFrom, "maple");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));

test("task.fallbackLane 'none' beats a configured env lane", () => withFallbackEnv("codex", async () => {
  const calls = [];
  const harness = makeHarness({
    taskPatch: { fallbackLane: "none" },
    inferAction: async (prompt) => {
      calls.push(prompt.fallbackProvider || "maple");
      if (prompt.fallbackProvider) {
        return { content: JSON.stringify({ kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map repo" }), provider: "codex" };
      }
      throw transportDeath();
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "completed");
    assert.equal(calls.filter((lane) => lane !== "maple").length, 0, "no fallback attempt was made");
    assert.equal(harness.events.some((event) => event.type === "action.lane.fallback"), false);
    const action = harness.kernel.getProjection().actions.find((item) => item.commandId === "repo-map");
    assert.equal(action.parseStatus, "fallback", "the deterministic plan-step fallback ran instead");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));

test("no configured lane keeps identical old behavior: bounded repairs then deterministic plan step", () => withFallbackEnv(null, async () => {
  let calls = 0;
  const harness = makeHarness({
    inferAction: async () => {
      calls += 1;
      throw transportDeath();
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "completed");
    assert.equal(calls, 3, "initial attempt plus two bounded in-lane repairs — unchanged from before");
    assert.equal(harness.events.some((event) => event.type === "action.lane.fallback"), false);
    assert.equal(harness.events.some((event) => event.type === "action.inference.fallback"), true, "the deterministic-action fallback event still records the degradation");
    const action = harness.kernel.getProjection().actions.find((item) => item.commandId === "repo-map");
    assert.equal(action.fallbackMode, "deterministic-action");
    assert.equal(action.provider, undefined, "a host deterministic action carries no model provider");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));

test("parse/envelope failures never trigger the lane fallback", () => withFallbackEnv("codex", async () => {
  const calls = [];
  const harness = makeHarness({
    inferAction: async (prompt) => {
      calls.push(prompt.fallbackProvider || "maple");
      // Returned garbage is a model parse failure, not a transport death —
      // the in-lane repair loop owns it. The second return is valid.
      if (calls.length === 1) return { content: "definitely not json" };
      return { content: JSON.stringify({ kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map repo" }) };
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "completed");
    assert.equal(calls.filter((lane) => lane !== "maple").length, 0, "no fallback attempt for a parse failure");
    assert.equal(harness.events.some((event) => event.type === "action.lane.fallback"), false);
    assert.equal(harness.events.some((event) => event.type === "action.parse.failed"), true, "the in-lane parse repair ran");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));

test("a thrown action-envelope error class also stays in-lane", () => withFallbackEnv("codex", async () => {
  const calls = [];
  const harness = makeHarness({
    inferAction: async (prompt) => {
      calls.push(prompt.fallbackProvider || "maple");
      throw Object.assign(new Error("two invalid action envelopes"), { code: "INVALID_ACTION_OUTPUT" });
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "completed", "the deterministic plan step still runs — envelope failures degrade like before");
    assert.equal(calls.filter((lane) => lane !== "maple").length, 0);
    assert.equal(harness.events.some((event) => event.type === "action.lane.fallback"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));

test("when the fallback lane also fails the task blocks naming BOTH failures", () => withFallbackEnv("codex", async () => {
  const calls = [];
  const harness = makeHarness({
    inferAction: async (prompt) => {
      calls.push(prompt.fallbackProvider || "maple");
      if (prompt.fallbackProvider) throw new Error("Codex CLI was not found. Open Settings to check installation and login.");
      throw transportDeath();
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /Maple structured-action inference failed \(transport-death: fetch failed/i, "the Maple failure is named");
    assert.match(result.reason, /fallback lane codex also failed: Codex CLI was not found/i, "the fallback-lane failure is named");
    assert.deepEqual(calls, ["maple", "codex"], "exactly one attempt per lane — the fallback is bounded");
    const fallbackEvents = harness.events.filter((event) => event.type === "action.lane.fallback");
    assert.equal(fallbackEvents.length, 1, "the fallback attempt is receipted before it runs");
    assert.equal(harness.events.some((event) => event.type === "task.blocked"), true);
    // A two-lane outage must not be papered over by a silent deterministic step.
    const action = harness.kernel.getProjection().actions.find((item) => item.commandId === "repo-map");
    assert.equal(action, undefined, "no action was fabricated after both lanes failed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));

test("a non-maple task never falls back — the selected lane owns its failures", () => withFallbackEnv("claude", async () => {
  const calls = [];
  const harness = makeHarness({
    taskPatch: { provider: "codex" },
    inferAction: async (prompt) => {
      calls.push(prompt.fallbackProvider || "codex-primary");
      throw transportDeath();
    },
  });
  try {
    const result = await approveTwoStepPlan(harness);
    assert.equal(result.status, "completed", "deterministic plan-step recovery still applies");
    assert.equal(calls.filter((lane) => lane === "claude").length, 0, "no fallback to a third lane for a CLI-lane task");
    assert.equal(harness.events.some((event) => event.type === "action.lane.fallback"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}));
