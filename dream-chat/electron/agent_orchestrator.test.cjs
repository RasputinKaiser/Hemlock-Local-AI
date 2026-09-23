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

function makeHarness({ inferAction = null, scoreActions = null, buildCandidates = null, executeCommand = async (command) => ({ status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`], ...(command === "artifact.create" ? { artifactId: `artifact-mock-${++makeHarness.mockCounter}` } : {}) }), commandRegistry = null } = {}) {
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
    scoreActions,
    buildCandidates,
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

test("accepts a T13 compact choice as a first-class action and records compact-choice parse status", async () => {
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({ kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map the repo first." }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.parseStatus, "compact-choice");
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.schema, ACTION_SCHEMA);
    assert.equal(action.status, "completed");
    // Host-owned fields stay host-owned even when the model omits them.
    assert.equal(action.taskId, "task-loop");
    assert.equal(action.approval, "none");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a compact choice missing shortRationale still validates — the host owns narration", async () => {
  // Live Maple output: {"kind":"tool","commandId":"artifact.author","input":{}}
  // — no shortRationale. That must not burn a repair inference.
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.parseStatus, "compact-choice");
    assert.equal(action.commandId, "repo-map");
    assert.ok(action.shortRationale.trim().length > 0);
    assert.equal(harness.events.filter((e) => e.type === "action.parse.failed").length, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("accepts a compact terminal choice with no commandId", async () => {
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({ kind: "answer", shortRationale: "The objective is already answerable." }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.kind, "answer");
    assert.equal(action.commandId, null);
    assert.equal(action.parseStatus, "compact-choice");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("takes the first well-formed choice from a choices array instead of degrading", async () => {
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({ choices: [
      { kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map first." },
      { kind: "tool", commandId: "git.status", input: {}, shortRationale: "Then status." },
    ] }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.parseStatus, "compact-choice");
    assert.equal(action.commandId, "repo-map");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("falls back to the next approved artifact step when Maple action output is unavailable", async () => {
  let calls = 0;
  const harness = makeHarness({
    commandRegistry: { "artifact.author": { capability: "artifact" } },
    // All bounded repairs fail too (1 initial + 2 repair inferences), so the
    // host recovers into the approved plan step instead of dead-ending.
    inferAction: async () => {
      calls += 1;
      throw new Error("Maple returned no structured action content.");
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

test("recovers into the approved plan after repeated invalid Maple action envelopes", async () => {
  // 1 initial + 2 bounded repair inferences all return garbage; the host then
  // falls back to the approved plan step rather than dead-ending the task.
  const mock = createMockMapleActionSource(["not json", "still not json", "still invalid"]);
  const harness = makeHarness({ inferAction: mock.inferAction });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(mock.source.calls.length, 3);
    assert.equal(harness.events.some((event) => event.type === "action.inference.fallback"), true);
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.status, "completed");
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
    assert.equal(harness.task.budget.maxAgentSteps, 64);
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
  const pass = resolveProgressCommand({ commandId: "artifact.create", input: {} }, completed, new Set(), [{ commandId: "artifact.create" }, { commandId: "artifact.author" }]);
  assert.equal(pass.redirected, false);
  assert.equal(pass.commandId, "artifact.create");
  const unknown = resolveProgressCommand({ commandId: "git.status" }, completed, new Set(), [{ commandId: "artifact.author" }]);
  assert.equal(unknown.redirected, false);
});

test("resolveProgressCommand redirects a repeated command to the next incomplete plan step", () => {
  const completed = new Set(["repo-map", "artifact.create"]);
  const work = new Set(["repo-map::{}", "artifact.create::{}"]);
  const steps = [
    { commandId: "repo-map", label: "Map repo" },
    { commandId: "artifact.create", label: "Create scratch artifact" },
    { commandId: "artifact.author", label: "Author the animation" },
  ];
  const redirect = resolveProgressCommand({ commandId: "repo-map", input: {} }, completed, work, steps);
  assert.equal(redirect.redirected, true);
  assert.equal(redirect.commandId, "artifact.author");
  assert.equal(redirect.requestedCommandId, "repo-map");
  assert.match(redirect.reason, /re-proposed completed repo-map; host advanced to plan step 3/);
  // All steps done → nothing to redirect into; the guard must not invent work.
  const exhausted = resolveProgressCommand({ commandId: "repo-map" }, completed, work, [{ commandId: "repo-map" }]);
  assert.equal(exhausted.redirected, false);
});

test("parameterized commands repeat only on identical input — experiment sweeps are real work", () => {
  const completed = new Set(["experiment.run", "experiment.note"]);
  const work = new Set([
    'experiment.run::{"experiment":"pendulum","input":{"length":1}}',
    'experiment.note::{"claim":"matched theory"}',
  ]);
  const steps = [
    { commandId: "experiment.run", label: "Run experiment" },
    { commandId: "experiment.note", label: "Record finding" },
    { commandId: "verify", label: "Verify" },
  ];
  // Identical pendulum run → repeat → redirect to the next incomplete step.
  const repeat = resolveProgressCommand({ commandId: "experiment.run", input: { experiment: "pendulum", input: { length: 1 } } }, completed, work, steps);
  assert.equal(repeat.redirected, true);
  assert.equal(repeat.commandId, "verify");
  // Different parameter → new work, passes through.
  const sweep = resolveProgressCommand({ commandId: "experiment.run", input: { experiment: "pendulum", input: { length: 2 } } }, completed, work, steps);
  assert.equal(sweep.redirected, false);
  assert.equal(sweep.commandId, "experiment.run");
  // A non-parameterized command repeats on commandId alone, whatever the input.
  const junkEvade = resolveProgressCommand({ commandId: "repo-map", input: { junk: "evade" } }, new Set(["repo-map"]), work, steps);
  assert.equal(junkEvade.redirected, true);
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
    // T13: volatile progress moved out of the static (cacheable) system prompt
    // into prompt.progress, which is serialized into the request body.
    const firstProgress = seenPrompts[0]?.progress || {};
    assert.deepEqual(firstProgress.completedCommands, []);
    assert.equal(firstProgress.planProgress, "step 1 of 2");
    // Second round: repo-map has completed; the context must name it explicitly.
    if (seenPrompts[1]) {
      assert.deepEqual(seenPrompts[1].progress?.completedCommands, ["repo-map"]);
      assert.equal(seenPrompts[1].progress?.planProgress, "step 2 of 2");
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
    assert.deepEqual(seenSecond?.progress?.completedCommands, ["repo-map"]);
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

test("scored-choice picks a complete envelope without a generative call", async () => {
  // Parallel constrained decoding: /v1/score ranks the enumerated candidate
  // envelopes; a `complete` winner is executed with zero generated tokens.
  const { buildScoreCandidates } = require("./agent_contracts.cjs");
  let generated = 0;
  const candidates = buildScoreCandidates(["repo-map", "repo.inspect", "experiment.run"]);
  const winnerIndex = candidates.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete);
  const harness = makeHarness({
    inferAction: async () => { generated += 1; return JSON.stringify({ kind: "tool", commandId: "repo.inspect", input: {} }); },
    scoreActions: async (_prompt, texts) => ({
      candidates: texts.map((text, index) => ({
        index,
        text,
        logprob: index === winnerIndex ? -5 : -40,
        avgLogprob: index === winnerIndex ? -0.5 : -4,
        tokens: 20,
      })),
      promptTokens: 100,
      cachedTokens: 80,
    }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(generated, 0, "scored winner executes without a generative turn");
    const scored = harness.events.find((event) => event.type === "action.scored");
    assert.ok(scored, "action.scored telemetry recorded");
    assert.equal(scored.payload.winner.commandId, "repo-map");
    assert.equal(scored.payload.complete, true);
    const action = harness.kernel.getProjection().actions.find((item) => item.kind === "tool");
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a generative (prefix) scored winner falls through to generation with the decision recorded", async () => {
  const { buildScoreCandidates } = require("./agent_contracts.cjs");
  const candidates = buildScoreCandidates(["repo-map", "artifact.author"]);
  const winnerIndex = candidates.findIndex((candidate) => candidate.commandId === "artifact.author");
  assert.equal(candidates[winnerIndex].complete, false, "artifact.author is a generative prefix candidate");
  let generated = 0;
  const harness = makeHarness({
    commandRegistry: { "repo-map": { capability: "read" }, "artifact.author": { capability: "artifact", auto: true } },
    inferAction: async (prompt) => {
      generated += 1;
      assert.equal(prompt.progress?.scoredDecision?.commandId, "artifact.author", "scored decision is visible to the generative fill-in");
      return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} });
    },
    scoreActions: async (_prompt, texts) => ({
      candidates: texts.map((text, index) => ({
        index,
        text,
        logprob: index === winnerIndex ? -5 : -40,
        avgLogprob: index === winnerIndex ? -0.5 : -4,
        tokens: 12,
      })),
    }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(generated, 1, "prefix winner still uses the generative path");
    assert.equal(harness.events.find((event) => event.type === "action.scored")?.payload?.winner?.commandId, "artifact.author");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("scoring failure degrades quietly to the generative path", async () => {
  let generated = 0;
  const harness = makeHarness({
    inferAction: async () => { generated += 1; return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} }); },
    scoreActions: async () => { throw new Error("ECONNREFUSED"); },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(generated, 1);
    const degraded = harness.events.find((event) => event.type === "action.scored" && event.status === "degraded");
    assert.ok(degraded, "scoring failure is recorded, not hidden");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("buildScoreCandidates enumerates experiment kinds and verify profiles", () => {
  const { buildScoreCandidates, pickScoredCandidate } = require("./agent_contracts.cjs");
  const candidates = buildScoreCandidates(["repo-map", "experiment.run", "verify", "artifact.author"]);
  const kinds = candidates.filter((candidate) => candidate.commandId === "experiment.run").map((candidate) => candidate.input?.experiment);
  assert.deepEqual(kinds.sort(), ["collision", "orbit", "pendulum", "projectile", "spring", "terminal"]);
  const profiles = candidates.filter((candidate) => candidate.commandId === "verify").map((candidate) => candidate.input?.profile);
  assert.deepEqual(profiles.sort(), ["app-build", "diff-check", "python-tests"]);
  assert.equal(candidates.find((candidate) => candidate.commandId === "artifact.author").complete, false);
  assert.equal(candidates.find((candidate) => candidate.commandId === "repo-map").complete, true);
  for (const candidate of candidates.filter((item) => item.complete)) {
    assert.doesNotThrow(() => JSON.parse(candidate.text), `complete candidate is valid JSON: ${candidate.text}`);
  }
  const winnerIndex = candidates.findIndex((candidate) => candidate.input?.experiment === "pendulum");
  const decision = pickScoredCandidate(candidates, {
    candidates: candidates.map((candidate, index) => ({ index, text: candidate.text, logprob: index === winnerIndex ? -10 : -60, avgLogprob: index === winnerIndex ? -0.4 : -3, tokens: 25 })),
    promptTokens: 200,
    cachedTokens: 150,
  });
  assert.equal(decision.winner.commandId, "experiment.run");
  assert.equal(decision.winner.input.experiment, "pendulum");
  assert.equal(decision.cachedTokens, 150);
});

test("pause parks the loop at a step boundary and resume completes the plan", async () => {
  const executed = [];
  const harness = makeHarness({
    executeCommand: async (command) => {
      executed.push(command);
      if (executed.length === 1) harness.orchestrator.pauseTask(harness.task.id);
      return { status: "passed", summary: `${command} ok`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map" }, { commandId: "repo.inspect", label: "Inspect" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "paused", "the loop parks instead of running the next step");
    assert.deepEqual(executed, ["repo-map"], "the in-flight step finished and recorded its receipt");
    assert.equal(harness.task.status, "paused");
    assert.equal(harness.events.some((event) => event.type === "task.paused"), true);

    const resumed = await harness.orchestrator.resumeTask(harness.task.id);
    assert.equal(resumed.status, "completed");
    assert.deepEqual(executed, ["repo-map", "repo.inspect"]);
    assert.equal(harness.events.some((event) => event.type === "task.resumed"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a paused task stays parked until resumed, with a single paused event", async () => {
  const harness = makeHarness();
  try {
    harness.orchestrator.pauseTask(harness.task.id);
    harness.orchestrator.pauseTask(harness.task.id);
    assert.equal(harness.task.status, "paused");
    assert.equal(harness.events.filter((event) => event.type === "task.paused").length, 1, "repeat pause is idempotent");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("guided autonomy opens sandboxed explicit commands to adaptive selection", () => {
  const registry = {
    "repo-map": { capability: "read", auto: true },
    "artifact.author": { capability: "artifact", auto: false, approval: "explicit" },
    "dream": { capability: "train", auto: false, approval: "explicit" },
  };
  const harness = makeHarness({ commandRegistry: registry });
  try {
    const plan = { steps: [{ commandId: "repo-map" }] };
    const history = { actions: [] };
    const ids = (level) => {
      harness.orchestrator.updateTask({ autonomy: level });
      return harness.orchestrator.allowedNextCommands(harness.task, plan, history).map((entry) => entry.commandId);
    };
    assert.equal(ids("bounded-local").includes("artifact.author"), false, "supervised keeps explicit commands out");
    const guided = ids("guided");
    assert.equal(guided.includes("artifact.author"), true, "guided opens sandboxed artifact commands");
    assert.equal(guided.includes("dream"), false, "guided keeps training explicit");
    const autonomous = ids("autonomous");
    assert.equal(autonomous.includes("artifact.author"), true);
    assert.equal(autonomous.includes("dream"), false, "autonomous still keeps train explicit");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a guided task runs an adaptively-selected explicit sandboxed action; supervised blocks it", async () => {
  const registry = {
    "repo-map": { capability: "read", auto: true },
    "artifact.preview.stop": { capability: "preview", auto: false, approval: "explicit" },
  };
  const executed = [];
  const harness = makeHarness({
    commandRegistry: registry,
    inferAction: async () => JSON.stringify({ kind: "tool", commandId: "artifact.preview.stop", input: {} }),
    executeCommand: async (command) => { executed.push(command); return { status: "passed", summary: `${command} ok`, evidenceRefs: [`receipt://${command}`] }; },
  });
  try {
    harness.orchestrator.updateTask({ autonomy: "guided" });
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.ok(executed.includes("artifact.preview.stop"), "guided task executed the explicit command without parking");
    assert.equal(harness.events.some((event) => event.type === "task.blocked"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }

  const supervisedRun = [];
  const supervised = makeHarness({
    commandRegistry: registry,
    inferAction: async () => JSON.stringify({ kind: "tool", commandId: "artifact.preview.stop", input: {} }),
    executeCommand: async (command) => { supervisedRun.push(command); return { status: "passed", summary: `${command} ok`, evidenceRefs: [`receipt://${command}`] }; },
  });
  try {
    const plan = supervised.orchestrator.proposePlan(supervised.task, { steps: [{ commandId: "repo-map", label: "Map" }] }).plan;
    await supervised.orchestrator.approvePlan(supervised.task.id, plan.id);
    assert.equal(supervisedRun.includes("artifact.preview.stop"), false, "supervised task never executes an unapproved explicit command");
  } finally {
    fs.rmSync(supervised.root, { recursive: true, force: true });
  }
});

test("continuous KV session replays prior steps verbatim and delta-slices history", async () => {
  // Each step's request/response is recorded as a chat turn so the next
  // rendered prompt is a strict token-prefix extension of the server's
  // committed prompt cache — only the trailing delta prefills.
  const prompts = [];
  const harness = makeHarness({
    commandRegistry: { "repo-map": { capability: "read" }, "repo.inspect": { capability: "read" }, "git.status": { capability: "read" } },
    inferAction: async (prompt) => {
      prompts.push(prompt);
      const step = prompts.length;
      const content = JSON.stringify({ kind: "tool", commandId: ["repo-map", "repo.inspect", "git.status"][step - 1], input: {} });
      return { content, requestContent: `request-${step}`, cachedTokens: 10, reasoning: "" };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, {
      steps: [{ commandId: "repo-map", label: "Map" }, { commandId: "repo.inspect", label: "Inspect" }, { commandId: "git.status", label: "Status" }],
    }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 3, "one model turn per planned step");
    assert.equal(prompts[0].sessionTurns.length, 0, "first step starts cold");
    assert.deepEqual(
      prompts[1].sessionTurns.map((turn) => turn.role),
      ["user", "assistant"],
      "second step replays step one's exchange verbatim",
    );
    assert.equal(prompts[1].sessionTurns[0].content, "request-1");
    assert.ok(prompts[1].sessionTurns[1].content.startsWith("<think>\n"), "reasoning-free output replays inside the forced think block");
    assert.equal(prompts[2].sessionTurns.length, 4, "transcript accumulates two turns per step");
    // Delta mode: the session transcript already carries older history, so the
    // fresh user turn only re-states the freshest entries.
    assert.equal(prompts[2].history.actions.length, 1, "delta turn carries only the newest action");
    assert.equal(prompts[0].history.actions.length, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("scored session commits replay as an assistant turn across steps", async () => {
  const { buildScoreCandidates, SCORED_REASONING_PREFIX } = require("./agent_contracts.cjs");
  const candidates = buildScoreCandidates(["repo-map", "repo.inspect"]);
  const winners = [
    candidates.findIndex((c) => c.commandId === "repo-map" && c.complete),
    candidates.findIndex((c) => c.commandId === "repo.inspect" && c.complete),
  ];
  const prompts = [];
  const harness = makeHarness({
    inferAction: async () => { throw new Error("generative path should not run"); },
    scoreActions: async (prompt, texts) => {
      prompts.push(prompt);
      const winnerIndex = winners[prompts.length - 1];
      return {
        candidates: texts.map((text, index) => ({
          index, text,
          logprob: index === winnerIndex ? -5 : -40,
          avgLogprob: index === winnerIndex ? -0.5 : -4,
          tokens: 20,
        })),
        promptTokens: 100,
        cachedTokens: prompts.length === 1 ? 0 : 60,
        committedIndex: winnerIndex,
        committedText: texts[winnerIndex],
        requestContent: `score-req-${prompts.length}`,
      };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, {
      steps: [{ commandId: "repo-map", label: "Map" }, { commandId: "repo.inspect", label: "Inspect" }],
    }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 2, "both steps decided by scoring alone");
    const replay = prompts[1].sessionTurns;
    assert.equal(replay.length, 2);
    assert.equal(replay[0].role, "user");
    assert.equal(replay[0].content, "score-req-1");
    assert.equal(replay[1].role, "assistant");
    assert.equal(replay[1].reasoning_content, SCORED_REASONING_PREFIX, "replay matches the /v1/score suffix prefix");
    assert.equal(replay[1].content, candidates[winners[0]].text, "committed winner replays verbatim");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

function decidePayloadFor(cands, winnerIndex, confidence = 0.9) {
  const rest = Math.max(cands.length - 1, 1);
  const probabilities = Object.fromEntries(cands.map((candidate, index) => [`cand-${index}`, index === winnerIndex ? 0.7 : 0.3 / rest]));
  return {
    schema: "hemlock.decide.v1",
    answers: { "next-action": { type: "choice", choice: `cand-${winnerIndex}`, confidence, probabilities } },
    committedQuestion: "next-action",
    committedKey: `cand-${winnerIndex}`,
    committedText: cands[winnerIndex]?.text,
    usage: { promptTokens: 100, cachedTokens: 80 },
  };
}

test("decide-choice maps a complete winner and records probability telemetry", async () => {
  let generated = 0;
  let scoreCalls = 0;
  let decideCalls = 0;
  const harness = makeHarness({
    inferAction: async () => { generated += 1; return JSON.stringify({ kind: "tool", commandId: "repo.inspect", input: {} }); },
    scoreActions: {
      decide: async (_prompt, cands) => {
        decideCalls += 1;
        assert.ok(cands.every((candidate) => typeof candidate === "object" && typeof candidate.text === "string"), "decide receives full candidate objects");
        const winnerIndex = cands.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete);
        return decidePayloadFor(cands, winnerIndex, 0.9);
      },
      score: async () => { scoreCalls += 1; return null; },
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(decideCalls, 1);
    assert.equal(scoreCalls, 0, "a decide decision never falls back to per-candidate scoring");
    assert.equal(generated, 0, "complete decide winner executes with zero generated tokens");
    const scored = harness.events.find((event) => event.type === "action.scored");
    assert.equal(scored.payload.mode, "decide");
    assert.equal(scored.payload.winner.commandId, "repo-map");
    assert.equal(scored.payload.complete, true);
    assert.equal(scored.payload.probability, 0.7);
    assert.equal(scored.payload.confidence, 0.9);
    assert.ok(scored.payload.margin > 0, "margin is p1 − p2");
    assert.equal(scored.payload.indecisive, false);
    const action = harness.kernel.getProjection().actions.find((item) => item.kind === "tool");
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a low-confidence decide winner falls through to the generative path", async () => {
  let generated = 0;
  const harness = makeHarness({
    inferAction: async (prompt) => {
      generated += 1;
      assert.equal(prompt.progress?.scoredDecision?.commandId, "repo-map", "indecisive decision is recorded for the fill-in");
      assert.equal(prompt.progress?.scoredDecision?.indecisive, true);
      return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} });
    },
    scoreActions: {
      decide: async (_prompt, cands) => decidePayloadFor(cands, cands.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete), 0.2),
      score: async () => { throw new Error("score must not run when decide answered"); },
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(generated, 1, "confidence < 0.35 does not take a zero-token complete winner");
    const scored = harness.events.find((event) => event.type === "action.scored");
    assert.equal(scored.payload.mode, "decide");
    assert.equal(scored.payload.indecisive, true);
    assert.equal(scored.payload.confidence, 0.2);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a missing decide endpoint falls back to the /v1/score path", async () => {
  let decideCalls = 0;
  let scoreCalls = 0;
  let generated = 0;
  const harness = makeHarness({
    inferAction: async () => { generated += 1; return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} }); },
    scoreActions: {
      // main.cjs returns null on a 404 and marks the endpoint unsupported.
      decide: async () => { decideCalls += 1; return null; },
      score: async (_prompt, texts) => {
        scoreCalls += 1;
        const winnerIndex = texts.findIndex((text) => { try { return JSON.parse(text).commandId === "repo-map"; } catch { return false; } });
        return {
          candidates: texts.map((text, index) => ({ index, text, logprob: index === winnerIndex ? -5 : -40, avgLogprob: index === winnerIndex ? -0.5 : -4, tokens: 20 })),
          promptTokens: 100,
          cachedTokens: 80,
        };
      },
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(decideCalls, 1);
    assert.equal(scoreCalls, 1, "decide returning null falls back to scoring");
    assert.equal(generated, 0);
    const scored = harness.events.find((event) => event.type === "action.scored" && event.status === "passed");
    assert.equal(scored.payload.mode, "score");
    assert.equal(scored.payload.winner.commandId, "repo-map");
    assert.equal(scored.payload.avgLogprob, -0.5, "score path keeps avgLogprob telemetry");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a decide transport error still falls back to the /v1/score path", async () => {
  let scoreCalls = 0;
  const harness = makeHarness({
    inferAction: async () => { throw new Error("generative path should not run"); },
    scoreActions: {
      decide: async () => { throw new Error("decide exploded"); },
      score: async (_prompt, texts) => {
        scoreCalls += 1;
        const winnerIndex = texts.findIndex((text) => { try { return JSON.parse(text).commandId === "repo-map"; } catch { return false; } });
        return { candidates: texts.map((text, index) => ({ index, text, logprob: index === winnerIndex ? -5 : -40, avgLogprob: index === winnerIndex ? -0.5 : -4, tokens: 20 })) };
      },
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(scoreCalls, 1);
    const degraded = harness.events.find((event) => event.type === "action.scored" && event.status === "degraded" && event.payload?.mode === "decide");
    assert.ok(degraded, "the decide failure is recorded, not hidden");
    assert.equal(harness.events.find((event) => event.type === "action.scored" && event.status === "passed")?.payload?.mode, "score");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a bare scoreActions function stays score-only (legacy dep shape)", async () => {
  let scoreCalls = 0;
  const harness = makeHarness({
    inferAction: async () => { throw new Error("generative path should not run"); },
    scoreActions: async (_prompt, texts) => {
      scoreCalls += 1;
      const winnerIndex = texts.findIndex((text) => { try { return JSON.parse(text).commandId === "repo-map"; } catch { return false; } });
      return { candidates: texts.map((text, index) => ({ index, text, logprob: index === winnerIndex ? -5 : -40, avgLogprob: index === winnerIndex ? -0.5 : -4, tokens: 20 })) };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(scoreCalls, 1);
    assert.equal(harness.orchestrator.scoreActions.decide, undefined);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

// Wiring guard (main.cjs has no test export seam — same pattern as
// maple_notify.test.cjs): the decide transport, its env/404 kill-switches,
// the {decide, score} injection, and the memory.select rerank receipt.
test("main.cjs wires /v1/decide with score fallback and the memory rerank", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  assert.match(source, /async function decideStructuredAction\(prompt, candidates\)/);
  assert.match(source, /`\$\{endpoint\}\/v1\/decide`/);
  assert.match(source, /let decideEndpointUnsupported = false/);
  assert.match(source, /process\.env\.HEMLOCK_NO_DECIDE !== "1"/, "HEMLOCK_NO_DECIDE=1 disables the decide path");
  assert.match(source, /decideEndpointUnsupported = true/, "a 404 marks decide unsupported for the session");
  assert.match(source, /scoreActions:\s*\{\s*decide:\s*decideStructuredAction,\s*score:\s*scoreStructuredAction\s*\}/);
  assert.match(source, /commitQuestion:\s*"next-action"/);
  assert.match(source, /decideRerankMemoryRecords\(heuristicRecords\.slice\(0, MEMORY_RERANK_LIMIT\)/);
  assert.match(source, /decideRanked: true/, "the reorder is receipted on the memory.select event");
});

test("a batch envelope executes each item through the normal action path with its own receipt", async () => {
  let inferCalls = 0;
  const commands = [];
  const harness = makeHarness({
    inferAction: async () => {
      inferCalls += 1;
      return JSON.stringify({ actions: [{ command: "repo-map", input: {} }, { command: "repo.inspect", input: {} }] });
    },
    executeCommand: async (command) => {
      commands.push(command);
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }, { commandId: "repo.inspect", label: "Inspect repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(inferCalls, 1, "one inference produced the whole batch");
    assert.deepEqual(commands, ["repo-map", "repo.inspect"], "items ran in order");
    const actions = harness.kernel.getProjection().actions;
    assert.equal(actions.filter((item) => item.kind === "batch").length, 0, "the batch container stays ephemeral");
    const items = actions.filter((item) => item.kind === "tool");
    assert.equal(items.length, 2);
    assert.ok(items.every((item) => item.batchId && item.batchSize === 2 && item.status === "completed"));
    assert.deepEqual(items.map((item) => item.batchIndex), [0, 1]);
    assert.equal(harness.kernel.getProjection().observations.length, 2, "each item produced its own observation");
    assert.equal(harness.events.filter((event) => event.type === "action.proposed" && event.payload?.action?.batchId).length, 2);
    assert.ok(items.every((item) => harness.events.some((event) => event.type === "action.completed" && event.payload?.actionId === item.id)), "each item earned a normal completion receipt");
    assert.equal(harness.events.some((event) => event.type === "batch.halted"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a batch halts on the first failure with a batch.halted receipt and never runs later items", async () => {
  const commands = [];
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({ actions: [{ command: "repo-map" }, { command: "repo.inspect" }, { command: "repo-map" }] }),
    executeCommand: async (command) => {
      commands.push(command);
      if (command === "repo.inspect") return { status: "blocked", summary: "inspection refused" };
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }, { commandId: "repo.inspect", label: "Inspect repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "blocked");
    assert.deepEqual(commands, ["repo-map", "repo.inspect"], "the third item never ran");
    const halted = harness.events.find((event) => event.type === "batch.halted");
    assert.ok(halted, "batch.halted receipt emitted");
    assert.equal(halted.payload.completedCount, 1);
    assert.equal(halted.payload.failedIndex, 1);
    assert.equal(halted.payload.reason, "blocked");
    const actions = harness.kernel.getProjection().actions;
    assert.equal(actions.length, 2, "only attempted items are durable");
    assert.equal(actions[0].status, "completed");
    assert.equal(actions[1].status, "blocked");
    // Prior mutations stay journaled — no automatic rollback of item 0.
    assert.equal(harness.kernel.getProjection().observations.length, 2);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("each batch item consumes the mutation-set budget independently", async () => {
  const commands = [];
  const harness = makeHarness({
    commandRegistry: {
      "file.read": { capability: "read" },
      "code.apply": { capability: "write", approval: "plan" },
    },
    inferAction: async () => JSON.stringify({ actions: [{ command: "file.read" }, { command: "code.apply" }, { command: "code.apply" }] }),
    executeCommand: async (command) => {
      commands.push(command);
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, {
      steps: [
        { commandId: "file.read", label: "Read a file" },
        { commandId: "code.apply", label: "Apply the change", approval: "plan" },
      ],
    }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "blocked");
    assert.deepEqual(commands, ["file.read", "code.apply"], "the second mutation never ran — the set was already consumed");
    assert.equal(harness.task.budget.mutationSetsUsed, 1);
    const halted = harness.events.find((event) => event.type === "batch.halted");
    assert.equal(halted.payload.completedCount, 2);
    assert.equal(halted.payload.failedIndex, 2);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("cancelling mid-batch prevents later items from running", async () => {
  const commands = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({ actions: [{ command: "repo-map" }, { command: "repo.inspect" }] }),
    executeCommand: async (command) => {
      commands.push(command);
      if (command === "repo-map") return pending;
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }, { commandId: "repo.inspect", label: "Inspect repo" }] }).plan;
    const running = harness.orchestrator.approvePlan(harness.task.id, plan.id);
    await new Promise((resolve) => setImmediate(resolve));
    harness.orchestrator.cancel(harness.task.id);
    release({ status: "passed", summary: "late", evidenceRefs: ["receipt://late"] });
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(commands, ["repo-map"], "the second batch item never ran");
    const halted = harness.events.find((event) => event.type === "batch.halted");
    assert.ok(halted);
    assert.equal(halted.status, "cancelled");
    assert.equal(halted.payload.completedCount, 0);
    assert.equal(halted.payload.failedIndex, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("pausing mid-batch lets the in-flight item finish and parks before the next", async () => {
  const commands = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = makeHarness({
    inferAction: async () => JSON.stringify({ actions: [{ command: "repo-map" }, { command: "repo.inspect" }] }),
    executeCommand: async (command) => {
      commands.push(command);
      if (command === "repo-map") return pending;
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }, { commandId: "repo.inspect", label: "Inspect repo" }] }).plan;
    const running = harness.orchestrator.approvePlan(harness.task.id, plan.id);
    await new Promise((resolve) => setImmediate(resolve));
    harness.orchestrator.pauseTask(harness.task.id);
    release({ status: "passed", summary: "done", evidenceRefs: ["receipt://repo-map"] });
    const result = await running;
    assert.equal(result.status, "paused");
    assert.deepEqual(commands, ["repo-map"], "the in-flight item finished; the next one parked");
    const halted = harness.events.find((event) => event.type === "batch.halted");
    assert.ok(halted);
    assert.equal(halted.status, "paused");
    assert.equal(halted.payload.completedCount, 1);
    assert.equal(halted.payload.failedIndex, 1);
    assert.equal(halted.payload.reason, "paused");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a single candidate skips /v1/decide and /v1/score and receipts the skip honestly", async () => {
  let decideCalls = 0;
  let scoreCalls = 0;
  let generated = 0;
  const commands = [];
  const harness = makeHarness({
    inferAction: async () => { generated += 1; throw new Error("no generative inference expected for a complete single candidate"); },
    buildCandidates: () => [{ text: '{"kind":"tool","commandId":"repo-map","input":{},"shortRationale":"Map the repo."}', kind: "tool", commandId: "repo-map", input: {}, complete: true }],
    scoreActions: {
      decide: async () => { decideCalls += 1; return null; },
      score: async () => { scoreCalls += 1; return null; },
    },
    executeCommand: async (command) => {
      commands.push(command);
      return { status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(decideCalls, 0, "decide skipped — there is nothing to rank");
    assert.equal(scoreCalls, 0, "score skipped — there is nothing to rank");
    assert.equal(generated, 0, "the complete candidate needs no fill-in either");
    assert.deepEqual(commands, ["repo-map"]);
    const scored = harness.events.find((event) => event.type === "action.scored");
    assert.equal(scored.payload.mode, "single-candidate");
    assert.equal(scored.payload.skipped, true);
    assert.equal(scored.payload.reason, "single-candidate");
    assert.equal(scored.payload.winner.commandId, "repo-map");
    assert.equal(scored.payload.candidateCount, 1);
    const action = harness.kernel.getProjection().actions.find((item) => item.kind === "tool");
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("action proposals carry the forced JSON assistant prefix on the prompt, plus an options arg when the transport declares one", async () => {
  const seen = [];
  async function inferWithOptions(prompt, options) {
    seen.push({ prompt, options });
    return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} });
  }
  const harness = makeHarness({ inferAction: inferWithOptions });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((call) => call.options?.assistantPrefix === '{"command":'), "every structured proposal gets the options argument");
    assert.ok(seen.every((call) => call.prompt?.assistantPrefix === '{"command":'), "and the prompt field the live transport forwards as assistant_prefix");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }

  const calls = [];
  const oneArg = makeHarness({
    inferAction: async (...args) => {
      calls.push(args);
      return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} });
    },
  });
  try {
    const plan = oneArg.orchestrator.proposePlan(oneArg.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await oneArg.orchestrator.approvePlan(oneArg.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((args) => args.length === 1), "a single-parameter transport is never handed the options argument");
    assert.ok(calls.every((args) => args[0]?.assistantPrefix === '{"command":'), "the prompt field still carries the prefix — inferStructuredAction forwards it");
  } finally {
    fs.rmSync(oneArg.root, { recursive: true, force: true });
  }
});

test("a decide winner the host overrides is receipted as action.scored.divergence, and the fill-in names the executing step", async () => {
  // Observed failure: /v1/decide returned {"kind":"blocked"} at p 0.83–0.99
  // while the host correctly executed the planned step — but the fill-in
  // prompt said "continue the scored command choice", so the model parroted
  // "Blocked due to insufficient evidence" and once emitted a literal
  // {"kind":"blocked"} that killed the task in one step.
  const { buildScoreCandidates } = require("./agent_contracts.cjs");
  const candidates = buildScoreCandidates(["repo-map", "repo.inspect"]);
  const blockedIndex = candidates.findIndex((candidate) => candidate.kind === "blocked");
  let fillInContent = null;
  const harness = makeHarness({
    inferAction: async (prompt) => {
      fillInContent = prompt.sessionUserContent;
      return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map the repo." });
    },
    scoreActions: {
      decide: async (_prompt, cands) => decidePayloadFor(cands, blockedIndex, 0.9),
      score: async () => null,
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed", "the ignored blocked winner must not kill the task");
    const divergence = harness.events.find((event) => event.type === "action.scored.divergence");
    assert.ok(divergence, "executed ≠ decided is receipted");
    assert.equal(divergence.payload.decidedKind, "blocked");
    assert.equal(divergence.payload.executedKind, "tool");
    assert.equal(divergence.payload.executedCommandId, "repo-map");
    assert.equal(divergence.payload.mode, "decide");
    assert.equal(divergence.payload.probability, 0.7);
    assert.equal(divergence.payload.confidence, 0.9);
    assert.ok(typeof divergence.payload.margin === "number");
    // The fill-in prompt names the ACTUAL executing action, not the winner.
    const fillIn = JSON.parse(fillInContent);
    assert.equal(fillIn.executingAction.commandId, "repo-map");
    assert.match(fillIn.instruction, /repo-map/);
    assert.doesNotMatch(fillIn.instruction, /continuing the scored/i);
    const action = harness.kernel.getProjection().actions.find((item) => item.kind === "tool");
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("no divergence event when the executed action is the decided winner", async () => {
  const { buildScoreCandidates } = require("./agent_contracts.cjs");
  const candidates = buildScoreCandidates(["repo-map"]);
  const winnerIndex = candidates.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete);
  const harness = makeHarness({
    inferAction: async () => { throw new Error("generative path should not run"); },
    scoreActions: {
      decide: async (_prompt, cands) => decidePayloadFor(cands, winnerIndex, 0.9),
      score: async () => null,
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(harness.events.some((event) => event.type === "action.scored.divergence"), false, "decided = executed is not a divergence");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an empty compact-choice input is filled from the executed plan step's input", async () => {
  // Observed failure evt-1789959126534: {"commandId":"improve.propose","input":{}}
  // passed envelope validation then died on deterministic-input validation —
  // the plan step's own input was never consulted.
  const payloads = [];
  const harness = makeHarness({
    commandRegistry: { "improve.propose": { capability: "write", inputHint: '{summary, rationale, files?:["repo-relative"]}' } },
    inferAction: async () => JSON.stringify({ kind: "tool", commandId: "improve.propose", input: {} }),
    executeCommand: async (command, payload) => {
      payloads.push({ command, payload });
      if (!payload?.summary) throw new Error("improve.propose needs a summary of the bounded change.");
      return { status: "passed", summary: "proposed", evidenceRefs: ["receipt://proposed-improvement"] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, {
      steps: [{ commandId: "improve.propose", label: "Propose the bounded fix", input: { summary: "bounded fix", rationale: "from receipts" } }],
    }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].payload.summary, "bounded fix", "the plan step's input fills the empty compact input");
    assert.equal(payloads[0].payload.rationale, "from receipts");
    const action = harness.kernel.getProjection().actions.find((item) => item.kind === "tool");
    assert.equal(action.input.summary, "bounded fix");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a deterministic-input failure gets exactly one corrective re-inference before blocking", async () => {
  const payloads = [];
  const repairPrompts = [];
  let calls = 0;
  const harness = makeHarness({
    commandRegistry: { "improve.propose": { capability: "write", inputHint: '{summary, rationale, files?:["repo-relative"]}' } },
    inferAction: async (prompt) => {
      calls += 1;
      if (prompt.repair?.schema === "hemlock.agent.input.repair.v1") {
        repairPrompts.push(prompt.repair);
        return JSON.stringify({ kind: "tool", commandId: "improve.propose", input: { summary: "bounded fix", rationale: "from receipts" } });
      }
      return JSON.stringify({ kind: "tool", commandId: "improve.propose", input: {} });
    },
    executeCommand: async (command, payload) => {
      payloads.push(payload);
      if (!payload?.summary || !payload?.rationale) throw new Error("improve.propose needs a summary of the bounded change.");
      return { status: "passed", summary: "proposed", evidenceRefs: ["receipt://proposed-improvement"] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "improve.propose", label: "Propose the bounded fix" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed", "a missing required arg is not an instant terminal block");
    assert.equal(payloads.length, 2, "the original call plus exactly one repaired retry");
    assert.equal(payloads[1].summary, "bounded fix");
    assert.equal(payloads[1].rationale, "from receipts");
    assert.equal(repairPrompts.length, 1);
    assert.deepEqual(repairPrompts[0].requiredFields, ["summary", "rationale"], "the repair prompt echoes the required-arg schema");
    assert.match(repairPrompts[0].inputHint, /summary/);
    const repaired = harness.events.find((event) => event.type === "action.input.repaired");
    assert.ok(repaired, "the input repair is receipted");
    assert.deepEqual(repaired.payload.requiredFields, ["summary", "rationale"]);
    const actions = harness.kernel.getProjection().actions.filter((item) => item.commandId === "improve.propose");
    assert.equal(actions.length, 2, "the failed attempt and the repaired retry are both durable");
    assert.equal(actions[1].inputRepairsUsed, 1);
    assert.equal(actions[1].status, "completed");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the input repair is one-shot: a second deterministic-input failure blocks honestly", async () => {
  const harness = makeHarness({
    commandRegistry: { "improve.propose": { capability: "write", inputHint: "{summary, rationale}" } },
    inferAction: async (prompt) => prompt.repair?.schema === "hemlock.agent.input.repair.v1"
      ? JSON.stringify({ kind: "tool", commandId: "improve.propose", input: { summary: "still missing rationale" } })
      : JSON.stringify({ kind: "tool", commandId: "improve.propose", input: {} }),
    executeCommand: async () => { throw new Error("improve.propose needs a rationale grounded in local evidence."); },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "improve.propose", label: "Propose" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "blocked");
    assert.equal(harness.events.filter((event) => event.type === "action.input.repaired").length, 1, "exactly one input repair attempt");
    assert.equal(harness.events.some((event) => event.type === "task.blocked"), true);
    const actions = harness.kernel.getProjection().actions.filter((item) => item.commandId === "improve.propose");
    assert.equal(actions.length, 2, "no unbounded repair loop");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("plan.revise rewrites the remaining steps inside the capability boundary and receipts a diff", async () => {
  const commands = [];
  const harness = makeHarness({
    commandRegistry: {
      "repo-map": { capability: "read" },
      "repo.inspect": { capability: "read" },
      "git.status": { capability: "read", auto: true },
    },
    executeCommand: async (command) => {
      commands.push(command);
      if (command === "repo-map") return { status: "blocked", summary: "map unavailable" };
      return { status: "passed", summary: `${command} ok`, evidenceRefs: [`receipt://${command}`] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, {
      steps: [{ commandId: "repo-map", label: "Map" }, { commandId: "repo.inspect", label: "Inspect" }],
    }).plan;
    const blocked = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(blocked.status, "blocked");
    const revised = harness.orchestrator.revisePlan(harness.task.id, {
      steps: [{ commandId: "git.status", label: "Check worktree scope instead" }, { kind: "answer", label: "Answer from the worktree state" }],
      rationale: "repo-map failed; use the git surface",
    });
    assert.equal(revised.status, "revised");
    assert.equal(revised.diff.keptCount, 1, "the executed prefix is immutable");
    assert.deepEqual(revised.diff.removed.map((step) => step.commandId), ["repo.inspect"]);
    assert.deepEqual(revised.diff.added.map((step) => step.commandId), ["git.status", null]);
    const stored = harness.kernel.getProjection().plans.find((item) => item.id === plan.id);
    assert.deepEqual(stored.steps.map((step) => step.commandId), ["repo-map", "git.status", null]);
    assert.equal(stored.steps[1].status, "ready");
    assert.equal(stored.revisions.length, 1);
    const event = harness.events.find((entry) => entry.type === "plan.revised");
    assert.ok(event, "plan.revised is emitted with the step diff");
    assert.equal(event.payload.rationale, "repo-map failed; use the git surface");
    const resumed = await harness.orchestrator.resumeTask(harness.task.id);
    assert.equal(resumed.status, "completed");
    assert.deepEqual(commands, ["repo-map", "git.status"], "the revised step is what executes");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("plan.revise rejects unknown or out-of-boundary commands and keeps the plan", async () => {
  const harness = makeHarness({
    commandRegistry: {
      "repo-map": { capability: "read" },
      "repo.inspect": { capability: "read" },
      dream: { capability: "train", approval: "explicit" },
    },
    executeCommand: async (command) => ({ status: "blocked", summary: `${command} blocked` }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, {
      steps: [{ commandId: "repo-map", label: "Map" }, { commandId: "repo.inspect", label: "Inspect" }],
    }).plan;
    await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(harness.task.status, "blocked");
    const rejected = harness.orchestrator.revisePlan(harness.task.id, { steps: [{ commandId: "shell.exec", label: "invented" }] });
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.reason, /unknown commandId/i);
    const outOfBoundary = harness.orchestrator.revisePlan(harness.task.id, { steps: [{ commandId: "dream", label: "train" }] });
    assert.equal(outOfBoundary.status, "rejected");
    assert.match(outOfBoundary.reason, /capability boundary/i);
    const stored = harness.kernel.getProjection().plans.find((item) => item.id === plan.id);
    assert.deepEqual(stored.steps.map((step) => step.commandId), ["repo-map", "repo.inspect"], "the plan is unchanged");
    assert.equal(harness.events.filter((event) => event.type === "plan.revision.rejected").length, 2);
    assert.equal(harness.events.some((event) => event.type === "plan.revised"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("mid-loop steering is delivered on the next action step and marked delivered", async () => {
  const prompts = [];
  const harness = makeHarness({
    commandRegistry: { "repo-map": { capability: "read" }, "repo.inspect": { capability: "read" } },
    inferAction: async (prompt) => {
      prompts.push(prompt);
      const step = prompts.length;
      return JSON.stringify({ kind: "tool", commandId: ["repo-map", "repo.inspect"][step - 1], input: {} });
    },
  });
  try {
    harness.orchestrator.updateTask({ steering: [{ id: "steer-1", content: "Prefer the git surface", source: "test", status: "accepted" }] });
    const plan = harness.orchestrator.proposePlan(harness.task, {
      steps: [{ commandId: "repo-map", label: "Map" }, { commandId: "repo.inspect", label: "Inspect" }],
    }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].task.steering[0].status, "accepted", "the pending item reaches the step prompt");
    assert.equal(prompts[1].task.steering[0].status, "delivered", "delivered steering does not ride later prompts as pending");
    const delivered = harness.events.find((event) => event.type === "task.steering.delivered");
    assert.ok(delivered, "delivery is receipted");
    assert.deepEqual(delivered.payload.steeringIds, ["steer-1"]);
    assert.equal(harness.task.steering[0].status, "delivered");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

// Wiring guard: the three structured-action transports must only send
// PENDING steering (status !== "delivered") so a delivered item is cleared
// from later step prompts.
test("main.cjs action transports send pending-only steering, cleared on delivery", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  const matches = source.match(/status !== "delivered"/g) || [];
  assert.ok(matches.length >= 3, "infer/score/decide compactTask.steering all filter delivered items");
});

// defaultPlanSteps reachability: the newest registry commands must be
// plannable, not just adaptive-selectable. Explicit-only lifecycle commands
// (conversation.trim, thread mutations) intentionally stay out of defaults.
test("defaultPlanSteps wires the newer registered commands into reachable plans", () => {
  const { defaultPlanSteps } = require("./agent_orchestrator.cjs");
  const ids = (intent, objective) => defaultPlanSteps(intent, objective).map((step) => step.commandId || step.kind);
  assert.ok(ids("memory").includes("memory.note"), "memory plan can record a note");
  assert.ok(ids("memory").includes("memory.list"), "memory plan still lists records first");
  assert.ok(ids("experiment").includes("world.state"), "experiment plan reads the world first");
  assert.ok(ids("experiment").includes("experiment.suggest"));
  assert.ok(ids("improve").includes("dream.dataset.preview"), "improve plan previews the dataset before proposing");
  assert.ok(ids("improve").includes("improve.propose"));
  assert.ok(ids("other-unmapped-intent").includes("agent.capabilities"), "the fallback plan surfaces the command map");
  assert.deepEqual(ids("conversation"), ["answer"], "conversation stays answer-only");
  assert.ok(!ids("memory").includes("conversation.trim"), "explicit-only trim is never a default step");
});

test("a near-tie decide winner falls through to the generative path despite high confidence", async () => {
  // Calibration fix: confidence alone admitted over-confident picks (a ~0.9
  // `blocked` winner once argued against the approved plan). The winner must
  // also clear a minimum top1-top2 probability margin.
  let generated = 0;
  const harness = makeHarness({
    inferAction: async (prompt) => {
      generated += 1;
      assert.equal(prompt.progress?.scoredDecision?.indecisive, true, "the fill-in sees the indecisive flag");
      return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} });
    },
    scoreActions: {
      decide: async (_prompt, cands) => {
        const winnerIndex = cands.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete);
        const runnerUpIndex = cands.findIndex((candidate, index) => index !== winnerIndex);
        const probabilities = Object.fromEntries(cands.map((candidate, index) => [`cand-${index}`,
          index === winnerIndex ? 0.4 : index === runnerUpIndex ? 0.36 : 0.24 / Math.max(cands.length - 2, 1)]));
        return {
          schema: "hemlock.decide.v1",
          answers: { "next-action": { type: "choice", choice: `cand-${winnerIndex}`, confidence: 0.9, probabilities } },
          committedQuestion: "next-action",
          committedKey: `cand-${winnerIndex}`,
          committedText: cands[winnerIndex]?.text,
        };
      },
      score: async () => { throw new Error("score must not run when decide answered"); },
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(generated, 1, "a 0.04 margin does not take the zero-token winner");
    const scored = harness.events.find((event) => event.type === "action.scored");
    assert.equal(scored.payload.mode, "decide");
    assert.equal(scored.payload.indecisive, true);
    assert.equal(scored.payload.confidence, 0.9);
    assert.ok(scored.payload.margin < 0.1);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a clear-margin decide winner still executes with zero generated tokens", async () => {
  let generated = 0;
  const harness = makeHarness({
    inferAction: async () => { generated += 1; return JSON.stringify({ kind: "tool", commandId: "repo.inspect", input: {} }); },
    scoreActions: {
      decide: async (_prompt, cands) => decidePayloadFor(cands, cands.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete), 0.9),
      score: async () => { throw new Error("score must not run when decide answered"); },
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(generated, 0, "margin >= 0.1 keeps the zero-token fast path");
    assert.equal(harness.events.find((event) => event.type === "action.scored")?.payload?.indecisive, false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a budget-exhausted command failure blocks without spending the input repair", async () => {
  // classifyFailure used to bucket every unmatched failure as
  // deterministic-input, so a spent budget burned the one input-repair
  // inference before blocking anyway.
  let repairCalls = 0;
  const harness = makeHarness({
    inferAction: async (prompt) => {
      if (prompt.repair?.schema === "hemlock.agent.input.repair.v1") repairCalls += 1;
      return JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} });
    },
    executeCommand: async () => {
      const error = new Error("Hemlock command budget exhausted (12/12).");
      error.code = "COMMAND_BUDGET_EXHAUSTED";
      throw error;
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "blocked");
    assert.equal(repairCalls, 0, "no input-repair inference ran");
    assert.equal(harness.events.some((event) => event.type === "action.input.repaired"), false);
    assert.match(harness.task.blockedReason, /^budget-exhausted:/);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("rejoins a structured action split across content and reasoning channels", async () => {
  // Observed Maple outputs: content carried `{"command":` while the JSON tail
  // (`"repo-map","input":{}}`) landed in the reasoning channel — a PARSE_FAIL.
  // Rejoin once instead of spending a repair inference.
  let calls = 0;
  const harness = makeHarness({
    inferAction: async () => {
      calls += 1;
      return { content: '{"command":', reasoning: '"repo-map","input":{}}', channels: [{ name: "content", text: '{"command":' }, { name: "reasoning", text: '"repo-map","input":{}}' }] };
    },
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(calls, 1, "the salvage avoids a repair inference");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.commandId, "repo-map");
    assert.equal(action.parseStatus, "channel-rejoined");
    assert.equal(harness.events.some((event) => event.type === "action.channel.rejoined"), true);
    assert.equal(harness.events.some((event) => event.type === "action.parse.failed"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a genuine reasoning channel never contaminates the parsed action", async () => {
  // The salvage only fires when content alone fails to parse AND the rejoined
  // text validates — normal reasoning must not reach the envelope.
  const harness = makeHarness({
    inferAction: async () => ({
      content: JSON.stringify({ kind: "tool", commandId: "repo-map", input: {} }),
      reasoning: "I considered repo.inspect but repo-map is the planned step.",
      channels: [{ name: "reasoning", text: "reasoning text" }],
    }),
  });
  try {
    const plan = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] }).plan;
    const result = await harness.orchestrator.approvePlan(harness.task.id, plan.id);
    assert.equal(result.status, "completed");
    const action = harness.kernel.getProjection().actions[0];
    assert.equal(action.commandId, "repo-map");
    assert.equal(harness.events.some((event) => event.type === "action.channel.rejoined"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});
