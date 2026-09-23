const crypto = require("node:crypto");

const {
  ACTION_SCHEMA,
  DEFAULT_BUDGET,
  DEFAULT_CONTEXT_MAX_TOKENS,
  TERMINAL_TASK_STATUSES,
  classifyFailure,
  compactObservation,
  createAction,
  createObservation,
  createPlan,
  boundedActionInput,
  clampBudgetOverrides,
  coerceActionPayload,
  normalizeCompactChoice,
  parseBatchActions,
  buildScoreCandidates,
  pickScoredCandidate,
  pickDecidedCandidate,
  SCORED_REASONING_PREFIX,
  extractActionEnvelope,
  mergeBudget,
  normalizeExpectedEvidence,
  normalizePlanStep,
  requiredInputFields,
  TERMINAL_ACTION_STATUSES,
  validateAction,
} = require("./agent_contracts.cjs");
// Context-ceiling resolution helpers (kv-aware default, model clamp) live in
// contracts; kept on a separate require line so the shared destructure above
// stays untouched.
const { defaultContextMaxTokens, modelMaxContextTokens, envKvBits, CONTEXT_GENERATION_HEADROOM_TOKENS } = require("./agent_contracts.cjs");
const { classifyInferenceError } = require("./error_taxonomy.cjs");

const MODEL_TERMINAL_KINDS = new Set(["ask_user", "blocked", "answer"]);
// "task"/"memory" admit only their auto:true members under supervised/guided
// (thread.search, task.ask, remember, memory.feedback/select, plan.propose…);
// lifecycle/explicit members still need autonomyOpens or a plan step.
const SAFE_ADAPTIVE_CAPABILITIES = new Set(["read", "context", "verify", "artifact", "preview", "write", "task", "memory"]);
const FORBIDDEN_ADAPTIVE_CAPABILITIES = new Set(["train", "runtime", "external", "network", "secret"]);
const HOST_DETERMINISTIC_COMMANDS = new Set([
  "artifact.preview.open",
  "artifact.preview.inspect",
]);
// Continuous KV session bounds: past this, a rebuilt standalone request
// (one cold prefill) beats replaying an ever-growing transcript.
const SESSION_MAX_TURNS = 80;
const SESSION_MAX_CHARS = 400000;
// Bounded recovery: invalid/unusable model turns get this many corrective
// re-inferences (on top of the initial attempt) before the host falls back to
// the approved plan step.
const MAX_ACTION_REPAIR_ATTEMPTS = 2;
// A deterministic-input failure (the compact choice cannot express nested
// required args — {"commandId":"improve.propose","input":{}} blocked a task
// outright on evt-1789959126534) gets exactly one corrective re-inference
// with the command's input contract echoed back, then a single retry action.
const MAX_INPUT_REPAIR_ATTEMPTS = 1;
// Decide acceptance gates. Confidence alone admitted a real high-confidence
// `blocked` pick (~0.83-0.99) that contradicted the approved plan; a separable
// top-2 probability margin is required alongside the confidence floor.
const DECIDE_MIN_CONFIDENCE = 0.35;
const DECIDE_MIN_MARGIN = 0.1;

// Context budget guard. The pre-flight projection is a chars/4 heuristic —
// it only ever surfaces as `estimatedTokens`; the authoritative count is
// written back from server usage after each call. When the projection
// exceeds the task's contextMaxTokens the volatile prompt region compacts
// instead of failing: detail fields of older history entries first, then
// stale observation text, then the oldest replayed session turns, then the
// history tail. The byte-static system block is never touched.
const TOKEN_ESTIMATE_CHARS = 4;
const CONTEXT_BUDGET_ERROR_CODE = "CONTEXT_BUDGET_EXHAUSTED";
// Compaction keeps this many replayed turns and whole-detail history rows.
const CONTEXT_COMPACTION_MIN_TURNS = 4;
const CONTEXT_COMPACTION_DETAILED_ACTIONS = 2;
const CONTEXT_COMPACTION_DETAILED_OBSERVATIONS = 1;

// The practical context ceiling is a budget, not the model's advertised
// position count: KV memory on the full-attention layers is the binding
// constraint. mergeBudget resolves a stored task pin; an unpinned
// contextMaxTokens falls back to the live env/kv-aware default (HEMLOCK_KV_BITS
// > 0 raises the default from 24000 to 61440 — quantized full-attention KV is
// ~2x/~4x smaller). The resolved value is then clamped to the model ceiling
// minus generation headroom — an over-ceiling request is adjusted AND
// reported (console + context.ceiling.clamped + contextUsage fields), never
// silently trusted.
const CONTEXT_CLAMP_WARNED = new Set();
function resolveContextMaxTokens(task = {}) {
  const merged = mergeBudget(task?.budget);
  const stored = Number(merged.contextMaxTokens);
  const requested = Number.isFinite(stored) && stored > 0 ? Math.round(stored) : defaultContextMaxTokens();
  const modelMaxTokens = modelMaxContextTokens();
  const ceiling = Math.max(1, modelMaxTokens - CONTEXT_GENERATION_HEADROOM_TOKENS);
  const maxTokens = Math.min(requested, ceiling);
  const clamped = maxTokens !== requested;
  if (clamped) {
    const key = `${requested}->${maxTokens}@${modelMaxTokens}`;
    if (!CONTEXT_CLAMP_WARNED.has(key)) {
      CONTEXT_CLAMP_WARNED.add(key);
      console.warn(`[hemlock] contextMaxTokens ${requested} exceeds the model ceiling ${modelMaxTokens} minus ${CONTEXT_GENERATION_HEADROOM_TOKENS}-token generation headroom; enforcing ${maxTokens}.`);
    }
  }
  return { maxTokens, requestedMaxTokens: requested, clamped, modelMaxTokens, kvBits: envKvBits() };
}

function contextMaxTokensFor(task = {}) {
  return resolveContextMaxTokens(task).maxTokens;
}

// Pre-flight request-size projection for the budget guard ONLY. The
// transport remaps task→compactTask and adds a compact thread context of
// similar order, so serializing the prompt's own volatile fields lands in
// the same band. Anything this produces is labeled estimatedTokens — never
// usedTokens, which comes from server usage.
function estimateActionPromptTokens(actionPrompt = {}) {
  try {
    const turnChars = (Array.isArray(actionPrompt.sessionTurns) ? actionPrompt.sessionTurns : [])
      .reduce((total, turn) => total + String(turn?.content || "").length + String(turn?.reasoning_content || "").length, 0);
    const requestChars = JSON.stringify({
      task: actionPrompt.task,
      nextStep: actionPrompt.nextPlannedStep || null,
      allowedNextCommands: actionPrompt.allowedNextCommands || null,
      progress: actionPrompt.progress || null,
      completed: actionPrompt.history || null,
      repair: actionPrompt.repair || null,
    }).length;
    const chars = String(actionPrompt.system || "").length
      + turnChars
      + requestChars
      + String(actionPrompt.sessionUserContent || "").length;
    return Math.ceil(chars / TOKEN_ESTIMATE_CHARS);
  } catch {
    return null;
  }
}

// Lane fallback for structured-action inference. A transport-class Maple
// death — dropped connection or unreachable host (both classify as
// "transport-death"), or a GPU-server fault — may retry the step ONCE on a
// configured external lane. Parse/envelope failures never qualify: those are
// the model's problem and stay with the in-lane repair loops. Configuration:
// HEMLOCK_FALLBACK_LANE (codex|claude|none, default none) is the global
// default; task.fallbackLane (set on the intent payload) is the per-task
// override — "none" disables the fallback for that task explicitly. With no
// configured lane the behavior is identical to before: the repair loop runs
// and the deterministic plan-step fallback owns the final degradation.
const LANE_FALLBACK_ERROR_KINDS = new Set(["transport-death", "gpu-server-error"]);
const LANE_FALLBACK_PROVIDERS = new Set(["codex", "claude"]);

function envFallbackLane() {
  const lane = String(process.env.HEMLOCK_FALLBACK_LANE || "").trim().toLowerCase();
  return LANE_FALLBACK_PROVIDERS.has(lane) ? lane : null;
}

function fallbackLaneForTask(task = {}) {
  const taskLane = String(task?.fallbackLane || "").trim().toLowerCase();
  if (taskLane === "none") return null;
  if (LANE_FALLBACK_PROVIDERS.has(taskLane)) return taskLane;
  return envFallbackLane();
}

// Lane honesty for receipts: when the durable action was produced by a
// provider other than the task's own lane (a lane fallback), the observation
// must carry the same provenance so no record claims Maple did the work.
function tagObservationLane(observation, action) {
  if (typeof action?.provider === "string" && action.provider && action.provider !== "maple") {
    observation.provider = action.provider;
    if (action.fallbackFrom) observation.fallbackFrom = action.fallbackFrom;
  }
  return observation;
}

// Forced prefix for action-proposal inference: the assistant turn is
// prefilled inside the JSON envelope — generation starts at {"command": and
// the unbounded-reasoning/no-content failure class dies. Two channels carry
// it: `prompt.assistantPrefix` (forwarded as snake_case `assistant_prefix` by
// inferStructuredAction in main.cjs, with a 400-retry fallback if the server
// rejects it) and a second options argument for transports that declare one.
const ACTION_PROPOSAL_PREFIX = "{\"command\":";
const ACTION_PROPOSAL_OPTIONS = Object.freeze({ assistantPrefix: ACTION_PROPOSAL_PREFIX });

const COMMAND_EVIDENCE = Object.freeze({
  "context.refresh": ["context://current"],
  "context.search": ["context://search"],
  "context.query": ["context://query"],
  "repo-map": ["repo://current-worktree"],
  "repo.inspect": ["repo://inspection"],
  "file.read": ["repo://file"],
  "file.search": ["repo://search"],
  "git.status": ["git://status"],
  "git.diff": ["git://diff"],
  "test.discover": ["verification://tests"],
  "verification.list": ["verification://profiles"],
  "receipt.inspect": ["receipt://inspection"],
  "receipts.query": ["receipt://recent"],
  recall: ["memory://scoped"],
  "code.inspect": ["workspace://inspection"],
  verify: ["receipt://verification"],
  "code.apply": ["changeset://applied"],
  "artifact.create": ["artifact://manifest"],
  "artifact.author": ["artifact://revision"],
  "artifact.update": ["artifact://revision"],
  "artifact.inspect": ["artifact://inspection"],
  "artifact.compare": ["artifact://comparison"],
  "artifact.preview.open": ["preview://session"],
  "artifact.preview.inspect": ["preview://inspection"],
  "artifact.preview.interact": ["preview://interaction"],
  "experiment.run": ["experiment://receipt"],
  "experiment.note": ["experiment://finding"],
  "experiment.dataset": ["experiment://dataset"],
  "experiment.suggest": ["experiment://coverage"],
  "world.state": ["world://state"],
  "memory.list": ["memory://records"],
  "memory.note": ["memory://note"],
  "dream.dataset.preview": ["experiment://dataset-preview"],
  "agent.capabilities": ["agent://capabilities"],
  "agent.self": ["agent://self"],
});

function expectedEvidenceForCommand(commandId, fallback = []) {
  return Array.isArray(COMMAND_EVIDENCE[commandId])
    ? [...COMMAND_EVIDENCE[commandId]]
    : normalizeExpectedEvidence(fallback, [`receipt://${String(commandId || "command").replace(/[^a-z0-9._-]+/gi, "-")}`]);
}

// Recovery guidance appended to thrown-command observation summaries so the
// next bounded turn can fix the input instead of re-failing the same way.
const ACTIONABLE_HINTS = Object.freeze({
  "artifact.create": "input carries only artifactId, title, kind, entrypoint, mime — never source or HTML",
  "artifact.author": "supply input.source as a complete self-contained HTML document",
  "artifact.update": "supply input.source as a complete relative-file map or input.patches as complete-file replacements",
  "artifact.preview.open": "provide input.artifactId from an artifact.create receipt",
  "artifact.preview.inspect": "open a preview first or provide input.sessionId",
  "artifact.preview.interact": "open a preview first or provide input.sessionId",
  "code.apply": "supply input.source as a complete relative-file map or input.patches as complete-file replacements",
  "context.query": "supply input.query as a short question",
  "context.search": "supply input.query as a short search string",
  "experiment.run": "input.experiment must be one of pendulum|projectile|orbit|spring|collision|terminal",
  "experiment.note": "supply input.claim; experimentId defaults to the latest run receipt",
  "file.read": "supply input.path as a repo-relative file path",
  "file.search": "supply input.query as a short search string",
  verify: "input.profile must be one of app-build|diff-check|python-tests",
});

// Guided autonomy widens adaptive selection to sandboxed capabilities only —
// artifact authoring and preview sessions are versioned and isolated, so they
// can run without a per-action click. Autonomous additionally permits every
// capability except train, which always requires an explicit user action.
const GUIDED_AUTO_CAPABILITIES = new Set(["artifact", "preview"]);

function autonomyLevel(task = {}) {
  const value = String(task?.autonomy || "bounded-local").toLowerCase();
  if (value === "autonomous" || value === "bounded-campaign") return "autonomous";
  if (value === "guided") return "guided";
  return "supervised";
}

function autonomyPermitsCommand(task, commandId, commandRegistry = {}) {
  const level = autonomyLevel(task);
  if (level === "supervised") return false;
  const capability = String(commandRegistry?.[commandId]?.capability || "").toLowerCase();
  if (level === "guided") return GUIDED_AUTO_CAPABILITIES.has(capability);
  return capability !== "train";
}

function modelMaySelectCommand(commandId, descriptor = {}, plan = { steps: [] }, autonomy = "supervised") {
  const capability = String(descriptor.capability || "").toLowerCase();
  const planned = (plan.steps || []).some((step) => step.commandId === commandId);
  if (!commandId || !capability || FORBIDDEN_ADAPTIVE_CAPABILITIES.has(capability)) return false;
  const autonomyOpens = autonomy === "guided"
    ? GUIDED_AUTO_CAPABILITIES.has(capability)
    : autonomy === "autonomous" && capability !== "train";
  if (!autonomyOpens && !SAFE_ADAPTIVE_CAPABILITIES.has(capability)) return false;
  // A command already present in the user-approved plan is available even if
  // its descriptor is normally explicit (artifact authoring is the important
  // example). New model-selected commands must be host-marked auto-safe —
  // unless the task's autonomy level opens that capability, or the command's
  // approval is "plan": an approved plan is already the capability boundary,
  // so plan-approved commands (e.g. change.apply) run under the same gate as
  // planned steps rather than being hidden from selection entirely.
  if (!planned && !autonomyOpens && descriptor.auto !== true && descriptor.approval !== "plan") return false;
  if (!planned && !autonomyOpens && descriptor.approval === "explicit") return false;
  return true;
}

function allowedNextCommands(commandRegistry = {}, plan = { steps: [] }, history = {}, autonomy = "supervised") {
  const inputHintOf = (commandId) => {
    const hint = commandRegistry[commandId]?.inputHint;
    return typeof hint === "string" && hint.trim() ? { hint: hint.trim() } : {};
  };
  const planned = (plan.steps || []).slice(Number(history.actions?.length || 0)).map((step) => ({
    commandId: step.commandId,
    label: step.label,
    capability: commandRegistry[step.commandId]?.capability || "planned",
    source: "approved-plan",
    ...inputHintOf(step.commandId),
  })).filter((item) => item.commandId);
  const adaptive = Object.entries(commandRegistry)
    .filter(([commandId, descriptor]) => modelMaySelectCommand(commandId, descriptor, plan, autonomy))
    .map(([commandId, descriptor]) => ({ commandId, label: descriptor.label || commandId, capability: descriptor.capability, source: "adaptive-safe", ...inputHintOf(commandId) }));
  const seen = new Set();
  return [...planned, ...adaptive].filter((item) => {
    if (seen.has(item.commandId)) return false;
    seen.add(item.commandId);
    return true;
  }).slice(0, 64);
}

// T12 anti-repeat guard: a completed command's receipt is already durable.
// Re-running it cannot create new progress — it only burns an agent step and,
// in Build mode, starves the artifact steps until the wall clock expires (the
// task-2026-08-24T21-02-29 loop: repo-map re-proposed for ~24 turns after
// artifact.create had completed). When Maple re-proposes anything that already
// completed AND approved plan work remains, the host deterministically advances
// to the plan's next incomplete step instead and records why.
function completedTaskCommands(history = {}) {
  return new Set((history.actions || [])
    .filter((action) => TERMINAL_ACTION_STATUSES.has(action.status) && action.kind !== "ask_user" && action.commandId)
    .map((action) => action.commandId));
}

// Commands whose input selects genuinely different work — a world experiment
// sweep (pendulum length 1 vs 2) or a different file read is new evidence, not
// a loop. For these, a repeat means the same command AND the same effective
// input. For everything else, a completed commandId is a repeat regardless of
// input, so junk-parameter evasion still redirects.
const PARAMETERIZED_REPEAT_COMMANDS = new Set([
  "experiment.run", "experiment.note", "experiment.dataset",
  "file.read", "file.search", "context.search", "context.query",
  "recall", "receipt.inspect", "receipts.query", "verify", "test.discover",
  "code.inspect", "artifact.inspect", "artifact.compare",
]);

function stableDigest(value) {
  if (Array.isArray(value)) return `[${value.map(stableDigest).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableDigest(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function completedWorkKeys(history = {}) {
  return new Set((history.actions || [])
    .filter((action) => TERMINAL_ACTION_STATUSES.has(action.status) && action.kind !== "ask_user" && action.commandId)
    .map((action) => `${action.commandId}::${stableDigest(action.input || {})}`));
}

// Capabilities whose completion can change what a repeat would observe —
// after one of these lands, re-running a read/inspect/verify command is new
// evidence, not a loop.
const MUTATING_CAPABILITIES = new Set(["write", "artifact", "train", "memory"]);

// Write-capable commands that never consume the mutation-set budget: rollback
// restores a prior state and experiment.note only journals a finding.
const MUTATION_EXEMPT_COMMANDS = new Set(["code.rollback", "experiment.note"]);

// Candidate pruning for the scored/decide selection. Every candidate costs a
// teacher-forced pass — measured on Maple: ~36s median/step at ~37 candidates,
// up to ~117s at 69. Rank allowed commands and cap them before expansion:
// approved-plan steps always keep their slot, then adaptive commands by
// capability value, diversity, and repeat-likelihood. Pruned commands stay
// available to the generative path — this narrows what gets scored, never what
// may be chosen.
const SCORE_RANKED_MAX_COMMANDS = Number.isInteger(Number(process.env.HEMLOCK_SCORE_MAX_COMMANDS))
  ? Math.max(4, Math.min(48, Number(process.env.HEMLOCK_SCORE_MAX_COMMANDS)))
  : 14;

const CAPABILITY_SCORE_ORDER = { verify: 50, artifact: 46, write: 42, read: 40, context: 38, preview: 34, memory: 32, task: 30, inference: 20 };

function rankScoringCommands(allowedCommands = [], history = {}, { maxCommands = SCORE_RANKED_MAX_COMMANDS } = {}) {
  const completedIds = completedTaskCommands(history);
  const capabilityCounts = new Map();
  const ranked = allowedCommands.map((entry, index) => {
    const capability = entry.capability || "read";
    const seen = capabilityCounts.get(capability) || 0;
    capabilityCounts.set(capability, seen + 1);
    let score = entry.source === "approved-plan" ? 100 : (CAPABILITY_SCORE_ORDER[capability] ?? 25);
    if (completedIds.has(entry.commandId)) score -= 45;
    if (seen >= 3) score -= 15;
    return { entry, score, index };
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, maxCommands).map((item) => item.entry);
}

// True when a mutating command completed after the requested command's last
// completion — a post-write re-inspection is legitimate and must not be
// redirected away by the anti-repeat guard.
function mutationIntervened(history = {}, commandId, commandRegistry = {}) {
  const actions = history.actions || [];
  let lastCompletion = -1;
  actions.forEach((action, index) => {
    if (action.commandId === commandId && TERMINAL_ACTION_STATUSES.has(action.status)) lastCompletion = index;
  });
  return actions.some((action, index) => index > lastCompletion
    && TERMINAL_ACTION_STATUSES.has(action.status)
    && action.commandId
    && MUTATING_CAPABILITIES.has(commandRegistry?.[action.commandId]?.capability));
}

function resolveProgressCommand(proposal, completedIds, completedWork, planSteps = [], stateChanged = false) {
  const requested = String(proposal?.commandId || "").trim();
  if (!requested) return { commandId: null, redirected: false };
  const repeated = !stateChanged && (PARAMETERIZED_REPEAT_COMMANDS.has(requested)
    ? completedWork?.has(`${requested}::${stableDigest(proposal?.input || {})}`)
    : completedIds?.has(requested));
  if (!repeated) return { commandId: requested || null, redirected: false };
  const nextIndex = planSteps.findIndex((step) => step?.commandId && !completedIds.has(step.commandId));
  const redirect = nextIndex >= 0 ? planSteps[nextIndex] : null;
  return {
    commandId: redirect?.commandId || null,
    redirected: Boolean(redirect),
    reason: `model re-proposed completed ${requested}; host advanced to plan step ${nextIndex + 1}`,
    step: redirect || null,
    requestedCommandId: requested,
  };
}

function actionInputContract(commandId) {
  switch (String(commandId || "")) {
    case "artifact.create":
      return "input may contain only artifactId, title, artifact kind (normally html), entrypoint (normally index.html), and mime. Do not include source, html, data, patches, or a full artifact; authoring is a later step.";
    case "artifact.author":
    case "artifact.update":
      return "input must contain either a complete relative-file source map under source or bounded complete-file replacements under patches. Use the requested visual concept and do not replace it with a fixed template. No external assets or network calls.";
    case "artifact.preview.open":
    case "artifact.preview.inspect":
      return "input should be {} unless the host-provided preview/session identifier is required.";
    case "code.apply":
      return "input must contain either a complete source map under source or a bounded list of complete-file replacements under patches.";
    case "experiment.run":
      return "input must contain experiment (one of projectile, pendulum, spring, orbit, collision, terminal) and may contain input (bounded numeric parameters), seed, and hypothesis. The host clamps parameters and runs the deterministic simulation; you do not compute results.";
    case "experiment.note":
      return "input should contain experimentId (defaults to the latest run receipt) and claim — your interpretation of what the measured result showed. The host attaches the real measurements verbatim.";
    case "experiment.dataset":
      return "input may contain only limit (max 400).";
    case "improve.propose":
      return "input must contain summary and rationale for the bounded change; files and change are optional. A {} input fails deterministic input validation.";
    case "memory.note":
      return "input must contain title and body; tags and evidenceRefs are optional. Record only a lesson worth keeping.";
    case "world.place":
      return "input must contain kind (marker|monument|sign) and label; note and position are optional.";
    case "shell.exec":
      return "input must contain command (an allowlisted executable such as git, rg, node, npm, python3) and may contain args and cwd. No paths, wrappers, or shell syntax.";
    case "plan.revise":
      return "input must contain steps — the full replacement list for the remaining plan, each {commandId,label,input?} or a terminal {kind,label}.";
    case "task.ask":
      return "input must contain question — the decision you need from the user; context is optional.";
    default:
      return "input should be {}. The host supplies task identity, command identity, approval, and evidence.";
  }
}

function defaultPlanSteps(intent, objective = "") {
  if (intent === "verify") return [{ commandId: "verification.list", label: "Select an allowlisted verification", expectedEvidence: ["verification://profiles"] }, { commandId: "verify", label: "Run the selected verification", expectedEvidence: ["receipt://verification"] }];
  if (intent === "memory") return [
    { commandId: "memory.list", label: "List memory records with staleness and provenance", expectedEvidence: ["memory://records"] },
    { commandId: "recall", label: "Recall scoped project lessons", expectedEvidence: ["memory://scoped"] },
    { commandId: "memory.note", label: "Record a memory note worth keeping", expectedEvidence: ["memory://note"] },
  ];
  if (intent === "experiment") return [
    { commandId: "world.state", label: "Read the understory world state before experimenting", expectedEvidence: ["world://state"] },
    { commandId: "experiment.suggest", label: "Read experiment coverage before choosing", expectedEvidence: ["world://suggest"] },
    { commandId: "experiment.run", label: "Run a bounded physics experiment in the world", expectedEvidence: ["experiment://receipt"] },
    { commandId: "experiment.note", label: "Record the finding into the Dream dataset", expectedEvidence: ["experiment://finding"] },
    { kind: "answer", label: "Interpret what the world showed" },
  ];
  if (intent === "inspect") return [{ commandId: "repo-map", label: "Map the current repository", expectedEvidence: ["repo://current-worktree"] }, { commandId: "repo.inspect", label: "Inspect the bounded project surface", expectedEvidence: ["repo://inspection"] }];
  if (intent === "coding") {
    const artifactRequest = /\b(artifact|animation|animated|html|css|javascript|typescript|canvas|svg)\b/i.test(String(objective));
    if (artifactRequest) return [
      { commandId: "repo-map", label: "Map the current repository before authoring", expectedEvidence: ["repo://current-worktree"] },
      { commandId: "artifact.create", label: "Create a task-scoped scratch artifact", expectedEvidence: ["artifact://manifest"] },
      { commandId: "artifact.author", label: "Author the requested animation into the scratch artifact", expectedEvidence: ["artifact://revision"] },
      { commandId: "artifact.preview.open", label: "Open the isolated artifact preview", expectedEvidence: ["preview://session"] },
      { commandId: "artifact.preview.inspect", label: "Inspect the rendered artifact and capture evidence", expectedEvidence: ["preview://inspection"] },
    ];
    const execRequest = /\b(test|tests|lint|build|run|check|exec|script)\b/i.test(String(objective));
    return [
      { commandId: "context.refresh", label: "Refresh scoped project context", expectedEvidence: ["context://current"] },
      { commandId: "repo-map", label: "Map the current repository", expectedEvidence: ["repo://current-worktree"] },
      { commandId: "repo.inspect", label: "Inspect relevant files before editing", expectedEvidence: ["repo://inspection"] },
      { commandId: "git.status", label: "Check worktree scope before a change", expectedEvidence: ["git://status"] },
      ...(execRequest ? [{ commandId: "shell.exec", label: "Run the requested bounded workspace command", input: { command: "npm", args: ["test"] }, expectedEvidence: ["receipt://exec"] }] : []),
      { commandId: "code.apply", label: "Apply the requested scoped coding edit", expectedEvidence: ["changeset://applied"] },
      { commandId: "verify", label: "Run the selected verification profile", expectedEvidence: ["receipt://verification"] },
      { commandId: "git.diff", label: "Record the final scoped diff", expectedEvidence: ["git://diff"] },
    ];
  }
  if (intent === "improve") return [{ commandId: "repo-map", label: "Map the current project", expectedEvidence: ["repo://current-worktree"] }, { commandId: "receipts.query", label: "Recall recent local evidence before proposing", expectedEvidence: ["receipt://recent"] }, { commandId: "dream.dataset.preview", label: "Preview the Dream dataset composition before proposing", expectedEvidence: ["experiment://dataset-preview"] }, { commandId: "improve.propose", label: "Propose a bounded local improvement from the evidence", expectedEvidence: ["receipt://proposed-improvement"] }, { kind: "answer", label: "Summarize the proposed improvement for approval" }];
  if (intent === "conversation") return [{ kind: "answer", label: "Answer from the scoped context and evidence" }];
  return [{ commandId: "agent.capabilities", label: "Read the available command surface", expectedEvidence: ["agent://capabilities"] }, { commandId: "repo-map", label: "Inspect the local project", expectedEvidence: ["repo://current-worktree"] }];
}

// INPUT CONTRACTS stays registry-derived (not allowedCommands-derived) so
// the system prompt remains byte-static across steps and the Maple prompt
// cache still holds — it is a superset of whatever is currently allowed.
// Priority order is fixed (failure-prone commands first): registry order
// would push artifact.author/code.apply/experiment.run past the cap.
const INPUT_CONTRACT_PRIORITY = [
  "artifact.author", "artifact.update", "artifact.create", "code.apply",
  "experiment.run", "experiment.note", "improve.propose", "verify",
  "file.read", "file.search", "context.search", "context.query",
  "artifact.preview.open", "repo.inspect", "repo-map", "remember",
];

// The full structured-action system prompt. Registry-derived only — no
// task/plan/history inputs — so it is byte-static across steps (the Maple
// prompt cache holds) and the host's maple.warm prefill can rebuild the
// identical prefix without a live task; the volatile plan/action tail lives
// in the user turn and is deliberately not part of this prefix.
function buildActionSystemPrompt(commandRegistry = {}) {
  const hintEntries = Object.entries(commandRegistry)
    .map(([commandId, descriptor]) => [commandId, String(descriptor?.inputHint || "").trim()])
    .filter(([, hint]) => hint);
  const inputContracts = [
    ...INPUT_CONTRACT_PRIORITY
      .map((commandId) => hintEntries.find(([id]) => id === commandId))
      .filter(Boolean),
    ...hintEntries.filter(([commandId]) => !INPUT_CONTRACT_PRIORITY.includes(commandId)),
  ].slice(0, 24);
  return [
    "You are Maple-Preview operating inside Hemlock.",
    "Return exactly one compact JSON choice in the content channel — no prose, no markdown, nothing else:",
    '{"kind":"tool","commandId":"<one allowedNextCommands entry>","input":{},"shortRationale":"one-line reason"}',
    "Emit the whole JSON object in the content channel alone — the reasoning channel is not parsed for actions.",
    "kind may instead be answer, ask_user, or blocked: terminal choices with no commandId.",
    "The host assigns id, taskId, step, approval, expectedEvidence, and status. Never emit them.",
    "The approved plan is a user-approved capability boundary and a starting direction, not a rigid script. Choose the next best command from request.allowedNextCommands when more inspection, verification, or artifact work is useful; the host validates and records the adaptation.",
    "request.progress.completedCommands are finished — never re-propose them; a re-proposal is redirected to the plan.",
    ...(inputContracts.length ? [
      "INPUT CONTRACTS (commandId → input shape):",
      ...inputContracts.map(([commandId, hint]) => `${commandId} → ${hint}`),
      "Prefer a tool call over answer when evidence is missing; keep input minimal but complete — free text goes in the named field, not nested objects.",
    ] : []),
    "Never put HTML, source code, or a large payload in artifact.create. Use the later artifact.author step for complete source.",
    "If evidence is insufficient, return kind ask_user or blocked. Do not claim completion without a host observation or receipt.",
  ].join("\n");
}

function fallbackAnimationSource(objective = "Eastern Hemlock night garden") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eastern Hemlock night garden</title>
<style>
:root{color-scheme:dark;font-family:Georgia,serif;background:#071b1b;color:#edf2d5}
*{box-sizing:border-box}body{margin:0;min-height:100vh;overflow:hidden;background:radial-gradient(circle at 70% 18%,#45655b 0 2px,transparent 3px),radial-gradient(circle at 28% 25%,#b9c978 0 1px,transparent 2px),linear-gradient(160deg,#102d2c,#071817 68%,#020b0d)}
.garden{position:relative;min-height:100vh;isolation:isolate;overflow:hidden;padding:clamp(24px,7vw,76px);display:grid;align-content:end}
.moon{position:absolute;width:clamp(92px,18vw,180px);height:clamp(92px,18vw,180px);border-radius:50%;right:14%;top:9%;background:#f5f0c8;box-shadow:0 0 0 18px #e9efc51c,0 0 80px #d9e8bb55;opacity:.9}
.copy{position:relative;z-index:4;max-width:34rem;text-shadow:0 2px 18px #0008}.kicker{font:600 .7rem/1.2 ui-monospace,monospace;letter-spacing:.22em;text-transform:uppercase;color:#c5d694}.title{font-size:clamp(2.4rem,7vw,6.5rem);line-height:.88;margin:.4rem 0 1rem;letter-spacing:-.055em}.subtitle{max-width:28rem;color:#d3dfbd;font:500 clamp(1rem,2vw,1.25rem)/1.45 system-ui,sans-serif}
.mist{position:absolute;z-index:2;left:-10%;right:-10%;bottom:15%;height:24%;border-radius:50%;background:linear-gradient(90deg,transparent,#c5e0be33 25%,#eff0c92b 50%,transparent 78%);filter:blur(16px);animation:drift 13s ease-in-out infinite alternate}
.mist.two{bottom:7%;opacity:.55;animation-duration:19s;animation-direction:alternate-reverse}.ridge{position:absolute;inset:auto -5% 0;height:35%;background:#061313;clip-path:polygon(0 56%,12% 38%,25% 53%,38% 27%,52% 48%,68% 22%,81% 48%,100% 30%,100% 100%,0 100%);z-index:1}
.tree{position:absolute;z-index:3;bottom:-3%;left:clamp(3%,12vw,16%);width:clamp(180px,32vw,390px);height:78%;transform-origin:55% 100%;animation:sway 7s ease-in-out infinite alternate}.tree:before{content:"";position:absolute;left:48%;bottom:0;width:10%;height:79%;background:linear-gradient(90deg,#180f13,#5a3b2a 48%,#24171b);border-radius:50% 50% 15% 15%}.tree:after{content:"";position:absolute;inset:5% 0 16%;background:radial-gradient(ellipse at 54% 9%,#87a36b 0 9%,transparent 10%),radial-gradient(ellipse at 36% 24%,#345f50 0 16%,transparent 17%),radial-gradient(ellipse at 69% 29%,#4e7959 0 17%,transparent 18%),radial-gradient(ellipse at 43% 46%,#254d43 0 21%,transparent 22%),radial-gradient(ellipse at 72% 55%,#527c5c 0 18%,transparent 19%),radial-gradient(ellipse at 29% 60%,#1e453c 0 18%,transparent 19%);filter:drop-shadow(0 16px 10px #0009)}
.firefly{position:absolute;z-index:4;width:7px;height:7px;border-radius:50%;background:#e6ef9a;box-shadow:0 0 8px 3px #e3ed8b99;animation:float 5s ease-in-out infinite}.f1{left:48%;top:24%;animation-duration:3.7s}.f2{left:76%;top:39%;animation-duration:6.3s;animation-delay:-2s}.f3{left:63%;top:59%;animation-duration:4.8s;animation-delay:-1s}.f4{left:31%;top:43%;animation-duration:8.2s;animation-delay:-4s}.f5{left:87%;top:67%;animation-duration:5.4s;animation-delay:-3s}
@keyframes sway{from{transform:rotate(-2deg) translateX(-4px)}to{transform:rotate(2.5deg) translateX(6px)}}@keyframes drift{from{transform:translateX(-10%);opacity:.3}to{transform:translateX(18%);opacity:.75}}@keyframes float{0%,100%{transform:translate(0,0);opacity:.2}35%{transform:translate(18px,-24px);opacity:1}70%{transform:translate(-14px,-8px);opacity:.45}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.001ms!important;animation-iteration-count:1!important}}
</style></head>
<body><main class="garden" data-preview-id="garden" aria-label="Animated Eastern Hemlock night garden"><div class="moon" aria-hidden="true"></div><div class="mist" aria-hidden="true"></div><div class="mist two" aria-hidden="true"></div><div class="ridge" aria-hidden="true"></div><div class="tree" aria-hidden="true"></div><i class="firefly f1"></i><i class="firefly f2"></i><i class="firefly f3"></i><i class="firefly f4"></i><i class="firefly f5"></i><div class="copy"><div class="kicker">Hemlock / living draft</div><h1 class="title">Eastern Hemlock<br>night garden</h1><p class="subtitle">Mist drifts, branches breathe, and fireflies keep their own quiet time.</p></div></main></body></html>`;
}

class AgentOrchestrator {
  constructor({ kernel, commandRegistry, getTask, setTask, emit, executeCommand, inferAction, scoreActions, repairCoding, createSuggestion, worldContext, buildCandidates }) {
    this.kernel = kernel;
    this.commandRegistry = commandRegistry || {};
    this.getTask = getTask;
    this.setTask = setTask;
    this.emit = emit || (() => {});
    this.executeCommand = executeCommand;
    this.inferAction = inferAction || null;
    // scoreActions may be a bare function (legacy shape = /v1/score only) or
    // {decide?, score?}; normalize once so the fast path can prefer decide.
    this.scoreActions = typeof scoreActions === "function"
      ? { score: scoreActions }
      : scoreActions && typeof scoreActions === "object" ? scoreActions : null;
    // Candidate enumerator for the scored/decide fast path — injectable so
    // degenerate enumerations (single candidate) are exercisable.
    this.buildCandidates = typeof buildCandidates === "function" ? buildCandidates : buildScoreCandidates;
    this.repairCoding = repairCoding || null;
    this.createSuggestion = createSuggestion || null;
    this.worldContext = worldContext || null;
    this._sessionTurns = new Map();
    // Last scored/decide winner for the in-flight step, consumed by
    // proposeNextAction to receipt decide↔execute divergence.
    this._scoredDecision = null;
  }

  task() {
    return this.getTask?.() || this.kernel?.getProjection()?.task || null;
  }

  projection(taskId = this.task()?.id) {
    return { ...this.kernel.getTaskHistory(taskId), task: this.task() };
  }

  updateTask(patch) {
    return this.setTask?.(patch) || { ...this.task(), ...patch };
  }

  proposePlan(task = this.task(), { steps, rationale } = {}) {
    if (!task?.id) throw new Error("Hemlock cannot propose a plan without a task.");
    const plan = createPlan({ task, steps: steps || defaultPlanSteps(task.intent, task.objective), rationale });
    this.kernel.createPlan(plan);
    this.updateTask({ phase: "plan", status: "waiting_for_approval", foregroundStep: "Review and approve the bounded plan", activePlanId: plan.id, blockedReason: null, budget: mergeBudget(task.budget) });
    this.emit("plan.proposed", "waiting_for_approval", { plan }, { evidenceRefs: plan.evidenceRefs, reversible: true });
    this.emit("plan.awaiting_approval", "waiting_for_approval", { plan }, { evidenceRefs: plan.evidenceRefs, reversible: true });
    return { schema: "hemlock.agent.plan.result.v1", status: "waiting_for_approval", plan, task: this.task(), claimBoundary: "This plan describes bounded local actions; no command or source mutation has run." };
  }

  requirePlan(taskId, planId) {
    const plan = this.kernel.getProjection().plans.find((item) => item.id === planId && item.taskId === taskId);
    if (!plan) throw new Error(`Hemlock plan was not found for task: ${planId}`);
    return plan;
  }

  async approvePlan(taskId, planId, budgetOverrides = null) {
    const task = this.task();
    if (task?.id !== taskId) throw new Error("The plan does not belong to the current task.");
    const plan = this.requirePlan(taskId, planId);
    if (plan.status === "approved") return { schema: "hemlock.agent.plan.result.v1", status: this.task().status, plan, task: this.task(), claimBoundary: "The plan was already approved; the durable task state is authoritative." };
    // T10-LaneA guard: an approval only means something while the task is
    // actually parked in waiting_for_approval. Reject honestly (no crash, no
    // state mutation) when the task has moved on to running/blocked/terminal.
    if (task.status !== "waiting_for_approval") {
      return {
        schema: "hemlock.agent.plan.result.v1",
        status: "blocked",
        reason: `Task is not awaiting plan approval; current status is ${task.status}.`,
        plan,
        task: this.task(),
        claimBoundary: "No approval was applied and no task state changed.",
      };
    }
    if (plan.status !== "proposed") throw new Error(`Plan is not awaiting approval; current status is ${plan.status}.`);
    // T10-LaneA: clamp user-granted budget overrides here (same pure helper the
    // host uses at plan.approve dispatch) so the orchestrator is safe even when
    // it is driven directly. Out-of-range or garbage keys drop out.
    const clampedOverrides = clampBudgetOverrides(budgetOverrides);
    if (Object.keys(clampedOverrides).length) this.updateTask({ budget: mergeBudget({ ...this.task().budget, ...clampedOverrides }) });
    this.kernel.transitionPlan(planId, "approve");
    this.updateTask({ phase: "work", status: "running", foregroundStep: "Maple is selecting the first bounded action", blockedReason: null, activePlanId: planId });
    this.emit("plan.approved", "passed", { planId, taskId, plan: this.kernel.getProjection().plans.find((item) => item.id === planId) }, { reversible: true });
    return this.resumeTask(taskId);
  }

  rejectPlan(taskId, planId, reason = "Rejected by user") {
    const plan = this.requirePlan(taskId, planId);
    this.kernel.transitionPlan(planId, "reject", { reason });
    this.updateTask({ phase: "blocked", status: "blocked", foregroundStep: "Plan rejected; waiting for a revised intent", blockedReason: reason });
    this.emit("plan.rejected", "blocked", { planId, taskId, reason, plan: this.kernel.getProjection().plans.find((item) => item.id === planId) }, { reversible: true });
    return { schema: "hemlock.agent.plan.result.v1", status: "blocked", plan: this.kernel.getProjection().plans.find((item) => item.id === planId), task: this.task() };
  }

  // plan.revise (plan-gated command): the model proposes a revised
  // remaining-step list for the CURRENT approved plan while a task is
  // running or blocked — replace/insert/remove of everything past the
  // already-executed prefix. Each proposed tool step is validated against
  // the registry and the current allowedNextCommands boundary; any invalid
  // entry rejects the whole revision and the durable plan stays untouched.
  //
  // Dispatch wiring (main.cjs runAgentCommand, registry entry owned by the
  // registry workstream):
  //   else if (command === "plan.revise") result = agentOrchestrator.revisePlan(String(payload.taskId || agentTask.id), payload);
  // Expected payload: { taskId?, planId?, steps: [{ commandId, label, input? } | { kind: "answer"|"ask_user", label }], rationale? }
  revisePlan(taskId = this.task()?.id, { planId, steps, rationale } = {}) {
    const task = this.task();
    if (!task || task.id !== taskId) throw new Error("Hemlock cannot revise a plan for an unknown task.");
    const plan = this.kernel.getProjection().plans.find((item) => item.id === (planId || task.activePlanId) && item.taskId === taskId);
    if (!plan) throw new Error(`Hemlock plan was not found for task: ${planId || task.activePlanId || "none"}`);
    const reject = (reason) => {
      this.emit("plan.revision.rejected", "rejected", { taskId, planId: plan.id, reason }, { evidenceRefs: plan.evidenceRefs || [], reversible: true });
      return { schema: "hemlock.agent.plan.result.v1", status: "rejected", reason, plan, task: this.task(), claimBoundary: "No revision was applied; the durable plan is unchanged." };
    };
    if (TERMINAL_TASK_STATUSES.has(task.status)) return reject(`The task is already terminal: ${task.status}.`);
    if (plan.status !== "approved") return reject(`Only an approved in-flight plan can be revised; current status is ${plan.status}.`);
    if (!Array.isArray(steps) || !steps.length) return reject("A plan revision needs at least one proposed step.");
    const history = this.kernel.getTaskHistory(taskId);
    const currentIndex = history.actions.length;
    const allowed = new Set(this.allowedNextCommands(task, plan, history).map((entry) => entry.commandId));
    const revision = [];
    for (const [index, step] of steps.entries()) {
      const kind = step?.kind || "tool";
      if (kind === "tool") {
        const commandId = String(step?.commandId || "").trim();
        if (!commandId || !this.commandRegistry[commandId]) return reject(`Revision step ${index + 1} names an unknown commandId: ${commandId || "none"}.`);
        if (!allowed.has(commandId)) return reject(`Revision step ${index + 1} command is outside the current capability boundary: ${commandId}.`);
        const descriptor = this.commandRegistry[commandId];
        revision.push({
          ...normalizePlanStep({ ...step, commandId, label: step.label || descriptor.label || commandId, expectedEvidence: Array.isArray(step.expectedEvidence) ? step.expectedEvidence : expectedEvidenceForCommand(commandId) }, index),
          approval: step.approval === "plan" || step.approval === "explicit" ? step.approval : descriptor.approval === "plan" ? "plan" : "none",
        });
      } else if (kind === "answer" || kind === "ask_user") {
        revision.push(normalizePlanStep({ ...step, kind, commandId: null }, index));
      } else {
        return reject(`Revision step ${index + 1} has an unsupported kind: ${kind}.`);
      }
    }
    // The executed prefix is immutable — history indexing assumes one durable
    // action per step, so revisions only ever replace the remaining suffix.
    const kept = plan.steps.slice(0, currentIndex).map((step) => ({ ...step, status: "completed" }));
    const removed = plan.steps.slice(currentIndex);
    const nextSteps = [...kept, ...revision].map((step, index) => ({ ...step, step: index + 1 }));
    const diff = {
      keptCount: kept.length,
      removed: removed.map((step) => ({ step: step.step, commandId: step.commandId || null, kind: step.kind || "tool", label: step.label })),
      added: revision.map((step) => ({ commandId: step.commandId || null, kind: step.kind, label: step.label })),
    };
    const revisionRecord = { revisedAt: new Date().toISOString(), rationale: String(rationale || "").trim() || null, diff };
    const revisions = [...(plan.revisions || []), revisionRecord].slice(-24);
    Object.assign(plan, { steps: nextSteps, revisions, lastRevision: revisionRecord });
    this.kernel.updatePlan(plan.id, { steps: nextSteps, revisions, lastRevision: revisionRecord });
    this.updateTask({ foregroundStep: `Plan revised: ${diff.added.map((step) => step.commandId || step.kind).join(" → ") || "no remaining steps"}` });
    this.emit("plan.revised", "revised", { taskId, planId: plan.id, rationale: revisionRecord.rationale, diff, plan }, { evidenceRefs: plan.evidenceRefs || [], reversible: true });
    return { schema: "hemlock.agent.plan.result.v1", status: "revised", plan, diff, task: this.task() };
  }

  async resumeTask(taskId = this.task()?.id) {
    const task = this.task();
    if (!task || task.id !== taskId) throw new Error("Hemlock cannot resume an unknown task.");
    if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error(`The task is already terminal: ${task.status}.`);
    const plan = this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId && item.taskId === taskId);
    if (task.status === "paused" && (!plan || plan.status !== "approved")) {
      // Paused before approval — resume restores the parked status, not the
      // execution loop (there is no approved plan to step into).
      const restore = task.pausedFrom || "waiting_for_approval";
      this.updateTask({ status: restore, phase: restore === "waiting_for_approval" ? "approval" : task.phase, foregroundStep: "Resumed — awaiting the next decision", pausedAt: null, pausedFrom: null, pausedAnnounced: false });
      this.emit("task.resumed", restore, { taskId }, { reversible: true });
      return { schema: "hemlock.agent.task.result.v1", status: restore, task: this.task() };
    }
    if (!plan || plan.status !== "approved") throw new Error("Approve a plan before resuming execution.");
    if (task.status === "paused") {
      this.updateTask({ status: "running", phase: "work", foregroundStep: "Resuming the approved plan", pausedAt: null, pausedFrom: null, pausedAnnounced: false });
      this.emit("task.resumed", "running", { taskId }, { reversible: true });
    }
    return this.proposeNextAction(taskId, plan);
  }

  allowedNextCommands(task, plan, history) {
    return allowedNextCommands(this.commandRegistry, plan, history, autonomyLevel(task));
  }

  selectModelCommand(task, plan, history, requestedCommandId) {
    const currentStep = plan.steps[history.actions.length] || null;
    const currentCommandId = currentStep?.commandId || null;
    const requested = String(requestedCommandId || "").trim();
    if (!requested || requested === "none") return { commandId: currentCommandId, mode: "planned", reason: "model omitted a command" };
    if (requested === currentCommandId) return { commandId: requested, mode: "planned", reason: null };
    const descriptor = this.commandRegistry[requested];
    if (descriptor && modelMaySelectCommand(requested, descriptor, plan, autonomyLevel(task))) {
      return { commandId: requested, mode: "adaptive", reason: "Maple selected an allowlisted next action" };
    }
    if (currentCommandId) {
      return {
        commandId: currentCommandId,
        mode: "recovered",
        reason: `Maple selected unavailable command ${requested}; continuing with the current approved step.`,
      };
    }
    const error = new Error(`Maple selected unavailable command: ${requested}`);
    error.code = "ACTION_COMMAND_NOT_ALLOWED";
    throw error;
  }

  adaptPlanForCommand(task, plan, history, decision) {
    if (!decision?.commandId || decision.mode !== "adaptive") return plan.steps[history.actions.length] || null;
    const currentIndex = history.actions.length;
    let existingIndex = plan.steps.findIndex((step, index) => index >= currentIndex && step.commandId === decision.commandId);
    let step = existingIndex >= currentIndex ? plan.steps.splice(existingIndex, 1)[0] : null;
    // T12 anti-repeat: never INSERT a new copy of a command that already
    // completed in this task while incomplete approved work remains — that
    // grew the plan forever and pushed the real step out of reach (the
    // task-2026-08-24 Build-mode loop). Hand back the current slot instead;
    // the proposeNextAction progress guard owns the explicit redirect note.
    if (!step) {
      const completedIds = completedTaskCommands(history);
      const openPlannedWork = plan.steps.some((item, index) => index >= currentIndex && item?.commandId && !completedIds.has(item.commandId));
      if (completedIds.has(decision.commandId) && openPlannedWork && !mutationIntervened(history, decision.commandId, this.commandRegistry)) return plan.steps[currentIndex] || null;
    }
    const descriptor = this.commandRegistry[decision.commandId] || {};
    if (!step) {
      step = {
        kind: "tool",
        commandId: decision.commandId,
        label: descriptor.label || decision.commandId,
        expectedEvidence: expectedEvidenceForCommand(decision.commandId),
        approval: descriptor.approval === "plan" ? "plan" : "none",
        status: "ready",
      };
    }
    step = { ...step, adaptive: true, selectionReason: decision.reason };
    plan.steps.splice(currentIndex, 0, step);
    const steps = plan.steps.map((item, index) => ({
      ...item,
      step: index + 1,
      status: index < currentIndex ? "completed" : index === currentIndex ? "ready" : "queued",
    }));
    const adaptiveDecisions = [...(plan.adaptiveDecisions || []), {
      atStep: currentIndex + 1,
      commandId: decision.commandId,
      reason: decision.reason,
      createdAt: new Date().toISOString(),
    }].slice(-48);
    Object.assign(plan, { steps, adaptiveDecisions, lastAdaptiveDecision: adaptiveDecisions.at(-1) });
    this.kernel.updatePlan(plan.id, { steps, adaptiveDecisions, lastAdaptiveDecision: plan.lastAdaptiveDecision });
    this.emit("plan.adapted", "running", {
      taskId: task.id,
      planId: plan.id,
      insertedStep: plan.steps[currentIndex],
      allowedNextCommands: this.allowedNextCommands(task, plan, history),
    }, { evidenceRefs: expectedEvidenceForCommand(decision.commandId), reversible: true });
    return plan.steps[currentIndex];
  }

  // Action-proposal inference with the forced JSON prefix. The prefix rides
  // the prompt as `assistantPrefix` — the live channel inferStructuredAction
  // already forwards as `assistant_prefix` — and additionally as a second
  // options argument when the transport declares one (arity >= 2).
  // Chat/free-text inference never routes through here.
  inferProposal(prompt) {
    const prefixed = { ...prompt, assistantPrefix: ACTION_PROPOSAL_PREFIX };
    return this.inferAction.length >= 2
      ? this.inferAction(prefixed, ACTION_PROPOSAL_OPTIONS)
      : this.inferAction(prefixed);
  }

  // Bounded context compaction for the volatile request region. Order:
  // detail fields of older history entries (ids + statuses survive), then
  // stale observation text, then the oldest replayed session turns (dropped
  // from the front in pairs so a user turn stays first), then the history
  // tail itself, and finally the whole replayed transcript — after which the
  // slim history re-expands because the transcript had been carrying it.
  // The byte-static system block is never touched. Every pass is receipted
  // with context.compacted (what dropped, counts, reason); the prompt's
  // progress notes "N earlier steps compacted" so Maple knows. Throws
  // CONTEXT_BUDGET_EXHAUSTED when even a fully compacted request cannot fit.
  compactActionContext(task, actionPrompt, sessionNext, compactHistory, maxTokens, contextCeiling = null) {
    const dropped = { actionDetails: 0, observationDetails: 0, operationDetails: 0, historyEntries: 0, sessionTurns: 0 };
    const slimAction = (entry) => ({ id: entry.id, step: entry.step, kind: entry.kind, commandId: entry.commandId, status: entry.status });
    const slimObservation = (entry) => ({ id: entry.id, operationId: entry.operationId ?? null, status: entry.status, outputDigest: entry.outputDigest ?? null });
    const slimOperation = (entry) => ({ id: entry.id, command: entry.command, status: entry.status });
    const slimList = (items, keepWhole, slim, counterKey) => (Array.isArray(items) ? items : []).map((entry, index, list) => {
      if (index >= list.length - keepWhole) return entry;
      const slimmed = slim(entry);
      if (JSON.stringify(slimmed).length >= JSON.stringify(entry).length) return entry;
      dropped[counterKey] += 1;
      return slimmed;
    });
    const measure = () => estimateActionPromptTokens(actionPrompt);
    const history = actionPrompt.history || {};
    // Phase 1: strip progress details from older history entries; the
    // freshest rows stay whole so the current step keeps full fidelity.
    actionPrompt.history = {
      actions: slimList(history.actions, CONTEXT_COMPACTION_DETAILED_ACTIONS, slimAction, "actionDetails"),
      observations: slimList(history.observations, CONTEXT_COMPACTION_DETAILED_OBSERVATIONS, slimObservation, "observationDetails"),
      operations: slimList(history.operations, CONTEXT_COMPACTION_DETAILED_OBSERVATIONS, slimOperation, "operationDetails"),
    };
    let estimatedTokens = measure();
    // Phase 2: drop the oldest replayed session turns. The next committed
    // call re-keys the prompt cache on the shorter transcript — a rebase,
    // not silent loss, and the event below records the counts.
    if (estimatedTokens > maxTokens && sessionNext.length > CONTEXT_COMPACTION_MIN_TURNS) {
      let removable = sessionNext.length - CONTEXT_COMPACTION_MIN_TURNS;
      if (removable % 2) removable -= 1;
      const removed = sessionNext.splice(0, removable);
      dropped.sessionTurns += removed.length;
      actionPrompt.sessionTurns = [...sessionNext];
      estimatedTokens = measure();
    }
    // Phase 3: shrink the history tail itself to the freshest entries.
    if (estimatedTokens > maxTokens) {
      const before = actionPrompt.history;
      actionPrompt.history = {
        actions: before.actions.slice(-CONTEXT_COMPACTION_DETAILED_ACTIONS),
        observations: before.observations.slice(-CONTEXT_COMPACTION_DETAILED_OBSERVATIONS),
        operations: before.operations.slice(-CONTEXT_COMPACTION_DETAILED_OBSERVATIONS),
      };
      dropped.historyEntries = Math.max(0, before.actions.length - actionPrompt.history.actions.length)
        + Math.max(0, before.observations.length - actionPrompt.history.observations.length)
        + Math.max(0, before.operations.length - actionPrompt.history.operations.length);
      estimatedTokens = measure();
    }
    // Phase 4: still over → drop the replayed transcript entirely and
    // re-expand slim history to compensate (the transcript had been carrying
    // that context). The session rebases on the next committed call. With no
    // transcript to drop, the phase-3 minimum already stands — re-expanding
    // would only grow the request.
    if (estimatedTokens > maxTokens && sessionNext.length) {
      dropped.sessionTurns += sessionNext.length;
      sessionNext.length = 0;
      actionPrompt.sessionTurns = [];
      const full = compactHistory || actionPrompt.history;
      actionPrompt.history = {
        actions: slimList((full.actions || []).slice(-8), CONTEXT_COMPACTION_DETAILED_ACTIONS, slimAction, "actionDetails"),
        observations: (full.observations || []).slice(-2).map(slimObservation),
        operations: (full.operations || []).slice(-2).map(slimOperation),
      };
      estimatedTokens = measure();
    }
    const compactedSteps = dropped.actionDetails + dropped.observationDetails + dropped.operationDetails + dropped.historyEntries;
    this.emit("context.compacted", "degraded", {
      taskId: task?.id || null,
      reason: "projected-request-over-budget",
      outcome: estimatedTokens > maxTokens ? "exhausted" : "compacted",
      estimatedTokens,
      estimated: true,
      maxTokens,
      dropped,
      compactedSteps,
    }, { reversible: true });
    if (estimatedTokens > maxTokens) {
      const error = new Error(`Context budget exhausted: a fully compacted request is still ~${estimatedTokens} estimated tokens against a ${maxTokens}-token budget.`);
      error.code = CONTEXT_BUDGET_ERROR_CODE;
      error.contextUsage = {
        taskId: task?.id || null,
        estimatedTokens,
        maxTokens,
        dropped,
        // If the configured ceiling exceeded the model clamp, the enforced
        // maxTokens is lower than requested — carry both.
        requestedMaxTokens: contextCeiling?.requestedMaxTokens ?? null,
        maxTokensClamped: contextCeiling?.clamped === true,
      };
      throw error;
    }
    actionPrompt.progress = {
      ...(actionPrompt.progress || {}),
      contextCompaction: {
        compactedSteps,
        sessionTurnsDropped: dropped.sessionTurns,
        estimatedTokens,
        estimated: true,
        maxTokens,
        note: `${compactedSteps} earlier steps compacted${dropped.sessionTurns ? ` and ${dropped.sessionTurns} replayed transcript turns dropped` : ""} to fit the ${maxTokens}-token context budget; older progress now lists ids and statuses only.`,
      },
    };
    return { actionPrompt, dropped, estimatedTokens, maxTokens };
  }

  async infer(task, plan, history) {
    if (!this.inferAction) return null;
    this._scoredDecision = null;
    const asModelResult = (value) => {
      if (typeof value === "string") return { content: value, channels: [], rawOutputRef: null };
      if (value && typeof value === "object" && typeof value.content === "string") {
        return {
          content: value.content,
          // Kept for the split-channel salvage in parseModelResult: the forced
          // `{"command":` prefix occasionally lands alone in content with the
          // JSON tail in reasoning — one bounded rejoin attempt, never merge-
          // by-default (a reasoning tail that does not re-parse is ignored).
          reasoning: typeof value.reasoning === "string" ? value.reasoning : "",
          channels: Array.isArray(value.channels) ? value.channels : [],
          rawOutputRef: value.rawOutputRef || null,
          // Lane provenance: the non-maple structured-action transport tags
          // its result with the provider that produced it; Maple's transport
          // leaves it unset. Propagated so a fallback-lane action can never
          // be receipted as Maple output.
          provider: typeof value.provider === "string" && value.provider ? value.provider : null,
        };
      }
      return { content: "", channels: [], rawOutputRef: null };
    };
    const summarizeOutput = (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const summary = {};
      for (const key of ["schema", "status", "id", "artifactId", "taskId", "workspaceId", "revision", "digest", "session", "sessionId", "claimBoundary", "summary", "root", "dirty", "exitCode", "error"]) {
        if (Object.prototype.hasOwnProperty.call(value, key)) summary[key] = value[key];
      }
      // The model must see WHY verification/repair failed — issues and the
      // nested verification verdict are diagnostic payload, not noise.
      if (Array.isArray(value.issues)) summary.issues = value.issues.slice(0, 16).map((item) => typeof item === "string" ? item : { code: item?.code, message: item?.message });
      if (value.verification && typeof value.verification === "object") {
        summary.verification = { status: value.verification.status, issues: Array.isArray(value.verification.issues) ? value.verification.issues.slice(0, 12).map((item) => typeof item === "string" ? item : { code: item?.code, message: item?.message }) : [] };
      }
      if (Array.isArray(value.evidenceRefs)) summary.evidenceRefs = value.evidenceRefs.slice(0, 12);
      if (Array.isArray(value.files)) summary.fileCount = value.files.length;
      if (Array.isArray(value.revisions)) summary.revisionCount = value.revisions.length;
      if (value.artifact && typeof value.artifact === "object") summary.artifact = summarizeOutput(value.artifact);
      if (value.observation && typeof value.observation === "object") summary.observation = summarizeOutput(value.observation);
      return summary;
    };
    const compactHistory = {
      actions: history.actions.slice(-16).map(({ id, step, kind, commandId, status, shortRationale, observationId }) => ({ id, step, kind, commandId, status, shortRationale, observationId })),
      observations: history.observations.slice(-16).map((observation) => ({ id: observation.id, operationId: observation.operationId, status: observation.status, summary: observation.summary, outputDigest: observation.outputDigest, evidenceRefs: (observation.evidenceRefs || []).slice(0, 12), structuredOutput: summarizeOutput(observation.structuredOutput) })),
      operations: history.operations.slice(-16).map(({ id, command, status, evidenceRefs, error }) => ({ id, command, status, evidenceRefs: (evidenceRefs || []).slice(0, 12), error })),
    };
    const nextPlannedStep = plan.steps[history.actions.length] || null;
    const allowedCommands = this.allowedNextCommands(task, plan, history);
    // T12 next-action clarity: Maple's failed-session reasoning showed genuine
    // confusion about what had already finished ("plan.approve is running but
    // not yet completed... suggests the plan has been approved"). Make the
    // completion state explicit and compact so stale commands stop looking live.
    const completedIds = completedTaskCommands(history);
    const totalSteps = plan.steps.filter((step) => step?.commandId).length;
    const doneSteps = plan.steps.filter((step) => step?.commandId && completedIds.has(step.commandId)).length;
    // Continuous KV session: replay prior steps verbatim as chat turns so the
    // rendered prompt is a strict token-prefix extension of the server's
    // committed cache entry — each step prefills only the trailing delta.
    // Turns are recorded verbatim from each transport's requestContent, so
    // the transcript is exactly what was sent; a replay that fails to match
    // the committed key degrades to a normal (partial) cache hit, never a
    // wrong result.
    const sessionKey = task?.id ? String(task.id) : null;
    const sessionDisabled = !sessionKey || process.env.HEMLOCK_NO_PREFIX_CACHE === "1";
    const sessionTurns = sessionDisabled ? [] : [...(this._sessionTurns.get(sessionKey) || [])];
    if (sessionTurns.length > SESSION_MAX_TURNS || sessionTurns.reduce((n, turn) => n + String(turn?.content || "").length, 0) > SESSION_MAX_CHARS) sessionTurns.length = 0;
    // Older history already lives in the transcript turns; once a session is
    // established the delta turn only needs the freshest entries.
    const requestHistory = sessionTurns.length
      ? {
          actions: compactHistory.actions.slice(-1),
          observations: compactHistory.observations.slice(-1),
          operations: compactHistory.operations.slice(-1),
        }
      : compactHistory;
    const sessionNext = [...sessionTurns];
    let sessionBroken = false;
    const persistSession = () => {
      if (sessionDisabled) return;
      const chars = sessionNext.reduce((n, turn) => n + String(turn?.content || "").length, 0);
      if (sessionBroken || sessionNext.length > SESSION_MAX_TURNS || chars > SESSION_MAX_CHARS) this._sessionTurns.delete(sessionKey);
      else this._sessionTurns.set(sessionKey, sessionNext);
      if (this._sessionTurns.size > 16) this._sessionTurns.clear();
    };
    const noteCacheMiss = (result) => {
      // An established session that suddenly gets zero cached tokens means the
      // server's committed key was evicted (restart, LRU pressure, adapter
      // swap). Rebase next step instead of paying growing dead transcript.
      if (sessionTurns.length && result && typeof result === "object" && result.cachedTokens === 0) sessionBroken = true;
    };
    const recordGenerativeTurn = (result) => {
      if (!result || typeof result !== "object") return;
      if (typeof result.requestContent === "string") sessionNext.push({ role: "user", content: result.requestContent });
      const content = typeof result.content === "string" ? result.content : "";
      if (!content) { persistSession(); return; }
      const reasoning = typeof result.reasoning === "string" ? result.reasoning.trim() : "";
      // The generation prompt ends with the template's forced `<think>\n`
      // opener, so a reasoning-free emission replays as literal content
      // beginning with `<think>` — matching what the server committed.
      sessionNext.push(reasoning
        ? { role: "assistant", content, reasoning_content: reasoning }
        : { role: "assistant", content: `<think>\n${content}` });
      persistSession();
    };
    // T13 compact-choice contract: the system prompt is fully static so the
    // Maple prompt cache holds across steps (cacheHitRatio telemetry records
    // the win), and the model only emits the fields it actually decides — the
    // host assigns id/taskId/step/approval/status/expectedEvidence anyway, so
    // asking for them was pure hallucination surface. Volatile progress moved
    // into the request body.
    let actionPrompt = {
      system: buildActionSystemPrompt(this.commandRegistry),
      task,
      plan,
      nextPlannedStep,
      allowedNextCommands: allowedCommands,
      history: requestHistory,
      sessionTurns,
      progress: {
        plannedCommand: nextPlannedStep?.commandId || null,
        completedCommands: [...completedIds],
        planProgress: `step ${Math.min(doneSteps + 1, Math.max(totalSteps, 1))} of ${Math.max(totalSteps, 1)}${totalSteps ? "" : " (no planned tool steps)"}`,
        inputContract: actionInputContract(nextPlannedStep?.commandId),
        // What Maple has already learned in the world — lets follow-up
        // experiments build on prior findings instead of repeating blindly.
        worldFindings: (() => { try { return this.worldContext?.() || null; } catch { return null; } })(),
      },
    };
    // Context budget guard: project the request BEFORE spending the call.
    // The estimate is the chars/4 heuristic and only ever surfaces as
    // estimatedTokens; the authoritative count is written back from server
    // usage after each transport returns. Over budget → compact the volatile
    // region (context.compacted receipts every pass); still over →
    // CONTEXT_BUDGET_EXHAUSTED, which proposeNextAction turns into an honest
    // context-exhausted block instead of a crash or a silent degrade.
    const contextCeiling = resolveContextMaxTokens(task);
    const contextMaxTokens = contextCeiling.maxTokens;
    if (contextCeiling.clamped) {
      // Durable note for the spine — once per task per clamped pair.
      const clampKey = `${task?.id || "task"}:${contextCeiling.requestedMaxTokens}->${contextCeiling.maxTokens}`;
      this._contextClampNotified = this._contextClampNotified || new Set();
      if (!this._contextClampNotified.has(clampKey)) {
        this._contextClampNotified.add(clampKey);
        this.emit("context.ceiling.clamped", "degraded", {
          taskId: task?.id || null,
          requestedMaxTokens: contextCeiling.requestedMaxTokens,
          maxTokens: contextCeiling.maxTokens,
          modelMaxTokens: contextCeiling.modelMaxTokens,
          generationHeadroom: CONTEXT_GENERATION_HEADROOM_TOKENS,
          kvBits: contextCeiling.kvBits,
          note: "Configured contextMaxTokens exceeds the model ceiling minus generation headroom; the clamped value is enforced.",
        }, { reversible: true });
      }
    }
    let promptEstimate = estimateActionPromptTokens(actionPrompt);
    if (Number.isFinite(promptEstimate) && promptEstimate > contextMaxTokens) {
      const compacted = this.compactActionContext(task, actionPrompt, sessionNext, compactHistory, contextMaxTokens, contextCeiling);
      actionPrompt = compacted.actionPrompt;
      promptEstimate = compacted.estimatedTokens;
    }
    // Real token accounting: usage flows back on every transport result and
    // lands on the task — per-step prompt/completion tokens accumulate into
    // metrics, and the rolling contextUsed estimate (last step's
    // prompt+completion ≈ the committed context) lives on task.contextUsage.
    const recordContextUsage = (result, mode) => {
      if (!result || typeof result !== "object") return;
      const usage = result.usage && typeof result.usage === "object" ? result.usage : result;
      const pick = (...keys) => {
        for (const key of keys) {
          const value = Number(usage?.[key]);
          if (Number.isFinite(value)) return value;
        }
        return null;
      };
      const promptTokens = pick("promptTokens", "prompt_tokens");
      const completionTokens = pick("completionTokens", "completion_tokens");
      const cachedTokens = pick("cachedTokens", "cached_tokens")
        ?? (Number.isFinite(Number(usage?.prompt_tokens_details?.cached_tokens)) ? Number(usage.prompt_tokens_details.cached_tokens) : null);
      if (promptTokens == null && cachedTokens == null) return;
      const current = this.task() || {};
      const previous = current.contextUsage && typeof current.contextUsage === "object" ? current.contextUsage : {};
      const contextUsage = {
        taskId: task?.id || null,
        // Last step's prompt+completion ≈ committed context.
        usedTokens: promptTokens != null ? promptTokens + (completionTokens || 0) : previous.usedTokens ?? null,
        promptTokens: promptTokens ?? previous.promptTokens ?? null,
        completionTokens: completionTokens ?? previous.completionTokens ?? null,
        cachedTokens: cachedTokens ?? previous.cachedTokens ?? null,
        estimatedTokens: Number.isFinite(promptEstimate) ? promptEstimate : null,
        maxTokens: contextMaxTokens,
        // Honest clamp note: when the configured ceiling exceeded the model
        // clamp, requestedMaxTokens keeps the configured value — the lower
        // enforced ceiling is never silent.
        requestedMaxTokens: contextCeiling.requestedMaxTokens,
        maxTokensClamped: contextCeiling.clamped === true,
        kvBits: contextCeiling.kvBits,
        source: "server-usage",
        mode,
        samples: Number(previous.samples || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      const metrics = { ...(current.metrics || {}) };
      if (promptTokens != null) metrics.promptTokens = Number(metrics.promptTokens || 0) + promptTokens;
      if (completionTokens != null) metrics.completionTokens = Number(metrics.completionTokens || 0) + completionTokens;
      if (cachedTokens != null) metrics.cachedTokens = Number(metrics.cachedTokens || 0) + cachedTokens;
      if (contextUsage.usedTokens != null) metrics.contextPeakTokens = Math.max(Number(metrics.contextPeakTokens || 0), contextUsage.usedTokens);
      this.updateTask({ contextUsage, metrics });
    };
    // Scored-choice fast path (parallel constrained decoding): enumerate the
    // closed command set as minimal candidate continuations and let the model
    // score them against the shared prefilled prompt instead of generating an
    // envelope token-by-token. A `complete` winner is already a valid compact
    // envelope — zero generated tokens, nothing to misparse. A prefix winner
    // means a generative action was chosen; its decision is recorded into
    // progress and the normal generative path fills in the free fields.
    let response = null;
    if (this.scoreActions) {
      try {
        const candidates = this.buildCandidates(rankScoringCommands(allowedCommands, history).map((entry) => entry.commandId), { maxCandidates: 24 });
        const startedAt = Date.now();
        // Prefer one batched /v1/decide choice over per-candidate /v1/score
        // continuations. A missing endpoint (null), an unusable answer, or a
        // transport failure falls back to the score path rather than skipping
        // the fast path entirely.
        let decision = null;
        let decisionMode = null;
        let scored = null;
        let skippedReason = null;
        if (candidates.length <= 1) {
          // Single-candidate fast path: with at most one continuation there is
          // nothing to rank, so /v1/decide and /v1/score would burn a full
          // inference to "choose" it. Take the candidate directly.
          decisionMode = "single-candidate";
          skippedReason = candidates.length === 1 ? "single-candidate" : "no-candidates";
          const winner = candidates[0] || null;
          if (winner) decision = { winner, margin: null, runnerUp: null, candidateCount: candidates.length, probability: null, confidence: null, promptTokens: null, cachedTokens: null };
        } else if (typeof this.scoreActions.decide === "function") {
          try {
            const decided = await this.scoreActions.decide(actionPrompt, candidates);
            if (decided) {
              noteCacheMiss(decided);
              recordContextUsage(decided, "decide");
              const picked = pickDecidedCandidate(candidates, decided);
              if (picked) { decision = picked; decisionMode = "decide"; scored = decided; }
            }
          } catch (decideError) {
            this.emit("action.scored", "degraded", { taskId: task.id, mode: "decide", error: decideError.message }, { reversible: true });
          }
        }
        if (!decision && candidates.length > 1 && typeof this.scoreActions.score === "function") {
          const scoreResult = await this.scoreActions.score(actionPrompt, candidates.map((candidate) => candidate.text));
          noteCacheMiss(scoreResult);
          recordContextUsage(scoreResult, "score");
          const picked = pickScoredCandidate(candidates, scoreResult);
          if (picked) { decision = picked; decisionMode = "score"; scored = scoreResult; }
        }
        if (skippedReason && !decision) {
          this.emit("action.scored", "passed", {
            taskId: task.id,
            mode: decisionMode,
            skipped: true,
            reason: skippedReason,
            winner: null,
            candidateCount: candidates.length,
            elapsedMs: Date.now() - startedAt,
          }, { reversible: true });
        }
        if (decision) {
          // Only join the transcript on a decision: otherwise the scored
          // request is an orphan turn that would diverge the replay from the
          // infer request's committed cache key.
          if (typeof scored?.requestContent === "string") sessionNext.push({ role: "user", content: scored.requestContent });
          const confidence = Number(decision.confidence);
          // A low-confidence decide winner means the model was genuinely
          // split — record the decision but let the generative path resolve
          // it rather than committing a zero-token action on a coin flip.
          // Confidence alone was not enough in production (a ~0.9 winner once
          // argued for `blocked` while planned work remained), so the winner
          // must also clear a minimum top1-top2 probability margin when the
          // decide payload carries a real probability map.
          const margin = Number(decision.margin);
          const indecisive = decisionMode === "decide" && !(
            confidence >= DECIDE_MIN_CONFIDENCE
            && (!Number.isFinite(margin) || margin >= DECIDE_MIN_MARGIN)
          );
          // Stash the winner for the divergence receipt in
          // proposeNextAction: decide picks are advisory — the host still
          // executes the planned/selected step, and executed ≠ decided must
          // be durable, not silent.
          this._scoredDecision = {
            taskId: task.id,
            mode: decisionMode,
            winner: { kind: decision.winner.kind, commandId: decision.winner.commandId ?? null },
            probability: decision.probability ?? null,
            confidence: Number.isFinite(confidence) ? confidence : null,
            margin: decision.margin ?? null,
          };
          // Per-option scores ride the receipt so offline evaluation can
          // re-run winner selection under permuted option order (the kev
          // permutation-invariance check) instead of trusting the recorded
          // winner blindly.
          const scoredOptions = (() => {
            if (decisionMode === "decide") {
              const answer = Object.values(scored?.answers || {}).find((item) => item?.type === "choice");
              const probabilities = answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};
              return candidates.map((candidate, index) => ({ kind: candidate.kind, commandId: candidate.commandId ?? null, probability: Number.isFinite(Number(probabilities[`cand-${index}`])) ? Number(probabilities[`cand-${index}`]) : null }));
            }
            if (decisionMode === "score") {
              const byIndex = new Map((Array.isArray(scored?.candidates) ? scored.candidates : []).map((entry) => [entry?.index, entry?.avgLogprob]));
              return candidates.map((candidate, index) => ({ kind: candidate.kind, commandId: candidate.commandId ?? null, avgLogprob: Number.isFinite(byIndex.get(index)) ? Number(byIndex.get(index)) : null }));
            }
            return candidates.map((candidate) => ({ kind: candidate.kind, commandId: candidate.commandId ?? null }));
          })();
          this.emit("action.scored", "passed", {
            taskId: task.id,
            mode: decisionMode,
            ...(skippedReason ? { skipped: true, reason: skippedReason } : {}),
            winner: { kind: decision.winner.kind, commandId: decision.winner.commandId },
            options: scoredOptions,
            complete: decision.winner.complete,
            avgLogprob: decision.winner.avgLogprob ?? null,
            probability: decision.probability ?? null,
            confidence: Number.isFinite(confidence) ? confidence : null,
            margin: decision.margin,
            indecisive,
            runnerUp: decision.runnerUp,
            candidateCount: decision.candidateCount,
            cachedTokens: decision.cachedTokens,
            elapsedMs: Date.now() - startedAt,
          }, { reversible: true });
          // The server committed prompt+suffix+winner+eos (or at least
          // prompt+suffix); replaying the winner as an assistant turn with the
          // fixed reasoning prefix renders a strict token-prefix extension.
          // A skipped single-candidate pick never hit the server, so nothing
          // was committed — replaying a fabricated turn would only diverge the
          // transcript from the committed cache key without benefit.
          const scoredTurn = { role: "assistant", content: scored?.committedText || decision.winner.text, reasoning_content: SCORED_REASONING_PREFIX };
          const replayScoredTurn = decisionMode !== "single-candidate";
          if (decision.winner.complete && !indecisive) {
            if (replayScoredTurn) sessionNext.push(scoredTurn);
            persistSession();
            response = { content: decision.winner.text, channels: [], rawOutputRef: null };
          } else {
            actionPrompt.progress.scoredDecision = {
              kind: decision.winner.kind,
              commandId: decision.winner.commandId,
              margin: decision.margin,
              advisory: true,
              ...(decisionMode === "decide" ? { probability: decision.probability ?? null, confidence: Number.isFinite(confidence) ? confidence : null, indecisive } : {}),
            };
            // Prefix winner (or an indecisive decide): the generative fill-in
            // re-enters the session one turn later — replay the scored turn,
            // then ask for the rest. The fill-in must name the ACTUAL action
            // being executed — the host-selected planned step — never the
            // ignored decide winner. Telling the model to "continue the
            // scored command choice" made it parrot the winner's text
            // ("Blocked due to insufficient evidence") into the executed
            // envelope and once emit {"kind":"blocked"} outright, killing a
            // receipt-backed task in one step.
            const executingAction = nextPlannedStep?.commandId
              ? { commandId: nextPlannedStep.commandId, label: nextPlannedStep.label || null, input: nextPlannedStep.input && typeof nextPlannedStep.input === "object" && !Array.isArray(nextPlannedStep.input) ? nextPlannedStep.input : {} }
              : null;
            const winnerMatchesExecution = Boolean(executingAction) && decision.winner.kind === "tool" && decision.winner.commandId === executingAction.commandId;
            sessionNext.push(scoredTurn);
            actionPrompt = {
              ...actionPrompt,
              sessionTurns: [...sessionNext],
              sessionUserContent: JSON.stringify({
                scoredDecision: actionPrompt.progress.scoredDecision,
                executingAction,
                instruction: winnerMatchesExecution
                  ? `Emit the complete compact JSON action continuing the scored ${executingAction.commandId} choice — fill in its required input fields.`
                  : executingAction
                    ? `The scored choice was advisory only and is not what runs. The host is executing the approved plan step ${executingAction.commandId}; emit the complete compact JSON action for ${executingAction.commandId} with its required input. Never restate or quote the scored choice.`
                    : "Emit the complete compact JSON action for the next step. The scored choice was advisory only; never restate or quote it.",
              }),
            };
            persistSession();
          }
        }
      } catch (scoreError) {
        this.emit("action.scored", "degraded", {
          taskId: task.id,
          error: scoreError.message,
        }, { reversible: true });
      }
    }
    try {
      if (!response) {
        response = await this.inferProposal(actionPrompt);
        noteCacheMiss(response);
        recordContextUsage(response, "generative");
        recordGenerativeTurn(response);
      }
    } catch (firstInferenceError) {
      // Lane fallback (bounded, receipted): a transport-class Maple death may
      // retry the step ONCE on the task's configured fallback lane before the
      // in-lane repair loop burns its attempts on a dead transport. The CLI
      // lane runs the same runCliInference path any non-maple selection uses,
      // so provider availability (executable resolution) and capacity (the
      // lane's provider lease) are enforced there — an unreachable lane fails
      // the attempt and the task blocks naming BOTH failures.
      const originalProvider = String(task.provider || "maple").toLowerCase();
      const laneErrorKind = classifyInferenceError(firstInferenceError).kind;
      const lane = originalProvider === "maple" ? fallbackLaneForTask(task) : null;
      if (lane && LANE_FALLBACK_ERROR_KINDS.has(laneErrorKind)) {
        // Receipted BEFORE the attempt — the lane switch is a reversible
        // host decision, and downstream records (action.provider,
        // observation.provider, the CLI lane's own stream record) keep the
        // provenance honest instead of claiming Maple produced the output.
        this.emit("action.lane.fallback", "degraded", {
          taskId: task.id,
          originalProvider: "maple",
          fallbackProvider: lane,
          errorClass: laneErrorKind,
        }, { reversible: true });
        try {
          response = await this.inferProposal({ ...actionPrompt, fallbackProvider: lane });
          recordContextUsage(response, "fallback-generative");
          // The external lane's output was never committed to Maple's KV
          // session — replaying it as a Maple turn would diverge the
          // committed prefix. Rebase the session instead of recording a
          // generative turn.
          sessionBroken = true;
          persistSession();
        } catch (fallbackError) {
          const error = new Error(`Maple structured-action inference failed (${laneErrorKind}: ${firstInferenceError.message}) and the configured fallback lane ${lane} also failed: ${fallbackError.message}`);
          error.code = "LANE_FALLBACK_EXHAUSTED";
          error.rawModelOutputRef = fallbackError.rawModelOutputRef || firstInferenceError.rawModelOutputRef || null;
          error.modelChannels = fallbackError.modelChannels || firstInferenceError.modelChannels || [];
          throw error;
        }
      }
      // Bounded repair loop: a local model on slow hardware produces transient
      // transport/format failures often enough that a single corrective pass
      // dead-ends otherwise-recoverable tasks. Two repairs stay bounded while
      // giving the retry prompt a real chance.
      let lastInferenceError = firstInferenceError;
      for (let repairAttempt = 1; repairAttempt <= MAX_ACTION_REPAIR_ATTEMPTS && !response; repairAttempt += 1) {
        this.emit("action.inference.failed", "degraded", {
          error: lastInferenceError.message,
          rawModelOutputRef: lastInferenceError.rawModelOutputRef || null,
          modelChannels: lastInferenceError.modelChannels || [],
          parseStatus: "inference-failed",
          repairAttempt,
        }, { reversible: true });
        try {
          response = await this.inferProposal({ ...actionPrompt, sessionUserContent: null, repair: `Maple did not return a usable action. Return exactly one compact JSON choice {"kind","commandId","input","shortRationale"} for an allowedNextCommands entry. Any model-emitted channels remain recorded separately. The prior error was: ${lastInferenceError.message}` });
          noteCacheMiss(response);
          recordContextUsage(response, "generative-repair");
          recordGenerativeTurn(response);
        } catch (repairInferenceError) {
          lastInferenceError = repairInferenceError;
        }
      }
      if (!response) {
        const error = new Error(`Maple failed to return a structured action after ${MAX_ACTION_REPAIR_ATTEMPTS} repairs: ${lastInferenceError.message}`);
        error.code = "INVALID_ACTION_OUTPUT";
        error.rawModelOutputRef = lastInferenceError.rawModelOutputRef || firstInferenceError.rawModelOutputRef || null;
        error.modelChannels = lastInferenceError.modelChannels || firstInferenceError.modelChannels || [];
        throw error;
      }
    }
    // Mid-loop steering rides the prompt as compactTask.steering (pending
    // items only). A secured response means the model saw it — mark those
    // items delivered exactly once so stale steering does not ride every
    // later step's prompt forever.
    const pendingSteering = (this.task()?.steering || []).filter((item) => item && item.status !== "delivered");
    if (pendingSteering.length) {
      const deliveredAt = new Date().toISOString();
      this.updateTask({ steering: (this.task().steering || []).map((item) => item && item.status !== "delivered" ? { ...item, status: "delivered", deliveredAt } : item) });
      this.emit("task.steering.delivered", "observed", { taskId: task.id, count: pendingSteering.length, steeringIds: pendingSteering.map((item) => item.id).filter(Boolean) }, { reversible: true });
    }
    const selectionForAction = (action) => {
      const requestedKind = String(action?.kind || "tool");
      const requestedCommandId = String(action?.commandId || "").trim();
      if (MODEL_TERMINAL_KINDS.has(requestedKind) && (!requestedCommandId || requestedCommandId === "none")) {
        return { kind: requestedKind, commandId: null, step: null, decision: { mode: "model-terminal", reason: requestedKind } };
      }
      const decision = this.selectModelCommand(task, plan, history, requestedCommandId);
      const step = this.adaptPlanForCommand(task, plan, history, decision);
      if (!step?.commandId) {
        const error = new Error("Maple did not select a usable next command inside the approved capability boundary.");
        error.code = "ACTION_COMMAND_NOT_ALLOWED";
        throw error;
      }
      return { kind: "tool", commandId: decision.commandId, step, decision };
    };
    const normalizeHostFields = (action, modelResult = {}) => {
      const recoveredTruncated = action?.__recoveredTruncated === true;
      const coercedPayload = action?.__coercedPayload === true;
      const compactChoice = action?.__compactChoice === true;
      const { __recoveredTruncated: _recoveredTruncated, __coercedPayload: _coercedPayload, __compactChoice: _compactChoice, ...modelFields } = action || {};
      const requestedId = String(action?.id || "").trim();
      // The model-facing example intentionally uses a readable placeholder,
      // but action identity belongs to the host. Reusing that placeholder (or
      // any stale model id) can collide with a durable action from an earlier
      // session and make an otherwise validated action impossible to accept.
      const actionId = !requestedId || requestedId === "action-unique" || this.kernel.getProjection().actions.some((item) => item.id === requestedId)
        ? `action-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
        : requestedId;
      const selection = selectionForAction(action);
      if (selection.kind === "tool" && selection.decision.mode === "recovered") {
        this.emit("action.command.recovered", "degraded", {
          taskId: task.id,
          requestedCommandId: String(action?.commandId || "none"),
          selectedCommandId: selection.commandId,
          reason: selection.decision.reason,
        }, { evidenceRefs: expectedEvidenceForCommand(selection.commandId), reversible: true });
      }
      if (selection.kind !== "tool") {
        return validateAction({
          ...modelFields,
          id: actionId,
          taskId: task.id,
          step: history.actions.length + 1,
          kind: selection.kind,
          commandId: null,
          input: action?.input && typeof action.input === "object" ? action.input : {},
          expectedEvidence: normalizeExpectedEvidence(action?.expectedEvidence),
          approval: "none",
          status: "proposed",
          rawModelOutputRef: modelResult.rawOutputRef || null,
          modelChannels: Array.isArray(modelResult.channels) ? modelResult.channels : [],
          parseStatus: recoveredTruncated ? "recovered-truncated" : coercedPayload ? "coerced-payload" : compactChoice ? "compact-choice" : "valid",
        }, this.commandRegistry);
      }
      const selectedStep = selection.step;
      const requestedCommandId = String(action?.commandId || "").trim() || "none";
      // A compact choice cannot express nested required args — when the
      // envelope arrives with {} and the executed plan step carries an
      // approved input, the step input fills it (re-bounded per command)
      // instead of failing deterministic-input validation.
      const boundedInput = boundedActionInput(selection.commandId, action);
      const stepInput = selectedStep?.input && typeof selectedStep.input === "object" && !Array.isArray(selectedStep.input) && Object.keys(selectedStep.input).length
        ? selectedStep.input
        : null;
      return validateAction({
        ...modelFields,
        id: actionId,
        taskId: task.id,
        step: history.actions.length + 1,
        kind: selectedStep.kind || "tool",
        commandId: selection.commandId,
        input: Object.keys(boundedInput).length || !stepInput ? boundedInput : boundedActionInput(selection.commandId, { input: stepInput }),
        expectedEvidence: expectedEvidenceForCommand(selection.commandId, selectedStep.expectedEvidence),
        approval: selectedStep.approval || "none",
        status: "proposed",
        hostSelection: { requestedCommandId, selectedCommandId: selection.commandId, mode: selection.decision.mode, reason: selection.decision.reason },
        rawModelOutputRef: modelResult.rawOutputRef || null,
        modelChannels: Array.isArray(modelResult.channels) ? modelResult.channels : [],
        parseStatus: recoveredTruncated ? "recovered-truncated" : coercedPayload ? "coerced-payload" : compactChoice ? "compact-choice" : "valid",
      }, this.commandRegistry);
    };
    // A batch envelope is all-or-nothing at selection time: every item's
    // command must be inside the current capability boundary — silently
    // substituting one item would change what the batch means. Items are
    // persisted as individual durable actions at execution time.
    const normalizeBatchEnvelope = (payload, modelResult = {}) => {
      const batch = parseBatchActions(payload, this.commandRegistry);
      if (batch.kind !== "batch") {
        // One-item envelope → the same host-selection path as any tool choice.
        return normalizeHostFields({ kind: "tool", commandId: batch.commandId, input: batch.input, shortRationale: batch.shortRationale, expectedEvidence: batch.expectedEvidence, __compactChoice: true }, modelResult);
      }
      const allowedIds = new Set(allowedCommands.map((entry) => entry.commandId));
      batch.actions.forEach((item, index) => {
        if (!allowedIds.has(item.commandId)) {
          const error = new Error(`Batch action ${index + 1} command is outside the approved capability boundary: ${item.commandId}`);
          error.code = "ACTION_COMMAND_NOT_ALLOWED";
          throw error;
        }
      });
      return validateAction({
        schema: ACTION_SCHEMA,
        id: `action-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        taskId: task.id,
        step: history.actions.length + 1,
        kind: "batch",
        commandId: null,
        input: {},
        actions: batch.actions,
        shortRationale: batch.shortRationale,
        expectedEvidence: batch.expectedEvidence,
        approval: "none",
        status: "proposed",
        rawModelOutputRef: modelResult.rawOutputRef || null,
        modelChannels: Array.isArray(modelResult.channels) ? modelResult.channels : [],
        parseStatus: "batch",
      }, this.commandRegistry);
    };
    const parseModelResult = (value) => {
      const modelResult = asModelResult(value);
      if (!modelResult.content.trim()) {
        const error = new Error("Maple returned an empty structured action response.");
        error.code = "EMPTY_ACTION_OUTPUT";
        error.rawModelOutputRef = modelResult.rawOutputRef || null;
        error.modelChannels = modelResult.channels || [];
        throw error;
      }
      const parseContent = (content) => {
        const extracted = extractActionEnvelope(content);
        if (extracted && Array.isArray(extracted.actions)) {
          return normalizeBatchEnvelope(extracted, modelResult);
        }
        const parsed = normalizeCompactChoice(extracted);
        try {
          return normalizeHostFields(parsed, modelResult);
        } catch (validationError) {
          const selection = selectionForAction(parsed);
          const coerced = coerceActionPayload(parsed, {
            taskId: task.id,
            step: history.actions.length + 1,
            commandId: selection.commandId,
            kind: selection.kind,
            expectedEvidence: selection.step?.expectedEvidence || [],
            approval: selection.step?.approval || "none",
          });
          if (!coerced) throw validationError;
          return normalizeHostFields(coerced, modelResult);
        }
      };
      try {
        return { modelResult, action: parseContent(modelResult.content) };
      } catch (error) {
        // Observed Maple failure mode: the forced-prefix JSON arrives split
        // across channels — `{"command":` in content, the object tail in
        // reasoning. Rejoin once before spending a repair inference; the
        // salvage only runs on an otherwise-failed parse and still goes
        // through the full normalize+validate path, so prose cannot slip in.
        const reasoningTail = String(modelResult.reasoning || "").trim();
        if (reasoningTail && /[}\]]\s*$/.test(reasoningTail)) {
          try {
            const action = { ...parseContent(`${modelResult.content.trimEnd()}${reasoningTail}`), parseStatus: "channel-rejoined" };
            this.emit("action.channel.rejoined", "degraded", {
              taskId: task.id,
              commandId: action?.commandId || null,
              reasoningChars: reasoningTail.length,
            }, { reversible: true });
            return { modelResult, action };
          } catch {
            // The tail was genuine reasoning, not a split envelope — the
            // original error below stands.
          }
        }
        error.rawModelOutputRef ||= modelResult.rawOutputRef || null;
        error.modelChannels ||= modelResult.channels || [];
        throw error;
      }
    };
    // Lane-honest receipts: a result produced by a provider other than the
    // task's own lane means a lane fallback ran — the durable action records
    // which provider did the work and which lane it fell back FROM, so no
    // receipt ever claims Maple produced fallback-lane output.
    const receiptForLane = (parsed) => {
      const provider = parsed?.modelResult?.provider;
      if (!provider || provider === "maple") return parsed.action;
      const taskProvider = String(task.provider || "maple").toLowerCase();
      return { ...parsed.action, provider, ...(provider !== taskProvider ? { fallbackFrom: taskProvider } : {}) };
    };
    try {
      return receiptForLane(parseModelResult(response));
    } catch (firstError) {
      // Bounded re-inference loop: invalid envelopes are re-asked up to
      // MAX_ACTION_REPAIR_ATTEMPTS times; an inference-level failure during a
      // repair stays terminal (transport retries already happened lower down).
      let lastError = firstError;
      for (let repairAttempt = 1; repairAttempt <= MAX_ACTION_REPAIR_ATTEMPTS; repairAttempt += 1) {
        this.emit("action.parse.failed", "blocked", {
          error: lastError.message,
          rawModelOutputRef: lastError.rawModelOutputRef || null,
          modelChannels: lastError.modelChannels || [],
          parseStatus: "invalid",
          repairAttempt,
        }, { reversible: true });
        try {
          response = await this.inferProposal({ ...actionPrompt, sessionUserContent: null, repair: `The prior output was invalid: ${lastError.message}. Return only one compact JSON choice object; preserve any model-emitted channels in the model output record.` });
          noteCacheMiss(response);
          recordContextUsage(response, "generative-repair");
          recordGenerativeTurn(response);
        } catch (repairInferenceError) {
          const error = new Error(`Maple failed during structured-action repair: ${repairInferenceError.message}`);
          error.code = "INVALID_ACTION_OUTPUT";
          error.rawModelOutputRef = repairInferenceError.rawModelOutputRef || firstError.rawModelOutputRef || null;
          error.modelChannels = repairInferenceError.modelChannels || firstError.modelChannels || [];
          throw error;
        }
        try {
          return receiptForLane(parseModelResult(response));
        } catch (retryError) {
          lastError = retryError;
        }
      }
      const error = new Error(`Maple produced ${MAX_ACTION_REPAIR_ATTEMPTS + 1} invalid action envelopes: ${lastError.message}`);
      error.code = "INVALID_ACTION_OUTPUT";
      error.rawModelOutputRef = lastError.rawModelOutputRef || firstError.rawModelOutputRef || null;
      error.modelChannels = lastError.modelChannels || firstError.modelChannels || [];
      throw error;
    }
  }

  actionInputContract(commandId) {
    return actionInputContract(commandId);
  }

  deterministicAction(task, plan, history) {
    const nextIndex = history.actions.length;
    const step = plan.steps[nextIndex];
    if (!step) return createAction({ taskId: task.id, step: nextIndex + 1, kind: "complete", shortRationale: "All planned steps have verified observations.", expectedEvidence: ["receipt://task"] });
    const stepInput = step.input && typeof step.input === "object" && !Array.isArray(step.input) && Object.keys(step.input).length
      ? boundedActionInput(step.commandId, { input: step.input })
      : {};
    return createAction({ taskId: task.id, step: nextIndex + 1, kind: step.kind || "tool", commandId: step.commandId, input: stepInput, shortRationale: step.label, expectedEvidence: step.expectedEvidence, approval: step.approval || "none" });
  }

  pauseTask(taskId = this.task()?.id) {
    const task = this.task();
    if (!task || task.id !== taskId) return { schema: "hemlock.agent.task.result.v1", status: "not_found", task };
    if (TERMINAL_TASK_STATUSES.has(task.status) || task.status === "paused") return { schema: "hemlock.agent.task.result.v1", status: task.status, task };
    this.updateTask({ status: "paused", phase: "paused", foregroundStep: "Paused — resume to continue the plan", pausedAt: new Date().toISOString(), pausedFrom: task.status, pausedAnnounced: true });
    this.emit("task.paused", "paused", { taskId, step: task.foregroundStep }, { reversible: true });
    return { schema: "hemlock.agent.task.result.v1", status: "paused", task: this.task() };
  }

  async proposeNextAction(taskId, plan) {
    const task = this.task();
    if (TERMINAL_TASK_STATUSES.has(task?.status)) return { schema: "hemlock.agent.task.result.v1", status: task.status, task };
    // Park at the next step boundary while paused. An in-flight action is
    // allowed to finish and record its observation; the loop resumes when
    // task.resume flips the status back to running.
    if (task?.status === "paused") {
      if (!task.pausedAnnounced) {
        this.updateTask({ pausedAnnounced: true });
        this.emit("task.paused", "paused", { taskId, parkedAtStep: this.kernel.getTaskHistory(taskId).actions.length }, { reversible: true });
      }
      return { schema: "hemlock.agent.task.result.v1", status: "paused", task: this.task() };
    }
    const budget = mergeBudget(task?.budget);
    const wallClockStartedAt = budget.wallClockStartedAt || Date.now();
    if (Date.now() - Number(wallClockStartedAt) > Number(budget.maxWallClockMs || DEFAULT_BUDGET.maxWallClockMs)) return this.blockTask(taskId, "Agent wall-clock budget exhausted before a terminal receipt was produced.");
    if (!budget.wallClockStartedAt) this.updateTask({ budget: { ...budget, wallClockStartedAt } });
    const history = this.kernel.getTaskHistory(taskId);
    if (history.actions.length >= Number(budget.maxAgentSteps || DEFAULT_BUDGET.maxAgentSteps)) return this.blockTask(taskId, "Agent step budget exhausted before a terminal receipt was produced.");
    let action;
    try {
      // Once the host has consumed the final planned command, completion is a
      // deterministic host transition. Asking Maple for a terminal envelope
      // here only creates a second opportunity for malformed JSON or a fake
      // commandId such as "none" to block a receipt-backed task.
      const nextPlannedCommand = plan.steps[history.actions.length]?.commandId || null;
      const hasPlannedStep = Boolean(nextPlannedCommand);
      const hostOwnsNextStep = HOST_DETERMINISTIC_COMMANDS.has(nextPlannedCommand);
      // Preview open/inspect are fully determined by the approved plan and
      // host-owned artifact receipts. Do not spend a Maple turn asking it to
      // restate those actions; the model may still explain or repair a
      // failure on the next bounded turn. Other safe commands retain the
      // adaptive model-selection path.
      action = hasPlannedStep && !hostOwnsNextStep
        ? (await this.infer(task, plan, history) || this.deterministicAction(task, plan, history))
        : this.deterministicAction(task, plan, history);
      if (TERMINAL_TASK_STATUSES.has(this.task()?.status)) return { schema: "hemlock.agent.task.result.v1", status: this.task().status, task: this.task() };
      action = { ...action, taskId, step: history.actions.length + 1 };
      // T12 anti-repeat guard: Maple re-proposing a command whose receipt is
      // already durable cannot create progress — and in Build mode it starves
      // the artifact steps until budgets expire (the task-2026-08-24 loop:
      // repo-map re-proposed ~24 times after artifact.create completed). While
      // approved plan work remains incomplete, a repeat proposal is replaced
      // by the plan's next unfinished step and a host note explains why.
      if (action.kind === "tool" && action.commandId) {
        const completedIds = completedTaskCommands(history);
        const hasIncompletePlanStep = plan.steps.some((step) => step?.commandId && !completedIds.has(step.commandId));
        if (hasIncompletePlanStep) {
          const redirect = resolveProgressCommand(action, completedIds, completedWorkKeys(history), plan.steps, mutationIntervened(history, action.commandId, this.commandRegistry));
          if (redirect.redirected) {
            this.emit("action.redirected", "degraded", {
              taskId,
              requestedCommandId: redirect.requestedCommandId,
              selectedCommandId: redirect.commandId,
              reason: redirect.reason,
              mode: "anti-repeat-guard",
              parseStatus: "redirected",
            }, { evidenceRefs: expectedEvidenceForCommand(redirect.commandId), reversible: true });
            action = { ...this.deterministicAction(task, plan, history), hostSelection: { requestedCommandId: redirect.requestedCommandId, selectedCommandId: redirect.commandId, mode: "redirected", reason: redirect.reason }, parseStatus: "redirected" };
          }
        }
      }
      validateAction(action, this.commandRegistry);
    } catch (error) {
      // Lane-fallback exhaustion is terminal for the step: the original lane
      // AND the configured fallback both failed, and the reason already names
      // each. Deterministic plan-step recovery must not silently paper over a
      // two-lane outage — block honestly instead.
      if (error?.code === "LANE_FALLBACK_EXHAUSTED") {
        return this.blockTask(taskId, error.message, { rawModelOutputRef: error.rawModelOutputRef || null });
      }
      // Context exhaustion blocks honestly instead of degrading to the
      // deterministic plan step: an action committed against an unbounded
      // prompt would fail identically next step, and silent progress would
      // hide the real constraint from the spine. The suggestion names the
      // supported recovery — fresh thread or conversation reset/trim.
      if (error?.code === "CONTEXT_BUDGET_EXHAUSTED") {
        return this.blockTask(taskId, `${error.message} Suggestion: start a fresh thread or run conversation.reset / conversation.trim, then resume the plan.`, {
          contextExhausted: true,
          contextUsage: error.contextUsage || null,
          suggestion: "fresh-thread-or-context-reset",
        });
      }
      const nextStep = plan.steps[history.actions.length];
      // The approved plan is the capability boundary, so a malformed or
      // unavailable model turn never dead-ends a receipt-backed task: the host
      // falls back to the next approved plan step (or the terminal completion
      // step once the plan is exhausted). The degraded event keeps the model
      // failure durable instead of silently swallowing it.
      const mode = nextStep ? "approved-plan-step" : "evidence-backed-terminal-step";
      this.emit("action.inference.fallback", "degraded", {
        taskId,
        commandId: nextStep?.commandId || "complete",
        reason: error.message,
        mode,
        rawModelOutputRef: error.rawModelOutputRef || null,
        modelChannels: error.modelChannels || [],
        parseStatus: "fallback",
        fallbackMode: "deterministic-action",
      }, { reversible: true });
      action = {
        ...this.deterministicAction(task, plan, history),
        rawModelOutputRef: error.rawModelOutputRef || null,
        modelChannels: error.modelChannels || [],
        parseStatus: "fallback",
        fallbackMode: "deterministic-action",
      };
    }
    // Decide/score winners are advisory — policy is "execute the plan, log
    // the divergence". Whenever the executed action is not the scored winner
    // (terminal kind ignored for a planned step, redirect, or fallback),
    // receipt the mismatch instead of letting it pass silently.
    const decided = this._scoredDecision;
    this._scoredDecision = null;
    if (decided && decided.taskId === taskId) {
      const executedKind = action.kind === "batch" ? "tool" : action.kind;
      const executedCommandId = action.kind === "batch" ? action.actions?.[0]?.commandId ?? null : action.commandId ?? null;
      const decidedKind = decided.winner?.kind ?? null;
      const decidedCommandId = decidedKind === "tool" ? decided.winner?.commandId ?? null : null;
      if (decidedKind !== executedKind || decidedCommandId !== executedCommandId) {
        this.emit("action.scored.divergence", "observed", {
          taskId,
          mode: decided.mode,
          decidedKind,
          decidedCommandId,
          executedKind,
          executedCommandId,
          probability: decided.probability ?? null,
          confidence: decided.confidence ?? null,
          margin: decided.margin ?? null,
        }, { evidenceRefs: action.expectedEvidence || [], reversible: true });
      }
    }
    if (action.kind === "batch") {
      // The container stays ephemeral: plan/history indexing assumes one
      // durable action per step, so each batch item is created as its own
      // action inside executeBatchActions.
      return this.executeBatchActions(task, action, plan, budget);
    }
    this.kernel.createAction(action);
    this.updateTask({ phase: action.kind === "ask_user" ? "waiting_for_user" : "work", status: action.kind === "ask_user" ? "waiting_for_approval" : "running", foregroundStep: action.shortRationale, activeActionId: action.id, budget: { ...budget, agentStepsUsed: history.actions.length + 1 } });
    this.emit("action.proposed", "proposed", { action }, { evidenceRefs: action.expectedEvidence, reversible: true });
    this.kernel.transitionAction(action.id, "validate");
    this.emit("action.validated", "passed", { action }, { evidenceRefs: action.expectedEvidence, reversible: true });
    if (action.kind === "ask_user") return { schema: "hemlock.agent.action.result.v1", status: "waiting_for_user", action, task: this.task() };
    const planApproved = action.approval === "plan" && this.kernel.getProjection().plans.some((item) => item.id === task.activePlanId && item.status === "approved");
    const autonomyAllows = action.approval === "explicit" && action.commandId && autonomyPermitsCommand(task, action.commandId, this.commandRegistry);
    if (autonomyAllows) {
      // Auditable autonomy: the explicit gate was bypassed by the task's
      // autonomy level, recorded on the action and as an event.
      action = { ...action, hostSelection: { ...(action.hostSelection || {}), autonomyBypass: autonomyLevel(task) } };
      this.emit("action.autonomy.bypass", "observed", { taskId, actionId: action.id, commandId: action.commandId, autonomy: autonomyLevel(task) }, { evidenceRefs: action.expectedEvidence, reversible: true });
    }
    if (action.approval !== "none" && !planApproved && !autonomyAllows) return { schema: "hemlock.agent.action.result.v1", status: "waiting_for_approval", action, task: this.task() };
    return this.executeAction(action.id);
  }

  async acceptAction(taskId, actionId) {
    const action = this.kernel.getProjection().actions.find((item) => item.id === actionId && item.taskId === taskId);
    if (!action) throw new Error(`Hemlock action was not found: ${actionId}`);
    if (!["validated", "proposed"].includes(action.status)) throw new Error(`Action cannot be accepted from ${action.status}.`);
    if (action.status === "proposed") this.kernel.transitionAction(action.id, "validate");
    return this.executeAction(action.id);
  }

  rejectAction(taskId, actionId, reason = "Rejected by user") {
    const action = this.kernel.getProjection().actions.find((item) => item.id === actionId && item.taskId === taskId);
    if (!action) throw new Error(`Hemlock action was not found: ${actionId}`);
    this.kernel.transitionAction(action.id, "reject", { rejectionReason: reason });
    this.updateTask({ phase: "blocked", status: "blocked", foregroundStep: "Action rejected; revise the plan", blockedReason: reason });
    this.emit("action.rejected", "blocked", { actionId, taskId, reason }, { reversible: true });
    return { schema: "hemlock.agent.action.result.v1", status: "blocked", action: this.kernel.getProjection().actions.find((item) => item.id === actionId), task: this.task() };
  }

  askUser(taskId, question, context = {}) {
    const task = this.task();
    if (!task || task.id !== taskId) throw new Error("Hemlock cannot ask a question for an unknown task.");
    if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error(`The task is already terminal: ${task.status}.`);
    const prompt = String(question || "Hemlock needs a decision before it can continue.").trim();
    this.updateTask({ phase: "waiting_for_user", status: "waiting_for_approval", foregroundStep: prompt, blockedReason: null });
    this.emit("task.question", "waiting_for_user", { taskId, question: prompt, context }, { reversible: true });
    return { schema: "hemlock.agent.task.question.v1", status: "waiting_for_user", task: this.task(), question: prompt, context };
  }

  async inferArtifactRepair(task, plan, history, verification, artifact, attempt) {
    if (!this.inferAction) return null;
    const issueSummary = (verification?.issues || []).slice(0, 16).map((item) => `${item.code}: ${item.message}`).join("\n") || String(verification?.summary || "Preview verification failed.");
    const response = await this.inferProposal({
      system: [
        "You are Maple-Preview repairing a task-scoped scratch artifact inside Hemlock.",
        "Return exactly one JSON action envelope and no prose.",
        "The host owns action identity, task identity, step, commandId, approval, lifecycle, and evidence.",
        "Use commandId artifact.update. Provide either input.source as a complete relative-file source map or input.patches as bounded complete file replacements.",
        "Do not modify repository files. Do not return a diff fragment, shell command, or partial file.",
        "Echo input.repair.issues back in input.repairFor.issues verbatim — never return an empty issues list unless input.repair.issues is empty.",
        '{"schema":"hemlock.agent.action.v1","id":"action-unique","taskId":"current-task-id","step":1,"kind":"tool","commandId":"artifact.update","input":{"source":{"index.html":"complete file contents"},"repairFor":{"revision":1,"issues":[{"code":"<issue-code>","message":"<issue message from input.repair.issues>"}]}},"shortRationale":"Repair the reported preview issue.","expectedEvidence":["artifact://revision"],"approval":"none","status":"proposed"}',
      ].join("\n"),
      task,
      plan,
      nextPlannedStep: { kind: "tool", commandId: "artifact.update", expectedEvidence: ["artifact://revision"], approval: "none" },
      history: { actions: history.actions.slice(-10), observations: history.observations.slice(-10), operations: history.operations.slice(-10) },
      repair: {
        schema: "hemlock.agent.artifact.repair.v1",
        attempt,
        baseRevision: Number(artifact?.revision || verification?.revision || 0),
        artifactId: artifact?.id || null,
        issues: (verification?.issues || []).slice(0, 16),
        inspectionDigest: verification?.inspectionDigest || null,
        instruction: issueSummary,
      },
    });
    const modelResult = typeof response === "string" ? { content: response, channels: [], rawOutputRef: null } : response || {};
    const parsed = extractActionEnvelope(modelResult.content || "");
    const action = coerceActionPayload(parsed, {
      taskId: task.id,
      step: this.kernel.getTaskHistory(task.id).actions.length + 1,
      commandId: "artifact.update",
      expectedEvidence: ["artifact://revision"],
      approval: "none",
    }) || parsed;
    const requestedId = String(action.id || "").trim();
    const actionId = !requestedId || requestedId === "action-unique" || this.kernel.getProjection().actions.some((item) => item.id === requestedId)
      ? `repair-action-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
      : requestedId;
    return validateAction({
      ...action,
      id: actionId,
      taskId: task.id,
      step: this.kernel.getTaskHistory(task.id).actions.length + 1,
      kind: "tool",
      commandId: "artifact.update",
      expectedEvidence: ["artifact://revision"],
      approval: "none",
      status: "proposed",
      rawModelOutputRef: modelResult.rawOutputRef || null,
      modelChannels: Array.isArray(modelResult.channels) ? modelResult.channels : [],
      parseStatus: action.__coercedPayload ? "coerced-payload" : action.__recoveredTruncated ? "recovered-truncated" : "valid",
    }, this.commandRegistry);
  }

  async inferCodingRepair(task, plan, history, verification, attempt) {
    if (!this.inferAction) return null;
    const response = await this.inferProposal({
      system: [
        "You are Maple-Preview repairing ordinary source code inside a user-assigned Hemlock workspace.",
        "Return exactly one JSON action envelope and no prose.",
        "The host owns action identity, task identity, step, commandId, approval, lifecycle, file scope, and verification.",
        "Use commandId code.apply. Provide input.source as complete relative-file contents or input.patches as bounded complete-file replacements.",
        "Do not delete files, use shell commands, modify secrets, or write outside the assigned workspace.",
        '{"schema":"hemlock.agent.action.v1","id":"action-unique","taskId":"current-task-id","step":1,"kind":"tool","commandId":"code.apply","input":{"patches":[{"path":"src/example.js","content":"complete file contents"}]},"shortRationale":"Repair the reported verification issue.","expectedEvidence":["changeset://applied"],"approval":"plan","status":"proposed"}',
      ].join("\n"),
      task,
      plan,
      nextPlannedStep: { kind: "tool", commandId: "code.apply", expectedEvidence: ["changeset://applied"], approval: "plan" },
      history: { actions: history.actions.slice(-12), observations: history.observations.slice(-12), operations: history.operations.slice(-12) },
      repair: {
        schema: "hemlock.agent.repair.v1",
        attempt,
        maxAttempts: Number(task.budget?.maxCodeRepairs ?? DEFAULT_BUDGET.maxCodeRepairs),
        threadId: task.threadId || null,
        taskId: task.id,
        issues: (verification?.issues || []).slice(0, 24),
        instruction: (verification?.issues || []).map((item) => `${item.code || "verification"}: ${item.message || item}`).join("\n") || String(verification?.summary || "Verification failed."),
      },
    });
    const modelResult = typeof response === "string" ? { content: response, channels: [], rawOutputRef: null } : response || {};
    const parsed = extractActionEnvelope(modelResult.content || "");
    const action = coerceActionPayload(parsed, {
      taskId: task.id,
      step: this.kernel.getTaskHistory(task.id).actions.length + 1,
      commandId: "code.apply",
      expectedEvidence: ["changeset://applied"],
      approval: "plan",
    }) || parsed;
    const requestedId = String(action.id || "").trim();
    const actionId = !requestedId || requestedId === "action-unique" || this.kernel.getProjection().actions.some((item) => item.id === requestedId)
      ? `repair-action-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
      : requestedId;
    return validateAction({
      ...action,
      id: actionId,
      taskId: task.id,
      step: this.kernel.getTaskHistory(task.id).actions.length + 1,
      kind: "tool",
      commandId: "code.apply",
      expectedEvidence: ["changeset://applied"],
      approval: "plan",
      status: "proposed",
      rawModelOutputRef: modelResult.rawOutputRef || null,
      modelChannels: Array.isArray(modelResult.channels) ? modelResult.channels : [],
      parseStatus: action.__coercedPayload ? "coerced-payload" : action.__recoveredTruncated ? "recovered-truncated" : "valid",
    }, this.commandRegistry);
  }

  // One-shot corrective re-inference for deterministic-input failures: the
  // compact choice can't express nested required args, so the repair prompt
  // echoes the command's inputHint plus the parsed required field names and
  // asks only for the corrected input object. The command itself is fixed —
  // a repair may never switch commandId.
  async inferActionInputRepair(task, plan, action, failure) {
    if (!this.inferAction) return null;
    const descriptor = this.commandRegistry[action.commandId] || {};
    const requiredFields = requiredInputFields(descriptor.inputHint);
    const history = this.kernel.getTaskHistory(task.id);
    const response = await this.inferProposal({
      system: [
        "You are Maple-Preview repairing a tool-call input inside Hemlock.",
        "Return exactly one compact JSON choice in the content channel — no prose, no markdown:",
        `{"kind":"tool","commandId":${JSON.stringify(action.commandId)},"input":{...},"shortRationale":"one-line reason"}`,
        "The host owns id, taskId, step, approval, expectedEvidence, and status. Never emit them.",
        `The prior ${action.commandId} call failed deterministic input validation; supply a corrected input object only.`,
      ].join("\n"),
      task,
      plan,
      nextPlannedStep: { kind: "tool", commandId: action.commandId, label: descriptor.label || action.commandId },
      history: { actions: history.actions.slice(-10), observations: history.observations.slice(-10), operations: history.operations.slice(-10) },
      repair: {
        schema: "hemlock.agent.input.repair.v1",
        attempt: Number(action.inputRepairsUsed || 0) + 1,
        maxAttempts: MAX_INPUT_REPAIR_ATTEMPTS,
        commandId: action.commandId,
        error: String(failure?.message || failure || "deterministic input validation failed").slice(0, 800),
        inputHint: descriptor.inputHint || null,
        requiredFields,
        priorInput: action.input && typeof action.input === "object" && !Array.isArray(action.input) ? action.input : {},
        instruction: `Provide a corrected input object for ${action.commandId}.${requiredFields.length ? ` Required fields: ${requiredFields.join(", ")}.` : ""}`,
      },
    });
    const modelResult = typeof response === "string" ? { content: response } : response || {};
    const choice = normalizeCompactChoice(extractActionEnvelope(modelResult.content || ""));
    if (!choice || String(choice.commandId || action.commandId) !== action.commandId) return null;
    const ENVELOPE_KEYS = new Set(["schema", "id", "taskId", "step", "kind", "commandId", "command", "input", "shortRationale", "expectedEvidence", "approval", "status", "reason", "title"]);
    const rawInput = choice.input && typeof choice.input === "object" && !Array.isArray(choice.input) && Object.keys(choice.input).length
      ? choice.input
      : Object.fromEntries(Object.entries(choice).filter(([key]) => !ENVELOPE_KEYS.has(key) && !key.startsWith("__")));
    const input = boundedActionInput(action.commandId, { input: rawInput });
    if (!Object.keys(input).length) return null;
    return { input, requiredFields, shortRationale: String(choice.shortRationale || "").trim() || `Retry ${action.commandId} with repaired input.` };
  }

  artifactFromHistory(history) {
    return history.observations.map((item) => item.structuredOutput).reverse().find((output) => output?.schema === "hemlock.agent.artifact.v1" && output.id) || null;
  }

  async repairArtifact(task, plan, action, failedResult) {
    const history = this.kernel.getTaskHistory(task.id);
    const artifact = this.artifactFromHistory(history);
    const budget = mergeBudget(task.budget);
    const previous = task.artifactRepair || {};
    const maxAttempts = Math.max(0, Number(previous.maxAttempts ?? budget.maxArtifactRepairs ?? DEFAULT_BUDGET.maxArtifactRepairs));
    let attempt = Number(previous.attempt || 0);
    let lastFailure = failedResult;
    let lastGoodRevision = Number(previous.lastGoodRevision || 0) || null;
    const baseRevision = Number(failedResult?.session?.revision || artifact?.revision || 0) || null;
    const artifactId = failedResult?.session?.artifactId || artifact?.id || null;
    if (!artifactId || maxAttempts <= 0) return failedResult;
    this.emit("artifact.verification.failed", "blocked", { taskId: task.id, artifactId, revision: baseRevision, verification: failedResult.verification || null, issues: failedResult.verification?.issues || [{ code: "preview_verification_failed", message: failedResult.summary || "Preview verification failed." }] }, { evidenceRefs: failedResult.evidenceRefs || [], reversible: true });
    while (attempt < maxAttempts) {
      attempt += 1;
      const state = { attempt, maxAttempts, baseRevision, candidateRevision: null, lastGoodRevision, issues: failedResult.verification?.issues || [], status: "repairing" };
      this.updateTask({ phase: "repairing", status: "running", foregroundStep: `Maple is repairing preview issue ${attempt}/${maxAttempts}`, artifactRepair: state, blockedReason: null, budget: { ...budget, artifactRepairsUsed: attempt } });
      this.emit("artifact.repair.started", "running", { taskId: task.id, artifactId, repair: state }, { evidenceRefs: failedResult.evidenceRefs || [], reversible: true });
      let repairAction = null;
      try {
        repairAction = await this.inferArtifactRepair(task, plan, history, failedResult.verification || failedResult, artifact, attempt);
        const input = repairAction?.input || {};
        const source = input.source && typeof input.source === "object" && !Array.isArray(input.source) ? input.source : null;
        const patches = Array.isArray(input.patches) ? input.patches : null;
        if (!source && !patches?.length) throw new Error("Maple repair did not provide a complete source map or bounded file replacements.");
        const update = await this.executeCommand("artifact.update", {
          taskId: task.id,
          artifactId,
          source,
          patches: source ? undefined : patches,
          status: "previewable",
          repairFor: { revision: baseRevision, issues: failedResult.verification?.issues || [], inspectionDigest: failedResult.verification?.inspectionDigest || null },
          evidence: [{ type: "artifact.repair", attempt, actionId: repairAction.id }],
          __fromAgentAction: true,
          __approvedPlan: true,
          __internalRepair: true,
        });
        const candidateRevision = Number(update?.revision || 0) || null;
        const nextState = { ...state, candidateRevision };
        this.updateTask({ artifactRepair: nextState, foregroundStep: `Verifying repaired artifact revision ${candidateRevision || "?"}` });
        const opened = await this.executeCommand("artifact.preview.open", { taskId: task.id, artifactId, revision: candidateRevision, __fromAgentAction: true, __approvedPlan: true, __internalRepair: true });
        const inspected = opened?.session?.id
          ? await this.executeCommand("artifact.preview.inspect", { taskId: task.id, artifactId, sessionId: opened.session.id, __fromAgentAction: true, __approvedPlan: true, __internalRepair: true })
          : opened;
        if (inspected?.status === "passed" && inspected?.verification?.status === "passed") {
          const passedState = { ...nextState, lastGoodRevision: candidateRevision, issues: [], status: "passed" };
          this.updateTask({ artifactRepair: passedState, phase: "work", status: "running", foregroundStep: "Repaired artifact verified" });
          const receipt = { schema: "hemlock.agent.artifact.repair.v1", status: "passed", taskId: task.id, artifactId, attempt, baseRevision, candidateRevision, lastGoodRevision: candidateRevision, issues: [], verification: inspected.verification, evidenceRefs: inspected.evidenceRefs || [] };
          this.emit("artifact.repair.completed", "passed", { repair: receipt }, { evidenceRefs: receipt.evidenceRefs, reversible: true });
          return { ...inspected, artifactRepair: passedState, repairReceipt: receipt };
        }
        lastFailure = inspected || failedResult;
      } catch (error) {
        this.emit("artifact.repair.failed", "degraded", { taskId: task.id, artifactId, attempt, error: error.message, action: repairAction ? { id: repairAction.id, commandId: repairAction.commandId } : null }, { reversible: true });
        lastFailure = { ...lastFailure, status: "blocked", summary: error.message, verification: { ...(lastFailure.verification || {}), issues: [...(lastFailure.verification?.issues || []), { code: "repair_invalid", message: error.message }] } };
      }
      const rollbackRevision = lastGoodRevision || baseRevision;
      if (rollbackRevision && lastFailure?.status !== "passed") {
        try { await this.executeCommand("artifact.restore", { taskId: task.id, artifactId, revision: rollbackRevision, __fromAgentAction: true, __approvedPlan: true, __internalRepair: true }); } catch (restoreError) { this.emit("artifact.restore.failed", "degraded", { taskId: task.id, artifactId, revision: rollbackRevision, error: restoreError.message }, { reversible: true }); }
      }
      history.actions = this.kernel.getTaskHistory(task.id).actions;
      history.observations = this.kernel.getTaskHistory(task.id).observations;
      history.operations = this.kernel.getTaskHistory(task.id).operations;
    }
    const exhausted = { ...lastFailure, status: "blocked", artifactRepair: { attempt, maxAttempts, baseRevision, candidateRevision: null, lastGoodRevision, issues: lastFailure?.verification?.issues || [], status: "exhausted" }, repairReceipt: { schema: "hemlock.agent.artifact.repair.v1", status: "exhausted", taskId: task.id, artifactId, attempt, maxAttempts, baseRevision, candidateRevision: null, lastGoodRevision, issues: lastFailure?.verification?.issues || [], evidenceRefs: lastFailure?.evidenceRefs || [] } };
    this.updateTask({ artifactRepair: exhausted.artifactRepair });
    this.emit("artifact.repair.exhausted", "blocked", { repair: exhausted.repairReceipt }, { evidenceRefs: exhausted.repairReceipt.evidenceRefs, reversible: true });
    return exhausted;
  }

  async retryArtifactRepair(taskId = this.task()?.id) {
    const task = this.task();
    if (!task || task.id !== taskId) throw new Error("Hemlock cannot retry an unknown task.");
    const history = this.kernel.getTaskHistory(taskId);
    const last = history.observations.at(-1)?.structuredOutput;
    const plan = this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId) || { steps: [] };
    const failed = last?.schema === "hemlock.agent.preview.inspect.v1" ? last : { status: "blocked", summary: task.blockedReason || "Preview repair needs another attempt.", verification: { issues: task.artifactRepair?.issues || [] } };
    const result = await this.repairArtifact(task, plan, { commandId: "artifact.preview.inspect", id: task.activeActionId || "repair-retry" }, failed);
    if (result.status === "passed") {
      const observation = compactObservation(result, { elapsedMs: 0 });
      this.kernel.recordObservation(observation);
      this.emit("observation.recorded", "passed", { actionId: task.activeActionId || null, observation }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      return this.completeTask(taskId, "A manually retried artifact repair produced a verified preview receipt.");
    }
    return this.blockTask(taskId, "Artifact repair attempts remain exhausted; the last good revision is available for review.", { artifactRepair: this.task().artifactRepair });
  }

  async useLastGoodArtifact(taskId = this.task()?.id) {
    const task = this.task();
    const state = task?.artifactRepair;
    const history = this.kernel.getTaskHistory(taskId);
    const artifact = this.artifactFromHistory(history);
    if (!task || task.id !== taskId || !state?.lastGoodRevision || !artifact?.id) throw new Error("No verified last-good artifact revision is available.");
    const restored = await this.executeCommand("artifact.restore", { taskId, artifactId: artifact.id, revision: state.lastGoodRevision, __fromAgentAction: true, __approvedPlan: true, __internalRepair: true });
    this.updateTask({ phase: "work", status: "running", foregroundStep: `Restored verified artifact revision ${state.lastGoodRevision}`, artifactRepair: { ...state, candidateRevision: null, status: "passed" }, blockedReason: null });
    return { schema: "hemlock.agent.artifact.repair.v1", status: "passed", action: "use-last-good", artifact: restored, artifactRepair: this.task(), evidenceRefs: restored.evidenceRefs || [] };
  }

  async executeAction(actionId, internal = {}) {
    const task = this.task();
    const action = this.kernel.getProjection().actions.find((item) => item.id === actionId);
    if (!action || action.taskId !== task?.id) throw new Error(`Hemlock action was not found: ${actionId}`);
    if (action.status === "cancelled") return { schema: "hemlock.agent.action.result.v1", status: "cancelled", action, task };
    if (action.kind === "answer") {
      const answer = String(action.input?.answer || action.input?.content || action.shortRationale || "").trim();
      const observation = createObservation({
        status: "passed",
        summary: answer || "Maple returned a scoped answer.",
        structuredOutput: { answer },
        evidenceRefs: action.expectedEvidence || [],
      });
      this.kernel.recordObservation(observation);
      this.kernel.transitionAction(action.id, "complete", { observationId: observation.id });
      const episode = this.kernel.appendEpisodeEvent(task.id, { action: this.kernel.getProjection().actions.find((item) => item.id === action.id), observation, outcome: "completed" });
      this.emit("episode.updated", "recorded", { episode }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      this.emit("observation.recorded", "passed", { actionId: action.id, observation }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      this.emit("action.completed", "passed", { actionId: action.id, observationId: observation.id }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      const result = this.completeTask(task.id, "Maple returned a structured answer observation.");
      return { ...result, answer, observation };
    }
    if (action.kind === "complete") {
      const history = this.kernel.getTaskHistory(task.id);
      const evidence = history.observations.flatMap((item) => item.evidenceRefs || []);
      const requiresArtifactVerification = task.interactionMode === "build" || /\b(artifact|animation|animated|html|svg|canvas)\b/i.test(String(task.objective || ""));
      const verifiedArtifact = history.observations.some((item) => item.structuredOutput?.schema === "hemlock.agent.preview.inspect.v1" && item.structuredOutput?.status === "passed" && item.structuredOutput?.verification?.status === "passed" && (item.evidenceRefs || []).length);
      if (!history.observations.length || (["coding", "verify"].includes(task.intent) && !evidence.length) || (requiresArtifactVerification && !verifiedArtifact)) {
        return this.blockTask(task.id, requiresArtifactVerification && !verifiedArtifact ? "Hemlock cannot complete this artifact task without a matching verified preview receipt." : "Hemlock cannot claim completion before a structured observation or receipt is recorded.", { actionId: action.id });
      }
      return this.completeTask(task.id, "The plan reached a terminal step with receipt-backed evidence.");
    }
    if (action.kind === "blocked") return this.blockTask(task.id, action.shortRationale);
    if (action.kind === "ask_user") {
      this.updateTask({ phase: "waiting_for_user", status: "waiting_for_approval", foregroundStep: action.shortRationale });
      return { schema: "hemlock.agent.action.result.v1", status: "waiting_for_user", action, task: this.task() };
    }
    const planApproved = action.approval === "plan" && this.kernel.getProjection().plans.some((item) => item.id === task.activePlanId && item.status === "approved");
    const autonomyAllows = action.approval === "explicit" && action.commandId && autonomyPermitsCommand(task, action.commandId, this.commandRegistry);
    if (action.approval !== "none" && !planApproved && !autonomyAllows) return { schema: "hemlock.agent.action.result.v1", status: "waiting_for_approval", action, task: this.task() };
    const descriptor = this.commandRegistry[action.commandId] || {};
    // Mutation budget: recovery (rollback) and journaling (experiment.note)
    // are write-capable but must never consume a mutation set — a model that
    // can't roll back its own apply or record a finding would be trapped.
    // Usage is counted on success below, not here: a failed apply leaves the
    // set free for repair.
    const consumesMutationSet = descriptor.capability === "write" && !MUTATION_EXEMPT_COMMANDS.has(action.commandId);
    if (consumesMutationSet) {
      const budget = mergeBudget(this.task().budget);
      if (Number(budget.mutationSetsUsed || 0) >= Number(budget.maxMutationSets || 1)) return this.blockTask(task.id, "The mutation-set budget is already consumed.", { actionId: action.id });
    }
    this.kernel.transitionAction(action.id, "start");
    this.emit("command.started", "running", { actionId: action.id, command: action.commandId }, { reversible: true });
    const startedAt = Date.now();
    let error = null;
    try {
      const commandInput = { ...(action.input || {}) };
      // T8-F4: the model parrots plan-step refs ("artifact://manifest", "scratch
      // artifact") as artifactId, which fails safeSegment and blocks authoring.
      // A valid id matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ — anything else is
      // treated as absent so the host fills in the task's real artifact below.
      const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
      // T9-H3: non-string artifactIds (numbers from a confused model envelope)
      // are invalid too — String(42)==="42" would otherwise pass the regex.
      if (typeof commandInput.artifactId !== "string" || !ARTIFACT_ID_RE.test(commandInput.artifactId)) delete commandInput.artifactId;
      if (action.commandId === "artifact.create") {
        const allowedArtifactKinds = new Set(["html", "svg", "text", "markdown", "json"]);
        commandInput.kind = allowedArtifactKinds.has(String(commandInput.kind || "").toLowerCase()) ? String(commandInput.kind).toLowerCase() : "html";
        commandInput.artifactId ||= `artifact-${Date.now()}`;
        commandInput.title ||= String(task.objective || "Hemlock animation").split(/[:.!?]/, 1)[0].slice(0, 120) || "Hemlock animation";
        commandInput.mime ||= "text/html";
        commandInput.entrypoint = typeof commandInput.entrypoint === "string" && commandInput.entrypoint !== "create" && commandInput.entrypoint && !commandInput.entrypoint.startsWith("/") && !commandInput.entrypoint.split(/[\\/]/).some((part) => part === "." || part === ".." || !part) ? commandInput.entrypoint : "index.html";
      }
      if (action.commandId === "artifact.author") {
        // T12: an adaptive artifact.author can arrive before any
        // artifact.create ran (real receipts: input {} and input.artifactId
        // "sha256:bbd26…" both ended action.faild). Resolve a usable target id
        // here; if none exists yet, mark it so the dispatch below creates one.
        const ARTIFACT_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
        if (typeof commandInput.artifactId !== "string" || !ARTIFACT_TARGET_RE.test(commandInput.artifactId)) delete commandInput.artifactId;
        if (!commandInput.artifactId) {
          const priorArtifact = this.kernel.getTaskHistory(task.id).observations.slice().reverse().map((item) => item.structuredOutput).find((output) => output?.schema === "hemlock.agent.artifact.v1" && output.id);
          commandInput.__ensureArtifact = !(priorArtifact?.id && typeof priorArtifact.id === "string" && ARTIFACT_TARGET_RE.test(priorArtifact.id));
          if (!commandInput.__ensureArtifact) commandInput.artifactId = priorArtifact.id;
        }
      }
      const priorOutputs = this.kernel.getTaskHistory(task.id).observations.slice().reverse().map((item) => item.structuredOutput);
      const latestArtifact = priorOutputs.find((output) => output?.schema === "hemlock.agent.artifact.v1" && output.id);
      if (action.commandId === "artifact.author") {
        const allowedKinds = new Set(["html", "javascript", "css", "svg", "image", "text", "ascii", "markdown", "json", "audio", "video", "binary"]);
        const allowedRuntimes = new Set(["html", "canvas", "text", "svg", "markdown", "json", "media", "binary"]);
        commandInput.kind = allowedKinds.has(String(commandInput.kind || "").toLowerCase()) ? String(commandInput.kind).toLowerCase() : "html";
        commandInput.filename = typeof commandInput.filename === "string" && commandInput.filename && !commandInput.filename.startsWith("/") && !commandInput.filename.split(/[\\/]/).some((part) => part === ".." || part === "." || !part) ? commandInput.filename : "index.html";
        commandInput.runtimeTemplate = allowedRuntimes.has(String(commandInput.runtimeTemplate || "").toLowerCase()) ? String(commandInput.runtimeTemplate).toLowerCase() : "html";
        const compatibleRuntimes = { html: ["html", "canvas"], svg: ["svg", "html"], javascript: ["html", "canvas"], css: ["html"], text: ["text", "markdown"], ascii: ["text"], markdown: ["markdown", "text"], json: ["json"], image: ["media"], audio: ["media"], video: ["media"], binary: ["binary"] };
        if (!compatibleRuntimes[commandInput.kind]?.includes(commandInput.runtimeTemplate)) { commandInput.kind = "html"; commandInput.filename = "index.html"; commandInput.runtimeTemplate = "html"; }
        commandInput.objective ||= task.objective;
        const sourceMapIsUsable = commandInput.source && typeof commandInput.source === "object" && !Array.isArray(commandInput.source)
          && Object.keys(commandInput.source).length > 0
          && Object.prototype.hasOwnProperty.call(commandInput.source, commandInput.filename)
          && Object.entries(commandInput.source).every(([file, contents]) => typeof file === "string" && file && typeof contents === "string" && contents.length <= 2 * 1024 * 1024);
        if (!sourceMapIsUsable) {
          // One bounded repair pass before the canned scaffold: the model
          // failed to emit a usable source map, but a targeted re-ask (the
          // same contract as a verification repair) often produces real
          // content. The canned template stays the last resort, not the first.
          let repairedSource = null;
          if (this.inferAction) {
            try {
              const repairAction = await this.inferArtifactRepair(task, plan, this.kernel.getTaskHistory(task.id), {
                revision: Number(latestArtifact?.revision || 0),
                issues: [{ code: "authoring_source_missing", message: "artifact.author returned no usable input.source map; author the complete file contents for the objective now." }],
                summary: "The authored source map was missing or malformed — produce complete file contents.",
              }, latestArtifact, 1);
              const candidate = repairAction?.input?.source;
              if (candidate && typeof candidate === "object" && !Array.isArray(candidate)
                && Object.prototype.hasOwnProperty.call(candidate, commandInput.filename)
                && Object.entries(candidate).every(([file, contents]) => typeof file === "string" && file && typeof contents === "string" && contents.length <= 2 * 1024 * 1024)) {
                repairedSource = candidate;
                this.emit("artifact.author.repaired", "degraded", { taskId: task.id, reason: "authoring source recovered by one bounded repair inference" }, { reversible: true });
              }
            } catch { /* fall through to the canned scaffold */ }
          }
          commandInput.source = repairedSource || { "index.html": fallbackAnimationSource(task.objective) };
          commandInput.status = "previewable";
          commandInput.evidence = repairedSource
            ? [{ type: "authoring.repaired_source", reason: "Maple's authoring envelope lacked usable source; a bounded repair inference produced the content." }]
            : [{ type: "authoring.host_fallback", reason: commandInput.source ? "Maple returned malformed or incomplete source; host scaffold retained." : "Maple did not return a usable structured authoring envelope." }];
        }
      }
      if (action.commandId === "artifact.preview.open" && !commandInput.artifactId && latestArtifact?.id) commandInput.artifactId = latestArtifact.id;
      if (action.commandId === "artifact.preview.inspect" && !commandInput.sessionId) {
        const latestPreview = priorOutputs.find((output) => output?.schema === "hemlock.agent.preview.open.v1" && output.session?.id);
        if (latestPreview?.session?.id) commandInput.sessionId = latestPreview.session.id;
      }
      if (action.commandId === "artifact.author" && commandInput.__ensureArtifact === true) {
        // T12 author-fallback bulletproofing: the author action targeted an
        // artifact that does not exist in this task (no artifact.create yet).
        // Create-if-missing with host defaults, then continue into the normal
        // author path — never fail the action for a missing scratch artifact.
        delete commandInput.__ensureArtifact;
        try {
          const created = await this.executeCommand("artifact.create", {
            taskId: task.id,
            title: String(task.objective || "Hemlock animation").split(/[:.!?]/, 1)[0].slice(0, 120) || "Hemlock animation",
            kind: "html",
            mime: "text/html",
            entrypoint: "index.html",
            __fromAgentAction: true,
            __approvedPlan: true,
            __agentActionId: action.id,
          });
          if (created?.artifactId) commandInput.artifactId = created.artifactId;
          else if (!commandInput.artifactId) throw new Error("Host could not create a scratch artifact for authoring.");
          this.emit("artifact.author.ensure", "degraded", { taskId: task.id, artifactId: created.artifactId, reason: "artifact.author arrived before any artifact.create completed; host created the scratch artifact." }, { reversible: true });
        } catch (ensureError) {
          this.emit("artifact.author.ensure", "failed", { taskId: task.id, reason: ensureError.message }, { reversible: true });
          throw ensureError;
        }
      }
      let result = await this.executeCommand(action.commandId, { ...commandInput, taskId: commandInput.taskId || task.id, __fromAgentAction: true, __approvedPlan: true, __agentActionId: action.id });
      if (action.commandId === "artifact.author") {
        // T12: registry-side throws (missing manifest, invalid path segments in
        // model-supplied source maps or filenames, kind/runtime validation)
        // must degrade to the host scaffold outcome instead of failing a
        // receipt-backed Build-mode action. Retry once through the same
        // create-if-missing-then-author fallback used above.
        const retryAuthor = async () => {
          const ensured = await this.executeCommand("artifact.create", {
            taskId: task.id,
            title: String(task.objective || "Hemlock animation").split(/[:.!?]/, 1)[0].slice(0, 120) || "Hemlock animation",
            kind: "html",
            mime: "text/html",
            entrypoint: "index.html",
            __fromAgentAction: true,
            __approvedPlan: true,
            __agentActionId: action.id,
          });
          if (!ensured?.artifactId) throw new Error("Host could not create a scratch artifact for authoring.");
          return this.executeCommand(action.commandId, {
            ...commandInput,
            artifactId: ensured.artifactId,
            filename: "index.html",
            runtimeTemplate: "html",
            source: { "index.html": fallbackAnimationSource(task.objective) },
            status: "previewable",
            evidence: [{ type: "authoring.host_fallback", reason: `Registry rejected the authored revision (${error.message}); host scaffold retained.` }],
            __fromAgentAction: true,
            __approvedPlan: true,
            __agentActionId: action.id,
          });
        };
        try {
          result = result && typeof result.then === "function" ? await result : result;
        } catch (authorError) {
          error = authorError;
          result = await retryAuthor();
          this.emit("artifact.author.recovered", "degraded", { taskId: task.id, artifactId: result?.id || null, reason: authorError.message }, { reversible: true });
        }
      }
      if (action.commandId === "artifact.preview.inspect" && result?.status === "blocked") {
        result = await this.repairArtifact(task, this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId) || { steps: [] }, action, result);
      }
      const verificationFailed = action.commandId === "verify" && (result?.status === "blocked" || result?.status === "failed" || (result?.exitCode != null && result.exitCode !== 0));
      if (verificationFailed && this.repairCoding) {
        const historyBeforeRepair = this.kernel.getTaskHistory(task.id);
        const baseChangeSet = historyBeforeRepair.observations.map((item) => item.structuredOutput).reverse().find((output) => output?.schema === "hemlock.agent.change-set.v1") || null;
        const repair = await this.repairCoding({
          task,
          plan: this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId) || { steps: [] },
          action,
          failedResult: result,
          baseChangeSetId: baseChangeSet?.id || null,
          history: historyBeforeRepair,
        });
        result = repair?.status === "passed"
          ? { ...repair, status: "passed", summary: "A bounded coding repair passed the verification profile.", evidenceRefs: [...new Set([...(repair.evidenceRefs || []), ...(repair.verification?.evidenceRefs || [])])] }
          : { ...repair, status: "blocked", summary: "Coding verification remained blocked after bounded repair attempts.", evidenceRefs: repair?.verification?.evidenceRefs || [] };
      }
      if (TERMINAL_TASK_STATUSES.has(this.task()?.status) || this.kernel.getProjection().actions.find((item) => item.id === action.id)?.status === "cancelled") {
        return { schema: "hemlock.agent.action.result.v1", status: "cancelled", action: this.kernel.getProjection().actions.find((item) => item.id === action.id), task: this.task() };
      }
      const observation = tagObservationLane(compactObservation(result, { operationId: result?.operationId, elapsedMs: Date.now() - startedAt }), action);
      this.kernel.recordObservation(observation);
      const actionTransition = observation.status === "blocked" ? "block" : observation.status === "failed" ? "fail" : "complete";
      this.kernel.transitionAction(action.id, actionTransition, { observationId: observation.id, operationId: observation.operationId || result?.operationId || null });
      const episode = this.kernel.appendEpisodeEvent(task.id, { action: this.kernel.getProjection().actions.find((item) => item.id === action.id), observation, outcome: observation.status === "passed" ? "running" : observation.status });
      this.emit("episode.updated", "recorded", { episode }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      this.emit("observation.recorded", observation.status, { actionId: action.id, observation }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      if (observation.status === "blocked" || observation.status === "failed") return this.blockTask(task.id, observation.summary, { actionId: action.id, observationId: observation.id });
      if (consumesMutationSet && observation.status === "passed") {
        const budget = mergeBudget(this.task().budget);
        this.updateTask({ budget: { ...budget, mutationSetsUsed: Number(budget.mutationSetsUsed || 0) + 1 } });
      }
      this.emit("action.completed", "passed", { actionId: action.id, observationId: observation.id }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      const nextPlan = this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId);
      if (!nextPlan) return this.completeTask(task.id, "Action completed with a receipt.");
      // A batch item returns control to executeBatchActions — the batch owns
      // the next step boundary instead of recursing into a fresh proposal.
      if (internal.batchItem) return { schema: "hemlock.agent.action.result.v1", status: "passed", action: this.kernel.getProjection().actions.find((item) => item.id === action.id), observation, task: this.task() };
      return this.proposeNextAction(task.id, nextPlan);
    } catch (error) {
      const category = classifyFailure(error);
      const hint = ACTIONABLE_HINTS[action.commandId];
      const observation = tagObservationLane(compactObservation({ status: "failed", error: error.message, summary: hint ? `${error.message} hint: ${hint}` : error.message }, { elapsedMs: Date.now() - startedAt }), action);
      this.kernel.recordObservation(observation);
      this.kernel.transitionAction(action.id, category === "cancelled" ? "cancel" : "fail", { observationId: observation.id, failureCategory: category, error: error.message });
      const episode = this.kernel.appendEpisodeEvent(task.id, { action: this.kernel.getProjection().actions.find((item) => item.id === action.id), observation, outcome: category });
      this.emit("episode.updated", "recorded", { episode }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      this.emit("observation.recorded", "failed", { actionId: action.id, observation, category }, { reversible: true });
      if (category === "retryable-transient" && action.retryCount < Number(mergeBudget(task.budget).maxRetriesPerOperation || 0)) {
        const retry = { ...action, id: `${action.id}-retry-${action.retryCount + 1}`, retryCount: action.retryCount + 1, status: "proposed", proposedAt: new Date().toISOString() };
        this.kernel.createAction(retry);
        this.emit("action.retry.proposed", "retrying", { actionId: action.id, category, retryCount: action.retryCount + 1 }, { reversible: true });
        this.updateTask({ activeActionId: retry.id, foregroundStep: `Retrying ${action.commandId} after a transient failure` });
        return this.executeAction(retry.id, internal);
      }
      // A missing/malformed required-arg failure (deterministic-input) is
      // never an instant terminal block: the compact envelope could not
      // express the args, so re-infer once with the command's input contract
      // echoed back, then retry the action exactly once.
      if (category === "deterministic-input" && this.inferAction && Number(action.inputRepairsUsed || 0) < MAX_INPUT_REPAIR_ATTEMPTS) {
        const plan = this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId) || { steps: [] };
        try {
          const repaired = await this.inferActionInputRepair(task, plan, action, error);
          if (repaired?.input && Object.keys(repaired.input).length) {
            const retry = {
              ...action,
              id: `${action.id}-input-repair-${Number(action.inputRepairsUsed || 0) + 1}`,
              input: { ...(action.input && typeof action.input === "object" && !Array.isArray(action.input) ? action.input : {}), ...repaired.input },
              shortRationale: repaired.shortRationale || action.shortRationale,
              inputRepairsUsed: Number(action.inputRepairsUsed || 0) + 1,
              status: "proposed",
              proposedAt: new Date().toISOString(),
              validatedAt: null,
              startedAt: null,
              completedAt: null,
              operationId: null,
              observationId: null,
            };
            this.kernel.createAction(retry);
            this.emit("action.input.repaired", "retrying", {
              taskId: task.id,
              actionId: action.id,
              retryActionId: retry.id,
              commandId: action.commandId,
              requiredFields: repaired.requiredFields,
            }, { evidenceRefs: expectedEvidenceForCommand(action.commandId), reversible: true });
            this.updateTask({ activeActionId: retry.id, foregroundStep: `Retrying ${action.commandId} with repaired input`, status: "running", phase: "work", blockedReason: null });
            return this.executeAction(retry.id, internal);
          }
          this.emit("action.input.repair.failed", "degraded", { taskId: task.id, actionId: action.id, commandId: action.commandId, reason: "repair inference returned no usable input" }, { reversible: true });
        } catch (repairError) {
          this.emit("action.input.repair.failed", "degraded", { taskId: task.id, actionId: action.id, commandId: action.commandId, error: repairError.message }, { reversible: true });
        }
      }
      return this.blockTask(task.id, `${category}: ${error.message}`, { actionId: action.id, observationId: observation.id });
    }
  }

  // Sequential batch execution. The container action is ephemeral — each item
  // becomes its own durable action (kernel record, action.proposed/validated,
  // observation, receipt) so plan/history indexing and audit trails are
  // identical to the single-action path. The first non-passed item halts the
  // batch with a batch.halted receipt; earlier mutations stay journaled —
  // rollback is explicit (code.rollback), never automatic.
  async executeBatchActions(task, batch, plan, budget = {}) {
    const items = Array.isArray(batch.actions) ? batch.actions : [];
    const halt = (status, index, reason, result) => {
      this.emit("batch.halted", status === "paused" ? "paused" : status === "cancelled" ? "cancelled" : "blocked", {
        taskId: task.id,
        batchId: batch.id,
        completedCount: index,
        failedIndex: index,
        reason,
      }, { reversible: true });
      return result;
    };
    for (let index = 0; index < items.length; index += 1) {
      // Same step-boundary semantics as proposeNextAction: a paused task parks
      // before the next item (the in-flight one already receipted), a terminal
      // task stops the batch outright.
      const current = this.task();
      if (!current || TERMINAL_TASK_STATUSES.has(current.status)) {
        const status = current?.status || "cancelled";
        return halt(status, index, status, { schema: "hemlock.agent.action.result.v1", status, task: current });
      }
      if (current.status === "paused") {
        return halt("paused", index, "paused", { schema: "hemlock.agent.action.result.v1", status: "paused", task: current });
      }
      const history = this.kernel.getTaskHistory(task.id);
      const liveBudget = mergeBudget(current.budget);
      // Each item counts independently against step and wall-clock budgets —
      // a batch is one proposal, not one step.
      if (history.actions.length >= Number(liveBudget.maxAgentSteps || DEFAULT_BUDGET.maxAgentSteps)) {
        return halt("blocked", index, "step-budget-exhausted", this.blockTask(task.id, "Agent step budget exhausted before the batch finished.", { batchId: batch.id }));
      }
      if (Date.now() - Number(liveBudget.wallClockStartedAt || Date.now()) > Number(liveBudget.maxWallClockMs || DEFAULT_BUDGET.maxWallClockMs)) {
        return halt("blocked", index, "wall-clock-budget-exhausted", this.blockTask(task.id, "Agent wall-clock budget exhausted before the batch finished.", { batchId: batch.id }));
      }
      const item = items[index];
      const descriptor = this.commandRegistry[item.commandId] || {};
      const plannedStep = (plan.steps || []).slice(history.actions.length).find((step) => step?.commandId === item.commandId);
      const itemInput = item.input && typeof item.input === "object" && Object.keys(item.input).length
        ? item.input
        : plannedStep?.input && typeof plannedStep.input === "object" && !Array.isArray(plannedStep.input) && Object.keys(plannedStep.input).length
          ? boundedActionInput(item.commandId, { input: plannedStep.input })
          : item.input;
      const itemAction = validateAction({
        schema: ACTION_SCHEMA,
        id: `${batch.id}-item-${index + 1}`,
        taskId: task.id,
        step: history.actions.length + 1,
        kind: "tool",
        commandId: item.commandId,
        input: itemInput,
        shortRationale: item.shortRationale,
        expectedEvidence: item.expectedEvidence?.length ? item.expectedEvidence : expectedEvidenceForCommand(item.commandId),
        approval: plannedStep?.approval || (descriptor.approval === "plan" ? "plan" : "none"),
        status: "proposed",
        batchId: batch.id,
        batchIndex: index,
        batchSize: items.length,
        rawModelOutputRef: batch.rawModelOutputRef || null,
        modelChannels: batch.modelChannels || [],
        parseStatus: batch.parseStatus || "batch",
      }, this.commandRegistry);
      this.kernel.createAction(itemAction);
      this.updateTask({ phase: "work", status: "running", foregroundStep: itemAction.shortRationale, activeActionId: itemAction.id, budget: { ...liveBudget, agentStepsUsed: history.actions.length + 1 } });
      this.emit("action.proposed", "proposed", { action: itemAction }, { evidenceRefs: itemAction.expectedEvidence, reversible: true });
      this.kernel.transitionAction(itemAction.id, "validate");
      this.emit("action.validated", "passed", { action: itemAction }, { evidenceRefs: itemAction.expectedEvidence, reversible: true });
      const result = await this.executeAction(itemAction.id, { batchItem: true });
      if (result?.status !== "passed") {
        return halt(result?.status === "cancelled" ? "cancelled" : result?.status === "paused" ? "paused" : "blocked", index, result?.status || "failed", result);
      }
    }
    const nextPlan = this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId);
    if (!nextPlan) return this.completeTask(task.id, "Batched actions completed with receipts.");
    return this.proposeNextAction(task.id, nextPlan);
  }

  completeTask(taskId, reason) {
    const task = this.task();
    if (task?.id !== taskId || TERMINAL_TASK_STATUSES.has(task.status)) return { schema: "hemlock.agent.task.result.v1", status: task?.status || "completed", task };
    const history = this.kernel.getTaskHistory(taskId);
    if (task.intent === "coding") {
      const outputs = history.observations.map((item) => item.structuredOutput).filter(Boolean);
      const artifactTask = outputs.some((output) => String(output.schema || "").startsWith("hemlock.agent.artifact.") || output.schema === "hemlock.agent.preview.inspect.v1");
      const verifiedArtifact = outputs.some((output) => output.schema === "hemlock.agent.preview.inspect.v1" && output.status === "passed" && output.verification?.status === "passed" && (output.evidenceRefs || []).length);
      const appliedChangeSet = outputs.find((output) => output.schema === "hemlock.agent.change-set.v1" && output.status === "applied" && (output.evidenceRefs || []).length);
      const verifiedSource = outputs.find((output) => output.schema === "hemlock.agent.verification.v1" && output.status === "passed" && (output.evidenceRefs || []).length);
      if ((artifactTask && !verifiedArtifact) || (!artifactTask && (!appliedChangeSet || !verifiedSource))) {
        return this.blockTask(taskId, "Hemlock cannot complete a coding task without a matching applied source change-set and verification receipt.", { completionGate: "source-and-verification-receipts" });
      }
    }
    this.updateTask({ phase: "complete", status: "completed", foregroundStep: "Evidence-backed task complete", blockedReason: null });
    const episode = this.kernel.appendEpisodeEvent(taskId, { outcome: "completed" });
    this.emit("episode.updated", "recorded", { episode }, { reversible: true });
    if (["coding", "verify"].includes(task?.intent)) {
      const evidenceRefs = history.observations.flatMap((item) => item.evidenceRefs || []).filter(Boolean);
      if (evidenceRefs.length) {
        const candidate = this.kernel.createCandidate({
          kind: "memory",
          sourceId: "local-project",
          title: `Verified lesson · ${String(task.objective || "Hemlock task").slice(0, 72)}`,
          summary: `Symptom: ${task.objective}\nFix: Hemlock completed the bounded host action loop.\nProof: ${evidenceRefs.slice(0, 4).join("; ")}`,
          sourceRefs: evidenceRefs,
          reason: "A completed coding/verification episode produced receipt-backed evidence.",
          confidence: 0.78,
          verifyBeforeUse: true,
        });
        this.emit("candidate.created", "candidate", { candidate }, { evidenceRefs, reversible: true });
      }
    }
    this.emit("task.completed", "passed", { task: this.task(), reason }, { reversible: true });
    return { schema: "hemlock.agent.task.result.v1", status: "completed", task: this.task(), reason };
  }

  blockTask(taskId, reason, payload = {}) {
    this.updateTask({ phase: "blocked", status: "blocked", foregroundStep: "Inspect the blocked action and choose the next decision", blockedReason: reason });
    this.emit("task.blocked", "blocked", { taskId, reason, ...payload }, { reversible: true });
    // T8-F6: provider escalation removed — Hemlock runs ONLY the selected
    // lane. A Maple failure surfaces as a blocked task with its reason; no
    // Codex/Claude escape hatch is offered.
    return { schema: "hemlock.agent.task.result.v1", status: "blocked", task: this.task(), reason, ...payload };
  }

  cancel(taskId = this.task()?.id) {
    const task = this.task();
    if (!task || task.id !== taskId) return task;
    const active = this.kernel.getProjection().actions.find((item) => item.taskId === taskId && ["proposed", "validated", "running"].includes(item.status));
    if (active) this.kernel.transitionAction(active.id, "cancel");
    this.kernel.cancelOperations(taskId);
    this.updateTask({ phase: "stopped", status: "cancelled", foregroundStep: "Stopped by user", blockedReason: null });
    this.emit("task.cancelled", "cancelled", { taskId, actionId: active?.id || null }, { reversible: true });
    return this.task();
  }
}

module.exports = { AgentOrchestrator, ACTIONABLE_HINTS, defaultPlanSteps, completedTaskCommands, resolveProgressCommand, mutationIntervened, fallbackLaneForTask, LANE_FALLBACK_ERROR_KINDS, buildActionSystemPrompt, contextMaxTokensFor, resolveContextMaxTokens, estimateActionPromptTokens, CONTEXT_BUDGET_ERROR_CODE };
