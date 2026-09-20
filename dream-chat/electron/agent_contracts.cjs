const crypto = require("node:crypto");
const { EXPERIMENTS } = require("./physics_sandbox.cjs");

const ACTION_SCHEMA = "hemlock.agent.action.v1";
const OBSERVATION_SCHEMA = "hemlock.agent.observation.v1";
const PLAN_SCHEMA = "hemlock.agent.plan.v1";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_ACTION_STATUSES = new Set(["completed", "failed", "cancelled", "blocked", "rejected"]);
const ACTION_KINDS = new Set(["tool", "ask_user", "answer", "complete", "blocked"]);
const APPROVALS = new Set(["none", "plan", "explicit"]);

const DEFAULT_BUDGET = Object.freeze({
  maxAgentSteps: 8,
  agentStepsUsed: 0,
  maxCommands: 12,
  commandsUsed: 0,
  maxRetriesPerOperation: 2,
  maxMutationSets: 1,
  mutationSetsUsed: 0,
  maxTrainingCycles: 0,
  trainingCyclesUsed: 0,
  maxWallClockMs: 600000,
  wallClockStartedAt: null,
  maxArtifactRepairs: 2,
  artifactRepairsUsed: 0,
  maxCodeRepairs: 2,
  codeRepairsUsed: 0,
});

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function mergeBudget(budget = {}) {
  return { ...DEFAULT_BUDGET, ...budget };
}

// T7-S3: pure clamp for user-granted plan budgets. Keeps only maxAgentSteps
// and maxCommands as integers bounded to [1..24] / [1..40]; garbage drops out.
const BUDGET_OVERRIDE_BOUNDS = Object.freeze({ maxAgentSteps: [1, 24], maxCommands: [1, 40] });

function clampBudgetOverrides(overrides) {
  const clamped = {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return clamped;
  for (const [key, [min, max]] of Object.entries(BUDGET_OVERRIDE_BOUNDS)) {
    const parsed = Number.parseInt(overrides[key], 10);
    if (Number.isFinite(parsed)) clamped[key] = Math.min(Math.max(parsed, min), max);
  }
  return clamped;
}

function normalizeExpectedEvidence(value, fallback = []) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value).filter((key) => value[key] === true || value[key] == null || typeof value[key] === "string");
    if (keys.length) return keys;
  }
  return Array.isArray(fallback) ? fallback.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function validateAction(action, registry = {}) {
  assertObject(action, "Action");
  if (action.schema !== ACTION_SCHEMA) throw new Error(`Action schema must be ${ACTION_SCHEMA}.`);
  if (!String(action.id || "").trim()) throw new Error("Action id is required.");
  if (!String(action.taskId || "").trim()) throw new Error("Action taskId is required.");
  if (!Number.isInteger(action.step) || action.step < 1) throw new Error("Action step must be a positive integer.");
  if (!ACTION_KINDS.has(action.kind)) throw new Error(`Unsupported action kind: ${action.kind}`);
  if (typeof action.shortRationale !== "string" || !action.shortRationale.trim()) throw new Error("Action shortRationale is required.");
  if (!Array.isArray(action.expectedEvidence)) throw new Error("Action expectedEvidence must be an array.");
  if (!APPROVALS.has(action.approval)) throw new Error(`Unsupported action approval: ${action.approval}`);
  if (action.status !== "proposed") throw new Error("Model action status must be proposed; the host owns lifecycle transitions.");
  if (action.kind === "tool") {
    if (!String(action.commandId || "").trim()) throw new Error("Tool actions require a registered commandId.");
    if (!registry[action.commandId]) throw new Error(`Action command is not allowlisted: ${action.commandId}`);
  }
  return action;
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) throw new Error("Maple returned an empty action response.");
  const candidates = [];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(source);
  // Local checkpoints occasionally wrap a valid envelope in a sentence or
  // append a short note after it. Find balanced object candidates while
  // respecting quoted strings so braces inside artifact source do not make
  // the parser consume unrelated prose.
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, index + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next bounded candidate */ }
  }
  throw new Error("Maple action response was not valid JSON.");
}

function quotedField(source, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source || "").match(new RegExp(`[\"']${escapedKey}[\"']\\s*:\\s*[\"']((?:\\\\.|[^\"'\\\\])*)[\"']`, "i"));
  if (!match) return null;
  try { return JSON.parse(`\"${match[1]}\"`); } catch { return match[1]; }
}

function numericField(source, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source || "").match(new RegExp(`[\"']${escapedKey}[\"']\\s*:\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : null;
}

function balancedObjectAfterKey(source, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = String(source || "").match(new RegExp(`[\"']${escapedKey}[\"']\\s*:\\s*`, "i"));
  if (!keyMatch) return null;
  const start = keyMatch.index + keyMatch[0].length;
  if (source[start] !== "{") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function recoverTruncatedAction(text) {
  const source = String(text || "");
  const commandId = quotedField(source, "commandId");
  const looksLikeAction = source.includes(ACTION_SCHEMA) || Boolean(commandId) && /[\"'](?:kind|approval|status)[\"']\s*:/.test(source);
  if (!looksLikeAction || !commandId) return null;
  const kind = quotedField(source, "kind") || "tool";
  const approval = quotedField(source, "approval") || "none";
  const status = quotedField(source, "status") || "proposed";
  const input = balancedObjectAfterKey(source, "input") || {};
  return {
    schema: ACTION_SCHEMA,
    id: quotedField(source, "id") || "action-recovered",
    taskId: quotedField(source, "taskId") || "model-task",
    step: numericField(source, "step") || 1,
    kind,
    commandId,
    input,
    shortRationale: quotedField(source, "shortRationale") || `Continue the registered ${commandId} step.`,
    expectedEvidence: [],
    approval,
    status,
    __recoveredTruncated: true,
  };
}

function extractActionEnvelope(text) {
  try { return extractJsonObject(text); } catch (error) {
    const recovered = recoverTruncatedAction(text);
    if (recovered) return recovered;
    throw error;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedActionInput(commandId, payload) {
  const flattenedInput = Object.entries(payload || {}).reduce((result, [key, value]) => {
    if (!key.startsWith("input.")) return result;
    result[key.slice("input.".length)] = value;
    return result;
  }, {});
  const source = plainObject(payload?.input)
    ? payload.input
    : Object.keys(flattenedInput).length
      ? flattenedInput
      : plainObject(payload)
        ? payload
        : {};
  const pick = (keys) => Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
  const directSourceMap = Object.keys(source).length > 0 && Object.entries(source).every(([file, content]) => typeof file === "string" && /\.[a-z0-9]{1,12}$/i.test(file) && typeof content === "string")
    ? Object.fromEntries(Object.entries(source))
    : null;
  switch (String(commandId || "")) {
    case "artifact.create":
      {
        const input = pick(["artifactId", "title", "entrypoint", "mime"]);
        const artifactKind = String(source.kind || "").toLowerCase();
        if (["html", "svg", "text", "markdown", "json"].includes(artifactKind)) input.kind = artifactKind;
        return input;
      }
    case "artifact.author":
    case "artifact.update":
      if (directSourceMap) return { source: directSourceMap };
      return pick(["artifactId", "kind", "filename", "runtimeTemplate", "objective", "source", "patches", "repairFor", "status", "evidence"]);
    case "artifact.preview.open":
      return pick(["artifactId", "revision"]);
    case "artifact.preview.inspect":
      return pick(["artifactId", "revision", "sessionId", "inspection"]);
    case "code.apply":
      if (directSourceMap) return { source: directSourceMap };
      return pick(["source", "patches", "baseDigests", "reason", "verificationProfile"]);
    case "experiment.run":
      return pick(["experiment", "input", "seed", "hypothesis"]);
    case "experiment.note":
      return pick(["experimentId", "claim", "finding", "hypothesis", "tags"]);
    case "experiment.dataset":
      return pick(["limit"]);
    default:
      return plainObject(payload?.input) ? payload.input : {};
  }
}

// T13 compact choice: the model only needs to emit kind/commandId/input/
// shortRationale — the host assigns every other envelope field. Anything that
// already looks like a choice gets the schema pinned on before validation so a
// compliant compact answer never falls into the repair loop.
function normalizeCompactChoice(payload) {
  if (!plainObject(payload) || payload.schema === ACTION_SCHEMA) return payload;
  // Models occasionally answer with {"choices":[{...}]} — take the first
  // well-formed choice instead of letting the whole batch degrade silently.
  if (Array.isArray(payload.choices) && payload.choices.length) {
    const first = payload.choices.find((choice) => plainObject(choice) && (ACTION_KINDS.has(choice.kind) || typeof choice.commandId === "string"));
    if (first) return normalizeCompactChoice({ ...first, __choiceCount: payload.choices.length });
  }
  if (!ACTION_KINDS.has(payload.kind) && typeof payload.commandId !== "string") return payload;
  // A compliant compact choice may omit shortRationale/input — the host owns
  // narration anyway, so synthesize them rather than burn a repair inference
  // (each failed parse costs a full local-model round-trip).
  const rationale = String(payload.shortRationale || payload.reason || payload.title || (payload.commandId ? `Run ${payload.commandId}.` : "Model returned a terminal choice.")).trim();
  return {
    ...payload,
    schema: ACTION_SCHEMA,
    input: plainObject(payload.input) ? payload.input : {},
    shortRationale: rationale || "Continue the registered step.",
    __compactChoice: true,
  };
}

function coerceActionPayload(payload, { taskId = "model-task", step = 1, commandId = null, expectedEvidence = [], approval = "none", kind = "tool" } = {}) {
  if (!plainObject(payload)) return null;
  if (payload.schema === ACTION_SCHEMA) return payload;
  const resolvedKind = ACTION_KINDS.has(payload.kind) ? payload.kind : kind;
  if (resolvedKind === "tool" && !String(commandId || "").trim()) return null;
  const input = resolvedKind === "tool"
    ? boundedActionInput(commandId, payload)
    : plainObject(payload.input) ? payload.input : {};
  const rationale = String(payload.shortRationale || payload.reason || payload.title || (resolvedKind === "tool" ? `Continue the registered ${commandId} step.` : "Model returned a terminal choice.")).trim();
  return {
    schema: ACTION_SCHEMA,
    id: String(payload.id || "action-coerced"),
    taskId: String(payload.taskId || taskId),
    step: Number.isInteger(payload.step) && payload.step > 0 ? payload.step : step,
    kind: resolvedKind,
    commandId: resolvedKind === "tool" ? commandId : null,
    input,
    shortRationale: rationale || "Continue the registered step.",
    expectedEvidence: normalizeExpectedEvidence(payload.expectedEvidence, expectedEvidence),
    approval,
    status: "proposed",
    __coercedPayload: true,
  };
}

function parseActionEnvelope(text, registry = {}) {
  const action = extractActionEnvelope(text);
  validateAction(action, registry);
  return action;
}

// Scored-choice action selection (parallel constrained decoding): rather
// than asking Maple to autoregressively generate a whole action envelope,
// the host enumerates the closed command set as minimal candidate
// continuations and scores each against the shared prefilled prompt
// (POST /v1/score). Candidates flagged `complete` are valid compact
// envelopes executable as-is — zero generated tokens. Prefix candidates end
// where free content begins; a prefix winner means the model chose a
// generative action and the host falls back to generation for the fill-in.
const SCORE_VERIFY_PROFILES = ["app-build", "diff-check", "python-tests"];

// Commands whose required input is free text: scoring can pick the command,
// but the input itself still needs a generative step.
const SCORE_GENERATIVE_COMMANDS = new Set([
  "artifact.author",
  "artifact.update",
  "code.apply",
  "file.search",
  "file.read",
  "context.search",
  "context.query",
  "receipt.inspect",
  "experiment.note",
]);

function scoreCandidateText(kind, commandId, input) {
  if (kind === "tool") {
    return `{"kind":"tool","commandId":${JSON.stringify(commandId)},"input":${JSON.stringify(input)},"shortRationale":${JSON.stringify(`Run ${commandId}.`)}}`;
  }
  const field = kind === "blocked" ? "reason" : "content";
  return `{"kind":${JSON.stringify(kind)},"${field}":"`;
}

function buildScoreCandidates(commandIds, { terminalKinds = ["answer", "ask_user", "blocked"], maxCandidates = 48 } = {}) {
  const candidates = [];
  for (const kind of terminalKinds) {
    candidates.push({ text: scoreCandidateText(kind, null, null), kind, commandId: null, complete: false });
  }
  for (const commandId of commandIds || []) {
    if (commandId === "experiment.run") {
      for (const experiment of EXPERIMENTS) {
        candidates.push({
          text: scoreCandidateText("tool", commandId, { experiment }),
          kind: "tool",
          commandId,
          input: { experiment },
          complete: true,
        });
      }
      continue;
    }
    if (commandId === "verify") {
      for (const profile of SCORE_VERIFY_PROFILES) {
        candidates.push({
          text: scoreCandidateText("tool", commandId, { profile }),
          kind: "tool",
          commandId,
          input: { profile },
          complete: true,
        });
      }
      continue;
    }
    if (SCORE_GENERATIVE_COMMANDS.has(commandId)) {
      candidates.push({
        text: `{"kind":"tool","commandId":${JSON.stringify(commandId)},"input":`,
        kind: "tool",
        commandId,
        complete: false,
      });
      continue;
    }
    candidates.push({
      text: scoreCandidateText("tool", commandId, {}),
      kind: "tool",
      commandId,
      input: {},
      complete: true,
    });
  }
  return candidates.slice(0, maxCandidates);
}

// Winner selection over /v1/score results. Candidates differ in length and
// completeness, so compare per-token average logprob; the raw sum is kept
// for telemetry. Returns null when the result is unusable.
function pickScoredCandidate(candidates, result) {
  const scores = Array.isArray(result?.candidates) ? result.candidates : [];
  let best = null;
  let runnerUp = null;
  for (const scored of scores) {
    if (!scored || !Number.isFinite(scored.avgLogprob)) continue;
    const candidate = candidates[scored.index];
    if (!candidate) continue;
    const entry = { ...candidate, logprob: scored.logprob, avgLogprob: scored.avgLogprob, tokens: scored.tokens };
    if (!best || entry.avgLogprob > best.avgLogprob) {
      runnerUp = best;
      best = entry;
    } else if (!runnerUp || entry.avgLogprob > runnerUp.avgLogprob) {
      runnerUp = entry;
    }
  }
  if (!best) return null;
  return {
    winner: best,
    margin: runnerUp ? best.avgLogprob - runnerUp.avgLogprob : null,
    runnerUp: runnerUp ? { kind: runnerUp.kind, commandId: runnerUp.commandId, avgLogprob: runnerUp.avgLogprob } : null,
    candidateCount: scores.length,
    promptTokens: result.promptTokens ?? null,
    cachedTokens: result.cachedTokens ?? null,
  };
}

function createPlan({ task, objective, intent, steps = [], rationale = "Bounded local work with evidence at each step." }) {
  const planSteps = steps.map((step, index) => ({
    step: index + 1,
    kind: step.kind || "tool",
    commandId: step.commandId || null,
    label: String(step.label || step.commandId || step.kind || `Step ${index + 1}`),
    expectedEvidence: Array.isArray(step.expectedEvidence) ? step.expectedEvidence : [],
    approval: step.approval || "none",
    status: index === 0 ? "ready" : "queued",
  }));
  return {
    schema: PLAN_SCHEMA,
    id: id("plan"),
    taskId: task?.id || null,
    objective: String(objective || task?.objective || "Hemlock task").trim(),
    intent: String(intent || task?.intent || "conversation"),
    rationale: String(rationale).trim(),
    steps: planSteps,
    status: "proposed",
    approval: "required",
    proposedAt: nowIso(),
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    evidenceRefs: [],
  };
}

function createAction({ taskId, step, kind = "tool", commandId = null, input = {}, shortRationale, expectedEvidence = [], approval = "none" }) {
  return {
    schema: ACTION_SCHEMA,
    id: id("action"),
    taskId,
    step,
    kind,
    commandId,
    input,
    shortRationale: String(shortRationale || "Perform the next bounded step.").trim(),
    expectedEvidence,
    approval,
    status: "proposed",
    proposedAt: nowIso(),
    validatedAt: null,
    startedAt: null,
    completedAt: null,
    operationId: null,
    observationId: null,
    retryCount: 0,
  };
}

function createObservation({ operationId, status, summary, structuredOutput = {}, evidenceRefs = [], filesTouched = [], elapsedMs = 0, error = null }) {
  return {
    schema: OBSERVATION_SCHEMA,
    id: id("observation"),
    operationId: operationId || null,
    status: status || "observed",
    summary: String(summary || "Local operation observed.").slice(0, 1200),
    structuredOutput,
    outputDigest: digest(JSON.stringify(structuredOutput)),
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    filesTouched: Array.isArray(filesTouched) ? filesTouched : [],
    elapsedMs: Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0,
    error: error ? String(error) : null,
    createdAt: nowIso(),
  };
}

function classifyFailure(error, result = {}) {
  const code = String(error?.code || result?.code || "").toUpperCase();
  const message = String(error?.message || result?.stderr || result?.error || "").toLowerCase();
  if (code.includes("CANCEL") || message.includes("cancel")) return "cancelled";
  if (code.includes("SCOPE") || code.includes("ALLOW") || code.includes("APPROVAL") || message.includes("not allowlisted")) return "safety-blocked";
  if (code.includes("TIMEOUT") || message.includes("timed out") || message.includes("timeout") || message.includes("temporarily")) return "retryable-transient";
  if (code.includes("RUNTIME") || message.includes("econnrefused") || message.includes("not ready")) return "runtime-unavailable";
  if (result?.exitCode != null && result.exitCode !== 0) return "verification-failure";
  return "deterministic-input";
}

function compactObservation(result, { operationId, elapsedMs = 0 } = {}) {
  if (result?.schema === OBSERVATION_SCHEMA) return result;
  const evidenceRefs = result?.evidenceRefs || (result?.receiptPath ? [result.receiptPath] : []);
  const status = result?.status === "blocked" ? "blocked" : result?.exitCode != null && result.exitCode !== 0 ? "failed" : "passed";
  const summary = result?.summary
    || result?.claimBoundary
    || (status === "failed" ? result?.stderr || result?.error || "The local command failed." : "The local command completed.");
  return createObservation({
    operationId,
    status,
    summary,
    structuredOutput: result,
    evidenceRefs,
    filesTouched: result?.filesTouched || [],
    elapsedMs,
    error: status === "failed" ? result?.error || result?.stderr : null,
  });
}

module.exports = {
  ACTION_SCHEMA,
  OBSERVATION_SCHEMA,
  PLAN_SCHEMA,
  DEFAULT_BUDGET,
  TERMINAL_TASK_STATUSES,
  TERMINAL_ACTION_STATUSES,
  nowIso,
  id,
  digest,
  mergeBudget,
  clampBudgetOverrides,
  normalizeExpectedEvidence,
  validateAction,
  extractJsonObject,
  extractActionEnvelope,
  recoverTruncatedAction,
  boundedActionInput,
  normalizeCompactChoice,
  coerceActionPayload,
  parseActionEnvelope,
  buildScoreCandidates,
  pickScoredCandidate,
  createPlan,
  createAction,
  createObservation,
  compactObservation,
  classifyFailure,
};
