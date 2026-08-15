const assert = require("node:assert/strict");
const test = require("node:test");
const { ACTION_SCHEMA, DEFAULT_BUDGET, createObservation, extractJsonObject, mergeBudget, validateAction, classifyFailure } = require("./agent_contracts.cjs");

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
