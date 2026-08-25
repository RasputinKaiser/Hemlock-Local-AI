const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { benchmarkPath, loadBenchmark } = require("./tool_use_eval.cjs");

const SCHEMA_LIVE = "hemlock.agent.tool-use.live.v1";
// Terminal kinds the orchestrator accepts instead of a tool command (agent_orchestrator.cjs).
const TERMINAL_KINDS = new Set(["ask_user", "blocked", "answer"]);
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
  if (!trimmed) return { parseStatus: "empty", envelope: null, commandId: null, validEnvelope: false };
  try {
    const envelope = extractFirstJsonObject(trimmed);
    const kind = typeof envelope.kind === "string" ? envelope.kind : "tool";
    const commandId = typeof envelope.commandId === "string" ? envelope.commandId : null;
    if (!TERMINAL_KINDS.has(kind) && kind !== "tool") {
      return { parseStatus: `invalid:unknown-kind:${kind}`, envelope, commandId, validEnvelope: false };
    }
    if (TERMINAL_KINDS.has(kind)) {
      return { parseStatus: "parsed", envelope, commandId: commandId || null, validEnvelope: true };
    }
    if (!commandId) {
      return { parseStatus: "invalid:missing-commandId", envelope, commandId: null, validEnvelope: false };
    }
    if (allowlist && !allowlist.has(commandId)) {
      return { parseStatus: "parsed-unallowlisted", envelope, commandId, validEnvelope: false };
    }
    return { parseStatus: "parsed", envelope, commandId, validEnvelope: true };
  } catch (error) {
    return { parseStatus: `invalid:${error.message}`, envelope: null, commandId: null, validEnvelope: false };
  }
}

// Injectable-for-tests default caller. Honors the shared wall-clock budget via AbortController.
async function fetchInference({ endpoint, system, user, remainingMs, signal } = {}) {
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

// Run every fixture input through the model once, score response quality only.
async function runLiveToolUseEval(options = {}) {
  const {
    endpoint = process.env.HEMLOCK_MAPLE_BASE || DEFAULT_ENDPOINT,
    maxMs = Number(process.env.HEMLOCK_MAPLE_MAX_MS || 600000),
    limit = null,
    inferenceFn = null,
    benchmarkPathOverride = benchmarkPath,
    now = () => Date.now(),
  } = options;
  const infer = inferenceFn || ((args) => fetchInference({ ...args, endpoint }));
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
      results.push({ taskId: task.id, responded: false, parseStatus: "skipped-timeout", commandId: null, validEnvelope: false, elapsedMs: 0 });
      continue;
    }
    const taskStartedAt = now();
    let content = "";
    let failure = null;
    try {
      content = await infer({ task, system, user: String(task.input), remainingMs });
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
        commandId: null,
        validEnvelope: false,
        elapsedMs,
      });
      continue;
    }
    const verdict = parseModelReply(content, allowlist);
    results.push({
      taskId: task.id,
      responded: Boolean(String(content || "").trim()),
      parseStatus: verdict.parseStatus,
      commandId: verdict.validEnvelope ? verdict.commandId : null,
      validEnvelope: verdict.validEnvelope,
      elapsedMs,
    });
  }

  const total = results.length || 1;
  return {
    schema: SCHEMA_LIVE,
    lane: "tool-use-live",
    endpoint: String(endpoint),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    elapsedMs: now() - startedAt,
    taskCount: results.length,
    benchmarkTaskIds: benchmark.tasks.map((task) => task.id),
    ranTaskIds: results.map((item) => item.taskId),
    respondedRate: results.filter((item) => item.responded).length / total,
    validEnvelopeRate: results.filter((item) => item.validEnvelope).length / total,
    allowlist: [...allowlist],
    maxTokens: MAX_TOKENS,
    results,
  };
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

// Dual mode: also runnable as a CLI against a live local server (default http://127.0.0.1:8080).
if (require.main === module) {
  const cliMaxMs = Number(process.env.HEMLOCK_MAPLE_MAX_MS || 600000);
  const cliLimitRaw = Number(process.env.HEMLOCK_TOOL_USE_LIMIT);
  const cliEndpoint = process.env.HEMLOCK_MAPLE_BASE || DEFAULT_ENDPOINT;
  runLiveToolUseEval({
    endpoint: cliEndpoint,
    maxMs: cliMaxMs,
    limit: Number.isFinite(cliLimitRaw) && cliLimitRaw > 0 ? cliLimitRaw : null,
  })
    .then((runResult) => {
      const receiptDir = path.join(os.homedir(), "Library", "Application Support", "Hemlock", "e2e", "tool-use-live");
      const receiptPath = path.join(receiptDir, `tool-use-live-${Date.now()}.json`);
      const receipt = buildLiveToolUseReceipt(runResult, { endpoint: cliEndpoint });
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
  TERMINAL_KINDS,
  MAX_TOKENS,
  benchmarkPath,
  loadBenchmark,
  deriveAllowlist,
  buildActionSystemPrompt,
  extractFirstJsonObject,
  parseModelReply,
  fetchInference,
  runLiveToolUseEval,
  buildLiveToolUseReceipt,
};
