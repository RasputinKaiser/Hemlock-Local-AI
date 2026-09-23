const assert = require("node:assert/strict");
const test = require("node:test");
const { ACTION_SCHEMA, DEFAULT_BUDGET, buildScoreCandidates, clampBudgetOverrides, coerceActionPayload, createObservation, createPlan, extractActionEnvelope, extractJsonObject, mergeBudget, normalizeCompactChoice, normalizeExpectedEvidence, requiredInputFields, validateAction, classifyFailure, pickDecidedCandidate, expectedScoreLevel, rerankByExpectedScore } = require("./agent_contracts.cjs");

test("clamps grantable budget overrides into the allowed step and command range", () => {
  assert.deepEqual(clampBudgetOverrides({ maxAgentSteps: 16, maxCommands: 24 }), { maxAgentSteps: 16, maxCommands: 24 });
  assert.deepEqual(clampBudgetOverrides({ maxAgentSteps: 0, maxCommands: 999 }), { maxAgentSteps: 1, maxCommands: 120 });
  assert.deepEqual(clampBudgetOverrides({ maxAgentSteps: "12", maxRetriesPerOperation: 9 }), { maxAgentSteps: 12 });
});

test("budget override clamping drops garbage and never invents grants", () => {
  assert.deepEqual(clampBudgetOverrides(null), {});
  assert.deepEqual(clampBudgetOverrides("more"), {});
  assert.deepEqual(clampBudgetOverrides({ maxAgentSteps: "lots" }), {});
  const merged = mergeBudget(clampBudgetOverrides({ maxAgentSteps: 20 }));
  assert.equal(merged.maxAgentSteps, 20);
  assert.equal(merged.maxCommands, DEFAULT_BUDGET.maxCommands);
});

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

test("pickDecidedCandidate maps the argmax probability back through cand-<i>", () => {
  const candidates = buildScoreCandidates(["repo-map", "repo.inspect"]);
  const winnerIndex = candidates.findIndex((candidate) => candidate.commandId === "repo.inspect" && candidate.complete);
  const runnerUpIndex = candidates.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete);
  const probabilities = Object.fromEntries(candidates.map((candidate, index) => [`cand-${index}`, index === winnerIndex ? 0.6 : index === runnerUpIndex ? 0.3 : 0.1 / (candidates.length - 2)]));
  const decision = pickDecidedCandidate(candidates, {
    schema: "hemlock.decide.v1",
    answers: { "next-action": { type: "choice", choice: `cand-${winnerIndex}`, confidence: 0.82, probabilities } },
    committedQuestion: "next-action",
    committedKey: `cand-${winnerIndex}`,
    committedText: candidates[winnerIndex].text,
    usage: { promptTokens: 120, cachedTokens: 90 },
  });
  assert.equal(decision.winner.commandId, "repo.inspect");
  assert.equal(decision.winner.complete, true);
  assert.equal(decision.winner.probability, 0.6);
  assert.equal(decision.probability, 0.6);
  assert.equal(decision.confidence, 0.82);
  assert.equal(decision.margin, 0.3);
  assert.equal(decision.runnerUp.commandId, "repo-map");
  assert.equal(decision.candidateCount, candidates.length);
  assert.equal(decision.promptTokens, 120);
  assert.equal(decision.cachedTokens, 90);
});

test("pickDecidedCandidate trusts recomputed argmax over the committed key", () => {
  const candidates = buildScoreCandidates(["repo-map", "repo.inspect"]);
  const argmaxIndex = candidates.findIndex((candidate) => candidate.commandId === "repo.inspect" && candidate.complete);
  const otherIndex = candidates.findIndex((candidate) => candidate.commandId === "repo-map" && candidate.complete);
  const probabilities = Object.fromEntries(candidates.map((candidate, index) => [`cand-${index}`, index === argmaxIndex ? 0.9 : 0.1 / (candidates.length - 1)]));
  const decision = pickDecidedCandidate(candidates, {
    schema: "hemlock.decide.v1",
    answers: { "next-action": { type: "choice", choice: `cand-${otherIndex}`, confidence: 0.5, probabilities } },
    committedQuestion: "next-action",
    committedKey: `cand-${otherIndex}`,
    committedText: candidates[otherIndex].text,
  });
  assert.equal(decision.winner.commandId, "repo.inspect", "probabilities, not the commit, decide the winner");
});

test("pickDecidedCandidate returns null for unusable payloads", () => {
  const candidates = buildScoreCandidates(["repo-map"]);
  assert.equal(pickDecidedCandidate(candidates, null), null);
  assert.equal(pickDecidedCandidate(candidates, {}), null);
  assert.equal(pickDecidedCandidate(candidates, { answers: {} }), null);
  assert.equal(pickDecidedCandidate(candidates, { answers: { "next-action": { type: "noul", text: "hello" } } }), null);
  assert.equal(pickDecidedCandidate(candidates, { answers: { "next-action": { type: "choice", choice: "cand-999", probabilities: { "cand-999": 1 } } } }), null);
  // No probabilities at all: the stated choice still resolves a winner.
  // buildScoreCandidates(["repo-map"]) → [answer, ask_user, blocked, repo-map].
  const fallback = pickDecidedCandidate(candidates, {
    answers: { "next-action": { type: "choice", choice: "cand-3", confidence: 0.4 } },
  });
  assert.equal(fallback.winner.commandId, "repo-map");
  assert.equal(fallback.confidence, 0.4);
  assert.equal(fallback.probability, null);
});

test("expectedScoreLevel and rerankByExpectedScore order records by expected usefulness", () => {
  const levels = ["not useful", "somewhat", "very useful"];
  assert.equal(expectedScoreLevel({ probabilities: { "not useful": 0.2, somewhat: 0.3, "very useful": 0.5 } }, levels), 0.3 + 1);
  assert.equal(expectedScoreLevel({ choice: "very useful" }, levels), 2);
  assert.equal(expectedScoreLevel({ choice: "1" }, levels), 1);
  assert.equal(expectedScoreLevel({ score: 2 }, levels), 2);
  assert.equal(expectedScoreLevel(null, levels), null);
  assert.equal(expectedScoreLevel({ probabilities: {} }, levels), null);
  const records = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const answers = {
    "mem-0": { type: "score", probabilities: { "not useful": 0.8, somewhat: 0.2 } },
    "mem-1": { type: "score", probabilities: { "very useful": 0.9, somewhat: 0.1 } },
    // mem-2 unrated: sorts below every rated record, keeping heuristic order.
  };
  assert.deepEqual(rerankByExpectedScore(records, answers, { levels }).map((record) => record.id), ["b", "a", "c"]);
  assert.equal(rerankByExpectedScore(records, {}, { levels }), null, "no usable answers keeps the heuristic order");
  assert.equal(rerankByExpectedScore(records, null, { levels }), null);
});

test("parseActionEnvelope accepts a bounded batch envelope and normalizes command aliases", () => {
  const { parseActionEnvelope, BATCH_ACTION_LIMITS } = require("./agent_contracts.cjs");
  const registry = { "repo-map": {}, "repo.inspect": {} };
  const batch = parseActionEnvelope(JSON.stringify({
    actions: [
      { command: "repo-map", input: {} },
      { command: "repo.inspect", input: { path: "." } },
    ],
  }), registry);
  assert.equal(batch.schema, ACTION_SCHEMA);
  assert.equal(batch.kind, "batch");
  assert.equal(batch.commandId, null);
  assert.equal(batch.actions.length, 2);
  assert.deepEqual(batch.actions.map((item) => item.commandId), ["repo-map", "repo.inspect"]);
  assert.deepEqual(batch.actions[1].input, { path: "." });
  assert.ok(batch.actions.every((item) => typeof item.shortRationale === "string" && item.shortRationale.trim()));
  // commandId spelling works too.
  const alias = parseActionEnvelope(JSON.stringify({ actions: [{ commandId: "repo-map" }, { commandId: "repo.inspect" }] }), registry);
  assert.equal(alias.kind, "batch");
  assert.equal(alias.actions.length, 2);
  assert.equal(BATCH_ACTION_LIMITS.min, 2);
  assert.equal(BATCH_ACTION_LIMITS.max, 6);
});

test("a single-entry batch normalizes to the existing single-action shape", () => {
  const { parseActionEnvelope } = require("./agent_contracts.cjs");
  const action = parseActionEnvelope(JSON.stringify({ actions: [{ command: "repo-map", input: {} }] }), { "repo-map": {} });
  assert.equal(action.kind, "tool");
  assert.equal(action.commandId, "repo-map");
  assert.equal(action.schema, ACTION_SCHEMA);
  assert.equal(action.status, "proposed");
  assert.equal(Array.isArray(action.actions), false, "no batch wrapper survives normalization");
});

test("batch envelopes enforce registry membership, input shape, and size bounds", () => {
  const { parseActionEnvelope } = require("./agent_contracts.cjs");
  const registry = { "repo-map": {}, "repo.inspect": {} };
  assert.throws(
    () => parseActionEnvelope(JSON.stringify({ actions: [{ command: "repo-map" }, { command: "rm -rf /" }] }), registry),
    /not allowlisted/i,
  );
  assert.throws(
    () => parseActionEnvelope(JSON.stringify({ actions: [{ command: "repo-map" }, { command: "repo.inspect", input: "not-an-object" }] }), registry),
    /input must be an object/i,
  );
  assert.throws(
    () => parseActionEnvelope(JSON.stringify({ actions: [{ command: "repo-map" }, { input: {} }] }), registry),
    /requires a command/i,
  );
  assert.throws(
    () => parseActionEnvelope(JSON.stringify({ actions: [] }), registry),
    /at least one action/i,
  );
  const seven = Array.from({ length: 7 }, (_, index) => ({ command: index % 2 ? "repo.inspect" : "repo-map" }));
  assert.throws(() => parseActionEnvelope(JSON.stringify({ actions: seven }), registry), /capped at 6/i);
  const six = parseActionEnvelope(JSON.stringify({ actions: seven.slice(0, 6) }), registry);
  assert.equal(six.actions.length, 6);
});

test("strips a stray trailing fence after the JSON envelope", () => {
  // Observed Maple output: the model closes a fenced block and then appends
  // one more bare ``` line. The trailing fence is dead markup.
  const action = { kind: "tool", commandId: "repo-map", input: {}, shortRationale: "Map the repo." };
  assert.deepEqual(extractActionEnvelope(`${JSON.stringify(action)}\n\`\`\``), action);
  assert.deepEqual(extractActionEnvelope(`${JSON.stringify(action)}\n\`\`\`json`), action);
  assert.deepEqual(extractActionEnvelope(`\`\`\`json\n${JSON.stringify(action)}\n\`\`\`\n\`\`\``), action);
  // A leading fence without a closing one still parses via the balanced scan.
  assert.deepEqual(extractActionEnvelope(`\`\`\`json\n${JSON.stringify(action)}`), action);
  // A fence-only response is still an honest parse failure.
  assert.throws(() => extractActionEnvelope("```"), /not valid JSON|empty action response/i);
});

test("requiredInputFields reads required names out of a registry inputHint", () => {
  assert.deepEqual(requiredInputFields('{summary, rationale, files?:["repo-relative"], change?:"patch/spec <=32KB", confidence?:0-1}'), ["summary", "rationale"]);
  assert.deepEqual(requiredInputFields('{path:"repo-relative", maxBytes?}'), ["path"]);
  assert.deepEqual(requiredInputFields("{query, path?:\"repo-relative\"}"), ["query"]);
  assert.deepEqual(requiredInputFields('{source|patches:"complete-file map", artifactId?, repairFor?}'), ["source|patches"]);
  assert.deepEqual(requiredInputFields("{}"), []);
  assert.deepEqual(requiredInputFields("{workspaceRoot?}"), []);
  assert.deepEqual(requiredInputFields(null), []);
});

test("createPlan preserves a step's pre-approved input for later input merging", () => {
  const plan = createPlan({
    task: { id: "task-x", objective: "Improve the loop", intent: "improve" },
    steps: [
      { commandId: "receipts.query", label: "Recall evidence" },
      { commandId: "improve.propose", label: "Propose the change", input: { summary: "bounded fix", rationale: "from receipts" } },
    ],
  });
  assert.deepEqual(plan.steps[0].input, {});
  assert.deepEqual(plan.steps[1].input, { summary: "bounded fix", rationale: "from receipts" });
  assert.equal(plan.steps[1].status, "queued");
});

test("classifyFailure resolves real classes instead of defaulting to deterministic-input", () => {
  // The flat default burned the one-shot input repair on failures repair can
  // never fix — budget deaths, malformed envelopes, approval gates.
  const budget = new Error("Hemlock command budget exhausted (40/40).");
  budget.code = "COMMAND_BUDGET_EXHAUSTED";
  assert.equal(classifyFailure(budget), "budget-exhausted");
  assert.equal(classifyFailure(new Error("Hemlock command budget exhausted (40/40).")), "budget-exhausted", "message alone resolves too");
  const malformed = new Error("Maple action response was not valid JSON.");
  malformed.code = "INVALID_ACTION_OUTPUT";
  assert.equal(classifyFailure(malformed), "malformed-envelope");
  assert.equal(classifyFailure(new Error("training.start requires an explicit user action.")), "approval-required");
  assert.equal(classifyFailure(new Error("command shell.exec is not allowlisted")), "safety-blocked");
  assert.equal(classifyFailure(new Error("improve.propose needs a summary of the bounded change.")), "deterministic-input");
  assert.equal(classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1:8080")), "runtime-unavailable");
  assert.equal(classifyFailure(new Error("something unrecognised")), "deterministic-input");
});

test("buildScoreCandidates keeps required-input commands as generative prefixes", () => {
  // A "complete" {} winner for these commands fails deterministic-input
  // validation immediately — scoring may pick them, but the input must be
  // generated, never committed as an empty envelope.
  const candidates = buildScoreCandidates(["improve.propose", "memory.note", "shell.exec", "task.ask", "world.place", "agent.capabilities", "world.state", "dream.dataset.preview", "memory.list", "experiment.suggest", "thread.list"]);
  for (const commandId of ["improve.propose", "memory.note", "shell.exec", "task.ask", "world.place"]) {
    const candidate = candidates.find((item) => item.commandId === commandId);
    assert.ok(candidate, `${commandId} is a candidate`);
    assert.equal(candidate.complete, false, `${commandId} is a prefix candidate`);
    assert.ok(candidate.text.endsWith('"input":'), `${commandId} prefix ends at the input open`);
  }
  for (const commandId of ["agent.capabilities", "world.state", "dream.dataset.preview", "memory.list", "experiment.suggest", "thread.list"]) {
    const candidate = candidates.find((item) => item.commandId === commandId);
    assert.equal(candidate.complete, true, `${commandId} stays a complete zero-token candidate`);
  }
});
