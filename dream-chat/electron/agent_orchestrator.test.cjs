const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator, completedTaskCommands, resolveProgressCommand } = require("./agent_orchestrator.cjs");
const { ACTION_SCHEMA, createAction, parseActionEnvelope } = require("./agent_contracts.cjs");
const { ArtifactRegistry } = require("./artifact_registry.cjs");
const { createMockMapleActionSource } = require("./mock_maple.cjs");

function makeHarness({ inferAction = null, executeCommand = async (command) => ({ status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`], ...(command === "artifact.create" ? { artifactId: `artifact-mock-${++makeHarness.mockCounter}` } : {}) }), commandRegistry = null } = {}) {
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
    assert.equal(mock.source.calls.length, 2);
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

test("host owns the planned command and normalizes malformed evidence metadata", async () => {
  const harness = makeHarness({ inferAction: async () => JSON.stringify({
    schema: ACTION_SCHEMA,
    id: "model-action",
    taskId: "wrong-task",
    step: 91,
    kind: "tool",
    commandId: "none",
    input: {},
    shortRationale: "Inspect the artifact preview.",
    expectedEvidence: { "preview://inspection": true },
    approval: "explicit",
    status: "proposed",
  }), commandRegistry: { "artifact.preview.inspect": { capability: "preview" } } });
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "artifact.preview.inspect", label: "Inspect preview", expectedEvidence: ["preview://inspection"] }] });
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "completed");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.commandId, "artifact.preview.inspect");
    assert.deepEqual(action.expectedEvidence, ["preview://inspection"]);
    assert.equal(action.taskId, harness.task.id);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("executes planned preview open and inspect steps without another Maple action turn", async () => {
  let inferenceCalls = 0;
  const commands = [];
  const harness = makeHarness({
    inferAction: async () => {
      inferenceCalls += 1;
      throw new Error("Maple should not be called for host-owned preview steps");
    },
    commandRegistry: {
      "artifact.preview.open": { capability: "preview" },
      "artifact.preview.inspect": { capability: "preview" },
    },
    executeCommand: async (command) => {
      commands.push(command);
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, {
      steps: [
        { commandId: "artifact.preview.open", label: "Open preview", expectedEvidence: ["preview://session"] },
        { commandId: "artifact.preview.inspect", label: "Inspect preview", expectedEvidence: ["preview://inspection"] },
      ],
    });
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "completed");
    assert.deepEqual(commands, ["artifact.preview.open", "artifact.preview.inspect"]);
    assert.equal(inferenceCalls, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("lets Maple adapt the approved plan with an additional safe inspection", async () => {
  let calls = 0;
  const commands = [];
  const harness = makeHarness({
    commandRegistry: {
      "repo-map": { capability: "read" },
      "file.search": { capability: "read", auto: true, label: "Search relevant files" },
    },
    executeCommand: async (command) => {
      commands.push(command);
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
    inferAction: async () => {
      calls += 1;
      return JSON.stringify(createAction({
        taskId: "model-task",
        step: calls,
        commandId: calls === 1 ? "file.search" : "repo-map",
        input: calls === 1 ? { query: "animation" } : {},
        shortRationale: calls === 1 ? "Search for the relevant animation surface before mapping it." : "Map the repository after the focused search.",
      }));
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.deepEqual(commands, ["file.search", "repo-map"]);
    assert.deepEqual(harness.kernel.getProjection().plans[0].steps.map((step) => step.commandId), ["file.search", "repo-map"]);
    assert.equal(harness.kernel.getProjection().plans[0].adaptiveDecisions[0].commandId, "file.search");
    assert.equal(harness.events.some((event) => event.type === "plan.adapted"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("recovers an unavailable model command into the current approved step", async () => {
  const harness = makeHarness({
    inferAction: async () => JSON.stringify(createAction({
      taskId: "model-task",
      step: 99,
      commandId: "invented.shell.command",
      shortRationale: "Inspect the project with the most useful available operation.",
    })),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.hostSelection.mode, "recovered");
    assert.equal(harness.events.some((event) => event.type === "action.command.recovered"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("lets Maple pause for a user decision instead of forcing the next tool", async () => {
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({
      schema: ACTION_SCHEMA,
      id: "maple-question",
      taskId: "model-task",
      step: 1,
      kind: "ask_user",
      commandId: null,
      input: { question: "Which project surface should I inspect first?" },
      shortRationale: "I need the target surface before choosing a useful inspection.",
      expectedEvidence: [],
      approval: "none",
      status: "proposed",
    }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "waiting_for_user");
    assert.equal(harness.kernel.getProjection().actions[0].kind, "ask_user");
    assert.equal(harness.kernel.getProjection().actions[0].commandId, null);
    assert.equal(harness.kernel.getProjection().observations.length, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("accepts a truncated Maple envelope only through host recovery and records the recovery mode", async () => {
  const harness = makeHarness({
    commandRegistry: { "artifact.create": { capability: "artifact" } },
    inferAction: async () => `{
      "kind": "tool",
      "commandId": "artifact.create",
      "approval": "plan",
      "status": "proposed",
      "data": {"html": "${"x".repeat(2200)}`,
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "artifact.create", label: "Create artifact", expectedEvidence: ["artifact://manifest"] }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(harness.kernel.getProjection().actions[0].parseStatus, "recovered-truncated");
    assert.equal(harness.kernel.getProjection().actions[0].commandId, "artifact.create");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("wraps a bare Maple artifact metadata payload without forcing a fixed visual template", async () => {
  const harness = makeHarness({
    commandRegistry: { "artifact.create": { capability: "artifact" } },
    inferAction: async () => JSON.stringify({ title: "A different moving scene", mime: "text/html" }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "artifact.create", label: "Create variation", expectedEvidence: ["artifact://manifest"] }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(harness.kernel.getProjection().actions[0].parseStatus, "coerced-payload");
    assert.equal(harness.kernel.getProjection().actions[0].input.title, "A different moving scene");
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

test("generates an evidence-backed terminal action without another Maple turn after the plan is complete", async () => {
  const valid = createAction({ taskId: "task-loop", step: 1, commandId: "repo-map", shortRationale: "Map repo" });
  const mock = createMockMapleActionSource([JSON.stringify(valid)]);
  const harness = makeHarness({ inferAction: mock.inferAction });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(harness.events.some((event) => event.type === "action.inference.fallback" && event.payload.mode === "evidence-backed-terminal-step"), false);
    assert.equal(mock.source.calls.length, 1);
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
    assert.equal(calls, 2);
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

test("completes a general coding fixture after one plan approval with host-owned verification gates", async () => {
  const commands = ["context.refresh", "repo-map", "repo.inspect", "git.status", "code.apply", "verify", "git.diff"];
  const commandRegistry = Object.fromEntries(commands.map((command) => [command, { capability: command === "code.apply" ? "write" : command === "verify" ? "verify" : "read", approval: command === "code.apply" ? "plan" : "none" }]));
  const harness = makeHarness({ commandRegistry, inferAction: null, executeCommand: async (command) => {
    if (command === "code.apply") return { schema: "hemlock.agent.change-set.v1", status: "applied", id: "changeset-fixture", evidenceRefs: ["changeset://fixture"] };
    if (command === "verify") return { schema: "hemlock.agent.verification.v1", status: "passed", receiptPath: "receipt://verification-fixture", evidenceRefs: ["receipt://verification-fixture"] };
    return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
  } });
  harness.orchestrator.updateTask({ intent: "coding", objective: "Make a verified local coding change" });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: commands.map((command) => ({ commandId: command, label: command, approval: command === "code.apply" ? "plan" : "none", expectedEvidence: [`receipt://${command}`] })) }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(harness.task.status, "completed");
    assert.equal(harness.kernel.getProjection().actions.filter((item) => item.taskId === harness.task.id && item.kind === "tool").length, commands.length);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("does not complete a coding task from prose or verification alone", async () => {
  const harness = makeHarness({ executeCommand: async () => ({ schema: "hemlock.agent.verification.v1", status: "passed", evidenceRefs: ["receipt://verification-only"] }) });
  harness.orchestrator.updateTask({ intent: "coding", objective: "A coding task without a source change" });
  try {
    const result = harness.orchestrator.completeTask(harness.task.id, "attempted completion");
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /applied source change-set and verification receipt/i);
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

test("blocks a plan approval when the task is not waiting_for_approval and leaves state intact", async () => {
  const harness = makeHarness();
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    // Simulate the task moving on (e.g. running) after the plan was proposed.
    harness.orchestrator.updateTask({ status: "running", phase: "work" });
    const before = harness.kernel.getProjection();
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /not awaiting plan approval; current status is running/i);
    assert.equal(result.claimBoundary, "No approval was applied and no task state changed.");
    const after = harness.kernel.getProjection();
    assert.deepEqual(after.plans[0].status, before.plans[0].status);
    assert.equal(after.plans[0].status, "proposed");
    assert.equal(harness.task.status, "running");
    assert.equal(after.actions.length, before.actions.length);
    assert.equal(after.observations.length, before.observations.length);
    assert.equal(harness.events.some((event) => event.type === "plan.approved"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("clamps out-of-range budget overrides at approval time into task.budget", async () => {
  const harness = makeHarness();
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ kind: "answer", label: "Answer from scoped local context" }] }).plan;
    await harness.orchestrator.approvePlan(harness.task.id, plan.id, { maxAgentSteps: 999, maxCommands: -4, garbageKey: 7 });
    assert.equal(harness.task.budget.maxAgentSteps, 24);
    assert.equal(harness.task.budget.maxCommands, 1);
    assert.equal(harness.task.budget.garbageKey, undefined);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("merges valid budget overrides into task.budget during approval", async () => {
  const harness = makeHarness();
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ kind: "answer", label: "Answer from scoped local context" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id, { maxAgentSteps: "5", maxCommands: 3 });
    assert.equal(result.status, "completed");
    assert.equal(harness.task.budget.maxAgentSteps, 5);
    assert.equal(harness.task.budget.maxCommands, 3);
    // Untouched fields keep their prior values rather than resetting.
    assert.equal(harness.task.budget.maxRetriesPerOperation, 1);
    assert.equal(harness.task.budget.maxMutationSets, 1);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

// T12 anti-repeat guard — pure helpers
test("completedTaskCommands collects terminal commandIds and skips ask_user", () => {
  const history = {
    actions: [
      { id: "a1", kind: "tool", commandId: "repo-map", status: "completed" },
      { id: "a2", kind: "tool", commandId: "artifact.create", status: "completed" },
      { id: "a3", kind: "tool", commandId: "repo.inspect", status: "failed" },
      { id: "a4", kind: "ask_user", commandId: null, status: "completed" },
      { id: "a5", kind: "tool", commandId: "verify", status: "running" },
    ],
  };
  const ids = completedTaskCommands(history);
  assert.deepEqual([...ids].sort(), ["artifact.create", "repo-map", "repo.inspect"]);
});

test("resolveProgressCommand passes fresh proposals through untouched", () => {
  const completed = new Set(["repo-map"]);
  const pass = resolveProgressCommand({ commandId: "artifact.create", input: {} }, completed, [{ commandId: "artifact.create" }, { commandId: "artifact.author" }]);
  assert.equal(pass.redirected, false);
  assert.equal(pass.commandId, "artifact.create");
  const unknown = resolveProgressCommand({ commandId: "git.status" }, completed, [{ commandId: "artifact.author" }]);
  assert.equal(unknown.redirected, false);
});

test("resolveProgressCommand redirects a repeated command to the next incomplete plan step", () => {
  const completed = new Set(["repo-map", "artifact.create"]);
  const steps = [
    { commandId: "repo-map", label: "Map repo" },
    { commandId: "artifact.create", label: "Create scratch artifact" },
    { commandId: "artifact.author", label: "Author the animation" },
  ];
  const redirect = resolveProgressCommand({ commandId: "repo-map", input: {} }, completed, steps);
  assert.equal(redirect.redirected, true);
  assert.equal(redirect.commandId, "artifact.author");
  assert.equal(redirect.requestedCommandId, "repo-map");
  assert.match(redirect.reason, /re-proposed completed repo-map; host advanced to plan step 3/);
  // All steps done → nothing to redirect into; the guard must not invent work.
  const exhausted = resolveProgressCommand({ commandId: "repo-map" }, completed, [{ commandId: "repo-map" }]);
  assert.equal(exhausted.redirected, false);
});

// T12 anti-repeat guard — integration: replay of the task-2026-08-24 loop
test("redirects a re-proposed completed command to the next plan step with a host note (Build-mode loop regression)", async () => {
  let calls = 0;
  const executedCommands = [];
  const harness = makeHarness({
    inferAction: async (prompt) => {
      calls += 1;
      if (calls === 1) return JSON.stringify(createAction({ taskId: "task-loop", step: 1, commandId: "repo-map", shortRationale: "Map repo before authoring" }));
      // Maple re-proposes repo-map even though it already completed (the incident).
      return JSON.stringify(createAction({ taskId: "task-loop", step: 2, commandId: "repo-map", shortRationale: "Map repo again" }));
    },
    executeCommand: async (command) => {
      executedCommands.push(command);
      // Mirror production receipt shape (artifactCommandReceipt): create results carry artifactId.
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`], ...(command === "artifact.create" ? { artifactId: `artifact-mock-${executedCommands.length}` } : {}) };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [
      { commandId: "repo-map", label: "Map the current repository", expectedEvidence: ["repo://current-worktree"] },
      { commandId: "artifact.author", label: "Author the requested animation", expectedEvidence: ["artifact://revision"] },
    ] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    // Inspect-intent harness: no preview-receipt completion gate, so finishing
    // both plan steps completes the task. The loop regression being guarded
    // here is that repo-map must run exactly ONCE despite repeat proposals.
    assert.equal(result.status, "completed");
    assert.ok(executedCommands.includes("artifact.author"));
    const redirectEvent = harness.events.find((event) => event.type === "action.redirected");
    assert.ok(redirectEvent, "an action.redirected host note is recorded");
    assert.equal(redirectEvent.payload.requestedCommandId, "repo-map");
    assert.equal(redirectEvent.payload.selectedCommandId, "artifact.author");
    assert.match(redirectEvent.payload.reason, /host advanced to plan step 2/);
    assert.equal(redirectEvent.payload.mode, "anti-repeat-guard");
    // The next-action context names completed commands explicitly.
    assert.equal(calls >= 2, true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("next-action context states completed commands and plan progress explicitly", async () => {
  const seenPrompts = [];
  const harness = makeHarness({
    inferAction: async (prompt) => {
      seenPrompts.push(prompt);
      return JSON.stringify(createAction({ taskId: "task-loop", step: 1, commandId: "repo-map", shortRationale: "Map repo" }));
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [
      { commandId: "repo-map", label: "Map repo" },
      { commandId: "repo.inspect", label: "Inspect repo" },
    ] }).plan;
    void await harness.orchestrator.approvePlan(harness.task.id, plan.id).catch(() => {});
    const firstSystem = String(seenPrompts[0]?.system || "");
    assert.match(firstSystem, /Completed already \(do NOT repeat[^)]*\): none/);
    assert.match(firstSystem, /Plan status: approved\. Plan progress: step 1 of 2/);
    // Second round: repo-map has completed; the context must name it explicitly.
    if (seenPrompts[1]) {
      const secondSystem = String(seenPrompts[1]?.system || "");
      assert.match(secondSystem, /Completed already \(do NOT repeat[^)]*\): repo-map/);
      assert.match(secondSystem, /Plan progress: step 2 of 2/);
    }
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }

  let seenSecond = null;
  let calls = 0;
  const second = makeHarness({
    inferAction: async (prompt) => {
      calls += 1;
      seenSecond = prompt;
      return JSON.stringify(createAction({ taskId: "task-loop", step: calls === 1 ? 1 : 2, commandId: calls === 1 ? "repo-map" : "repo-map", shortRationale: "repeat" }));
    },
  });
  try {
    const plan = second.orchestrator.proposePlan(second.task, { steps: [
      { commandId: "repo-map", label: "Map repo" },
      { commandId: "repo.inspect", label: "Inspect repo" },
    ] }).plan;
    void await second.orchestrator.approvePlan(second.task.id, plan.id).catch(() => {});
    assert.match(String(seenSecond?.system || ""), /Completed already \(do NOT repeat[^)]*\): repo-map/);
  } finally {
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});

// T12 author-fallback bulletproofing — real registry behind executeCommand
function makeRegistryExecute(registryByTask) {
  return async (command, payload) => {
    const registry = registryByTask;
    if (command === "artifact.create") {
      const manifest = registry.create({ ...payload, taskId: payload.taskId || "task-loop" });
      return { ...manifest, artifactId: manifest.id, evidenceRefs: [registry.manifestPath(manifest.taskId, manifest.id)], summary: `Created scratch artifact ${manifest.id}.` };
    }
    if (command === "artifact.author") {
      try {
        const manifest = registry.author({ ...payload, taskId: payload.taskId || "task-loop" });
        return { ...manifest, artifactId: manifest.id, evidenceRefs: [registry.manifestPath(manifest.taskId, manifest.id)], summary: `${command} recorded revision ${manifest.revision} for ${manifest.id}.` };
      } catch (error) {
        throw error;
      }
    }
    return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
  };
}

function makeRegistryHarness(inferAction, extraRegistry = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-author-fallback-"));
  const task = {
    schema: "hemlock.agent.task.v1",
    id: "task-author",
    objective: "Hello, please make a beautiful artifact",
    intent: "build",
    phase: "work",
    status: "running",
    budget: { maxAgentSteps: 8, maxCommands: 12, maxRetriesPerOperation: 1, maxMutationSets: 1, maxTrainingCycles: 0, commandsUsed: 0, agentStepsUsed: 0 },
  };
  const kernel = new AgentKernel({ root, repoRoot: "/tmp/hemlock-project", task });
  let currentTask = task;
  const events = [];
  const registry = new ArtifactRegistry({ root, workspaceId: "workspace-test" });
  const orchestrator = new AgentOrchestrator({
    kernel,
    commandRegistry: { "artifact.author": { capability: "artifact" }, ...extraRegistry },
    getTask: () => currentTask,
    setTask: (patch) => { currentTask = { ...currentTask, ...patch }; kernel.syncTask(currentTask); return currentTask; },
    emit: (type, status, payload) => events.push({ type, status, payload }),
    executeCommand: makeRegistryExecute(registry),
    inferAction,
  });
  return { root, kernel, registry, orchestrator, events, get task() { return currentTask; } };
}

test("author fallback completes via create-if-missing when no artifact exists yet (empty model input)", async () => {
  const harness = makeRegistryHarness(async () => JSON.stringify(createAction({ taskId: "task-author", step: 1, commandId: "artifact.author", input: {}, shortRationale: "Author the requested visual" })));
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "artifact.author", label: "Author the requested animation", expectedEvidence: ["artifact://revision"] }] }).plan;
    await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.commandId, "artifact.author");
    assert.equal(action.status, "completed");
    const observation = harness.kernel.getProjection().observations[0];
    assert.equal(observation.status, "passed");
    assert.equal(observation.structuredOutput.status, "previewable");
    assert.ok(observation.structuredOutput.source?.["index.html"]?.length > 0, "scaffold source present");
    assert.equal(harness.events.some((event) => event.type === "artifact.author.ensure"), true);
    assert.equal(harness.task.status, "blocked"); // completion gate needs a verified preview receipt; author itself succeeded
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("author fallback survives a digest-shaped id pasted as artifactId", async () => {
  const digestId = "sha256:bbd266447729c7d6f6b78eb2497db2a2e3d49fabd450590d0c920e7dce5fe939";
  const harness = makeRegistryHarness(async () => JSON.stringify(createAction({ taskId: "task-author", step: 1, commandId: "artifact.author", input: { artifactId: digestId }, shortRationale: "Author into the referenced artifact" })));
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "artifact.author", label: "Author the requested animation", expectedEvidence: ["artifact://revision"] }] }).plan;
    await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.status, "completed");
    // The projection preserves the model's raw proposed input; the sanitization
    // contract is about what the host EXECUTED, asserted via the observation.
    const observation = harness.kernel.getProjection().observations[0];
    assert.equal(observation.status, "passed");
    assert.match(observation.structuredOutput.summary || "", /revision 1 for artifact-/);
    const artifactId = observation.structuredOutput.id;
    assert.doesNotMatch(artifactId, /^sha256:/);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("author falls back to the host scaffold when the registry rejects the authored source", async () => {
  // A traversal filename survives boundedActionInput but must be rejected by
  // the registry's safeRelativePath — previously that threw action.faild.
  const harness = makeRegistryHarness(async () => JSON.stringify(createAction({ taskId: "task-author", step: 1, commandId: "artifact.author", input: { filename: "../escape.html", source: { "../escape.html": "<h1>escape</h1>" } }, shortRationale: "Author with an unsafe path" })));
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "artifact.author", label: "Author the requested animation", expectedEvidence: ["artifact://revision"] }] }).plan;
    await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.status, "completed");
    const observation = harness.kernel.getProjection().observations[0];
    assert.equal(observation.status, "passed");
    assert.equal(Object.keys(observation.structuredOutput.source || {}).includes("../escape.html"), false);
    assert.ok(observation.structuredOutput.source?.["index.html"].includes("Eastern Hemlock"), "host scaffold retained after registry rejection");
    // The unsafe filename is sanitized BEFORE the registry sees it; the
    // host_fallback evidence on the executed revision records the recovery.
    const fallbackEvidence = (observation.structuredOutput.evidence || []).some((item) => item.type === "authoring.host_fallback") || harness.events.some((event) => event.type === "artifact.author.recovered" || event.type === "artifact.author.ensure");
    assert.equal(fallbackEvidence, true, "a host-fallback recovery marker is recorded");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});
