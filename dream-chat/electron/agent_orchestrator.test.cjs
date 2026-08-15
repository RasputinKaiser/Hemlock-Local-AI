const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator } = require("./agent_orchestrator.cjs");
const { ACTION_SCHEMA, createAction, parseActionEnvelope } = require("./agent_contracts.cjs");
const { createMockMapleActionSource } = require("./mock_maple.cjs");

function makeHarness({ inferAction = null, executeCommand = async (command) => ({ status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] }), commandRegistry = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-agent-loop-"));
  const task = {
    schema: "hemlock.agent.task.v1",
    id: "task-loop",
    objective: "Inspect the Hemlock project",
    intent: "inspect",
    phase: "plan",
    status: "planning",
    budget: { maxAgentSteps: 8, maxCommands: 12, maxRetriesPerOperation: 1, maxMutationSets: 1, maxTrainingCycles: 0, commandsUsed: 0, agentStepsUsed: 0 },
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
    executeCommand,
    inferAction,
  });
  return { root, kernel, orchestrator, events, get task() { return currentTask; } };
}

test("parses one allowlisted action envelope and rejects invented commands", () => {
  const valid = { schema: ACTION_SCHEMA, id: "action_test", taskId: "task_test", step: 1, kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map the repository.", expectedEvidence: ["repo://current-worktree"], approval: "none", status: "proposed" };
  assert.deepEqual(parseActionEnvelope(`Here is the action:\n\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, { "repo-map": {} }), valid);
  assert.throws(() => parseActionEnvelope(JSON.stringify({ ...valid, commandId: "rm" }), { "repo-map": {} }), /not allowlisted/i);
});

test("runs a durable multi-step loop only after plan approval", async () => {
  const harness = makeHarness();
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }, { commandId: "repo.inspect", label: "Inspect repo" }] });
    assert.equal(proposed.status, "waiting_for_approval");
    assert.equal(harness.task.status, "waiting_for_approval");
    assert.equal(harness.kernel.getProjection().actions.length, 0);
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "completed");
    const projection = harness.kernel.getProjection();
    assert.equal(projection.task.status, "completed");
    assert.equal(projection.plans[0].status, "approved");
    assert.deepEqual(projection.actions.filter((item) => item.kind === "tool").map((item) => item.commandId), ["repo-map", "repo.inspect"]);
    assert.equal(projection.observations.length, 2);
    assert.equal(projection.episodes.length, 1);
    assert.equal(projection.episodes[0].actions.length, 2);
    assert.equal(projection.episodes[0].observations.length, 2);
    const repeated = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(repeated.plan.status, "approved");
    assert.equal(harness.events.some((event) => event.type === "action.validated"), true);
    assert.equal(harness.events.some((event) => event.type === "observation.recorded"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("repairs one invalid Maple action and continues with the corrected trace", async () => {
  const valid = createAction({ taskId: "task-loop", step: 1, commandId: "repo-map", shortRationale: "Map repo" });
  const mock = createMockMapleActionSource(["not json", JSON.stringify(valid), JSON.stringify(createAction({ taskId: "task-loop", step: 2, kind: "complete", shortRationale: "The bounded inspection is complete." }))]);
  const harness = makeHarness({ inferAction: mock.inferAction });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(mock.source.calls.length, 3);
    assert.equal(harness.events.some((event) => event.type === "action.parse.failed"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("retains Maple channels and raw output reference beside the validated action", async () => {
  const action = createAction({ taskId: "task-loop", step: 1, commandId: "repo-map", shortRationale: "Map repo" });
  const complete = createAction({ taskId: "task-loop", step: 2, kind: "complete", shortRationale: "The bounded inspection is complete." });
  let calls = 0;
  const harness = makeHarness({ inferAction: async () => {
    calls += 1;
    const content = calls === 1
      ? `I will map the repository first. ${JSON.stringify(action)} This output remains inspectable.`
      : JSON.stringify(complete);
    return {
      content,
      channels: [
        { name: "content", text: content, source: "maple", visible: true },
        { name: "reasoning", text: "Checking the current evidence before selecting the registered command.", source: "maple", visible: true },
      ],
      rawOutputRef: "/tmp/hemlock-model-output.json",
    };
  } });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const stored = harness.kernel.getProjection().actions[0];
    assert.equal(stored.rawModelOutputRef, "/tmp/hemlock-model-output.json");
    assert.equal(stored.modelChannels[1].name, "reasoning");
    assert.equal(stored.parseStatus, "valid");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("gives placeholder Maple action ids a fresh host-owned identity", async () => {
  let calls = 0;
  const harness = makeHarness({ inferAction: async () => {
    calls += 1;
    if (calls > 1) return JSON.stringify(createAction({ taskId: "old-task", step: 2, kind: "complete", shortRationale: "The bounded inspection is complete." }));
    return JSON.stringify({
    schema: ACTION_SCHEMA,
    id: "action-unique",
    taskId: "old-task",
    step: 1,
    kind: "tool",
    commandId: "repo-map",
    input: {},
    shortRationale: "Map repo",
    expectedEvidence: ["repo://current-worktree"],
    approval: "none",
    status: "proposed",
    });
  } });
  // Simulate the durable collision left by a prior Maple response.
  harness.kernel.createAction({ ...createAction({ taskId: "old-task", step: 1, commandId: "repo-map", shortRationale: "Stale action" }), id: "action-unique" });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const current = harness.kernel.getProjection().actions.find((item) => item.taskId === harness.task.id);
    assert.ok(current);
    assert.notEqual(current.id, "action-unique");
    assert.equal(current.status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("falls back to the next approved artifact step when Maple action output is unavailable", async () => {
  let calls = 0;
  const harness = makeHarness({
    commandRegistry: { "artifact.author": { capability: "artifact" } },
    inferAction: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("Maple returned no structured action content.");
      return JSON.stringify(createAction({ taskId: "task-loop", step: 2, kind: "complete", shortRationale: "The artifact evidence is complete." }));
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "artifact.author", label: "Author artifact" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(harness.events.some((event) => event.type === "action.inference.fallback"), true);
    assert.equal(harness.kernel.getProjection().actions[0].commandId, "artifact.author");
    assert.equal(harness.kernel.getProjection().actions[0].status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("falls back to an evidence-backed terminal action after the approved plan is complete", async () => {
  const valid = createAction({ taskId: "task-loop", step: 1, commandId: "repo-map", shortRationale: "Map repo" });
  const mock = createMockMapleActionSource([JSON.stringify(valid), "not json", "still not json"]);
  const harness = makeHarness({ inferAction: mock.inferAction });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(harness.events.some((event) => event.type === "action.inference.fallback" && event.payload.mode === "evidence-backed-terminal-step"), true);
    assert.equal(harness.kernel.getProjection().task.status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("repairs an empty Maple action response once before continuing", async () => {
  const valid = createAction({ taskId: "task-loop", step: 1, commandId: "repo-map", shortRationale: "Map repo" });
  const complete = createAction({ taskId: "task-loop", step: 2, kind: "complete", shortRationale: "The bounded inspection is complete." });
  let calls = 0;
  const harness = makeHarness({ inferAction: async () => {
    calls += 1;
    if (calls === 1) throw new Error("Maple returned no structured action content.");
    return JSON.stringify(calls === 2 ? valid : complete);
  } });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(calls, 3);
    assert.equal(harness.events.some((event) => event.type === "action.inference.failed"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("blocks after a second invalid Maple action envelope", async () => {
  const mock = createMockMapleActionSource(["not json", "still not json"]);
  const harness = makeHarness({ inferAction: mock.inferAction });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /two invalid action envelopes/i);
    assert.equal(mock.source.calls.length, 2);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("answers and asks for user input through durable terminal states", async () => {
  const harness = makeHarness();
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ kind: "answer", label: "Answer from scoped local context" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(result.observation.status, "passed");
    assert.equal(harness.kernel.getProjection().episodes[0].observations.length, 1);
    const questionHarness = makeHarness();
    const question = questionHarness.orchestrator.askUser(questionHarness.task.id, "Which verification profile should Hemlock run?");
    assert.equal(question.status, "waiting_for_user");
    assert.equal(questionHarness.task.status, "waiting_for_approval");
    assert.equal(questionHarness.events.some((event) => event.type === "task.question"), true);
    fs.rmSync(questionHarness.root, { recursive: true, force: true });
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a retryable failure retries once, while a cancellation cannot be rewritten by a late result", async () => {
  let attempts = 0;
  const harness = makeHarness({ executeCommand: async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("temporary runtime timeout");
      error.code = "TIMEOUT";
      throw error;
    }
    return { status: "passed", summary: "Recovered", evidenceRefs: ["receipt://recovered"] };
  } });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(attempts, 2);
    assert.equal(harness.events.some((event) => event.type === "action.retry.proposed"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const cancelled = makeHarness({ executeCommand: async () => pending });
  const plan = cancelled.orchestrator.proposePlan(cancelled.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
  const running = cancelled.orchestrator.approvePlan(cancelled.task.id, plan.id);
  await new Promise((resolve) => setImmediate(resolve));
  cancelled.orchestrator.cancel(cancelled.task.id);
  release({ status: "passed", summary: "Late result", evidenceRefs: ["receipt://late"] });
  await running;
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(cancelled.kernel.getProjection().task.status, "cancelled");
  assert.equal(cancelled.kernel.getProjection().actions[0].status, "cancelled");
  fs.rmSync(cancelled.root, { recursive: true, force: true });
});
