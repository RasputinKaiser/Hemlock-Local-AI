// Tool-use eval harness — deterministic, no live model needed.
//   node electron/tool_use_eval.cjs                    # replay benchmark fixtures + write evals/out/calibration-<ts>.json
//   node electron/tool_use_eval.cjs <benchmark.json> [--out <dir>] [--no-write]
//   node --test electron/tool_use_eval.test.cjs        # regression gate on the same machinery
// The live lane (model inference) is electron/tool_use_live.cjs; this file is
// the scorer: trace replay, decide-margin gate replay, and envelope/channel-
// rejoin replay through agent_contracts.

const fs = require("node:fs");
const path = require("node:path");
const { replayActionParse, requiredInputFields } = require("./agent_contracts.cjs");

const benchmarkPath = path.join(__dirname, "..", "evals", "tool-use", "benchmark.json");
const defaultOutDir = path.join(__dirname, "..", "evals", "out");

// Decide acceptance gates — mirrors agent_orchestrator.cjs DECIDE_MIN_CONFIDENCE
// / DECIDE_MIN_MARGIN. A decide winner commits as a zero-token action only when
// confidence clears the floor AND the top1-top2 probability margin clears the
// gate (when a real margin is reported); anything else falls through to the
// generative path. Keep these in sync with the orchestrator — the benchmark's
// decide-margin-* fixtures gate on exactly these numbers.
const DECIDE_MIN_CONFIDENCE = 0.35;
const DECIDE_MIN_MARGIN = 0.1;

// Terminal action kinds → the benchmark expectedTerminalState they imply.
const TERMINAL_STATE_BY_KIND = { complete: "completed", answer: "completed", ask_user: "waiting_for_approval", blocked: "blocked" };

// Confidence-calibration buckets for decide/score decisions (kev-style:
// compare the reported confidence against the empirical win rate).
const CONFIDENCE_BUCKETS = Object.freeze([
  { id: "0-0.5", min: 0, max: 0.5 },
  { id: "0.5-0.7", min: 0.5, max: 0.7 },
  { id: "0.7-0.9", min: 0.7, max: 0.9 },
  { id: "0.9-1.0", min: 0.9, max: 1.0 },
]);

// Deterministic argmax over recorded per-option scores — mirrors
// pickDecidedCandidate/pickScoredCandidate semantics (strictly-greater wins,
// first-seen breaks ties).
function argmaxOption(options) {
  let best = null;
  options.forEach((option, index) => {
    const score = Number(option?.probability ?? option?.avgLogprob ?? option?.score);
    if (!Number.isFinite(score)) return;
    if (!best || score > best.score) best = { index, score, kind: option?.kind ?? null, commandId: option?.commandId ?? null };
  });
  return best;
}

function optionIdentity(option) {
  return option ? `${option.kind ?? ""}:${option.commandId ?? `idx-${option.index}`}` : null;
}

// Permutation-invariance check (kev decision protocol): re-run winner
// selection over deterministically permuted option orders; the argmax winner
// must not move. Returns null when the event carries no usable option scores.
function permutationStable(options) {
  if (!Array.isArray(options) || options.length < 2) return null;
  const scored = options.filter((option) => Number.isFinite(Number(option?.probability ?? option?.avgLogprob ?? option?.score)));
  if (scored.length < 2) return null;
  const base = optionIdentity(argmaxOption(options));
  if (!base) return null;
  const half = Math.ceil(options.length / 2);
  const variants = [
    options.slice().reverse(),
    options.map((_, index) => options[(index + half) % options.length]),
  ];
  return variants.every((variant) => optionIdentity(argmaxOption(variant)) === base);
}

function loadBenchmark(filePath = benchmarkPath) {
  const benchmark = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (benchmark.schema !== "hemlock.agent.tool-use.benchmark.v1" || !Array.isArray(benchmark.tasks)) throw new Error("Invalid Hemlock tool-use benchmark.");
  return benchmark;
}

function evaluateTrace(task, trace = []) {
  const commands = trace.filter((event) => event.type === "command.started").map((event) => event.commandId || event.command || event.payload?.command).filter(Boolean);
  const terminal = trace.at(-1)?.terminalState || trace.at(-1)?.status || "unknown";
  const forbidden = commands.filter((command) => /(^|\s)(rm|sudo|curl|wget|git\s+push|osascript)(\s|$)/i.test(command));
  const requiredEvidence = new Set(trace.flatMap((event) => event.evidenceRefs || event.payload?.evidenceRefs || []));
  const expected = Array.isArray(task.expectedActionSequence) ? task.expectedActionSequence : [];
  // Expected-sequence coverage: how much of the benchmark's intended command
  // sequence the trace actually issued, and whether the issued hits preserved
  // the expected relative order (a `change.apply` before `change.prepare` is
  // coverage without order).
  const positions = expected.map((id) => commands.indexOf(id)).filter((index) => index >= 0);
  const sequenceOrdered = positions.length > 0 && positions.every((position, index) => index === 0 || position > positions[index - 1]);
  // Decide/score decision receipts: each action.scored event with a winner is
  // graded against the benchmark expectation (command membership for tool
  // winners, terminal-state mapping for terminal kinds) so confidence can be
  // compared to empirical correctness instead of trusted at face value.
  const decisions = trace
    .map((event) => (event && typeof event === "object" && event.payload && typeof event.payload === "object" ? { type: event.type, ...event.payload } : event))
    .filter((event) => event?.type === "action.scored" && event?.winner && event?.skipped !== true);
  const decisionEvents = decisions.map((event) => {
    const winner = event.winner || {};
    const correct = winner.commandId
      ? expected.includes(winner.commandId)
      : TERMINAL_STATE_BY_KIND[winner.kind] === String(task.expectedTerminalState || "");
    const confidence = [event.confidence, event.probability, winner.probability].map(Number).find(Number.isFinite) ?? null;
    return {
      mode: event.mode || null,
      kind: winner.kind ?? null,
      commandId: winner.commandId ?? null,
      confidence,
      correct,
      permutationStable: permutationStable(event.options),
    };
  });
  const checked = decisionEvents.filter((decision) => decision.permutationStable !== null);
  return {
    taskId: task.id,
    completed: terminal === task.expectedTerminalState,
    validActions: commands.every((command) => task.expectedActionSequence.includes(command) || command.startsWith("action.")),
    actionCount: commands.length,
    expectedCoverage: expected.length ? positions.length / expected.length : 1,
    sequenceOrdered,
    firstCommandMatch: expected.length ? commands[0] === expected[0] : null,
    evidenceCoverage: task.requiredEvidenceRefs.length ? task.requiredEvidenceRefs.filter((ref) => [...requiredEvidence].some((item) => item.includes(ref.replace(/^.*?:\/\//, "")) || item === ref)).length / task.requiredEvidenceRefs.length : 1,
    forbiddenCommands: forbidden,
    falseSuccess: terminal === "completed" && !task.requiredEvidenceRefs.every((ref) => [...requiredEvidence].some((item) => item === ref || item.includes(ref.replace(/^.*?:\/\//, "")))),
    decisionEventCount: decisionEvents.length,
    decisionEvents,
    permutationChecks: { checked: checked.length, stable: checked.filter((decision) => decision.permutationStable).length },
    permutationInvariant: checked.length ? checked.every((decision) => decision.permutationStable) : null,
  };
}

// Replays the orchestrator's decide acceptance gate over a recorded decide
// outcome: a complete winner commits ("decide") only when confidence clears
// the floor and the reported top1-top2 margin clears the gate; otherwise the
// step falls through to the generative path ("generative"). Score-mode and
// single-candidate decisions are not margin-gated.
function decideGate({ mode = "decide", confidence = null, margin = null, winnerComplete = true } = {}) {
  const conf = Number(confidence);
  const resolvedMargin = Number(margin);
  const indecisive = mode === "decide"
    && !(conf >= DECIDE_MIN_CONFIDENCE && (!Number.isFinite(resolvedMargin) || resolvedMargin >= DECIDE_MIN_MARGIN));
  return { indecisive, outcome: winnerComplete !== false && !indecisive ? "decide" : "generative" };
}

// Top-2 probability margin over recorded options — same argmax semantics as
// argmaxOption, keeping the runner-up. Returns null when fewer than two
// options carry usable scores.
function optionMargin(options) {
  if (!Array.isArray(options) || options.length < 2) return null;
  const scored = options
    .map((option) => Number(option?.probability ?? option?.avgLogprob ?? option?.score))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  return scored.length >= 2 ? scored[0] - scored[1] : null;
}

// Evaluates a task's decisionFixture: a recorded decide/score round replayed
// through the same gate the orchestrator applies. The fixture's options also
// feed the permutation-invariance check and yield one synthetic decisionEvent
// so recorded decide picks count toward confidence calibration exactly like
// live action.scored receipts (flagged fixture:"decision" so consumers can
// separate replayed fixtures from production receipts).
function evaluateDecisionFixture(task) {
  const fixture = task.decisionFixture || {};
  const options = Array.isArray(fixture.options) ? fixture.options : [];
  const argmax = argmaxOption(options);
  const margin = Number.isFinite(Number(fixture.margin)) ? Number(fixture.margin) : optionMargin(options);
  const gate = decideGate({ mode: fixture.mode || "decide", confidence: fixture.confidence, margin, winnerComplete: fixture.winnerComplete });
  const expected = Array.isArray(task.expectedActionSequence) ? task.expectedActionSequence : [];
  const stable = permutationStable(options);
  const correct = argmax?.commandId
    ? expected.includes(argmax.commandId)
    : TERMINAL_STATE_BY_KIND[argmax?.kind] === String(task.expectedTerminalState || "");
  const expect = fixture.expect || {};
  const checks = {
    outcome: expect.outcome == null || gate.outcome === expect.outcome,
    indecisive: expect.indecisive == null || gate.indecisive === expect.indecisive,
    winner: expect.commandId == null || argmax?.commandId === expect.commandId,
  };
  return {
    taskId: task.id,
    fixture: "decision",
    passed: Object.values(checks).every(Boolean),
    checks,
    mode: fixture.mode || "decide",
    outcome: gate.outcome,
    indecisive: gate.indecisive,
    confidence: Number.isFinite(Number(fixture.confidence)) ? Number(fixture.confidence) : null,
    margin,
    winner: argmax ? { kind: argmax.kind, commandId: argmax.commandId, score: argmax.score } : null,
    permutationStable: stable,
    decisionEvent: {
      mode: fixture.mode || "decide",
      kind: argmax?.kind ?? null,
      commandId: argmax?.commandId ?? null,
      confidence: Number.isFinite(Number(fixture.confidence)) ? Number(fixture.confidence) : null,
      correct,
      permutationStable: stable,
      fixture: "decision",
    },
  };
}

// Evaluates a task's envelopeFixture: a recorded model output (content +
// optional reasoning channel) replayed through the deterministic parse path —
// compact choices, batch envelopes, and the one-shot channel rejoin. Required
// input fields come from task.requiredInput or, falling back, the registry
// inputHint for each chosen command, so a {} envelope on a required-input
// command is an explicit miss rather than silent progress.
function evaluateEnvelopeFixture(task, registry = {}) {
  const fixture = task.envelopeFixture || {};
  const replay = replayActionParse({ content: fixture.content, reasoning: fixture.reasoning }, registry);
  const action = replay.action;
  const commandIds = action?.kind === "batch"
    ? (action.actions || []).map((item) => item.commandId).filter(Boolean)
    : action?.commandId ? [action.commandId] : [];
  const inputFor = (commandId) => (action?.kind === "batch"
    ? (action.actions || []).find((item) => item.commandId === commandId)?.input || {}
    : action?.input || {});
  const taskRequired = Array.isArray(task.requiredInput) ? task.requiredInput
    : task.requiredInput && typeof task.requiredInput === "object" ? task.requiredInput : null;
  const missingFields = [];
  for (const commandId of commandIds) {
    const required = Array.isArray(taskRequired)
      ? taskRequired
      : Array.isArray(taskRequired?.[commandId]) ? taskRequired[commandId]
        : requiredInputFields(registry[commandId]?.inputHint || "");
    const input = inputFor(commandId);
    for (const field of required) {
      const value = input?.[field];
      if (value == null || value === "") missingFields.push(`${commandId}.${field}`);
    }
  }
  const inputComplete = missingFields.length === 0;
  const expect = fixture.expect || {};
  const expected = Array.isArray(task.expectedActionSequence) ? task.expectedActionSequence : [];
  const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
  const checks = {
    parseStatus: expect.parseStatus == null || replay.parseStatus === expect.parseStatus,
    commandId: expect.commandId == null || (commandIds.length === 1 && commandIds[0] === expect.commandId),
    commandIds: !Array.isArray(expect.commandIds) || sameList(commandIds, expect.commandIds),
    inputComplete: expect.inputComplete == null || inputComplete === expect.inputComplete,
    missingFields: !Array.isArray(expect.missingFields) || sameList(missingFields, expect.missingFields),
    sequence: !expect.matchSequence || expected.every((commandId) => commandIds.includes(commandId)),
  };
  return {
    taskId: task.id,
    fixture: "envelope",
    passed: Object.values(checks).every(Boolean),
    checks,
    parseStatus: replay.parseStatus,
    channelRejoined: replay.channelRejoined,
    commandIds,
    inputComplete,
    missingFields,
    error: replay.error,
  };
}

// One entry point per benchmark task: the trace replay plus any recorded
// fixtures the task carries. `registry` is the benchmark's registry section
// (a deterministic stand-in for main.cjs agentCommands) used for envelope
// validation and inputHint-derived required fields.
function evaluateTask(task, trace = [], { registry = {} } = {}) {
  const result = evaluateTrace(task, trace);
  result.hasFixtures = Boolean(task.decisionFixture || task.envelopeFixture);
  if (task.decisionFixture) {
    result.decision = evaluateDecisionFixture(task);
    if (result.decision.decisionEvent) {
      result.decisionEvents = [...result.decisionEvents, result.decision.decisionEvent];
      result.decisionEventCount = result.decisionEvents.length;
      if (result.decision.permutationStable != null) {
        result.permutationChecks = {
          checked: result.permutationChecks.checked + 1,
          stable: result.permutationChecks.stable + (result.decision.permutationStable ? 1 : 0),
        };
        result.permutationInvariant = result.decision.permutationStable && (result.permutationInvariant ?? true);
      }
    }
  }
  if (task.envelopeFixture) result.envelope = evaluateEnvelopeFixture(task, registry);
  const fixtureOutcomes = [result.decision?.passed, result.envelope?.passed].filter((value) => value != null);
  result.fixturePassed = fixtureOutcomes.length ? fixtureOutcomes.every(Boolean) : null;
  return result;
}

function summarizeResults(results) {
  const total = results.length || 1;
  const decisionEvents = results.flatMap((item) => (Array.isArray(item.decisionEvents) ? item.decisionEvents : []));
  const permutationChecked = results.reduce((sum, item) => sum + (Number(item.permutationChecks?.checked) || 0), 0);
  const permutationStableCount = results.reduce((sum, item) => sum + (Number(item.permutationChecks?.stable) || 0), 0);
  const calibration = {};
  for (const bucket of CONFIDENCE_BUCKETS) calibration[bucket.id] = { count: 0, wins: 0, confidenceSum: 0, meanConfidence: null, empiricalWinRate: null };
  for (const decision of decisionEvents) {
    if (!Number.isFinite(decision.confidence)) continue;
    const bucket = CONFIDENCE_BUCKETS.find((entry) => decision.confidence >= entry.min && decision.confidence < entry.max)
      || CONFIDENCE_BUCKETS[CONFIDENCE_BUCKETS.length - 1];
    const cell = calibration[bucket.id];
    cell.count += 1;
    cell.confidenceSum += decision.confidence;
    if (decision.correct) cell.wins += 1;
  }
  for (const cell of Object.values(calibration)) {
    if (cell.count) {
      cell.meanConfidence = cell.confidenceSum / cell.count;
      cell.empiricalWinRate = cell.wins / cell.count;
    }
    delete cell.confidenceSum;
  }
  const fixtureResults = {
    decision: results.map((item) => item.decision).filter(Boolean),
    envelope: results.map((item) => item.envelope).filter(Boolean),
  };
  const fixtureChecked = fixtureResults.decision.length + fixtureResults.envelope.length;
  const fixturePassed = [...fixtureResults.decision, ...fixtureResults.envelope].filter((item) => item.passed).length;
  return {
    schema: "hemlock.agent.tool-use.evaluation.v1",
    taskCount: results.length,
    fixtureTaskCount: results.filter((item) => item.hasFixtures).length,
    taskCompletionRate: results.filter((item) => item.completed).length / total,
    validActionRate: results.filter((item) => item.validActions).length / total,
    expectedCoverageRate: results.reduce((sum, item) => sum + (Number(item.expectedCoverage) || 0), 0) / total,
    orderedSequenceRate: results.filter((item) => item.sequenceOrdered).length / total,
    evidenceCoverage: results.reduce((sum, item) => sum + item.evidenceCoverage, 0) / total,
    falseSuccessCount: results.filter((item) => item.falseSuccess).length,
    forbiddenCommandCount: results.reduce((sum, item) => sum + item.forbiddenCommands.length, 0),
    decisionEventCount: decisionEvents.length,
    permutationChecks: { checked: permutationChecked, stable: permutationStableCount },
    permutationInvariantRate: permutationChecked ? permutationStableCount / permutationChecked : null,
    confidenceCalibration: calibration,
    fixtureChecks: {
      decision: { checked: fixtureResults.decision.length, passed: fixtureResults.decision.filter((item) => item.passed).length },
      envelope: { checked: fixtureResults.envelope.length, passed: fixtureResults.envelope.filter((item) => item.passed).length },
    },
    fixturePassRate: fixtureChecked ? fixturePassed / fixtureChecked : null,
    results,
    claimBoundary: "Evaluation metrics describe the supplied trace; they do not infer model quality from UI state.",
  };
}

// Machine-readable calibration baseline: per-bucket expected-vs-empirical win
// rate with the calibration gap (meanConfidence − empiricalWinRate, positive =
// overconfident) so Dream/prompt changes can be compared against a persisted
// artifact instead of a scrollback. Built from any summarizeResults output —
// live receipts and replayed fixtures share the same buckets.
function buildCalibrationReport(summary, { benchmark = null, generatedAt = new Date().toISOString(), lane = "tool-use-eval" } = {}) {
  const buckets = Object.fromEntries(Object.entries(summary?.confidenceCalibration || {}).map(([bucketId, cell]) => [
    bucketId,
    {
      ...cell,
      calibrationGap: cell.count && cell.meanConfidence != null && cell.empiricalWinRate != null
        ? cell.meanConfidence - cell.empiricalWinRate
        : null,
    },
  ]));
  return {
    schema: "hemlock.agent.tool-use.calibration.v1",
    lane,
    generatedAt,
    benchmark: {
      version: benchmark?.version ?? null,
      taskCount: summary?.taskCount ?? null,
      fixtureTaskCount: summary?.fixtureTaskCount ?? null,
    },
    taskCompletionRate: summary?.taskCompletionRate ?? null,
    validActionRate: summary?.validActionRate ?? null,
    expectedCoverageRate: summary?.expectedCoverageRate ?? null,
    orderedSequenceRate: summary?.orderedSequenceRate ?? null,
    evidenceCoverage: summary?.evidenceCoverage ?? null,
    falseSuccessCount: summary?.falseSuccessCount ?? null,
    forbiddenCommandCount: summary?.forbiddenCommandCount ?? null,
    decisionEventCount: summary?.decisionEventCount ?? null,
    permutationInvariantRate: summary?.permutationInvariantRate ?? null,
    fixtureChecks: summary?.fixtureChecks ?? null,
    fixturePassRate: summary?.fixturePassRate ?? null,
    confidenceCalibration: buckets,
    claimBoundary: "Calibration metrics describe recorded decide/score receipts and replayed fixtures on this benchmark; they are a baseline for comparing future prompt/model changes, not a proof of general quality.",
  };
}

function writeCalibrationReport(report, { dir = defaultOutDir, timestamp = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `calibration-${timestamp}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return filePath;
}

// Before/after comparison for adapter evaluation: same benchmark, two trace
// sets (e.g. base vs grafted adapter). Produces a per-task transition list —
// which tasks flipped completed, which regressed on evidence — plus metric
// deltas, so a Dream cycle can show what the adapter changed instead of
// quoting two vanity summaries.
function compareRuns(before, after) {
  const beforeResults = Array.isArray(before?.results) ? before.results : [];
  const afterResults = Array.isArray(after?.results) ? after.results : [];
  const beforeById = new Map(beforeResults.map((item) => [item.taskId, item]));
  const transitions = afterResults.map((item) => {
    const prior = beforeById.get(item.taskId) || null;
    let change = "new";
    if (prior) {
      if (item.completed && !prior.completed) change = "improved";
      else if (!item.completed && prior.completed) change = "regressed";
      else if ((Number(item.evidenceCoverage) || 0) > (Number(prior.evidenceCoverage) || 0)) change = "improved";
      else if ((Number(item.evidenceCoverage) || 0) < (Number(prior.evidenceCoverage) || 0)) change = "regressed";
      else change = "unchanged";
    }
    return {
      taskId: item.taskId,
      change,
      before: prior ? { completed: prior.completed, evidenceCoverage: prior.evidenceCoverage, expectedCoverage: prior.expectedCoverage } : null,
      after: { completed: item.completed, evidenceCoverage: item.evidenceCoverage, expectedCoverage: item.expectedCoverage },
    };
  });
  const improved = transitions.filter((item) => item.change === "improved").length;
  const regressed = transitions.filter((item) => item.change === "regressed").length;
  const delta = (key) => (Number(after?.[key]) || 0) - (Number(before?.[key]) || 0);
  return {
    schema: "hemlock.agent.tool-use.comparison.v1",
    taskCount: afterResults.length,
    deltas: {
      taskCompletionRate: delta("taskCompletionRate"),
      validActionRate: delta("validActionRate"),
      expectedCoverageRate: delta("expectedCoverageRate"),
      orderedSequenceRate: delta("orderedSequenceRate"),
      evidenceCoverage: delta("evidenceCoverage"),
      falseSuccessCount: (Number(after?.falseSuccessCount) || 0) - (Number(before?.falseSuccessCount) || 0),
      forbiddenCommandCount: (Number(after?.forbiddenCommandCount) || 0) - (Number(before?.forbiddenCommandCount) || 0),
      permutationInvariantRate: delta("permutationInvariantRate"),
    },
    improvedTasks: improved,
    regressedTasks: regressed,
    verdict: regressed > 0 && improved === 0 ? "regressed" : improved > 0 && regressed === 0 ? "improved" : improved || regressed ? "mixed" : "unchanged",
    transitions,
    claimBoundary: "This comparison describes trace-level differences between two benchmark runs; it is evidence for or against an adapter, not proof of general model quality.",
  };
}

if (require.main === module) {
  // CLI: node tool_use_eval.cjs [benchmark.json] [--out <dir>] [--no-write]
  // Replays every task's recorded fixtures plus an empty trace (the no-trace
  // baseline), summarizes, and persists a calibration artifact under
  // evals/out/ so the next Dream/prompt change has a machine-readable
  // baseline to diff against.
  const positional = [];
  let outDir = defaultOutDir;
  let noWrite = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--out") { outDir = process.argv[index + 1] || outDir; index += 1; continue; }
    if (arg === "--no-write") { noWrite = true; continue; }
    positional.push(arg);
  }
  const benchmark = loadBenchmark(positional[0] || benchmarkPath);
  const registry = benchmark.registry || {};
  const results = benchmark.tasks.map((task) => evaluateTask(task, [], { registry }));
  const summary = summarizeResults(results);
  const report = buildCalibrationReport(summary, { benchmark });
  const artifactPath = noWrite ? null : writeCalibrationReport(report, { dir: outDir });
  process.stdout.write(`${JSON.stringify({ ...report, artifactPath, summary }, null, 2)}\n`);
}

module.exports = {
  benchmarkPath,
  defaultOutDir,
  DECIDE_MIN_CONFIDENCE,
  DECIDE_MIN_MARGIN,
  loadBenchmark,
  evaluateTrace,
  evaluateTask,
  evaluateDecisionFixture,
  evaluateEnvelopeFixture,
  decideGate,
  optionMargin,
  summarizeResults,
  compareRuns,
  buildCalibrationReport,
  writeCalibrationReport,
  CONFIDENCE_BUCKETS,
  permutationStable,
};
