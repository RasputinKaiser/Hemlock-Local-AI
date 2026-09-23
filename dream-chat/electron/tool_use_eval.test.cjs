const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadBenchmark,
  evaluateTrace,
  evaluateTask,
  evaluateDecisionFixture,
  evaluateEnvelopeFixture,
  decideGate,
  summarizeResults,
  compareRuns,
  buildCalibrationReport,
  writeCalibrationReport,
  DECIDE_MIN_CONFIDENCE,
  DECIDE_MIN_MARGIN,
} = require("./tool_use_eval.cjs");
const { replayActionParse, requiredInputFields } = require("./agent_contracts.cjs");

test("tool-use benchmark has the required task families and safety assertions", () => {
  const benchmark = loadBenchmark();
  assert.equal(benchmark.tasks.length >= 10, true);
  assert.equal(benchmark.tasks.every((task) => task.input && task.allowedScope && task.expectedActionSequence.length && task.expectedTerminalState && Array.isArray(task.safetyAssertions)), true);
  assert.equal(benchmark.tasks.some((task) => task.id === "dream-training-gate"), true);
  assert.equal(benchmark.tasks.some((task) => task.id === "cancel-restart-recovery"), true);
});

test("benchmark regression gate: sequence entries are registered commands or declared pseudo-actions", () => {
  const benchmark = loadBenchmark();
  const registry = benchmark.registry || {};
  const pseudo = new Set(benchmark.pseudoActions || []);
  for (const task of benchmark.tasks) {
    for (const commandId of task.expectedActionSequence) {
      assert.equal(
        Boolean(registry[commandId]) || pseudo.has(commandId),
        true,
        `${task.id}: ${commandId} is neither a registered command nor a declared pseudo-action`,
      );
    }
  }
  // The plannable command surface the QUALITY coverage map enumerated must
  // itself be registered — coverage is measured against it.
  for (const commandId of benchmark.plannable || []) {
    assert.equal(Boolean(registry[commandId]), true, `plannable ${commandId} missing from the eval registry`);
  }
  // requiredInput entries must agree with the registry inputHint the host
  // actually advertises — drift here would gate on stale fields.
  for (const task of benchmark.tasks) {
    if (!Array.isArray(task.requiredInput)) continue;
    const commandId = task.expectedActionSequence.at(-1);
    const hintFields = requiredInputFields(registry[commandId]?.inputHint || "");
    for (const field of task.requiredInput) {
      assert.equal(hintFields.includes(field), true, `${task.id}: requiredInput ${field} not in ${commandId} inputHint (${registry[commandId]?.inputHint})`);
    }
  }
});

test("benchmark covers the newly-plannable commands and the observed failure modes", () => {
  const benchmark = loadBenchmark();
  const ids = new Set(benchmark.tasks.map((task) => task.id));
  for (const id of [
    "memory-note-lesson",
    "world-state-read",
    "dream-dataset-preview",
    "agent-capabilities-surface",
    "batch-inspection-envelope",
    "required-input-improve-propose",
    "required-input-file-search",
    "decide-margin-near-tie",
    "decide-margin-clear",
    "channel-rejoin-forced-prefix",
  ]) {
    assert.equal(ids.has(id), true, `missing benchmark task ${id}`);
  }
  const covered = new Set(benchmark.tasks.flatMap((task) => task.expectedActionSequence));
  const uncovered = (benchmark.plannable || []).filter((commandId) => !covered.has(commandId));
  // Coverage floor: the plannable map has ~41 entries; the benchmark must
  // cover at least half of them by id (exact list is reported, not hidden).
  assert.equal(covered.size >= 20, true);
  assert.equal(uncovered.length <= (benchmark.plannable || []).length - 20, true);
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

test("evaluateTrace scores expected-sequence coverage and order", () => {
  const task = {
    id: "t",
    expectedActionSequence: ["change.prepare", "change.apply", "blocked_on_conflict"],
    expectedTerminalState: "blocked",
    requiredEvidenceRefs: [],
  };
  const ordered = evaluateTrace(task, [
    { type: "command.started", commandId: "change.prepare" },
    { type: "command.started", commandId: "change.apply" },
    { type: "command.started", commandId: "blocked_on_conflict" },
    { type: "task.completed", terminalState: "blocked" },
  ]);
  assert.equal(ordered.expectedCoverage, 1);
  assert.equal(ordered.sequenceOrdered, true);
  assert.equal(ordered.firstCommandMatch, true);
  const partial = evaluateTrace(task, [
    { type: "command.started", commandId: "change.apply" },
    { type: "command.started", commandId: "change.prepare" },
    { type: "task.completed", terminalState: "blocked" },
  ]);
  assert.equal(partial.expectedCoverage, 2 / 3);
  assert.equal(partial.sequenceOrdered, false, "out-of-order coverage is not ordered coverage");
  assert.equal(partial.firstCommandMatch, false);
  const summary = summarizeResults([ordered, partial]);
  assert.equal(summary.expectedCoverageRate, (1 + 2 / 3) / 2);
  assert.equal(summary.orderedSequenceRate, 0.5);
});

test("compareRuns produces per-task transitions and a verdict", () => {
  const before = summarizeResults([
    { taskId: "a", completed: true, validActions: true, evidenceCoverage: 1, expectedCoverage: 1, sequenceOrdered: true, forbiddenCommands: [], falseSuccess: false },
    { taskId: "b", completed: false, validActions: true, evidenceCoverage: 0, expectedCoverage: 0, sequenceOrdered: false, forbiddenCommands: [], falseSuccess: false },
    { taskId: "c", completed: true, validActions: true, evidenceCoverage: 1, expectedCoverage: 1, sequenceOrdered: true, forbiddenCommands: [], falseSuccess: false },
  ]);
  const after = summarizeResults([
    { taskId: "a", completed: false, validActions: true, evidenceCoverage: 0, expectedCoverage: 0, sequenceOrdered: false, forbiddenCommands: [], falseSuccess: false },
    { taskId: "b", completed: true, validActions: true, evidenceCoverage: 1, expectedCoverage: 1, sequenceOrdered: true, forbiddenCommands: [], falseSuccess: false },
    { taskId: "c", completed: true, validActions: true, evidenceCoverage: 1, expectedCoverage: 1, sequenceOrdered: true, forbiddenCommands: [], falseSuccess: false },
  ]);
  const comparison = compareRuns(before, after);
  assert.equal(comparison.schema, "hemlock.agent.tool-use.comparison.v1");
  assert.equal(comparison.improvedTasks, 1);
  assert.equal(comparison.regressedTasks, 1);
  assert.equal(comparison.verdict, "mixed");
  const transition = comparison.transitions.find((item) => item.taskId === "b");
  assert.equal(transition.change, "improved");
  assert.equal(transition.before.completed, false);
  assert.equal(transition.after.completed, true);
  // A clean sweep is "improved"; identical runs are "unchanged".
  assert.equal(compareRuns(before, before).verdict, "unchanged");
  const allBetter = compareRuns(before, summarizeResults([
    { taskId: "a", completed: true, validActions: true, evidenceCoverage: 1, expectedCoverage: 1, sequenceOrdered: true, forbiddenCommands: [], falseSuccess: false },
    { taskId: "b", completed: true, validActions: true, evidenceCoverage: 1, expectedCoverage: 1, sequenceOrdered: true, forbiddenCommands: [], falseSuccess: false },
    { taskId: "c", completed: true, validActions: true, evidenceCoverage: 1, expectedCoverage: 1, sequenceOrdered: true, forbiddenCommands: [], falseSuccess: false },
  ]));
  assert.equal(allBetter.verdict, "improved");
  assert.match(comparison.claimBoundary, /not proof of general model quality/i);
});

test("evaluateTrace checks permutation invariance of recorded decide winners", () => {
  const task = { id: "t", expectedActionSequence: ["repo-map", "repo.inspect"], expectedTerminalState: "completed", requiredEvidenceRefs: [] };
  const options = [
    { kind: "tool", commandId: "repo-map", probability: 0.7 },
    { kind: "tool", commandId: "repo.inspect", probability: 0.2 },
    { kind: "ask_user", commandId: null, probability: 0.1 },
  ];
  const result = evaluateTrace(task, [
    { type: "command.started", commandId: "repo-map" },
    { type: "action.scored", payload: { mode: "decide", winner: { kind: "tool", commandId: "repo-map" }, confidence: 0.9, options } },
    { type: "task.completed", terminalState: "completed" },
  ]);
  assert.equal(result.decisionEventCount, 1);
  assert.equal(result.permutationInvariant, true, "the argmax winner survives option reordering");
  assert.deepEqual(result.permutationChecks, { checked: 1, stable: 1 });
  assert.equal(result.decisionEvents[0].correct, true);

  // Tied probabilities are order-sensitive: first-seen wins, so a reversed
  // option list flips the argmax — the check must catch that.
  const tied = evaluateTrace(task, [
    {
      type: "action.scored",
      payload: {
        mode: "decide",
        winner: { kind: "tool", commandId: "repo-map" },
        confidence: 0.5,
        options: [
          { kind: "tool", commandId: "repo-map", probability: 0.5 },
          { kind: "tool", commandId: "repo.inspect", probability: 0.5 },
        ],
      },
    },
  ]);
  assert.equal(tied.permutationInvariant, false);

  // Events without option scores — and skipped single-candidate picks — are
  // honestly unmeasurable, not silently counted as invariant.
  const unmeasurable = evaluateTrace(task, [
    { type: "action.scored", payload: { mode: "single-candidate", skipped: true, reason: "single-candidate", winner: { kind: "tool", commandId: "repo-map" } } },
    { type: "action.scored", payload: { mode: "decide", winner: { kind: "tool", commandId: "repo-map" }, confidence: 0.8 } },
  ]);
  assert.equal(unmeasurable.decisionEventCount, 1, "skipped picks are not decision evidence");
  assert.equal(unmeasurable.permutationInvariant, null);
  assert.deepEqual(unmeasurable.permutationChecks, { checked: 0, stable: 0 });
});

test("summarizeResults buckets decision confidence against empirical win rate", () => {
  const task = { id: "t", expectedActionSequence: ["repo-map"], expectedTerminalState: "completed", requiredEvidenceRefs: [] };
  const traceWith = (commandId, confidence) => evaluateTrace(task, [
    { type: "action.scored", payload: { mode: "decide", winner: { kind: "tool", commandId }, confidence } },
    { type: "task.completed", terminalState: "completed" },
  ]);
  const summary = summarizeResults([
    traceWith("repo-map", 0.95),
    traceWith("repo.inspect", 0.95),
    traceWith("repo-map", 0.6),
    traceWith("repo.inspect", 0.6),
    traceWith("repo-map", 0.3),
  ]);
  assert.equal(summary.decisionEventCount, 5);
  assert.equal(summary.confidenceCalibration["0.9-1.0"].count, 2);
  assert.equal(summary.confidenceCalibration["0.9-1.0"].wins, 1);
  assert.equal(summary.confidenceCalibration["0.9-1.0"].empiricalWinRate, 0.5);
  assert.equal(summary.confidenceCalibration["0.9-1.0"].meanConfidence, 0.95);
  assert.equal(summary.confidenceCalibration["0.5-0.7"].empiricalWinRate, 0.5);
  assert.equal(summary.confidenceCalibration["0-0.5"].empiricalWinRate, 1);
  assert.equal(summary.confidenceCalibration["0.7-0.9"].count, 0);
  assert.equal(summary.confidenceCalibration["0.7-0.9"].empiricalWinRate, null);
  assert.equal(summary.permutationInvariantRate, null, "no option data means no claim");
});

test("permutation invariance aggregates across results and flows into compareRuns deltas", () => {
  const task = { id: "t", expectedActionSequence: ["repo-map"], expectedTerminalState: "completed", requiredEvidenceRefs: [] };
  const options = [
    { kind: "tool", commandId: "repo-map", probability: 0.8 },
    { kind: "tool", commandId: "other", probability: 0.2 },
  ];
  const stable = evaluateTrace(task, [{ type: "action.scored", payload: { mode: "decide", winner: { kind: "tool", commandId: "repo-map" }, confidence: 0.9, options } }]);
  const tied = evaluateTrace(task, [{
    type: "action.scored",
    payload: { mode: "decide", winner: { kind: "tool", commandId: "repo-map" }, confidence: 0.5, options: options.map((option) => ({ ...option, probability: 0.5 })) },
  }]);
  const summary = summarizeResults([stable, tied]);
  assert.deepEqual(summary.permutationChecks, { checked: 2, stable: 1 });
  assert.equal(summary.permutationInvariantRate, 0.5);
  const comparison = compareRuns(summarizeResults([stable]), summary);
  assert.equal(comparison.deltas.permutationInvariantRate, -0.5);
});

test("decideGate mirrors the orchestrator confidence floor and margin gate", () => {
  // Clear margin + confidence: the decide path commits.
  assert.deepEqual(decideGate({ mode: "decide", confidence: 0.9, margin: 0.52, winnerComplete: true }), { indecisive: false, outcome: "decide" });
  // Near-tie inside DECIDE_MIN_MARGIN: falls through to generation.
  assert.deepEqual(decideGate({ mode: "decide", confidence: 0.83, margin: DECIDE_MIN_MARGIN - 0.01, winnerComplete: true }), { indecisive: true, outcome: "generative" });
  // Exactly at the gate still commits (>= semantics).
  assert.equal(decideGate({ mode: "decide", confidence: 0.6, margin: DECIDE_MIN_MARGIN, winnerComplete: true }).outcome, "decide");
  // Below the confidence floor: indecisive even with a wide margin.
  assert.equal(decideGate({ mode: "decide", confidence: DECIDE_MIN_CONFIDENCE - 0.01, margin: 0.5, winnerComplete: true }).outcome, "generative");
  // No reported margin: production computes Number(decision.margin) → null is
  // 0, so a missing margin counts as margin 0 and falls through, same as the
  // orchestrator.
  assert.equal(decideGate({ mode: "decide", confidence: 0.9, margin: null, winnerComplete: true }).outcome, "generative");
  // A prefix (non-complete) winner always means the generative fill-in.
  assert.equal(decideGate({ mode: "decide", confidence: 0.99, margin: 0.9, winnerComplete: false }).outcome, "generative");
  // Score-mode picks are not margin-gated.
  assert.equal(decideGate({ mode: "score", confidence: null, margin: 0.01, winnerComplete: true }).outcome, "decide");
});

test("benchmark decision fixtures replay the margin gate deterministically", () => {
  const benchmark = loadBenchmark();
  const byId = new Map(benchmark.tasks.map((task) => [task.id, task]));
  const nearTie = evaluateDecisionFixture(byId.get("decide-margin-near-tie"));
  assert.equal(nearTie.passed, true);
  assert.equal(nearTie.outcome, "generative");
  assert.equal(nearTie.indecisive, true);
  assert.equal(nearTie.margin < DECIDE_MIN_MARGIN, true);
  const clear = evaluateDecisionFixture(byId.get("decide-margin-clear"));
  assert.equal(clear.passed, true);
  assert.equal(clear.outcome, "decide");
  const boundary = evaluateDecisionFixture(byId.get("decide-margin-boundary"));
  assert.equal(Math.abs(boundary.margin - DECIDE_MIN_MARGIN) < 1e-9, true, "the fixture margin lands on the gate");
  assert.equal(boundary.margin >= DECIDE_MIN_MARGIN, true);
  assert.equal(boundary.outcome, "decide");
  const floor = evaluateDecisionFixture(byId.get("decide-confidence-floor"));
  assert.equal(floor.outcome, "generative");
  // Recorded decide picks feed calibration exactly like live receipts.
  assert.equal(nearTie.decisionEvent.confidence, 0.83);
  assert.equal(nearTie.decisionEvent.correct, true, "argmax was the expected command even though the gate fell through");
  assert.equal(nearTie.permutationStable, true);
});

test("replayActionParse validates compact choices, batch envelopes, and the channel rejoin", () => {
  const benchmark = loadBenchmark();
  const registry = benchmark.registry || {};
  // Compact choice with the assistant-prefix "command" alias.
  const compact = replayActionParse({ content: "{\"command\":\"memory.note\",\"input\":{\"title\":\"t\",\"body\":\"b\"}}" }, registry);
  assert.equal(compact.parseStatus, "compact-choice");
  assert.equal(compact.action.commandId, "memory.note");
  assert.equal(compact.action.status, "proposed");
  // Batch envelope fans out into registry-checked items.
  const batch = replayActionParse({ content: "{\"actions\":[{\"command\":\"repo-map\",\"input\":{}},{\"command\":\"git.status\",\"input\":{}}]}" }, registry);
  assert.equal(batch.parseStatus, "batch");
  assert.equal(batch.action.kind, "batch");
  assert.deepEqual(batch.action.actions.map((item) => item.commandId), ["repo-map", "git.status"]);
  // An unregistered command inside a batch fails the whole envelope.
  const badBatch = replayActionParse({ content: "{\"actions\":[{\"command\":\"repo-map\"},{\"command\":\"nope.bad\"}]}" }, registry);
  assert.equal(badBatch.parseStatus, "invalid");
  assert.equal(badBatch.action, null);
  // The production split-channel failure: {"command": in content, tail in reasoning.
  const rejoined = replayActionParse({ content: "{\"command\":", reasoning: "\"memory.list\",\"input\":{},\"shortRationale\":\"List records.\"}" }, registry);
  assert.equal(rejoined.parseStatus, "channel-rejoined");
  assert.equal(rejoined.channelRejoined, true);
  assert.equal(rejoined.action.commandId, "memory.list");
  // A reasoning tail that does not re-parse is ignored, not salvaged.
  const prose = replayActionParse({ content: "{\"command\":", reasoning: "I think the next step should be memory.list because..." }, registry);
  assert.equal(prose.parseStatus, "invalid");
  assert.equal(prose.action, null);
});

test("benchmark envelope fixtures pass, including {} envelopes flagged input-incomplete", () => {
  const benchmark = loadBenchmark();
  const registry = benchmark.registry || {};
  const results = benchmark.tasks.filter((task) => task.envelopeFixture).map((task) => evaluateEnvelopeFixture(task, registry));
  assert.equal(results.length >= 8, true);
  for (const result of results) {
    assert.equal(result.passed, true, `${result.taskId} fixture failed: ${JSON.stringify(result.checks)} (${result.error})`);
  }
  const byId = new Map(results.map((result) => [result.taskId, result]));
  assert.equal(byId.get("required-input-improve-propose").inputComplete, false);
  assert.deepEqual(byId.get("required-input-improve-propose").missingFields, ["improve.propose.summary", "improve.propose.rationale"]);
  assert.equal(byId.get("required-input-file-search").inputComplete, false);
  assert.equal(byId.get("batch-inspection-envelope").parseStatus, "batch");
  assert.equal(byId.get("channel-rejoin-forced-prefix").parseStatus, "channel-rejoined");
  assert.equal(byId.get("channel-rejoin-forced-prefix").channelRejoined, true);
});

test("evaluateTask merges fixture outcomes and synthetic decision receipts", () => {
  const benchmark = loadBenchmark();
  const registry = benchmark.registry || {};
  const results = benchmark.tasks.map((task) => evaluateTask(task, [], { registry }));
  const fixtureTasks = results.filter((result) => result.hasFixtures);
  assert.equal(fixtureTasks.length >= 12, true);
  for (const result of fixtureTasks) {
    assert.equal(result.fixturePassed, true, `${result.taskId} fixture regression: ${JSON.stringify(result.decision?.checks ?? result.envelope?.checks)}`);
  }
  const nearTie = results.find((result) => result.taskId === "decide-margin-near-tie");
  assert.equal(nearTie.decisionEventCount, 1);
  assert.equal(nearTie.decisionEvents[0].fixture, "decision");
  assert.equal(nearTie.permutationChecks.checked, 1);
  const summary = summarizeResults(results);
  assert.equal(summary.fixturePassRate, 1);
  assert.equal(summary.fixtureChecks.decision.checked, 4);
  assert.equal(summary.fixtureChecks.envelope.checked >= 9, true);
  assert.equal(summary.decisionEventCount, 4, "decision fixtures contribute one calibration receipt each");
});

test("calibration report persists per-bucket expected-vs-empirical rates as a machine-readable artifact", () => {
  const benchmark = loadBenchmark();
  const registry = benchmark.registry || {};
  const summary = summarizeResults(benchmark.tasks.map((task) => evaluateTask(task, [], { registry })));
  const report = buildCalibrationReport(summary, { benchmark });
  assert.equal(report.schema, "hemlock.agent.tool-use.calibration.v1");
  for (const [bucketId, cell] of Object.entries(report.confidenceCalibration)) {
    assert.equal(typeof cell.count, "number", bucketId);
    assert.equal(typeof cell.wins, "number", bucketId);
    assert.equal(cell.count === 0 ? cell.empiricalWinRate === null : typeof cell.empiricalWinRate === "number", true, bucketId);
    assert.equal(cell.count === 0 ? cell.calibrationGap === null : typeof cell.calibrationGap === "number", true, bucketId);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-use-calibration-"));
  const artifactPath = writeCalibrationReport(report, { dir, timestamp: 12345 });
  assert.equal(path.basename(artifactPath), "calibration-12345.json");
  const persisted = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(persisted.schema, "hemlock.agent.tool-use.calibration.v1");
  assert.deepEqual(persisted.confidenceCalibration, report.confidenceCalibration);
  assert.equal(persisted.fixturePassRate, 1);
});
