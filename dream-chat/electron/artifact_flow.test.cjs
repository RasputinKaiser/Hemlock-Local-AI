// T9-H3: Artifact flow regression tests (create -> author -> preview -> repair).
//
// Locks down the Build-mode artifact flow at the orchestrator boundary:
//   1. Garbage model-supplied artifactId values are never forwarded to
//      executeCommand verbatim (T8-F4 sanitizer + prior-artifact fallback).
//   2. Authoring without a prior create falls back to the host scaffold source.
//   3. A blocked artifact.preview.inspect triggers exactly one bounded
//      repairArtifact attempt (one artifact.update execution).
//   4. clampBudgetOverrides clamps user-granted plan budgets.
//
// These tests mock the kernel's executeCommand seam exactly like
// agent_orchestrator.test.cjs does; no product code is modified here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator } = require("./agent_orchestrator.cjs");
const { ACTION_SCHEMA, clampBudgetOverrides, createAction, createObservation } = require("./agent_contracts.cjs");

const TASK_ID = "task-artifact-flow";
const ARTIFACT_ID = "artifact-real-1";

const COMMAND_REGISTRY = {
  "artifact.create": { capability: "artifact" },
  "artifact.author": { capability: "artifact" },
  "artifact.update": { capability: "artifact" },
  "artifact.restore": { capability: "artifact" },
  "artifact.preview.open": { capability: "read" },
  "artifact.preview.inspect": { capability: "read" },
};

function makeHarness({ objective = "Build an animated HTML artifact preview", budgetExtras = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-artifact-flow-"));
  const task = {
    schema: "hemlock.agent.task.v1",
    id: TASK_ID,
    objective,
    intent: "coding",
    interactionMode: "build",
    phase: "work",
    status: "running",
    activePlanId: null,
    budget: { maxAgentSteps: 8, maxCommands: 12, maxRetriesPerOperation: 1, maxMutationSets: 1, maxTrainingCycles: 0, commandsUsed: 0, agentStepsUsed: 0, ...budgetExtras },
  };
  const kernel = new AgentKernel({ root, repoRoot: "/tmp/hemlock-project", task });
  let currentTask = task;
  const events = [];
  const commandCalls = [];
  // Tests may override the artifact.preview.inspect response to force the
  // repair path (test 3).
  const state = { inspectResult: null };
  const orchestrator = new AgentOrchestrator({
    kernel,
    commandRegistry: COMMAND_REGISTRY,
    getTask: () => currentTask,
    setTask: (patch) => { currentTask = { ...currentTask, ...patch }; kernel.syncTask(currentTask); return currentTask; },
    emit: (type, status, payload) => events.push({ type, status, payload }),
    executeCommand: async (commandId, input) => {
      commandCalls.push({ commandId, input });
      switch (commandId) {
        case "artifact.create":
          return { schema: "hemlock.agent.artifact.v1", status: "passed", summary: "Scratch artifact created.", id: ARTIFACT_ID, artifactId: ARTIFACT_ID, revision: 1, evidenceRefs: ["artifact://manifest"] };
        case "artifact.author":
          return { schema: "hemlock.agent.artifact.v1", status: "passed", summary: "Artifact authored.", id: input.artifactId || ARTIFACT_ID, artifactId: input.artifactId || ARTIFACT_ID, revision: 2, evidenceRefs: ["artifact://revision"] };
        case "artifact.update":
          return { schema: "hemlock.agent.artifact.v1", status: "passed", summary: "Repair candidate written.", id: input.artifactId || ARTIFACT_ID, artifactId: input.artifactId || ARTIFACT_ID, revision: 2, evidenceRefs: ["artifact://revision"] };
        case "artifact.preview.open":
          return { schema: "hemlock.agent.preview.open.v1", status: "passed", summary: "Isolated preview opened.", session: { id: `preview-session-${commandCalls.length}`, artifactId: input.artifactId || ARTIFACT_ID }, evidenceRefs: ["preview://session"] };
        case "artifact.preview.inspect":
          // T9-H3: first inspection returns the blocked result (drives the
          // repair loop); the host re-inspects after each repair attempt and
          // the SECOND inspection passes — matching a successful repair.
          if (state.inspectResult && !state.repairedOnce) {
            state.repairedOnce = true;
            return state.inspectResult;
          }
          state.inspectResult = null;
          return { schema: "hemlock.agent.preview.inspect.v1", status: "passed", summary: "Preview verified.", verification: { status: "passed", issues: [] }, evidenceRefs: ["preview://inspection"] };
        default:
          return { status: "passed", summary: `${commandId} passed`, evidenceRefs: [`receipt://${commandId}`] };
      }
    },
    inferAction: null,
  });
  return { root, kernel, orchestrator, events, commandCalls, state, get task() { return currentTask; } };
}

function cleanup(harness) {
  fs.rmSync(harness.root, { recursive: true, force: true });
}

function recordStructuredOutput(harness, structuredOutput, evidenceRefs = []) {
  harness.kernel.recordObservation(createObservation({
    status: "passed",
    summary: structuredOutput.summary || "Host operation observed.",
    structuredOutput,
    evidenceRefs,
  }));
}

// Seed a prior observation the way the real loop does: the observation must
// be linked to a task action via observationId for getTaskHistory to surface it.
function seedPriorStep(harness, step, commandId, structuredOutput, evidenceRefs) {
  const action = createAction({ taskId: TASK_ID, step, commandId, shortRationale: `Seed prior ${commandId}.` });
  harness.kernel.createAction(action);
  const observation = createObservation({
    status: "passed",
    summary: structuredOutput.summary || `Host ${commandId} observed.`,
    structuredOutput,
    evidenceRefs,
  });
  harness.kernel.recordObservation(observation);
  harness.kernel.transitionAction(action.id, "complete", { observationId: observation.id });
}

test("strips garbage model-supplied artifactId before executeCommand (T8-F4)", async () => {
  const garbageValues = ["artifact://manifest", "", "scratch artifact", null];
  for (const garbage of garbageValues) {
    const harness = makeHarness();
    try {
      // A prior artifact.create observation gives the host a real id to fall back to.
      seedPriorStep(harness, 1, "artifact.create", { schema: "hemlock.agent.artifact.v1", status: "passed", id: ARTIFACT_ID, revision: 1 }, ["artifact://manifest"]);
      const action = createAction({ taskId: TASK_ID, step: 2, commandId: "artifact.author", input: { artifactId: garbage }, shortRationale: "Author the requested animation." });
      harness.kernel.createAction(action);
      await harness.orchestrator.executeAction(action.id);
      const authorCall = harness.commandCalls.find((call) => call.commandId === "artifact.author");
      assert.ok(authorCall, `executeCommand was called for artifact.author (input artifactId was ${JSON.stringify(garbage)})`);
      const received = authorCall.input.artifactId;
      assert.equal(
        received,
        ARTIFACT_ID,
        `garbage artifactId ${JSON.stringify(garbage)} must never reach executeCommand; expected the prior created artifact's real id`,
      );
    } finally {
      cleanup(harness);
    }
  }
});

// T9-H3 follow-up: the numeric case was originally a skipped EXPOSED GAP;
// the sanitizer now rejects non-string artifactIds, so this runs for real.
test("numeric garbage artifactId (42) is dropped like other plan-ref parrots", async () => {
  const harness = makeHarness();
  try {
    seedPriorStep(harness, 1, "artifact.create", { schema: "hemlock.agent.artifact.v1", status: "passed", id: ARTIFACT_ID, revision: 1, summary: "created" }, ["artifact://manifest"]);
    const action = createAction({ taskId: TASK_ID, step: 3, commandId: "artifact.author", input: { artifactId: 42 }, shortRationale: "Author into the scratch artifact." });
    harness.kernel.createAction(action);
    await harness.orchestrator.executeAction(action.id);
    const authorCall = harness.commandCalls.find((call) => call.commandId === "artifact.author");
    assert.ok(authorCall, "artifact.author executed");
    assert.equal(authorCall.input.artifactId, ARTIFACT_ID, `numeric artifactId must never reach executeCommand; expected ${ARTIFACT_ID}`);
  } finally {
    cleanup(harness);
  }
});

test("author-without-create uses the host scaffold fallback source", async () => {
  const harness = makeHarness();
  try {
    // No prior artifact.create observation: the host must supply its own scaffold.
    const action = createAction({ taskId: TASK_ID, step: 1, commandId: "artifact.author", input: {}, shortRationale: "Author the requested animation." });
    harness.kernel.createAction(action);
    await harness.orchestrator.executeAction(action.id);
    const authorCall = harness.commandCalls.find((call) => call.commandId === "artifact.author");
    assert.ok(authorCall, "executeCommand was called for artifact.author");
    // T12: the host ensures a scratch artifact exists BEFORE authoring, so the
    // executed author targets the ensured id instead of forwarding none.
    assert.equal(typeof authorCall.input.artifactId, "string");
    assert.match(authorCall.input.artifactId, /^artifact-/);
    const scaffold = authorCall.input.source?.["index.html"];
    assert.equal(typeof scaffold, "string");
    assert.ok(scaffold.length > 0, "host fallbackAnimationSource scaffold is non-empty");
    assert.match(scaffold, /<style>/, "scaffold contains an inline <style> block");
    assert.equal(authorCall.input.status, "previewable");
    assert.equal(authorCall.input.evidence?.[0]?.type, "authoring.host_fallback");
  } finally {
    cleanup(harness);
  }
});

test("blocked preview inspection triggers exactly one bounded repair attempt", async () => {
  const harness = makeHarness();
  try {
    // Seed via seedPriorStep (action-linked) — getTaskHistory only surfaces
    // observations linked to a task action, which repairArtifact depends on.
    seedPriorStep(harness, 1, "artifact.create", { schema: "hemlock.agent.artifact.v1", status: "passed", id: ARTIFACT_ID, revision: 1, summary: "created" }, ["artifact://manifest"]);
    seedPriorStep(harness, 2, "artifact.preview.open", { schema: "hemlock.agent.preview.open.v1", status: "passed", summary: "opened", session: { id: "preview-session-0", artifactId: ARTIFACT_ID } }, ["preview://session"]);
    harness.state.inspectResult = {
      schema: "hemlock.agent.preview.inspect.v1",
      status: "blocked",
      summary: "Preview verification failed.",
      verification: { status: "blocked", issues: [{ code: "preview_blank_frame", message: "Canvas rendered blank." }] },
      evidenceRefs: ["preview://inspection"],
    };
    harness.orchestrator.inferAction = async () => JSON.stringify({
      ...createAction({ taskId: TASK_ID, step: 99, commandId: "artifact.update", shortRationale: "Repair the reported preview issue." }),
      input: { source: { "index.html": "<!doctype html><html><body>repaired</body></html>" } },
    });
    const action = createAction({ taskId: TASK_ID, step: 2, commandId: "artifact.preview.inspect", input: {}, shortRationale: "Inspect the rendered artifact." });
    harness.kernel.createAction(action);
    await harness.orchestrator.executeAction(action.id);
    const updateCalls = harness.commandCalls.filter((call) => call.commandId === "artifact.update");
    assert.equal(updateCalls.length, 1, `exactly one artifact.update repair attempt ran (got ${updateCalls.length})`);
    assert.equal(updateCalls[0].input.__internalRepair, true, "the repair update is flagged as an internal host repair");
    assert.equal(updateCalls[0].input.artifactId, ARTIFACT_ID, "the repair targets the real created artifact");
    // The repaired candidate is re-opened and re-inspected by the host loop.
    assert.ok(harness.commandCalls.some((call) => call.commandId === "artifact.preview.open"), "repair loop reopens the isolated preview");
    assert.ok(harness.events.some((event) => event.type === "artifact.repair.started"), "artifact.repair.started emitted");
    assert.ok(harness.events.some((event) => event.type === "artifact.repair.completed"), "successful repair emits artifact.repair.completed");
  } finally {
    cleanup(harness);
  }
});

test("clampBudgetOverrides bounds user-granted plan budgets (unit)", () => {
  // Absurd upper bound clamps to the ceiling.
  assert.deepEqual(clampBudgetOverrides({ maxAgentSteps: 9999 }), { maxAgentSteps: 64 });
  assert.deepEqual(clampBudgetOverrides({ maxCommands: 100000 }), { maxCommands: 120 });
  // Zero/negative floors clamp to 1; both keys survive together.
  assert.deepEqual(clampBudgetOverrides({ maxAgentSteps: 0, maxCommands: -5 }), { maxAgentSteps: 1, maxCommands: 1 });
  // Valid passthrough is preserved untouched.
  assert.deepEqual(clampBudgetOverrides({ maxAgentSteps: 16, maxCommands: 24 }), { maxAgentSteps: 16, maxCommands: 24 });
  // Unknown keys and garbage drop out entirely.
  assert.deepEqual(clampBudgetOverrides({ maxRetriesPerOperation: 9, maxAgentSteps: "lots" }), {});
  assert.deepEqual(clampBudgetOverrides(null), {});
});
