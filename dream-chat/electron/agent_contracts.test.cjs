const assert = require("node:assert/strict");
const test = require("node:test");
const { ACTION_SCHEMA, DEFAULT_BUDGET, coerceActionPayload, createObservation, extractActionEnvelope, extractJsonObject, mergeBudget, normalizeExpectedEvidence, validateAction, classifyFailure } = require("./agent_contracts.cjs");

test("contract helpers create bounded observations and merge the execution budget", () => {
  const budget = mergeBudget({ maxCommands: 3 });
  assert.equal(budget.maxCommands, 3);
  assert.equal(budget.maxAgentSteps, DEFAULT_BUDGET.maxAgentSteps);
  const observation = createObservation({ operationId: "op-1", status: "passed", summary: "Read a file", structuredOutput: { bytes: 12 }, evidenceRefs: ["file://README.md"] });
  assert.equal(observation.schema, "hemlock.agent.observation.v1");
  assert.match(observation.outputDigest, /^sha256:/);
});

test("action validation is explicit about schema, kind, and registered tools", () => {
  const action = { schema: ACTION_SCHEMA, id: "action-1", taskId: "task-1", step: 1, kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map the repo", expectedEvidence: [], approval: "none", status: "proposed" };
  assert.equal(validateAction(action, { "repo-map": {} }).commandId, "repo-map");
  assert.throws(() => validateAction({ ...action, kind: "shell" }, { "repo-map": {} }), /unsupported action kind/i);
  assert.throws(() => validateAction({ ...action, commandId: "rm" }, { "repo-map": {} }), /not allowlisted/i);
});

test("failure classification distinguishes retryable, safety, and verification failures", () => {
  const timeout = new Error("temporary timeout");
  timeout.code = "TIMEOUT";
  assert.equal(classifyFailure(timeout), "retryable-transient");
  const safety = new Error("command is not allowlisted");
  assert.equal(classifyFailure(safety), "safety-blocked");
  assert.equal(classifyFailure(null, { exitCode: 1 }), "verification-failure");
});

test("recovers a balanced action envelope surrounded by local model prose", () => {
  const action = { schema: ACTION_SCHEMA, id: "action_wrapped", taskId: "task_test", step: 1, kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map the repository.", expectedEvidence: ["repo://current-worktree"], approval: "none", status: "proposed" };
  assert.deepEqual(extractJsonObject(`I will use the registered action now. ${JSON.stringify(action)}\nDone.`), action);
});

test("recovers a truncated action envelope without trusting its unbounded payload", () => {
  const action = extractActionEnvelope(`{\n  "kind": "tool",\n  "commandId": "artifact.create",\n  "approval": "plan",\n  "status": "proposed",\n  "data": {"html": "<html>${"x".repeat(2400)}`);
  assert.equal(action.schema, ACTION_SCHEMA);
  assert.equal(action.commandId, "artifact.create");
  assert.equal(action.approval, "plan");
  assert.deepEqual(action.input, {});
  assert.equal(action.__recoveredTruncated, true);
  assert.equal(validateAction(action, { "artifact.create": {} }).commandId, "artifact.create");
});

test("wraps a compact bare Maple payload with host-owned action fields", () => {
  const action = coerceActionPayload({ title: "Night garden", kind: "tool", entrypoint: "create", mime: "text/html", data: { html: "should be discarded" } }, {
    taskId: "task_test",
    step: 2,
    commandId: "artifact.create",
    expectedEvidence: ["artifact://manifest"],
    approval: "plan",
  });
  assert.equal(action.schema, ACTION_SCHEMA);
  assert.equal(action.commandId, "artifact.create");
  assert.deepEqual(action.input, { title: "Night garden", entrypoint: "create", mime: "text/html" });
  assert.equal(action.approval, "plan");
  assert.equal(action.__coercedPayload, true);
});

test("accepts a direct relative-file map as an authoring payload", () => {
  const action = coerceActionPayload({ "index.html": "<!doctype html><main>variation</main>" }, {
    taskId: "task_test",
    step: 2,
    commandId: "artifact.author",
    expectedEvidence: ["artifact://revision"],
  });
  assert.deepEqual(action.input, { source: { "index.html": "<!doctype html><main>variation</main>" } });
});

test("accepts Maple's flattened input.source authoring shape", () => {
  const action = coerceActionPayload({ "input.source": { "index.html": "<!doctype html><main>flattened variation</main>" } }, {
    taskId: "task_test",
    step: 2,
    commandId: "artifact.author",
    expectedEvidence: ["artifact://revision"],
  });
  assert.deepEqual(action.input, { source: { "index.html": "<!doctype html><main>flattened variation</main>" } });
});

test("normalizes object-shaped evidence without accepting arbitrary values", () => {
  assert.deepEqual(normalizeExpectedEvidence({ "preview://inspection": true }), ["preview://inspection"]);
  assert.deepEqual(normalizeExpectedEvidence(["artifact://revision", 7]), ["artifact://revision"]);
  assert.deepEqual(normalizeExpectedEvidence(null, ["receipt://host"]), ["receipt://host"]);
});
