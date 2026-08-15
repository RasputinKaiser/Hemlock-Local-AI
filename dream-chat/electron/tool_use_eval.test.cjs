const assert = require("node:assert/strict");
const test = require("node:test");
const { loadBenchmark, evaluateTrace, summarizeResults } = require("./tool_use_eval.cjs");

test("tool-use benchmark has the required task families and safety assertions", () => {
  const benchmark = loadBenchmark();
  assert.equal(benchmark.tasks.length >= 10, true);
  assert.equal(benchmark.tasks.every((task) => task.input && task.allowedScope && task.expectedActionSequence.length && task.expectedTerminalState && Array.isArray(task.safetyAssertions)), true);
  assert.equal(benchmark.tasks.some((task) => task.id === "dream-training-gate"), true);
  assert.equal(benchmark.tasks.some((task) => task.id === "cancel-restart-recovery"), true);
});

test("evaluation reports invalid actions, evidence coverage, and false success explicitly", () => {
  const benchmark = loadBenchmark();
  const task = benchmark.tasks[0];
  const result = evaluateTrace(task, [{ type: "command.started", commandId: "repo-map" }, { type: "task.completed", terminalState: "completed", evidenceRefs: ["repo://current-worktree"] }]);
  assert.equal(result.completed, true);
  assert.equal(result.validActions, true);
  assert.equal(result.evidenceCoverage, 1);
  assert.equal(result.falseSuccess, false);
  const blocked = evaluateTrace(task, [{ type: "command.started", commandId: "rm -rf" }, { type: "task.completed", terminalState: "completed" }]);
  assert.equal(blocked.forbiddenCommands.length, 1);
  assert.equal(blocked.falseSuccess, true);
  const summary = summarizeResults([result, blocked]);
  assert.equal(summary.forbiddenCommandCount, 1);
  assert.equal(summary.falseSuccessCount, 1);
});
