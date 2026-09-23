const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator, contextMaxTokensFor, resolveContextMaxTokens, estimateActionPromptTokens } = require("./agent_orchestrator.cjs");
const { DEFAULT_BUDGET, mergeBudget } = require("./agent_contracts.cjs");
const { ThreadManager } = require("./thread_manager.cjs");

const REGISTRY = {
  "repo-map": { capability: "read", label: "Map repo" },
  "repo.inspect": { capability: "read", label: "Inspect repo" },
};

function makeHarness({ inferAction = null, budget = {}, executeCommand = async (command) => ({ status: "passed", summary: `${command} passed`, evidenceRefs: [`receipt://${command}`] }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-context-budget-"));
  const task = {
    schema: "hemlock.agent.task.v1",
    id: "task-loop",
    objective: "Inspect the Hemlock project",
    intent: "inspect",
    phase: "plan",
    status: "planning",
    budget: { maxAgentSteps: 8, maxCommands: 12, maxRetriesPerOperation: 1, maxMutationSets: 1, maxTrainingCycles: 0, commandsUsed: 0, agentStepsUsed: 0, ...budget },
  };
  const kernel = new AgentKernel({ root, repoRoot: "/tmp/hemlock-project", task });
  let currentTask = task;
  const events = [];
  const orchestrator = new AgentOrchestrator({
    kernel,
    commandRegistry: REGISTRY,
    getTask: () => currentTask,
    setTask: (patch) => { currentTask = { ...currentTask, ...patch }; kernel.syncTask(currentTask); return currentTask; },
    emit: (type, status, payload) => events.push({ type, status, payload }),
    executeCommand,
    inferAction,
  });
  return { root, kernel, orchestrator, events, get task() { return currentTask; } };
}

const ANSWER_CHOICE = JSON.stringify({ kind: "answer", input: { answer: "Done." }, shortRationale: "The bounded inspection is complete." });

// 10 fat history entries per collection: enough serialized weight that the
// chars/4 projection clears any small test budget pre-compaction.
function fatHistory() {
  return {
    plans: [],
    episodes: [],
    actions: Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, step: index + 1, kind: "tool", commandId: "repo-map", status: "completed", shortRationale: "x".repeat(2000), observationId: `o${index}` })),
    observations: Array.from({ length: 10 }, (_, index) => ({ id: `o${index}`, operationId: `op${index}`, status: "passed", summary: "y".repeat(3000), outputDigest: "sha256:x", evidenceRefs: [], structuredOutput: { blob: "z".repeat(2000) } })),
    operations: Array.from({ length: 10 }, (_, index) => ({ id: `op${index}`, command: "repo-map", status: "completed", evidenceRefs: [], error: "e".repeat(1500) })),
  };
}

function slimHistory() {
  return {
    plans: [],
    episodes: [],
    actions: [{ id: "a0", step: 1, kind: "tool", commandId: "repo-map", status: "completed", shortRationale: "Map repo", observationId: "o0" }],
    observations: [{ id: "o0", operationId: "op0", status: "passed", summary: "repo mapped", evidenceRefs: [] }],
    operations: [{ id: "op0", command: "repo-map", status: "completed", evidenceRefs: [] }],
  };
}

test("budget resolves contextMaxTokens from the task budget with a 24000 default", () => {
  assert.equal(mergeBudget({}).contextMaxTokens, DEFAULT_BUDGET.contextMaxTokens);
  assert.equal(contextMaxTokensFor({ budget: {} }), 24000);
  assert.equal(contextMaxTokensFor({ budget: { contextMaxTokens: 12000 } }), 12000);
});

// Env save/restore: the ceiling helpers read process.env per call, so tests
// must not leak overrides into sibling cases.
function withContextEnv(overrides, fn) {
  const keys = ["HEMLOCK_KV_BITS", "HEMLOCK_CONTEXT_MAX_TOKENS", "HEMLOCK_MODEL_MAX_TOKENS"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[key] = String(value);
    }
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("the context default scales with KV quantization state", () => {
  withContextEnv({}, () => {
    assert.equal(contextMaxTokensFor({ budget: {} }), 24000, "exact KV keeps the safe 24000 default");
    process.env.HEMLOCK_KV_BITS = "8";
    assert.equal(contextMaxTokensFor({ budget: {} }), 61440, "8-bit KV raises the default ceiling");
    process.env.HEMLOCK_KV_BITS = "4";
    assert.equal(contextMaxTokensFor({ budget: {} }), 61440, "4-bit KV raises the default ceiling");
    process.env.HEMLOCK_KV_BITS = "0";
    assert.equal(contextMaxTokensFor({ budget: {} }), 24000, "explicit 0 restores the exact default");
  });
});

test("explicit HEMLOCK_CONTEXT_MAX_TOKENS wins over the kv-scaled default, floored at 4096", () => {
  withContextEnv({ HEMLOCK_KV_BITS: "8", HEMLOCK_CONTEXT_MAX_TOKENS: "48000" }, () => {
    assert.equal(contextMaxTokensFor({ budget: {} }), 48000);
  });
  withContextEnv({ HEMLOCK_CONTEXT_MAX_TOKENS: "48000" }, () => {
    assert.equal(contextMaxTokensFor({ budget: {} }), 48000, "explicit env wins over the exact default too");
  });
  withContextEnv({ HEMLOCK_CONTEXT_MAX_TOKENS: "100" }, () => {
    assert.equal(contextMaxTokensFor({ budget: {} }), 4096, "explicit env keeps the 4096 floor");
  });
});

test("a stored task pin wins over env and the kv-scaled default", () => {
  withContextEnv({ HEMLOCK_KV_BITS: "8", HEMLOCK_CONTEXT_MAX_TOKENS: "48000" }, () => {
    assert.equal(contextMaxTokensFor({ budget: { contextMaxTokens: 12000 } }), 12000);
    // A non-positive pin is not a pin — the live default takes over.
    assert.equal(contextMaxTokensFor({ budget: { contextMaxTokens: 0 } }), 48000);
    assert.equal(contextMaxTokensFor({ budget: { contextMaxTokens: null } }), 48000);
  });
});

test("over-ceiling requests clamp to modelMax minus generation headroom, honestly", () => {
  withContextEnv({ HEMLOCK_CONTEXT_MAX_TOKENS: "200000" }, () => {
    const resolved = resolveContextMaxTokens({ budget: {} });
    assert.equal(resolved.requestedMaxTokens, 200000, "the configured value is preserved as requested");
    assert.equal(resolved.maxTokens, 128000 - 2048, "clamped to Maple's 128000 ceiling minus 2048 headroom");
    assert.equal(resolved.clamped, true);
    assert.equal(resolved.modelMaxTokens, 128000);
    assert.equal(resolved.kvBits, 0);
    assert.equal(contextMaxTokensFor({ budget: {} }), 125952);
  });
  withContextEnv({ HEMLOCK_CONTEXT_MAX_TOKENS: "200000", HEMLOCK_MODEL_MAX_TOKENS: "65536" }, () => {
    const resolved = resolveContextMaxTokens({ budget: {} });
    assert.equal(resolved.maxTokens, 65536 - 2048, "the clamp follows an explicit model ceiling override");
    assert.equal(resolved.clamped, true);
  });
  // Values already under the ceiling are never touched.
  withContextEnv({ HEMLOCK_CONTEXT_MAX_TOKENS: "48000" }, () => {
    const resolved = resolveContextMaxTokens({ budget: {} });
    assert.equal(resolved.maxTokens, 48000);
    assert.equal(resolved.clamped, false);
  });
});

test("a clamped ceiling is receipted on the task and in contextUsage", async () => {
  const harness = makeHarness({
    inferAction: async () => ({
      content: ANSWER_CHOICE,
      usage: { prompt_tokens: 5000, completion_tokens: 20 },
    }),
  });
  const saved = {
    HEMLOCK_KV_BITS: process.env.HEMLOCK_KV_BITS,
    HEMLOCK_CONTEXT_MAX_TOKENS: process.env.HEMLOCK_CONTEXT_MAX_TOKENS,
    HEMLOCK_MODEL_MAX_TOKENS: process.env.HEMLOCK_MODEL_MAX_TOKENS,
  };
  try {
    delete process.env.HEMLOCK_KV_BITS;
    delete process.env.HEMLOCK_MODEL_MAX_TOKENS;
    // The env write reaches a running task on its next request because the
    // task never pinned a ceiling (contextMaxTokens stays null in the stored
    // budget).
    process.env.HEMLOCK_CONTEXT_MAX_TOKENS = "200000";
    const plan = { id: "plan-1", steps: [{ commandId: "repo.inspect", label: "Inspect repo" }] };
    await harness.orchestrator.infer(harness.task, plan, slimHistory());
    const usage = harness.task.contextUsage;
    assert.equal(usage.maxTokens, 125952);
    assert.equal(usage.requestedMaxTokens, 200000);
    assert.equal(usage.maxTokensClamped, true);
    assert.equal(usage.kvBits, 0);
    const clamped = harness.events.find((event) => event.type === "context.ceiling.clamped");
    assert.ok(clamped, "the clamp is receipted on the event spine");
    assert.equal(clamped.payload.requestedMaxTokens, 200000);
    assert.equal(clamped.payload.maxTokens, 125952);
    assert.equal(clamped.payload.modelMaxTokens, 128000);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("estimateActionPromptTokens projects only the volatile request region", () => {
  const estimate = estimateActionPromptTokens({
    system: "s".repeat(4000),
    sessionTurns: [{ role: "user", content: "u".repeat(4000) }],
    task: { id: "t", objective: "o".repeat(4000) },
    history: { actions: [], observations: [], operations: [] },
  });
  assert.equal(estimate, Math.ceil((4000 + 4000 + JSON.stringify({ task: { id: "t", objective: "o".repeat(4000) }, nextStep: null, allowedNextCommands: null, progress: null, completed: { actions: [], observations: [], operations: [] }, repair: null }).length) / 4));
});

test("over-budget request compacts: drops stale detail, receipts context.compacted, and notes it in the prompt", async () => {
  const calls = [];
  const harness = makeHarness({
    budget: { contextMaxTokens: 6000 },
    inferAction: async (prompt) => { calls.push(prompt); return ANSWER_CHOICE; },
  });
  try {
    const plan = { id: "plan-1", steps: [{ commandId: "repo.inspect", label: "Inspect repo" }] };
    const action = await harness.orchestrator.infer(harness.task, plan, fatHistory());
    assert.equal(action.kind, "answer");
    const compacted = harness.events.find((event) => event.type === "context.compacted");
    assert.ok(compacted, "context.compacted was emitted");
    assert.equal(compacted.payload.outcome, "compacted");
    assert.equal(compacted.payload.estimated, true);
    assert.equal(compacted.payload.maxTokens, 6000);
    assert.ok(compacted.payload.dropped.observationDetails > 0, "stale observation text dropped");
    const note = calls[0].progress?.contextCompaction;
    assert.ok(note, "prompt progress carries the compaction note");
    assert.match(note.note, /earlier steps compacted/);
    // Stale observations keep ids + status; their text was dropped. The
    // freshest row stays whole so the current step keeps full fidelity.
    const observations = calls[0].history.observations;
    assert.equal(observations.length, 10);
    const stale = observations[0];
    assert.equal(stale.id, "o0");
    assert.equal(stale.status, "passed");
    assert.equal("summary" in stale, false);
    assert.equal("structuredOutput" in stale, false);
    assert.equal(observations.at(-1).id, "o9");
    assert.ok(observations.at(-1).summary, "freshest observation keeps its text");
    // Older actions lost their rationale but keep identity + status.
    const staleAction = calls[0].history.actions[0];
    assert.equal(staleAction.id, "a0");
    assert.equal(staleAction.status, "completed");
    assert.equal("shortRationale" in staleAction, false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("deeper overage shrinks the history tail itself and re-expands slim when the transcript carried context", async () => {
  const calls = [];
  const harness = makeHarness({
    budget: { contextMaxTokens: 3000 },
    inferAction: async (prompt) => { calls.push(prompt); return ANSWER_CHOICE; },
  });
  try {
    const plan = { id: "plan-1", steps: [{ commandId: "repo.inspect", label: "Inspect repo" }] };
    const action = await harness.orchestrator.infer(harness.task, plan, fatHistory());
    assert.equal(action.kind, "answer");
    const compacted = harness.events.find((event) => event.type === "context.compacted");
    assert.ok(compacted, "context.compacted was emitted");
    assert.equal(compacted.payload.outcome, "compacted");
    assert.ok(compacted.payload.dropped.historyEntries > 0, "the history tail shrank");
    // Whatever remains keeps identity + status; only the freshest rows keep text.
    const observations = calls[0].history.observations;
    assert.ok(observations.length > 0 && observations.length < 10);
    assert.equal(observations.at(-1).id, "o9");
    assert.ok(calls[0].history.actions.every((entry) => entry.id && entry.status));
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("compaction shrinks the replayed session tail from the front", async () => {
  const calls = [];
  const harness = makeHarness({
    budget: { contextMaxTokens: 2000 },
    inferAction: async (prompt) => { calls.push(prompt); return ANSWER_CHOICE; },
  });
  try {
    // Seed a 10-turn continuous-KV transcript (~8K chars → ~2000 estimated tokens).
    harness.orchestrator._sessionTurns.set("task-loop", Array.from({ length: 10 }, (_, index) => index % 2 === 0
      ? { role: "user", content: "u".repeat(800) }
      : { role: "assistant", content: "a".repeat(800), reasoning_content: "r" }));
    const plan = { id: "plan-1", steps: [{ commandId: "repo.inspect", label: "Inspect repo" }] };
    await harness.orchestrator.infer(harness.task, plan, slimHistory());
    const compacted = harness.events.find((event) => event.type === "context.compacted");
    assert.ok(compacted, "context.compacted was emitted");
    assert.ok(compacted.payload.dropped.sessionTurns > 0, "replayed turns were dropped");
    assert.ok(calls[0].sessionTurns.length <= 4, `replayed tail bounded, got ${calls[0].sessionTurns.length}`);
    assert.equal(calls[0].sessionTurns[0]?.role, "user", "drop stays pair-aligned so a user turn leads");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("server usage lands in task metrics and the rolling contextUsed estimate", async () => {
  const harness = makeHarness({
    inferAction: async () => ({
      content: ANSWER_CHOICE,
      usage: { prompt_tokens: 5000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 4200 } },
    }),
  });
  try {
    const plan = { id: "plan-1", steps: [{ commandId: "repo.inspect", label: "Inspect repo" }] };
    await harness.orchestrator.infer(harness.task, plan, slimHistory());
    const usage = harness.task.contextUsage;
    assert.ok(usage, "contextUsage recorded on the task");
    assert.equal(usage.taskId, "task-loop");
    assert.equal(usage.usedTokens, 5020);
    assert.equal(usage.promptTokens, 5000);
    assert.equal(usage.completionTokens, 20);
    assert.equal(usage.cachedTokens, 4200);
    assert.equal(usage.source, "server-usage");
    // The estimate stays a labeled estimate — never conflated with usage.
    assert.ok(Number.isFinite(usage.estimatedTokens));
    assert.notEqual(usage.estimatedTokens, usage.usedTokens);
    assert.equal(usage.maxTokens, 24000);
    const metrics = harness.task.metrics;
    assert.equal(metrics.promptTokens, 5000);
    assert.equal(metrics.completionTokens, 20);
    assert.equal(metrics.cachedTokens, 4200);
    assert.equal(metrics.contextPeakTokens, 5020);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("decide/score transport usage also lands in context accounting", async () => {
  const calls = [];
  const harness = makeHarness({ inferAction: async (prompt) => { calls.push(prompt); return ANSWER_CHOICE; } });
  harness.orchestrator.scoreActions = {
    decide: async () => ({
      answers: { "next-action": { type: "choice", winner: "cand-0", probabilities: { "cand-0": 0.9 }, confidence: 0.9 } },
      usage: { promptTokens: 1200, cachedTokens: 900 },
      promptTokens: 1200,
      cachedTokens: 900,
      requestContent: "{}",
    }),
  };
  try {
    const plan = { id: "plan-1", steps: [{ commandId: "repo.inspect", label: "Inspect repo" }] };
    await harness.orchestrator.infer(harness.task, plan, slimHistory());
    assert.equal(harness.task.contextUsage.usedTokens, 1200);
    assert.equal(harness.task.contextUsage.cachedTokens, 900);
    assert.equal(harness.task.metrics.promptTokens, 1200);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a request that cannot compact under the ceiling blocks honestly instead of crashing", async () => {
  let inferCalls = 0;
  const harness = makeHarness({
    budget: { contextMaxTokens: 10 },
    inferAction: async () => { inferCalls += 1; return ANSWER_CHOICE; },
  });
  try {
    const proposed = harness.orchestrator.proposePlan(harness.task, { steps: [{ commandId: "repo-map", label: "Map repo" }] });
    const result = await harness.orchestrator.approvePlan(harness.task.id, proposed.plan.id);
    assert.equal(result.status, "blocked");
    assert.equal(harness.task.status, "blocked");
    assert.match(harness.task.blockedReason, /Context budget exhausted/);
    assert.match(harness.task.blockedReason, /conversation\.reset/);
    assert.equal(inferCalls, 0, "no inference was spent on an unbounded request");
    const compacted = harness.events.find((event) => event.type === "context.compacted");
    assert.ok(compacted, "the failed compaction is still receipted");
    assert.equal(compacted.payload.outcome, "exhausted");
    const blocked = harness.events.find((event) => event.type === "task.blocked");
    assert.ok(blocked);
    assert.equal(blocked.payload.contextExhausted, true);
    assert.equal(blocked.payload.suggestion, "fresh-thread-or-context-reset");
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("under-budget requests run uncompacted and emit no context.compacted", async () => {
  const calls = [];
  const harness = makeHarness({ inferAction: async (prompt) => { calls.push(prompt); return ANSWER_CHOICE; } });
  try {
    const plan = { id: "plan-1", steps: [{ commandId: "repo.inspect", label: "Inspect repo" }] };
    await harness.orchestrator.infer(harness.task, plan, slimHistory());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].progress.contextCompaction, undefined);
    assert.equal(harness.events.some((event) => event.type === "context.compacted"), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("trimConversation archives the oldest tail and keeps the recent messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-threads-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "A\n");
  try {
    const manager = new ThreadManager({ root: path.join(root, "runtime"), defaultWorkspaceRoot: project });
    const thread = manager.ensureDefaultThread();
    for (let index = 0; index < 10; index += 1) {
      manager.appendConversation(thread.id, { role: index % 2 ? "assistant" : "user", content: `message ${index}` });
    }
    const trimmed = manager.trimConversation(thread.id, { keep: 4 });
    assert.equal(trimmed.kept, 4);
    assert.equal(trimmed.dropped, 6);
    assert.ok(trimmed.archivePath && fs.existsSync(trimmed.archivePath));
    const conversation = manager.readConversation(thread.id);
    assert.equal(conversation.length, 4);
    assert.equal(conversation.at(-1).content, "message 9");
    assert.equal(conversation[0].content, "message 6");
    // A second trim within budget is a no-op — nothing fabricated.
    const noop = manager.trimConversation(thread.id, { keep: 4 });
    assert.equal(noop.dropped, 0);
    assert.equal(noop.archivePath, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
