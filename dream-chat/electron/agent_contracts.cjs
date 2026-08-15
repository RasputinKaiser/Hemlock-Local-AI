const crypto = require("node:crypto");

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

function parseActionEnvelope(text, registry = {}) {
  const action = extractJsonObject(text);
  validateAction(action, registry);
  return action;
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
  validateAction,
  extractJsonObject,
  parseActionEnvelope,
  createPlan,
  createAction,
  createObservation,
  compactObservation,
  classifyFailure,
};
