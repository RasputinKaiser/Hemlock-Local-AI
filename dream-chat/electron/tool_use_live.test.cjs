const assert = require("node:assert/strict");
const test = require("node:test");
const {
  deriveAllowlist,
  buildActionSystemPrompt,
  extractFirstJsonObject,
  parseModelReply,
  buildLiveToolUseReceipt,
  runLiveToolUseEval,
  compareLiveRuns,
  runAdapterComparison,
} = require("./tool_use_live.cjs");

const FIXTURES = require("../evals/tool-use/benchmark.json");

function envelopeFor(commandId, extra = {}) {
  return JSON.stringify({
    schema: "hemlock.agent.action.v1",
    id: "a1",
    taskId: "t1",
    step: 1,
    kind: "tool",
    commandId,
    input: {},
    shortRationale: "because",
    expectedEvidence: [],
    approval: "none",
    status: "proposed",
    ...extra,
  });
}

test("allowlist is derived from fixture action sequences plus terminal kinds", () => {
  const allowlist = deriveAllowlist(FIXTURES);
  for (const task of FIXTURES.tasks) {
    for (const commandId of task.expectedActionSequence) {
      if (commandId !== "none") assert.equal(allowlist.has(commandId), true, commandId);
    }
  }
  for (const kind of ["ask_user", "blocked", "answer"]) assert.equal(allowlist.has(kind), true);
  assert.equal(allowlist.has("rm -rf"), false);
});

test("system prompt lists allowlisted commands and forbids unearned completion claims", () => {
  const prompt = buildActionSystemPrompt([...deriveAllowlist(FIXTURES)].filter((id) => !["ask_user", "blocked", "answer"].includes(id)));
  assert.match(prompt, /allowedNextCommands/);
  assert.match(prompt, /repo-map/);
  assert.match(prompt, /Do not claim completion without host evidence/);
});

test("lenient JSON extraction handles fences and surrounding prose", () => {
  assert.deepEqual(extractFirstJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractFirstJsonObject('Sure! {"a":{"b":"} trick"}} hope that helps'), { a: { b: "} trick" } });
  assert.throws(() => extractFirstJsonObject("no json here at all"));
});

test("parseModelReply scores envelopes against the allowlist", () => {
  const allowlist = deriveAllowlist({ tasks: FIXTURES.tasks });
  assert.equal(parseModelReply(envelopeFor("repo-map"), allowlist).validEnvelope, true);
  assert.equal(parseModelReply(envelopeFor("rm -rf"), allowlist).parseStatus.startsWith("parsed-unallowlisted"), true);
  assert.equal(parseModelReply("total garbage", allowlist).parseStatus.startsWith("invalid:"), true);
  assert.equal(parseModelReply("", allowlist).parseStatus, "empty");
  const terminal = JSON.stringify({ schema: "hemlock.agent.action.v1", kind: "ask_user", question: "which file?" });
  assert.equal(parseModelReply(terminal, allowlist).validEnvelope, true);
});

test("runLiveToolUseEval happy path aggregates responded and valid envelope rates", async () => {
  const calls = [];
  const inferenceFn = async ({ task }) => {
    calls.push(task.id);
    const byId = {
      "repo-map": "file.search",
      "file-search": "file.read",
      "file-inspection": "repo-map",
    };
    return envelopeFor(byId[task.id]);
  };
  const runResult = await runLiveToolUseEval({ inferenceFn, limit: 3, maxMs: 60000 });
  assert.equal(runResult.taskCount, 3);
  assert.deepEqual(runResult.ranTaskIds, ["repo-map", "file-search", "file-inspection"]);
  assert.equal(runResult.respondedRate, 1);
  // repo-map + file-search valid; file-inspection picked an off-task (but allowlisted) command -> still valid envelope.
  assert.equal(runResult.validEnvelopeRate, 1);
  assert.equal(runResult.results[0].commandId, "file.search");
  assert.equal(calls.length, 3);
  assert.equal(typeof runResult.claimBoundary, "undefined"); // receipt owns the boundary
});

test("runLiveToolUseEval skips remaining tasks once the shared wall clock is exhausted", async () => {
  let callCount = 0;
  const inferenceFn = async () => {
    callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return envelopeFor("repo-map");
  };
  const runResult = await runLiveToolUseEval({ inferenceFn, limit: 4, maxMs: 40 });
  assert.ok(callCount < 4, `expected early skip, made ${callCount} calls`);
  const skipped = runResult.results.filter((item) => item.parseStatus === "skipped-timeout");
  assert.ok(skipped.length >= 1);
  for (const item of skipped) {
    assert.equal(item.responded, false);
    assert.equal(item.commandId, null);
    assert.equal(item.validEnvelope, false);
  }
  assert.ok(runResult.respondedRate < 1);
});

test("inference errors are recorded per task without throwing", async () => {
  const inferenceFn = async ({ task }) => {
    if (task.id === "repo-map") throw new Error("connection refused");
    return envelopeFor("repo-map");
  };
  const runResult = await runLiveToolUseEval({ inferenceFn, limit: 2, maxMs: 60000 });
  assert.match(runResult.results[0].parseStatus, /^error:connection refused/);
  assert.equal(runResult.results[0].responded, false);
  assert.equal(runResult.results[1].validEnvelope, true);
});

test("garbage model output yields invalid parse status and null commandId", async () => {
  const inferenceFn = async () => "I would map the repository using my tools. Done!";
  const runResult = await runLiveToolUseEval({ inferenceFn, limit: 1, maxMs: 60000 });
  assert.equal(runResult.results[0].responded, true);
  assert.match(runResult.results[0].parseStatus, /^invalid:/);
  assert.equal(runResult.results[0].commandId, null);
  assert.equal(runResult.validEnvelopeRate, 0);
});

test("limit respects the requested number of tasks only", async () => {
  let callCount = 0;
  const inferenceFn = async () => {
    callCount += 1;
    return envelopeFor("repo-map");
  };
  const runResult = await runLiveToolUseEval({ inferenceFn, limit: 5, maxMs: 60000 });
  assert.equal(runResult.taskCount, 5);
  assert.equal(callCount, 5);
  assert.equal(runResult.benchmarkTaskIds.length, FIXTURES.tasks.length);
  assert.notDeepEqual(runResult.ranTaskIds.length, runResult.benchmarkTaskIds.length);
});

test("receipt carries a claimBoundary that never claims task completion", () => {
  const runResult = {
    schema: "hemlock.agent.tool-use.live.v1",
    lane: "tool-use-live",
    taskCount: 1,
    results: [{ taskId: "repo-map", responded: true, parseStatus: "parsed", commandId: "repo-map", validEnvelope: true, elapsedMs: 12 }],
    respondedRate: 1,
    validEnvelopeRate: 1,
  };
  const receipt = buildLiveToolUseReceipt(runResult);
  assert.match(receipt.claimBoundary, /response quality/i);
  assert.match(receipt.claimBoundary, /task completion is never claimed/i);
  assert.equal(receipt.taskCompletionRate, undefined);
  assert.equal(receipt.completed, undefined);
});

test("taskMatch distinguishes the right command from merely a valid one", async () => {
  const inferenceFn = async ({ task }) => {
    // Answer every task with its first expected command — or the mapped
    // terminal kind for tasks whose sequence ends in a wait/block state.
    const first = task.expectedActionSequence[0];
    if (task.expectedTerminalState === "waiting_for_approval") return JSON.stringify({ kind: "ask_user", question: "approve?" });
    return envelopeFor(first);
  };
  const runResult = await runLiveToolUseEval({ inferenceFn, limit: 4, maxMs: 60000 });
  // First 4 tasks all expect completed + a specific first command.
  assert.equal(runResult.results[0].taskMatch, true);
  assert.equal(runResult.taskMatchRate, 1);
  // An allowlisted-but-wrong command is a valid envelope yet a task miss
  // (task 0 expects repo-map; file.search parses but doesn't match).
  const wrong = await runLiveToolUseEval({ inferenceFn: async () => envelopeFor("file.search"), limit: 1, maxMs: 60000 });
  assert.equal(wrong.results[0].validEnvelope, true);
  assert.equal(wrong.results[0].taskMatch, false);
  assert.equal(wrong.taskMatchRate, 0);
});

test("terminal kinds match only the expected terminal state", async () => {
  const ask = async () => JSON.stringify({ kind: "ask_user", question: "ok?" });
  // plan-approval expects waiting_for_approval → ask_user is the right call.
  const planTask = FIXTURES.tasks.find((task) => task.id === "plan-approval");
  const benchmark = { schema: "hemlock.agent.tool-use.benchmark.v1", tasks: [planTask] };
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tool-use-live-")), "benchmark.json");
  fs.writeFileSync(tmp, JSON.stringify(benchmark));
  const matched = await runLiveToolUseEval({ inferenceFn: ask, benchmarkPathOverride: tmp, maxMs: 60000 });
  assert.equal(matched.results[0].taskMatch, true);
  // repo-map expects completed — asking a question is the wrong terminal.
  const single = { schema: "hemlock.agent.tool-use.benchmark.v1", tasks: [FIXTURES.tasks[0]] };
  fs.writeFileSync(tmp, JSON.stringify(single));
  const missed = await runLiveToolUseEval({ inferenceFn: ask, benchmarkPathOverride: tmp, maxMs: 60000 });
  assert.equal(missed.results[0].taskMatch, false);
});

test("compareLiveRuns reports per-task transitions and a verdict", async () => {
  const baseRun = {
    lane: "tool-use-live:base",
    respondedRate: 1,
    validEnvelopeRate: 1,
    taskMatchRate: 0.5,
    results: [
      { taskId: "a", responded: true, parseStatus: "parsed", commandId: "repo-map", validEnvelope: true, taskMatch: true },
      { taskId: "b", responded: true, parseStatus: "parsed", commandId: "file.read", validEnvelope: true, taskMatch: false },
    ],
  };
  const candidateRun = {
    lane: "tool-use-live:candidate",
    adapterPath: "/tmp/adapters",
    respondedRate: 1,
    validEnvelopeRate: 1,
    taskMatchRate: 1,
    results: [
      { taskId: "a", responded: true, parseStatus: "parsed", commandId: "repo-map", validEnvelope: true, taskMatch: true },
      { taskId: "b", responded: true, parseStatus: "parsed", commandId: "file.search", validEnvelope: true, taskMatch: true },
    ],
  };
  const comparison = compareLiveRuns(baseRun, candidateRun);
  assert.equal(comparison.schema, "hemlock.agent.tool-use.live-comparison.v1");
  assert.equal(comparison.verdict, "improved");
  assert.equal(comparison.deltas.taskMatchRate, 0.5);
  assert.equal(comparison.candidateAdapterPath, "/tmp/adapters");
  const regressed = compareLiveRuns(candidateRun, baseRun);
  assert.equal(regressed.verdict, "regressed");
  assert.equal(regressed.deltas.taskMatchRate, -0.5);
  assert.match(comparison.claimBoundary, /promotion evidence, not proof/i);
});

test("runAdapterComparison runs base and candidate lanes through the same tasks", async () => {
  const seen = [];
  const inferenceFn = async ({ task, adapterPath }) => {
    seen.push({ taskId: task.id, adapterPath });
    // The adapter lane picks the expected command; the base lane picks a
    // different allowlisted one.
    return envelopeFor(adapterPath ? task.expectedActionSequence[0] : "repo-map");
  };
  const result = await runAdapterComparison({ inferenceFn, adapterPath: "/tmp/adapters", limit: 2, maxMs: 60000 });
  assert.equal(result.base.results.length, 2);
  assert.equal(result.candidate.results.length, 2);
  assert.equal(seen.filter((call) => call.adapterPath === "/tmp/adapters").length, 2);
  assert.equal(seen.filter((call) => call.adapterPath === "").length, 2);
  // Both base picks land on "repo-map": task 0 matches, task 1 misses.
  assert.equal(result.base.taskMatchRate, 0.5);
  assert.equal(result.candidate.taskMatchRate, 1);
  assert.equal(result.comparison.verdict, "improved");
});
