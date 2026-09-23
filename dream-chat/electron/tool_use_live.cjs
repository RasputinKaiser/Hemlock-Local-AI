const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { benchmarkPath, loadBenchmark } = require("./tool_use_eval.cjs");

const SCHEMA_LIVE = "hemlock.agent.tool-use.live.v1";
const SCHEMA_COMPARISON = "hemlock.agent.tool-use.live-comparison.v1";
// Terminal kinds the orchestrator accepts instead of a tool command (agent_orchestrator.cjs).
const TERMINAL_KINDS = new Set(["ask_user", "blocked", "answer"]);
// Terminal kind -> the benchmark expectedTerminalState it would produce if
// the host executed it. Used to score whether a terminal answer was the
// RIGHT terminal answer (asking for approval on a task that should complete
// is a miss, not a pass).
const TERMINAL_STATE_BY_KIND = { ask_user: "waiting_for_approval", blocked: "blocked", answer: "completed" };
const MAX_TOKENS = 1536;
const DEFAULT_ENDPOINT = "http://127.0.0.1:8080";

// Fixture-derived allowlist: every expectedActionSequence entry across the benchmark,
// so "valid envelope" means the model picked a command the benchmark itself expects to exist.
function deriveAllowlist(benchmark) {
  const commands = new Set(TERMINAL_KINDS);
  for (const task of benchmark.tasks) {
    for (const commandId of task.expectedActionSequence || []) {
      if (commandId && commandId !== "none") commands.add(commandId);
    }
  }
  return commands;
}

function buildActionSystemPrompt(allowlistCommands) {
  return [
    "You are Maple operating inside Hemlock.",
    "Return exactly one compact JSON action envelope in the content channel and no prose or markdown.",
    "The host owns id, taskId, step, kind, commandId validation, approval, expectedEvidence, and status lifecycle. Do not spend output on host-owned fields beyond the required envelope.",
    "You may return kind ask_user when a real user decision is needed, kind blocked when a host boundary prevents progress, or kind answer when the request is genuinely answerable without another command. Do not claim completion without host evidence.",
    '{"schema":"hemlock.agent.action.v1","id":"a","taskId":"t","step":1,"kind":"tool","commandId":"registered-command","input":{},"shortRationale":"Short reason","expectedEvidence":[],"approval":"none","status":"proposed"}',
    `allowedNextCommands: ${JSON.stringify([...allowlistCommands])}`,
    "Choose exactly one commandId from allowedNextCommands (or a terminal kind). Never invent a commandId outside that list.",
  ].join("\n");
}

// Lenient JSON extraction: tolerate code fences, leading/trailing prose, and multiple
// objects by scanning for the first balanced top-level {...} block that parses.
function extractFirstJsonObject(text) {
  const raw = String(text || "");
  let source = raw.trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) source = fenced[1].trim();
  try {
    return JSON.parse(source);
  } catch {}
  let start = -1;
  while ((start = source.indexOf("{", start + 1)) !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { break; }
        }
      }
    }
  }
  throw new Error("no parseable JSON object found");
}

// Parse one model reply into an action-envelope verdict. Pure: no network, no fs.
function parseModelReply(content, allowlist = null) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return { parseStatus: "empty", envelope: null, kind: null, commandId: null, validEnvelope: false };
  try {
    const envelope = extractFirstJsonObject(trimmed);
    const kind = typeof envelope.kind === "string" ? envelope.kind : "tool";
    const commandId = typeof envelope.commandId === "string" ? envelope.commandId : null;
    if (!TERMINAL_KINDS.has(kind) && kind !== "tool") {
      return { parseStatus: `invalid:unknown-kind:${kind}`, envelope, kind, commandId, validEnvelope: false };
    }
    if (TERMINAL_KINDS.has(kind)) {
      return { parseStatus: "parsed", envelope, kind, commandId: commandId || null, validEnvelope: true };
    }
    if (!commandId) {
      return { parseStatus: "invalid:missing-commandId", envelope, kind, commandId: null, validEnvelope: false };
    }
    if (allowlist && !allowlist.has(commandId)) {
      return { parseStatus: "parsed-unallowlisted", envelope, kind, commandId, validEnvelope: false };
    }
    return { parseStatus: "parsed", envelope, kind, commandId, validEnvelope: true };
  } catch (error) {
    return { parseStatus: `invalid:${error.message}`, envelope: null, kind: null, commandId: null, validEnvelope: false };
  }
}

// Injectable-for-tests default caller. Honors the shared wall-clock budget via
// AbortController. `adapterPath` grafts a LoRA adapter onto the request the
// same way codingInference does (`adapters` field), so base and candidate
// lanes run identical prompts against the same served weights.
async function fetchInference({ endpoint, system, user, remainingMs, signal, adapterPath = "" } = {}) {
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("tool-use-live-budget"), Math.max(1000, remainingMs));
  const owned = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: process.env.HEMLOCK_MAPLE_MODEL || "default_model",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        top_p: 1,
        top_k: 0,
        max_tokens: MAX_TOKENS,
        stream: false,
        ...(adapterPath ? { adapters: adapterPath } : {}),
      }),
      signal: owned,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message || {};
    return String(message.content || "");
  } finally {
    clearTimeout(timer);
  }
}

// Score one parsed verdict against the task it answered: a tool envelope hits
// when its commandId is inside the benchmark's expectedActionSequence, a
// terminal kind hits when it maps to the task's expectedTerminalState.
function taskMatch(task, verdict) {
  if (!verdict || !verdict.validEnvelope) return false;
  const expected = Array.isArray(task?.expectedActionSequence) ? task.expectedActionSequence : [];
  if (verdict.kind && TERMINAL_KINDS.has(verdict.kind)) {
    return TERMINAL_STATE_BY_KIND[verdict.kind] === String(task?.expectedTerminalState || "");
  }
  return expected.includes(verdict.commandId);
}

// Run every fixture input through the model once, score response quality only.
async function runLiveToolUseEval(options = {}) {
  const {
    endpoint = process.env.HEMLOCK_MAPLE_BASE || DEFAULT_ENDPOINT,
    maxMs = Number(process.env.HEMLOCK_MAPLE_MAX_MS || 600000),
    limit = null,
    inferenceFn = null,
    benchmarkPathOverride = benchmarkPath,
    adapterPath = "",
    lane = "tool-use-live",
    now = () => Date.now(),
  } = options;
  const infer = inferenceFn || ((args) => fetchInference({ ...args, endpoint, adapterPath }));
  const startedAt = now();
  const benchmark = loadBenchmark(benchmarkPathOverride);
  const tasks = Number.isFinite(limit) && limit > 0 ? benchmark.tasks.slice(0, limit) : benchmark.tasks;
  const allowlist = options.allowlist instanceof Set ? options.allowlist : deriveAllowlist(benchmark);
  const system = buildActionSystemPrompt([...allowlist].filter((id) => !TERMINAL_KINDS.has(id)));
  const results = [];

  for (const task of tasks) {
    const elapsedBefore = now() - startedAt;
    const remainingMs = maxMs - elapsedBefore;
    if (remainingMs <= 0) {
      // Skip remaining on wall-clock timeout, mirroring e2e_artistic_maple behavior.
      results.push({ taskId: task.id, responded: false, parseStatus: "skipped-timeout", kind: null, commandId: null, validEnvelope: false, taskMatch: false, elapsedMs: 0 });
      continue;
    }
    const taskStartedAt = now();
    let content = "";
    let failure = null;
    try {
      content = await infer({ task, system, user: String(task.input), remainingMs, adapterPath });
    } catch (error) {
      failure = error;
    }
    const elapsedMs = now() - taskStartedAt;
    if (failure) {
      const timedOut = failure.name === "AbortError" || /budget|abort/i.test(String(failure.message));
      results.push({
        taskId: task.id,
        responded: false,
        parseStatus: timedOut ? "skipped-timeout" : `error:${String(failure.message).slice(0, 200)}`,
        kind: null,
        commandId: null,
        validEnvelope: false,
        taskMatch: false,
        elapsedMs,
      });
      continue;
    }
    const verdict = parseModelReply(content, allowlist);
    results.push({
      taskId: task.id,
      responded: Boolean(String(content || "").trim()),
      parseStatus: verdict.parseStatus,
      kind: verdict.kind || null,
      commandId: verdict.validEnvelope ? verdict.commandId : null,
      validEnvelope: verdict.validEnvelope,
      expectedCommands: Array.isArray(task.expectedActionSequence) ? task.expectedActionSequence : [],
      taskMatch: taskMatch(task, verdict),
      elapsedMs,
    });
  }

  const total = results.length || 1;
  return {
    schema: SCHEMA_LIVE,
    lane,
    endpoint: String(endpoint),
    adapterPath: adapterPath || null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    elapsedMs: now() - startedAt,
    taskCount: results.length,
    benchmarkTaskIds: benchmark.tasks.map((task) => task.id),
    ranTaskIds: results.map((item) => item.taskId),
    respondedRate: results.filter((item) => item.responded).length / total,
    validEnvelopeRate: results.filter((item) => item.validEnvelope).length / total,
    // The honest quality signal: did the model pick the command (or terminal
    // kind) the benchmark expected, not merely any well-formed envelope.
    taskMatchRate: results.filter((item) => item.taskMatch).length / total,
    allowlist: [...allowlist],
    maxTokens: MAX_TOKENS,
    results,
  };
}

// Before/after comparison of two live runs (e.g. base vs grafted adapter).
// Per-task transitions show exactly which task selections improved or
// regressed — the signal a Dream cycle needs to decide whether an adapter
// earned promotion, instead of diffing two rate numbers by eye.
function compareLiveRuns(before, after) {
  const beforeResults = Array.isArray(before?.results) ? before.results : [];
  const afterResults = Array.isArray(after?.results) ? after.results : [];
  const beforeById = new Map(beforeResults.map((item) => [item.taskId, item]));
  const transitions = afterResults.map((item) => {
    const prior = beforeById.get(item.taskId) || null;
    let change = "new";
    if (prior) {
      if (item.taskMatch && !prior.taskMatch) change = "improved";
      else if (!item.taskMatch && prior.taskMatch) change = "regressed";
      else if (item.validEnvelope && !prior.validEnvelope) change = "improved";
      else if (!item.validEnvelope && prior.validEnvelope) change = "regressed";
      else if (item.commandId !== prior.commandId) change = "changed-command";
      else change = "unchanged";
    }
    return {
      taskId: item.taskId,
      change,
      before: prior ? { responded: prior.responded, parseStatus: prior.parseStatus, commandId: prior.commandId, validEnvelope: prior.validEnvelope, taskMatch: prior.taskMatch } : null,
      after: { responded: item.responded, parseStatus: item.parseStatus, commandId: item.commandId, validEnvelope: item.validEnvelope, taskMatch: item.taskMatch },
    };
  });
  const improved = transitions.filter((item) => item.change === "improved").length;
  const regressed = transitions.filter((item) => item.change === "regressed").length;
  const delta = (key) => (Number(after?.[key]) || 0) - (Number(before?.[key]) || 0);
  return {
    schema: SCHEMA_COMPARISON,
    baseLane: before?.lane || "base",
    candidateLane: after?.lane || "candidate",
    baseAdapterPath: before?.adapterPath ?? null,
    candidateAdapterPath: after?.adapterPath ?? null,
    taskCount: afterResults.length,
    deltas: {
      respondedRate: delta("respondedRate"),
      validEnvelopeRate: delta("validEnvelopeRate"),
      taskMatchRate: delta("taskMatchRate"),
    },
    improvedTasks: improved,
    regressedTasks: regressed,
    verdict: regressed > 0 && improved === 0 ? "regressed" : improved > 0 && regressed === 0 ? "improved" : improved || regressed ? "mixed" : "unchanged",
    transitions,
    claimBoundary:
      "This comparison measures structured action selection between two runs on the same benchmark — which commandId or terminal kind the model chose per task. No host action was executed in either lane, and a positive verdict is promotion evidence, not proof of general quality.",
  };
}

// Run the benchmark twice — once on the base model, once with `adapterPath`
// grafted — and emit the comparison. `inferenceFn` stays injectable; it
// receives `adapterPath` so tests can simulate per-lane behavior.
async function runAdapterComparison(options = {}) {
  const { adapterPath = "", inferenceFn = null, ...rest } = options;
  const infer = inferenceFn || ((args) => fetchInference({ ...args, endpoint: options.endpoint }));
  const base = await runLiveToolUseEval({ ...rest, inferenceFn: (args) => infer({ ...args, adapterPath: "" }), adapterPath: "", lane: "tool-use-live:base" });
  const candidate = await runLiveToolUseEval({ ...rest, inferenceFn: (args) => infer({ ...args, adapterPath }), adapterPath, lane: "tool-use-live:candidate" });
  const comparison = compareLiveRuns(base, candidate);
  return { schema: SCHEMA_COMPARISON, lane: "tool-use-live-comparison", base, candidate, comparison };
}

// Receipt assembly stays here; writing is the caller's job (CLI writes its own).
function buildLiveToolUseReceipt(runResult, extras = {}) {
  return {
    schema: SCHEMA_LIVE,
    lane: "tool-use-live",
    ...runResult,
    claimBoundary:
      extras.claimBoundary ||
      "This lane measures structured-action response quality only: whether the model returned a parseable hemlock.agent.action.v1 envelope naming an allowlisted commandId or terminal kind. No host action was executed, no evidence was collected, and task completion is NEVER claimed by this runner.",
    ...extras,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Dual mode: also runnable as a CLI against a live local server (default
// http://127.0.0.1:8080). Set HEMLOCK_TOOL_USE_ADAPTER to an adapter dir to
// run base-vs-adapter comparison mode instead of a single pass.
if (require.main === module) {
  const cliMaxMs = Number(process.env.HEMLOCK_MAPLE_MAX_MS || 600000);
  const cliLimitRaw = Number(process.env.HEMLOCK_TOOL_USE_LIMIT);
  const cliEndpoint = process.env.HEMLOCK_MAPLE_BASE || DEFAULT_ENDPOINT;
  const cliAdapter = String(process.env.HEMLOCK_TOOL_USE_ADAPTER || "").trim();
  const cliLimit = Number.isFinite(cliLimitRaw) && cliLimitRaw > 0 ? cliLimitRaw : null;
  const receiptDir = path.join(os.homedir(), "Library", "Application Support", "Hemlock", "e2e", "tool-use-live");
  const receiptPath = path.join(receiptDir, `tool-use-live-${Date.now()}.json`);
  const run = cliAdapter
    ? runAdapterComparison({ endpoint: cliEndpoint, maxMs: cliMaxMs, limit: cliLimit, adapterPath: cliAdapter })
        .then((result) => buildLiveToolUseReceipt(result, { endpoint: cliEndpoint, adapterPath: cliAdapter }))
    : runLiveToolUseEval({ endpoint: cliEndpoint, maxMs: cliMaxMs, limit: cliLimit })
        .then((runResult) => buildLiveToolUseReceipt(runResult, { endpoint: cliEndpoint }));
  run
    .then((receipt) => {
      writeJson(receiptPath, receipt);
      process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  SCHEMA_LIVE,
  SCHEMA_COMPARISON,
  TERMINAL_KINDS,
  TERMINAL_STATE_BY_KIND,
  MAX_TOKENS,
  benchmarkPath,
  loadBenchmark,
  deriveAllowlist,
  buildActionSystemPrompt,
  extractFirstJsonObject,
  parseModelReply,
  taskMatch,
  fetchInference,
  runLiveToolUseEval,
  compareLiveRuns,
  runAdapterComparison,
  buildLiveToolUseReceipt,
};
