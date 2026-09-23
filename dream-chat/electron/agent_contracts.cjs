const crypto = require("node:crypto");
const { EXPERIMENTS } = require("./physics_sandbox.cjs");

const ACTION_SCHEMA = "hemlock.agent.action.v1";
const OBSERVATION_SCHEMA = "hemlock.agent.observation.v1";
const PLAN_SCHEMA = "hemlock.agent.plan.v1";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_ACTION_STATUSES = new Set(["completed", "failed", "cancelled", "blocked", "rejected"]);
// "batch" is a host-only parse kind: a model envelope {"actions":[...]} parses
// into one batch proposal that the orchestrator fans out into ordinary "tool"
// action records. A bare {"kind":"batch"} choice carries no actions and
// degrades through command selection like any other malformed choice.
const ACTION_KINDS = new Set(["tool", "ask_user", "answer", "complete", "blocked", "batch"]);
const APPROVALS = new Set(["none", "plan", "explicit"]);

// Practical per-request context ceiling — deliberately far under the model's
// advertised position count (Maple: 128000, config.max_position_embeddings)
// because KV memory on the full-attention layers is the real constraint, not
// positions. Maple's 6 full-attention layers cost ~2KB/token/layer in fp16
// (~12KB/token total): 24000 tokens ≈ 288MB of full-layer KV — the safe
// exact-KV default. With --kv-bits those layers shrink ~2x (8-bit) / ~4x
// (4-bit) past quantized-kv-start, so the default rises to 61440 — still
// under the model ceiling minus generation headroom.
// HEMLOCK_CONTEXT_MAX_TOKENS retunes the default; a task budget may pin its
// own contextMaxTokens through the same mergeBudget channel — any stored
// positive number wins over the env/default resolution below.
const CONTEXT_MAX_TOKENS_EXACT_KV = 24000;
const CONTEXT_MAX_TOKENS_QUANTIZED_KV = 61440;
const CONTEXT_MAX_TOKENS_MIN = 4096;
// A max-context request still needs room to generate: the enforced ceiling
// stays this far under the model's advertised position count.
const CONTEXT_GENERATION_HEADROOM_TOKENS = 2048;
// Maple's verified config.max_position_embeddings. The host republishes the
// served checkpoint's real value on HEMLOCK_MODEL_MAX_TOKENS when it reads
// config.json, so the clamp follows the actual checkpoint; the env also
// stands as an explicit override for a checkpoint the host has not inspected.
const FALLBACK_MODEL_MAX_TOKENS = 128000;

// Read per call (the envFallbackLane pattern): settings.set writes
// process.env through applyRuntimeSettingEnv, so the next resolution after
// the write sees it without a relaunch.
function envKvBits() {
  const bits = Number(process.env.HEMLOCK_KV_BITS);
  return Number.isFinite(bits) ? Math.max(0, Math.min(8, Math.round(bits))) : 0;
}
function explicitContextMaxTokens() {
  const raw = Number(process.env.HEMLOCK_CONTEXT_MAX_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(CONTEXT_MAX_TOKENS_MIN, Math.round(raw)) : null;
}
function modelMaxContextTokens() {
  const raw = Number(process.env.HEMLOCK_MODEL_MAX_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : FALLBACK_MODEL_MAX_TOKENS;
}
function defaultContextMaxTokens() {
  const explicit = explicitContextMaxTokens();
  if (explicit != null) return explicit;
  return envKvBits() > 0 ? CONTEXT_MAX_TOKENS_QUANTIZED_KV : CONTEXT_MAX_TOKENS_EXACT_KV;
}

// Frozen module-load snapshot kept for compatibility; live resolution goes
// through defaultContextMaxTokens() (kv-aware, per-call env read).
const DEFAULT_CONTEXT_MAX_TOKENS = explicitContextMaxTokens() ?? CONTEXT_MAX_TOKENS_EXACT_KV;

// Generous-but-bounded defaults: a single local-model step can cost tens of
// seconds, so budgets are sized for real multi-step plans plus adaptive detours
// rather than the minimal happy path.
const DEFAULT_BUDGET = Object.freeze({
  maxAgentSteps: 24,
  agentStepsUsed: 0,
  // null = "no pin": resolveContextMaxTokens falls back to the live
  // env/kv-aware default per call, so a settings.set contextMaxTokens write
  // reaches even a running task on its next request.
  contextMaxTokens: null,
  maxCommands: 40,
  commandsUsed: 0,
  maxRetriesPerOperation: 3,
  maxMutationSets: 3,
  mutationSetsUsed: 0,
  maxTrainingCycles: 1,
  trainingCyclesUsed: 0,
  maxWallClockMs: 1800000,
  wallClockStartedAt: null,
  maxArtifactRepairs: 4,
  artifactRepairsUsed: 0,
  maxCodeRepairs: 4,
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
// and maxCommands as integers bounded to [1..64] / [1..120]; garbage drops out.
const BUDGET_OVERRIDE_BOUNDS = Object.freeze({ maxAgentSteps: [1, 64], maxCommands: [1, 120] });

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
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Maple returned an empty action response.");
  // Observed Maple output appends a stray trailing fence after the JSON
  // envelope (`{...}\n``` `) — dead markup, not content. Strip it
  // deterministically before candidate parsing.
  const source = raw.replace(/\s*`{3,}[a-zA-Z]*\s*$/, "").trim() || raw;
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
  // `command` is an accepted alias for `commandId` — the assistant-prefix
  // transport prefills {"command": so prefixed generations arrive in that
  // spelling, and batch items use the same key.
  const commandRef = typeof payload.commandId === "string" ? payload.commandId : typeof payload.command === "string" ? payload.command : null;
  if (!ACTION_KINDS.has(payload.kind) && !commandRef) return payload;
  // A compliant compact choice may omit shortRationale/input — the host owns
  // narration anyway, so synthesize them rather than burn a repair inference
  // (each failed parse costs a full local-model round-trip).
  const rationale = String(payload.shortRationale || payload.reason || payload.title || (commandRef ? `Run ${commandRef}.` : "Model returned a terminal choice.")).trim();
  return {
    ...payload,
    schema: ACTION_SCHEMA,
    commandId: typeof payload.commandId === "string" ? payload.commandId : commandRef,
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

// Batch action envelopes: {"actions":[{"command":"<registered>","input":{...}}, ...]}.
// Each entry is a compact tool call — the host still owns identity, step,
// approval, evidence, and lifecycle. A single-entry batch normalizes to the
// existing single-action shape so nothing downstream forks; 2–6 entries return
// the discriminated wrapper {kind:"batch", actions:[...]} where every item has
// already been registry-checked and input-bounded exactly like a single action.
const BATCH_ACTION_LIMITS = Object.freeze({ min: 2, max: 6 });

function normalizeBatchActionEntry(entry, index, registry = {}) {
  assertObject(entry, `Batch action ${index + 1}`);
  const commandId = String(entry.command ?? entry.commandId ?? "").trim();
  if (!commandId) throw new Error(`Batch action ${index + 1} requires a command.`);
  if (!registry[commandId]) throw new Error(`Batch action command is not allowlisted: ${commandId}`);
  if (entry.input != null && !plainObject(entry.input)) throw new Error(`Batch action ${index + 1} input must be an object.`);
  return {
    commandId,
    input: boundedActionInput(commandId, entry),
    shortRationale: String(entry.shortRationale || entry.reason || `Run ${commandId}.`).trim() || `Run ${commandId}.`,
    expectedEvidence: normalizeExpectedEvidence(entry.expectedEvidence),
  };
}

// Returns null when the payload is not a batch envelope; throws when it claims
// to be a batch but is malformed. Registry membership and input bounding are
// enforced per entry, the same way single actions are validated.
function parseBatchActions(payload, registry = {}) {
  if (!plainObject(payload) || !Array.isArray(payload.actions)) return null;
  if (!payload.actions.length) throw new Error("Batch actions must contain at least one action.");
  if (payload.actions.length > BATCH_ACTION_LIMITS.max) throw new Error(`Batch actions are capped at ${BATCH_ACTION_LIMITS.max} entries.`);
  const actions = payload.actions.map((entry, index) => normalizeBatchActionEntry(entry, index, registry));
  if (actions.length < BATCH_ACTION_LIMITS.min) {
    const [item] = actions;
    const action = {
      schema: ACTION_SCHEMA,
      id: String(payload.id || "action-batch-single"),
      taskId: String(payload.taskId || "model-task"),
      step: Number.isInteger(payload.step) && payload.step > 0 ? payload.step : 1,
      kind: "tool",
      commandId: item.commandId,
      input: item.input,
      shortRationale: String(payload.shortRationale || item.shortRationale),
      expectedEvidence: item.expectedEvidence.length ? item.expectedEvidence : normalizeExpectedEvidence(payload.expectedEvidence),
      approval: "none",
      status: "proposed",
    };
    return validateAction(action, registry);
  }
  return validateAction({
    schema: ACTION_SCHEMA,
    id: String(payload.id || "action-batch"),
    taskId: String(payload.taskId || "model-task"),
    step: Number.isInteger(payload.step) && payload.step > 0 ? payload.step : 1,
    kind: "batch",
    commandId: null,
    input: {},
    actions,
    shortRationale: String(payload.shortRationale || `Run ${actions.length} batched actions: ${actions.map((item) => item.commandId).join(", ")}.`).slice(0, 400),
    expectedEvidence: normalizeExpectedEvidence(payload.expectedEvidence),
    approval: "none",
    status: "proposed",
  }, registry);
}

function parseActionEnvelope(text, registry = {}) {
  const parsed = extractActionEnvelope(text);
  const batch = parseBatchActions(parsed, registry);
  if (batch) return batch;
  validateAction(parsed, registry);
  return parsed;
}

// Deterministic replay of the structured-action parse path for offline eval
// and regression fixtures — the parse/validate half of the orchestrator's
// parseModelResult without the kernel: batch envelopes fan out through
// parseBatchActions, compact choices get host-owned fields filled, and every
// shape is registry-validated. On a failed first parse, a reasoning-channel
// tail ending in } or ] is rejoined ONCE and reported as
// parseStatus:"channel-rejoined" (the observed production failure: the forced
// {"command": prefix alone in content, the JSON tail in reasoning). Host
// command selection (plan adaptation, autonomy boundary, executed-command
// override) is not replayed — the result names the model's chosen command,
// not the command the host would have executed.
function replayActionParse(modelResult = {}, registry = {}) {
  const content = String(modelResult?.content ?? "");
  const reasoning = String(modelResult?.reasoning ?? modelResult?.reasoning_content ?? "");
  const parse = (text) => {
    const extracted = extractActionEnvelope(text);
    if (extracted && Array.isArray(extracted.actions)) {
      const batch = parseBatchActions(extracted, registry);
      return { action: batch, parseStatus: batch.kind === "batch" ? "batch" : "compact-choice" };
    }
    const compact = normalizeCompactChoice(extracted);
    const recoveredTruncated = compact?.__recoveredTruncated === true;
    const compactChoice = compact?.__compactChoice === true;
    const commandId = String(compact?.commandId || "").trim() || null;
    const action = {
      ...compact,
      schema: ACTION_SCHEMA,
      id: String(compact?.id || "action-replay"),
      taskId: String(compact?.taskId || "model-task"),
      step: Number.isInteger(compact?.step) && compact.step > 0 ? compact.step : 1,
      kind: ACTION_KINDS.has(compact?.kind) ? compact.kind : commandId ? "tool" : null,
      commandId,
      input: commandId ? boundedActionInput(commandId, compact) : plainObject(compact?.input) ? compact.input : {},
      shortRationale: String(compact?.shortRationale || "Replayed eval action.").trim(),
      expectedEvidence: normalizeExpectedEvidence(compact?.expectedEvidence),
      approval: APPROVALS.has(compact?.approval) ? compact.approval : "none",
      status: "proposed",
    };
    validateAction(action, registry);
    return { action, parseStatus: recoveredTruncated ? "recovered-truncated" : compactChoice ? "compact-choice" : "valid" };
  };
  try {
    const parsed = parse(content);
    return { action: parsed.action, parseStatus: parsed.parseStatus, channelRejoined: false, error: null };
  } catch (error) {
    // Same salvage as production: only a reasoning tail that re-parses when
    // appended to the content prefix counts as a split envelope.
    const reasoningTail = reasoning.trim();
    if (reasoningTail && /[}\]]\s*$/.test(reasoningTail)) {
      try {
        const rejoined = parse(`${content.trimEnd()}${reasoningTail}`);
        return { action: rejoined.action, parseStatus: "channel-rejoined", channelRejoined: true, error: null };
      } catch { /* the tail was genuine reasoning — the original failure stands */ }
    }
    return { action: null, parseStatus: "invalid", channelRejoined: false, error: error.message };
  }
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

// Fixed reasoning line prepended to every scored continuation. The chat
// template can only render a think block with non-empty reasoning content —
// keeping this identical to the /v1/score prompt_suffix prefix in main.cjs
// lets the host replay the scored step as an assistant turn whose rendered
// tokens are a strict extension of the server's committed prompt cache key.
const SCORED_REASONING_PREFIX = "Deciding next action.";

// Commands whose required input is free text: scoring can pick the command,
// but the input itself still needs a generative step.
const SCORE_GENERATIVE_COMMANDS = new Set([
  "artifact.author",
  "artifact.update",
  "artifact.restore",
  "artifact.compare",
  "artifact.preview.interact",
  "code.apply",
  "change.apply",
  "file.search",
  "file.read",
  "context.search",
  "context.query",
  "receipt.inspect",
  "experiment.note",
  "improve.propose",
  "shell.exec",
  "memory.note",
  "memory.feedback",
  "remember",
  "plan.revise",
  "task.ask",
  "thread.search",
  "world.place",
  "candidate.create",
  "intent.submit",
]);

function scoreCandidateText(kind, commandId, input) {
  if (kind === "tool") {
    return `{"kind":"tool","commandId":${JSON.stringify(commandId)},"input":${JSON.stringify(input)},"shortRationale":${JSON.stringify(`Run ${commandId}.`)}}`;
  }
  const field = kind === "blocked" ? "reason" : "content";
  return `{"kind":${JSON.stringify(kind)},"${field}":"`;
}

function buildScoreCandidates(commandIds, { terminalKinds = ["answer", "ask_user", "blocked"], maxCandidates = 96 } = {}) {
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

// Winner selection over /v1/decide results: the server scores every
// candidate continuation in one batched choice question and returns
// normalized probabilities keyed `cand-<index>`. The argmax of the reported
// probabilities — not the committed key — is authoritative, so a malformed
// commit can never smuggle in a candidate the model did not actually rank
// first. Returns null when the payload has no usable choice answer.
function pickDecidedCandidate(candidates, decidePayload) {
  const answers = decidePayload?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const questionId = typeof decidePayload.committedQuestion === "string" && answers[decidePayload.committedQuestion]?.type === "choice"
    ? decidePayload.committedQuestion
    : Object.keys(answers).find((key) => answers[key]?.type === "choice");
  const answer = questionId ? answers[questionId] : null;
  if (!answer) return null;
  const indexOfKey = (key) => {
    const match = /^cand-(\d+)$/.exec(String(key ?? ""));
    const index = match ? Number(match[1]) : -1;
    return index >= 0 && candidates[index] ? index : -1;
  };
  const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};
  let bestIndex = -1;
  let bestProbability = -Infinity;
  let runnerUpIndex = -1;
  let runnerUpProbability = -Infinity;
  let scoredCount = 0;
  for (const [key, raw] of Object.entries(probabilities)) {
    const index = indexOfKey(key);
    const probability = Number(raw);
    if (index < 0 || !Number.isFinite(probability)) continue;
    scoredCount += 1;
    if (probability > bestProbability) {
      runnerUpIndex = bestIndex;
      runnerUpProbability = bestProbability;
      bestIndex = index;
      bestProbability = probability;
    } else if (probability > runnerUpProbability) {
      runnerUpIndex = index;
      runnerUpProbability = probability;
    }
  }
  if (bestIndex < 0) {
    // No usable probability map — the stated choice is the only signal left.
    bestIndex = indexOfKey(answer.choice ?? decidePayload.committedKey);
    if (bestIndex < 0) return null;
    bestProbability = NaN;
  }
  const winner = candidates[bestIndex];
  const runnerUp = runnerUpIndex >= 0 ? candidates[runnerUpIndex] : null;
  const confidence = Number(answer.confidence);
  return {
    winner: { ...winner, probability: Number.isFinite(bestProbability) ? bestProbability : null },
    probability: Number.isFinite(bestProbability) ? bestProbability : null,
    confidence: Number.isFinite(confidence) ? confidence : null,
    margin: Number.isFinite(bestProbability) && Number.isFinite(runnerUpProbability) ? bestProbability - runnerUpProbability : null,
    runnerUp: runnerUp ? { kind: runnerUp.kind, commandId: runnerUp.commandId, probability: runnerUpProbability } : null,
    candidateCount: scoredCount || candidates.length,
    promptTokens: decidePayload.usage?.promptTokens ?? decidePayload.promptTokens ?? null,
    cachedTokens: decidePayload.usage?.cachedTokens ?? decidePayload.cachedTokens ?? null,
  };
}

// Ordinal expectation over a /v1/decide "score" answer: criteria are ordered
// levels (worst → best) and the answer's probability mass is weighted by each
// level's index. Keys resolve as level labels first, then integer indices.
// Returns null when the answer carries no usable rating.
function expectedScoreLevel(answer, levels = []) {
  if (!answer || typeof answer !== "object") return null;
  const levelOf = (key) => {
    const byLabel = levels.indexOf(String(key));
    if (byLabel >= 0) return byLabel;
    const numeric = Number(key);
    return Number.isInteger(numeric) && numeric >= 0 && numeric < levels.length ? numeric : -1;
  };
  const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : null;
  if (probabilities) {
    let weighted = 0;
    let mass = 0;
    for (const [key, raw] of Object.entries(probabilities)) {
      const level = levelOf(key);
      const probability = Number(raw);
      if (level < 0 || !Number.isFinite(probability)) continue;
      weighted += probability * level;
      mass += probability;
    }
    if (mass > 0) return weighted;
  }
  const chosen = levelOf(answer.choice ?? answer.level ?? answer.score);
  if (chosen >= 0) return chosen;
  const numeric = Number(answer.score ?? answer.value);
  return Number.isFinite(numeric) ? numeric : null;
}

// Reorder records by expected score level (the memory.select rerank). Record
// i is answered under question id `${prefix}${i}`; unrated records keep their
// prior relative order below every rated one. Returns null when nothing was
// rated so callers can keep the heuristic order untouched.
function rerankByExpectedScore(records, answers, { prefix = "mem-", levels = [] } = {}) {
  if (!Array.isArray(records) || !answers || typeof answers !== "object") return null;
  const entries = records.map((record, index) => ({
    record,
    index,
    level: expectedScoreLevel(answers[`${prefix}${index}`], levels),
  }));
  if (entries.every((entry) => entry.level == null)) return null;
  return entries
    .sort((a, b) => (b.level ?? -Infinity) - (a.level ?? -Infinity) || a.index - b.index)
    .map((entry) => entry.record);
}

// A plan step may carry a pre-approved input object (plan.propose /
// plan.revise payloads). It is preserved verbatim here and re-bounded through
// boundedActionInput at action time — the compact-choice envelope cannot
// express nested required args, so the step input is the fallback that keeps
// required-arg commands (e.g. improve.propose) from dead-ending on {}.
function normalizePlanStep(step, index) {
  return {
    step: index + 1,
    kind: step.kind || "tool",
    commandId: step.commandId || null,
    label: String(step.label || step.commandId || step.kind || `Step ${index + 1}`),
    input: plainObject(step.input) ? { ...step.input } : {},
    expectedEvidence: Array.isArray(step.expectedEvidence) ? step.expectedEvidence : [],
    approval: step.approval || "none",
    status: index === 0 ? "ready" : "queued",
  };
}

// Required field names parsed from a registry inputHint such as
// "{summary, rationale, files?:[\"repo-relative\"]}" → ["summary","rationale"].
// Top-level keys only; a `?` suffix marks the field optional, and alternation
// heads ("text|objective") are kept verbatim. Advisory text echoed into
// repair prompts — never a validation gate.
function requiredInputFields(inputHint = "") {
  const text = String(inputHint || "").trim();
  if (!text) return [];
  const closing = text.lastIndexOf("}");
  const inner = text.startsWith("{") && closing > 0 ? text.slice(1, closing) : text;
  const segments = [];
  let depth = 0;
  let quoted = false;
  let segment = "";
  for (const character of inner) {
    if (quoted) {
      segment += character;
      if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; segment += character; continue; }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    if (character === "," && depth <= 0) { segments.push(segment); segment = ""; continue; }
    segment += character;
  }
  segments.push(segment);
  const fields = [];
  for (const part of segments) {
    const head = part.split(":")[0].trim();
    if (!head || head.endsWith("?")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_|]*$/.test(head)) fields.push(head);
  }
  return fields;
}

function createPlan({ task, objective, intent, steps = [], rationale = "Bounded local work with evidence at each step." }) {
  const planSteps = steps.map((step, index) => normalizePlanStep(step, index));
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

function createObservation({ operationId, commandId = null, status, summary, structuredOutput = {}, evidenceRefs = [], filesTouched = [], elapsedMs = 0, error = null, errorClass = null, suggestion = null }) {
  const failed = status === "failed" || status === "blocked" || Boolean(error);
  const resolvedErrorClass = errorClass || (failed
    ? classifyFailure(null, { ...structuredOutput, error: error || structuredOutput?.error || structuredOutput?.stderr })
    : null);
  const resolvedSuggestion = typeof suggestion === "string" && suggestion.trim()
    ? suggestion.trim().slice(0, FAILURE_SUGGESTION_LIMIT)
    : failed
      ? failureHint(resolvedErrorClass, {
        message: error || structuredOutput?.error || structuredOutput?.stderr || structuredOutput?.summary || summary,
        commandId,
        inputHint: structuredOutput?.inputHint,
        requiredFields: structuredOutput?.requiredFields || structuredOutput?.missingFields,
      })
      : null;
  return {
    schema: OBSERVATION_SCHEMA,
    id: id("observation"),
    operationId: operationId || null,
    commandId: commandId || structuredOutput?.commandId || null,
    status: status || "observed",
    summary: String(summary || "Local operation observed.").slice(0, 4000),
    structuredOutput,
    outputDigest: digest(JSON.stringify(structuredOutput)),
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    filesTouched: Array.isArray(filesTouched) ? filesTouched : [],
    elapsedMs: Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0,
    error: error ? String(error) : null,
    errorClass: failed ? resolvedErrorClass : null,
    suggestion: resolvedSuggestion,
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
  // The flat "deterministic-input" default burned the one input-repair retry
  // on failures repair can never fix (budget exhaustion, malformed envelopes,
  // approval gates). Resolve the error code first, then let the message name
  // the class; only a genuine "missing/invalid input" shape stays input-class.
  const resolved = resolveFailureClass(code || null, { message });
  return resolved && resolved !== "unknown" ? resolved : "deterministic-input";
}

// Host-authored failure → next-step hints. A failed action's observation and
// the action.faild event payload both carry `suggestion` so the durable spine
// teaches the model what to do differently. Pure lookup — a failure class or
// an error code maps to one bounded hint (≤240 chars); the optional context
// ({message, commandId, inputHint, requiredFields}) only makes the hint more
// specific, it never changes the vocabulary.
const FAILURE_SUGGESTION_LIMIT = 240;

const FAILURE_HINTS = Object.freeze({
  "deterministic-input": "Supply the command's required input{} fields exactly as its inputHint shows (agent.capabilities lists them); the host input-repair retry can also fill them once.",
  "malformed-envelope": "Return exactly one JSON action envelope {\"kind\",\"commandId\",\"input\",\"shortRationale\"} — or a batch {\"actions\":[{\"command\",\"input\"},...]} (2-6 items). Prose is never executed.",
  "unknown-command": "Choose a commandId from request.allowedNextCommands or the agent.capabilities listing — invented commandIds are rejected.",
  "approval-required": "This command requires explicit user approval — surface it through the approval flow (or task.ask) or choose an auto:true command.",
  "plan-gate": "This command is plan-gated: it runs only under an approved plan — wait for plan approval or choose a non-gated command.",
  "budget-exhausted": "A task budget is spent — report honestly via task.block or task.complete with a reason, or wait for a user-granted budget raise; do not retry the same command.",
  "transport-death": "The local model server was unreachable — host retry and lane fallback own recovery; do not blind-retry the same action.",
  "verification-failed": "Verification failed — read the receipt tail in this observation's evidence, fix the named issue, then re-run verify.",
  "scope-violation": "The path or command fell outside this thread's workspace scope — stay inside workspaceRoot and use scoped commands.",
  "safety-blocked": "A safety gate stopped the action (scope, allowlist, or approval) — read the error to see which, then unblock via approval/plan instead of retrying.",
  cancelled: "The action was cancelled by the user or host — do not retry; a fresh intent restarts the work.",
  "retryable-transient": "Transient local failure — the host already retries bounded times; if it persists, report it rather than looping the same call.",
  stall: "The local model accepted the request but produced no output — the host watchdog owns retry; pick a smaller or different next step.",
  "server-error": "The local model server faulted — host recovery owns respawn; report via task.block if it persists instead of blind retrying.",
  "endpoint-not-found": "The server does not expose that endpoint — retrying can never help; choose a different command path.",
  "cancelled-by-user": "Cancelled by the user — do not retry; a fresh intent restarts the work.",
  "model-invalid": "The selected model checkpoint is not loadable — report it via task.block; retrying the same weights cannot help.",
  "server-not-ready": "The model server is not ready yet — the host readiness loop owns warmup; proceed once the server reports ready.",
  unknown: "The command failed — read the error and any receipt evidence, fix the named cause, then retry once.",
});

// classifyFailure/error-taxonomy spellings that share one hint.
const FAILURE_CLASS_ALIASES = Object.freeze({
  "verification-failure": "verification-failed",
  "runtime-unavailable": "transport-death",
  "action-envelope-invalid": "malformed-envelope",
  "envelope-invalid": "malformed-envelope",
  "gpu-server-error": "server-error",
});

// Raw error codes seen on thrown command failures → the class vocabulary above.
const FAILURE_CODE_CLASSES = Object.freeze({
  COMMAND_BUDGET_EXHAUSTED: "budget-exhausted",
  TRAINING_BUDGET_EXHAUSTED: "budget-exhausted",
  ACTION_COMMAND_NOT_ALLOWED: "unknown-command",
  INVALID_ACTION_OUTPUT: "malformed-envelope",
  EMPTY_ACTION_OUTPUT: "malformed-envelope",
  SCOPE_OUTSIDE_RUNTIME: "scope-violation",
  MAPLE_FIRST_TOKEN_STALL: "stall",
});

// classifyFailure's catch-all is "deterministic-input" and "safety-blocked"
// lumps scope/allowlist/approval together — the thrown message usually names
// the real class. Strong classes are matched first so a default bucket never
// masks a budget death or a transport failure; word boundaries keep
// "Scoped file" from misfiring as a scope violation.
function failureClassFromMessage(message) {
  const m = String(message || "").toLowerCase();
  if (!m) return null;
  if (/not allowlisted|unavailable command|unknown command|not registered/.test(m)) return "unknown-command";
  if (/\boutside\b|\bescapes?\b|\bscope\b|workspaceroot|workspace root|application data/.test(m)) return "scope-violation";
  if (/approve a plan|approved plan|plan-gated|under an approved plan/.test(m)) return "plan-gate";
  if (/explicit|requires an explicit|approval/.test(m)) return "approval-required";
  if (/budget|exhausted/.test(m)) return "budget-exhausted";
  if (/econnrefused|econnreset|ehostunreach|enetunreach|eai_again|fetch failed|socket hang|terminated|unreachable|not ready/.test(m)) return "transport-death";
  if (/timed out|timeout|temporarily|\bstall/.test(m)) return "retryable-transient";
  if (/not valid json|malformed|envelope/.test(m)) return "malformed-envelope";
  if (/needs an? |required|missing|must be|not found|expects|invalid input/.test(m)) return "deterministic-input";
  if (/verif|exit code/.test(m)) return "verification-failed";
  return null;
}

// Resolves a failure class or raw error code to the canonical hint class,
// refining the bucket classes (safety-blocked, deterministic-input, unknown)
// with the message when it names the real cause.
function resolveFailureClass(codeOrClass, context = {}) {
  const raw = String(codeOrClass || "").trim();
  const message = context && typeof context === "object" ? context.message ?? context.error ?? "" : "";
  const normalized = raw.toLowerCase();
  let cls = FAILURE_CLASS_ALIASES[normalized]
    || (Object.prototype.hasOwnProperty.call(FAILURE_HINTS, normalized) ? normalized : null);
  if (!cls && raw) {
    const upper = raw.toUpperCase();
    cls = FAILURE_CODE_CLASSES[upper]
      || (/CANCEL/.test(upper) ? "cancelled"
        : /SCOPE|OUTSIDE/.test(upper) ? "scope-violation"
        : /BUDGET|EXHAUSTED/.test(upper) ? "budget-exhausted"
        : /APPROVAL|EXPLICIT/.test(upper) ? "approval-required"
        : /PLAN/.test(upper) ? "plan-gate"
        : /ALLOW|UNAVAILABLE|NOT_REGISTERED|UNKNOWN/.test(upper) ? "unknown-command"
        : /MALFORMED|ENVELOPE|JSON|PARSE/.test(upper) ? "malformed-envelope"
        : /ECONN|EPIPE|EHOST|ENET|EAI_AGAIN|SOCKET|TRANSPORT|TERMINATED|UNREACH|NOT_READY|RUNTIME|FETCH/.test(upper) ? "transport-death"
        : /STALL/.test(upper) ? "stall"
        : /TIMEOUT|TRANSIENT/.test(upper) ? "retryable-transient"
        : /VERIF/.test(upper) ? "verification-failed"
        : null);
  }
  if (!cls || cls === "safety-blocked" || cls === "deterministic-input" || cls === "unknown") {
    cls = failureClassFromMessage(message) || cls || "unknown";
  }
  return cls;
}

function failureHint(codeOrClass, context = {}) {
  const message = context && typeof context === "object" ? context.message ?? context.error ?? "" : "";
  const cls = resolveFailureClass(codeOrClass, context);
  let hint = FAILURE_HINTS[cls] || FAILURE_HINTS.unknown;
  if (cls === "deterministic-input") {
    const fields = Array.isArray(context?.requiredFields) && context.requiredFields.length
      ? context.requiredFields.map(String)
      : requiredInputFields(context?.inputHint);
    if (fields.length) {
      hint = `Missing or malformed required input: ${fields.join(", ")}. Supply them in input{} per the command's inputHint (agent.capabilities), or let host input-repair fill them once.`;
    }
  } else if (cls === "budget-exhausted") {
    const which = /training/.test(message) ? "training-cycle" : /mutation/.test(message) ? "mutation-set" : /step/.test(message) ? "agent-step" : /wall/.test(message) ? "wall-clock" : "command";
    hint = `The ${which} budget is spent — report honestly via task.block or task.complete with a reason, or wait for a user-granted budget raise; do not retry.`;
  }
  return String(hint || FAILURE_HINTS.unknown).slice(0, FAILURE_SUGGESTION_LIMIT);
}

function compactObservation(result, { operationId, elapsedMs = 0 } = {}) {
  if (result?.schema === OBSERVATION_SCHEMA) return result;
  const evidenceRefs = result?.evidenceRefs || (result?.receiptPath ? [result.receiptPath] : []);
  const status = result?.status === "blocked" ? "blocked"
    : result?.status === "failed" || (result?.exitCode != null && result.exitCode !== 0) ? "failed"
      : "passed";
  const summary = result?.summary
    || result?.claimBoundary
    || (status === "failed" ? result?.stderr || result?.error || "The local command failed." : "The local command completed.");
  return createObservation({
    operationId,
    commandId: result?.commandId || result?.command || null,
    status,
    summary,
    structuredOutput: result,
    evidenceRefs,
    filesTouched: result?.filesTouched || [],
    elapsedMs,
    error: status === "failed" || status === "blocked" ? result?.error || result?.stderr : null,
    errorClass: result?.errorClass || result?.failureClass || result?.category || null,
    suggestion: result?.suggestion || null,
  });
}

module.exports = {
  ACTION_SCHEMA,
  OBSERVATION_SCHEMA,
  PLAN_SCHEMA,
  DEFAULT_BUDGET,
  DEFAULT_CONTEXT_MAX_TOKENS,
  CONTEXT_MAX_TOKENS_EXACT_KV,
  CONTEXT_MAX_TOKENS_QUANTIZED_KV,
  CONTEXT_MAX_TOKENS_MIN,
  CONTEXT_GENERATION_HEADROOM_TOKENS,
  FALLBACK_MODEL_MAX_TOKENS,
  envKvBits,
  explicitContextMaxTokens,
  modelMaxContextTokens,
  defaultContextMaxTokens,
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
  parseBatchActions,
  replayActionParse,
  BATCH_ACTION_LIMITS,
  buildScoreCandidates,
  pickScoredCandidate,
  pickDecidedCandidate,
  expectedScoreLevel,
  rerankByExpectedScore,
  SCORED_REASONING_PREFIX,
  createPlan,
  normalizePlanStep,
  requiredInputFields,
  createAction,
  createObservation,
  compactObservation,
  classifyFailure,
  failureHint,
  resolveFailureClass,
  FAILURE_SUGGESTION_LIMIT,
};
