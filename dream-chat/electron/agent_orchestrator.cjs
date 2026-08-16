const crypto = require("node:crypto");

const {
  DEFAULT_BUDGET,
  TERMINAL_TASK_STATUSES,
  classifyFailure,
  compactObservation,
  createAction,
  createObservation,
  createPlan,
  boundedActionInput,
  coerceActionPayload,
  extractActionEnvelope,
  mergeBudget,
  normalizeExpectedEvidence,
  validateAction,
} = require("./agent_contracts.cjs");

const MODEL_TERMINAL_KINDS = new Set(["ask_user", "blocked", "answer"]);
const SAFE_ADAPTIVE_CAPABILITIES = new Set(["read", "context", "verify", "artifact", "preview", "write"]);
const FORBIDDEN_ADAPTIVE_CAPABILITIES = new Set(["train", "runtime", "external", "network", "secret"]);
const HOST_DETERMINISTIC_COMMANDS = new Set([
  "artifact.preview.open",
  "artifact.preview.inspect",
]);

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
});

function expectedEvidenceForCommand(commandId, fallback = []) {
  return Array.isArray(COMMAND_EVIDENCE[commandId])
    ? [...COMMAND_EVIDENCE[commandId]]
    : normalizeExpectedEvidence(fallback, [`receipt://${String(commandId || "command").replace(/[^a-z0-9._-]+/gi, "-")}`]);
}

function modelMaySelectCommand(commandId, descriptor = {}, plan = { steps: [] }) {
  const capability = String(descriptor.capability || "").toLowerCase();
  const planned = (plan.steps || []).some((step) => step.commandId === commandId);
  if (!commandId || !capability || FORBIDDEN_ADAPTIVE_CAPABILITIES.has(capability)) return false;
  if (!SAFE_ADAPTIVE_CAPABILITIES.has(capability)) return false;
  // A command already present in the user-approved plan is available even if
  // its descriptor is normally explicit (artifact authoring is the important
  // example). New model-selected commands must be host-marked auto-safe.
  if (!planned && descriptor.auto !== true) return false;
  if (!planned && descriptor.approval === "explicit") return false;
  return true;
}

function allowedNextCommands(commandRegistry = {}, plan = { steps: [] }, history = {}) {
  const planned = (plan.steps || []).slice(Number(history.actions?.length || 0)).map((step) => ({
    commandId: step.commandId,
    label: step.label,
    capability: commandRegistry[step.commandId]?.capability || "planned",
    source: "approved-plan",
  })).filter((item) => item.commandId);
  const adaptive = Object.entries(commandRegistry)
    .filter(([commandId, descriptor]) => modelMaySelectCommand(commandId, descriptor, plan))
    .map(([commandId, descriptor]) => ({ commandId, label: descriptor.label || commandId, capability: descriptor.capability, source: "adaptive-safe" }));
  const seen = new Set();
  return [...planned, ...adaptive].filter((item) => {
    if (seen.has(item.commandId)) return false;
    seen.add(item.commandId);
    return true;
  }).slice(0, 32);
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
    default:
      return "input should be {}. The host supplies task identity, command identity, approval, and evidence.";
  }
}

function defaultPlanSteps(intent, objective = "") {
  if (intent === "verify") return [{ commandId: "verification.list", label: "Select an allowlisted verification", expectedEvidence: ["verification://profiles"] }, { commandId: "verify", label: "Run the selected verification", expectedEvidence: ["receipt://verification"] }];
  if (intent === "memory") return [{ commandId: "recall", label: "Recall scoped project lessons", expectedEvidence: ["memory://scoped"] }];
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
    return [
      { commandId: "context.refresh", label: "Refresh scoped project context", expectedEvidence: ["context://current"] },
      { commandId: "repo-map", label: "Map the current repository", expectedEvidence: ["repo://current-worktree"] },
      { commandId: "repo.inspect", label: "Inspect relevant files before editing", expectedEvidence: ["repo://inspection"] },
      { commandId: "git.status", label: "Check worktree scope before a change", expectedEvidence: ["git://status"] },
      { commandId: "code.apply", label: "Apply the requested scoped coding edit", expectedEvidence: ["changeset://applied"] },
      { commandId: "verify", label: "Run the selected verification profile", expectedEvidence: ["receipt://verification"] },
      { commandId: "git.diff", label: "Record the final scoped diff", expectedEvidence: ["git://diff"] },
    ];
  }
  if (intent === "improve") return [{ commandId: "repo-map", label: "Map the current project", expectedEvidence: ["repo://current-worktree"] }, { commandId: "receipts.query", label: "Inspect recent evidence before proposing improvement", expectedEvidence: ["receipt://recent"] }];
  if (intent === "conversation") return [{ kind: "answer", label: "Answer from the scoped context and evidence" }];
  return [{ commandId: "repo-map", label: "Inspect the local project", expectedEvidence: ["repo://current-worktree"] }];
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
  constructor({ kernel, commandRegistry, getTask, setTask, emit, executeCommand, inferAction, repairCoding, createSuggestion }) {
    this.kernel = kernel;
    this.commandRegistry = commandRegistry || {};
    this.getTask = getTask;
    this.setTask = setTask;
    this.emit = emit || (() => {});
    this.executeCommand = executeCommand;
    this.inferAction = inferAction || null;
    this.repairCoding = repairCoding || null;
    this.createSuggestion = createSuggestion || null;
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

  async approvePlan(taskId, planId) {
    const task = this.task();
    if (task?.id !== taskId) throw new Error("The plan does not belong to the current task.");
    const plan = this.requirePlan(taskId, planId);
    if (plan.status === "approved") return { schema: "hemlock.agent.plan.result.v1", status: this.task().status, plan, task: this.task(), claimBoundary: "The plan was already approved; the durable task state is authoritative." };
    if (plan.status !== "proposed") throw new Error(`Plan is not awaiting approval; current status is ${plan.status}.`);
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

  async resumeTask(taskId = this.task()?.id) {
    const task = this.task();
    if (!task || task.id !== taskId) throw new Error("Hemlock cannot resume an unknown task.");
    if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error(`The task is already terminal: ${task.status}.`);
    const plan = this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId && item.taskId === taskId);
    if (!plan || plan.status !== "approved") throw new Error("Approve a plan before resuming execution.");
    return this.proposeNextAction(taskId, plan);
  }

  allowedNextCommands(task, plan, history) {
    return allowedNextCommands(this.commandRegistry, plan, history);
  }

  selectModelCommand(task, plan, history, requestedCommandId) {
    const currentStep = plan.steps[history.actions.length] || null;
    const currentCommandId = currentStep?.commandId || null;
    const requested = String(requestedCommandId || "").trim();
    if (!requested || requested === "none") return { commandId: currentCommandId, mode: "planned", reason: "model omitted a command" };
    if (requested === currentCommandId) return { commandId: requested, mode: "planned", reason: null };
    const descriptor = this.commandRegistry[requested];
    if (descriptor && modelMaySelectCommand(requested, descriptor, plan)) {
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
    const existingIndex = plan.steps.findIndex((step, index) => index >= currentIndex && step.commandId === decision.commandId);
    let step = existingIndex >= currentIndex ? plan.steps.splice(existingIndex, 1)[0] : null;
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
    }].slice(-24);
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

  async infer(task, plan, history) {
    if (!this.inferAction) return null;
    const asModelResult = (value) => {
      if (typeof value === "string") return { content: value, channels: [], rawOutputRef: null };
      if (value && typeof value === "object" && typeof value.content === "string") {
        return {
          content: value.content,
          channels: Array.isArray(value.channels) ? value.channels : [],
          rawOutputRef: value.rawOutputRef || null,
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
      if (Array.isArray(value.evidenceRefs)) summary.evidenceRefs = value.evidenceRefs.slice(0, 12);
      if (Array.isArray(value.files)) summary.fileCount = value.files.length;
      if (Array.isArray(value.revisions)) summary.revisionCount = value.revisions.length;
      if (value.artifact && typeof value.artifact === "object") summary.artifact = summarizeOutput(value.artifact);
      if (value.observation && typeof value.observation === "object") summary.observation = summarizeOutput(value.observation);
      return summary;
    };
    const compactHistory = {
      actions: history.actions.slice(-8).map(({ id, step, kind, commandId, status, shortRationale, observationId }) => ({ id, step, kind, commandId, status, shortRationale, observationId })),
      observations: history.observations.slice(-8).map((observation) => ({ id: observation.id, operationId: observation.operationId, status: observation.status, summary: observation.summary, outputDigest: observation.outputDigest, evidenceRefs: (observation.evidenceRefs || []).slice(0, 12), structuredOutput: summarizeOutput(observation.structuredOutput) })),
      operations: history.operations.slice(-8).map(({ id, command, status, evidenceRefs, error }) => ({ id, command, status, evidenceRefs: (evidenceRefs || []).slice(0, 12), error })),
    };
    const nextPlannedStep = plan.steps[history.actions.length] || null;
    const allowedCommands = this.allowedNextCommands(task, plan, history);
    const actionPrompt = {
      system: [
        "You are Maple-Preview operating inside Hemlock.",
        "Return exactly one compact JSON action envelope in the content channel and no prose or markdown.",
        "The host owns id, taskId, step, commandId, kind, approval, expectedEvidence, status, and lifecycle. Do not spend output on those fields beyond the required envelope.",
        "The approved plan is a user-approved capability boundary and a starting direction, not a rigid script. Choose the next best allowlisted command from allowedNextCommands when more inspection, verification, or artifact work is useful.",
        "You may return kind ask_user when a real user decision is needed, kind blocked when the host boundary prevents progress, or kind answer when the task is genuinely answerable without another command. Do not claim completion without host evidence.",
        "Never put HTML, source code, or a large payload in artifact.create. Use the later artifact.author step for complete source.",
        "If evidence is insufficient, return kind ask_user or blocked. Do not claim completion without a host observation or receipt.",
        '{"schema":"hemlock.agent.action.v1","id":"a","taskId":"t","step":1,"kind":"tool","commandId":"registered-command","input":{},"shortRationale":"Short reason","expectedEvidence":[],"approval":"none","status":"proposed"}',
        `The current planned command is ${nextPlannedStep?.commandId || "none"}. You may choose another entry from allowedNextCommands if it better serves the objective; the host will validate and record that adaptation.`,
        `allowedNextCommands: ${JSON.stringify(allowedCommands)}`,
        `Input contract for the current planned command: ${actionInputContract(nextPlannedStep?.commandId)} Use the reasoning channel as needed, then finish with the action envelope.`,
      ].join("\n"),
      task,
      plan,
      nextPlannedStep,
      allowedNextCommands: allowedCommands,
      history: compactHistory,
    };
    let response;
    try {
      response = await this.inferAction(actionPrompt);
    } catch (firstInferenceError) {
      this.emit("action.inference.failed", "degraded", {
        error: firstInferenceError.message,
        rawModelOutputRef: firstInferenceError.rawModelOutputRef || null,
        modelChannels: firstInferenceError.modelChannels || [],
        parseStatus: "inference-failed",
        repairAttempt: true,
      }, { reversible: true });
      try {
        response = await this.inferAction({ ...actionPrompt, repair: `Maple did not return a usable action. Return exactly one JSON action envelope for the registered commands. Any model-emitted channels remain recorded separately. The prior error was: ${firstInferenceError.message}` });
      } catch (secondInferenceError) {
        const error = new Error(`Maple failed to return a structured action after one repair: ${secondInferenceError.message}`);
        error.code = "INVALID_ACTION_OUTPUT";
        error.rawModelOutputRef = secondInferenceError.rawModelOutputRef || firstInferenceError.rawModelOutputRef || null;
        error.modelChannels = secondInferenceError.modelChannels || firstInferenceError.modelChannels || [];
        throw error;
      }
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
      const { __recoveredTruncated: _recoveredTruncated, __coercedPayload: _coercedPayload, ...modelFields } = action || {};
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
          parseStatus: recoveredTruncated ? "recovered-truncated" : coercedPayload ? "coerced-payload" : "valid",
        }, this.commandRegistry);
      }
      const selectedStep = selection.step;
      const requestedCommandId = String(action?.commandId || "").trim() || "none";
      return validateAction({
        ...modelFields,
        id: actionId,
        taskId: task.id,
        step: history.actions.length + 1,
        kind: selectedStep.kind || "tool",
        commandId: selection.commandId,
        input: boundedActionInput(selection.commandId, action),
        expectedEvidence: expectedEvidenceForCommand(selection.commandId, selectedStep.expectedEvidence),
        approval: selectedStep.approval || "none",
        status: "proposed",
        hostSelection: { requestedCommandId, selectedCommandId: selection.commandId, mode: selection.decision.mode, reason: selection.decision.reason },
        rawModelOutputRef: modelResult.rawOutputRef || null,
        modelChannels: Array.isArray(modelResult.channels) ? modelResult.channels : [],
        parseStatus: recoveredTruncated ? "recovered-truncated" : coercedPayload ? "coerced-payload" : "valid",
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
      try {
        const parsed = extractActionEnvelope(modelResult.content);
        try {
          return { modelResult, action: normalizeHostFields(parsed, modelResult) };
        } catch (validationError) {
          const selection = selectionForAction(parsed);
          const coerced = coerceActionPayload(parsed, {
            taskId: task.id,
            step: history.actions.length + 1,
            commandId: selection.commandId,
            expectedEvidence: selection.step?.expectedEvidence || [],
            approval: selection.step?.approval || "none",
          });
          if (!coerced) throw validationError;
          return { modelResult, action: normalizeHostFields(coerced, modelResult) };
        }
      } catch (error) {
        error.rawModelOutputRef ||= modelResult.rawOutputRef || null;
        error.modelChannels ||= modelResult.channels || [];
        throw error;
      }
    };
    try {
      return parseModelResult(response).action;
    } catch (firstError) {
      this.emit("action.parse.failed", "blocked", {
        error: firstError.message,
        rawModelOutputRef: firstError.rawModelOutputRef || null,
        modelChannels: firstError.modelChannels || [],
        parseStatus: "invalid",
        repairAttempt: true,
      }, { reversible: true });
      try {
        response = await this.inferAction({ ...actionPrompt, repair: `The prior output was invalid: ${firstError.message}. Return only one valid action envelope; preserve any model-emitted channels in the model output record.` });
      } catch (repairInferenceError) {
        const error = new Error(`Maple failed during structured-action repair: ${repairInferenceError.message}`);
        error.code = "INVALID_ACTION_OUTPUT";
        error.rawModelOutputRef = repairInferenceError.rawModelOutputRef || firstError.rawModelOutputRef || null;
        error.modelChannels = repairInferenceError.modelChannels || firstError.modelChannels || [];
        throw error;
      }
      try {
        return parseModelResult(response).action;
      } catch (secondError) {
        const error = new Error(`Maple produced two invalid action envelopes: ${secondError.message}`);
        error.code = "INVALID_ACTION_OUTPUT";
        error.rawModelOutputRef = secondError.rawModelOutputRef || firstError.rawModelOutputRef || null;
        error.modelChannels = secondError.modelChannels || firstError.modelChannels || [];
        throw error;
      }
    }
  }

  actionInputContract(commandId) {
    return actionInputContract(commandId);
  }

  deterministicAction(task, plan, history) {
    const nextIndex = history.actions.length;
    const step = plan.steps[nextIndex];
    if (!step) return createAction({ taskId: task.id, step: nextIndex + 1, kind: "complete", shortRationale: "All planned steps have verified observations.", expectedEvidence: ["receipt://task"] });
    return createAction({ taskId: task.id, step: nextIndex + 1, kind: step.kind || "tool", commandId: step.commandId, input: {}, shortRationale: step.label, expectedEvidence: step.expectedEvidence, approval: step.approval || "none" });
  }

  async proposeNextAction(taskId, plan) {
    const task = this.task();
    if (TERMINAL_TASK_STATUSES.has(task?.status)) return { schema: "hemlock.agent.task.result.v1", status: task.status, task };
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
      validateAction(action, this.commandRegistry);
    } catch (error) {
      const nextStep = plan.steps[history.actions.length];
      const deterministicSafeCommands = new Set(["context.refresh", "repo-map", "repo.inspect", "git.status", "git.diff", "verification.list", "verify", "code.inspect"]);
      if ((error.code !== "INVALID_ACTION_OUTPUT" || nextStep?.commandId?.startsWith("artifact.")) && (nextStep?.commandId?.startsWith("artifact.") || deterministicSafeCommands.has(nextStep?.commandId) || !nextStep)) {
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
      } else {
      return this.blockTask(taskId, error.message, { code: error.code || "ACTION_INVALID" });
      }
    }
    this.kernel.createAction(action);
    this.updateTask({ phase: action.kind === "ask_user" ? "waiting_for_user" : "work", status: action.kind === "ask_user" ? "waiting_for_approval" : "running", foregroundStep: action.shortRationale, activeActionId: action.id, budget: { ...budget, agentStepsUsed: history.actions.length + 1 } });
    this.emit("action.proposed", "proposed", { action }, { evidenceRefs: action.expectedEvidence, reversible: true });
    this.kernel.transitionAction(action.id, "validate");
    this.emit("action.validated", "passed", { action }, { evidenceRefs: action.expectedEvidence, reversible: true });
    if (action.kind === "ask_user") return { schema: "hemlock.agent.action.result.v1", status: "waiting_for_user", action, task: this.task() };
    const planApproved = action.approval === "plan" && this.kernel.getProjection().plans.some((item) => item.id === task.activePlanId && item.status === "approved");
    if (action.approval !== "none" && !planApproved) return { schema: "hemlock.agent.action.result.v1", status: "waiting_for_approval", action, task: this.task() };
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
    const issueSummary = (verification?.issues || []).slice(0, 12).map((item) => `${item.code}: ${item.message}`).join("\n") || String(verification?.summary || "Preview verification failed.");
    const response = await this.inferAction({
      system: [
        "You are Maple-Preview repairing a task-scoped scratch artifact inside Hemlock.",
        "Return exactly one JSON action envelope and no prose.",
        "The host owns action identity, task identity, step, commandId, approval, lifecycle, and evidence.",
        "Use commandId artifact.update. Provide either input.source as a complete relative-file source map or input.patches as bounded complete file replacements.",
        "Do not modify repository files. Do not return a diff fragment, shell command, or partial file.",
        '{"schema":"hemlock.agent.action.v1","id":"action-unique","taskId":"current-task-id","step":1,"kind":"tool","commandId":"artifact.update","input":{"source":{"index.html":"complete file contents"},"repairFor":{"revision":1,"issues":[]}},"shortRationale":"Repair the reported preview issue.","expectedEvidence":["artifact://revision"],"approval":"none","status":"proposed"}',
      ].join("\n"),
      task,
      plan,
      nextPlannedStep: { kind: "tool", commandId: "artifact.update", expectedEvidence: ["artifact://revision"], approval: "none" },
      history: { actions: history.actions.slice(-6), observations: history.observations.slice(-6), operations: history.operations.slice(-6) },
      repair: {
        schema: "hemlock.agent.artifact.repair.v1",
        attempt,
        baseRevision: Number(artifact?.revision || verification?.revision || 0),
        artifactId: artifact?.id || null,
        issues: (verification?.issues || []).slice(0, 12),
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
    const response = await this.inferAction({
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
      history: { actions: history.actions.slice(-8), observations: history.observations.slice(-8), operations: history.operations.slice(-8) },
      repair: {
        schema: "hemlock.agent.repair.v1",
        attempt,
        maxAttempts: Number(task.budget?.maxCodeRepairs || 2),
        threadId: task.threadId || null,
        taskId: task.id,
        issues: (verification?.issues || []).slice(0, 16),
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

  artifactFromHistory(history) {
    return history.observations.map((item) => item.structuredOutput).reverse().find((output) => output?.schema === "hemlock.agent.artifact.v1" && output.id) || null;
  }

  async repairArtifact(task, plan, action, failedResult) {
    const history = this.kernel.getTaskHistory(task.id);
    const artifact = this.artifactFromHistory(history);
    const budget = mergeBudget(task.budget);
    const previous = task.artifactRepair || {};
    const maxAttempts = Math.max(0, Number(previous.maxAttempts ?? budget.maxArtifactRepairs ?? 2));
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

  async executeAction(actionId) {
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
    if (action.approval !== "none" && !planApproved) return { schema: "hemlock.agent.action.result.v1", status: "waiting_for_approval", action, task: this.task() };
    const descriptor = this.commandRegistry[action.commandId] || {};
    if (descriptor.capability === "write") {
      const budget = mergeBudget(this.task().budget);
      if (Number(budget.mutationSetsUsed || 0) >= Number(budget.maxMutationSets || 1)) return this.blockTask(task.id, "The single mutation-set budget is already consumed.", { actionId: action.id });
      this.updateTask({ budget: { ...budget, mutationSetsUsed: Number(budget.mutationSetsUsed || 0) + 1 } });
    }
    this.kernel.transitionAction(action.id, "start");
    this.emit("command.started", "running", { actionId: action.id, command: action.commandId }, { reversible: true });
    const startedAt = Date.now();
    try {
      const commandInput = { ...(action.input || {}) };
      if (action.commandId === "artifact.create") {
        const allowedArtifactKinds = new Set(["html", "svg", "text", "markdown", "json"]);
        commandInput.kind = allowedArtifactKinds.has(String(commandInput.kind || "").toLowerCase()) ? String(commandInput.kind).toLowerCase() : "html";
        commandInput.artifactId ||= `artifact-${Date.now()}`;
        commandInput.title ||= String(task.objective || "Hemlock animation").split(/[:.!?]/, 1)[0].slice(0, 120) || "Hemlock animation";
        commandInput.mime ||= "text/html";
        commandInput.entrypoint = typeof commandInput.entrypoint === "string" && commandInput.entrypoint !== "create" && commandInput.entrypoint && !commandInput.entrypoint.startsWith("/") && !commandInput.entrypoint.split(/[\\/]/).some((part) => part === "." || part === ".." || !part) ? commandInput.entrypoint : "index.html";
      }
      if (action.commandId === "artifact.author" && !commandInput.artifactId) {
        const priorArtifact = this.kernel.getTaskHistory(task.id).observations.slice().reverse().map((item) => item.structuredOutput).find((output) => output?.schema === "hemlock.agent.artifact.v1" && output.id);
        if (priorArtifact?.id) commandInput.artifactId = priorArtifact.id;
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
          commandInput.source = { "index.html": fallbackAnimationSource(task.objective) };
          commandInput.status = "previewable";
          commandInput.evidence = [{ type: "authoring.host_fallback", reason: commandInput.source ? "Maple returned malformed or incomplete source; host scaffold retained." : "Maple did not return a usable structured authoring envelope." }];
        }
      }
      if (action.commandId === "artifact.preview.open" && !commandInput.artifactId && latestArtifact?.id) commandInput.artifactId = latestArtifact.id;
      if (action.commandId === "artifact.preview.inspect" && !commandInput.sessionId) {
        const latestPreview = priorOutputs.find((output) => output?.schema === "hemlock.agent.preview.open.v1" && output.session?.id);
        if (latestPreview?.session?.id) commandInput.sessionId = latestPreview.session.id;
      }
      let result = await this.executeCommand(action.commandId, { ...commandInput, __fromAgentAction: true, __approvedPlan: true, __agentActionId: action.id });
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
      const observation = compactObservation(result, { operationId: result?.operationId, elapsedMs: Date.now() - startedAt });
      this.kernel.recordObservation(observation);
      const actionTransition = observation.status === "blocked" ? "block" : observation.status === "failed" ? "fail" : "complete";
      this.kernel.transitionAction(action.id, actionTransition, { observationId: observation.id, operationId: observation.operationId || result?.operationId || null });
      const episode = this.kernel.appendEpisodeEvent(task.id, { action: this.kernel.getProjection().actions.find((item) => item.id === action.id), observation, outcome: observation.status === "passed" ? "running" : observation.status });
      this.emit("episode.updated", "recorded", { episode }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      this.emit("observation.recorded", observation.status, { actionId: action.id, observation }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      if (observation.status === "blocked" || observation.status === "failed") return this.blockTask(task.id, observation.summary, { actionId: action.id, observationId: observation.id });
      this.emit("action.completed", "passed", { actionId: action.id, observationId: observation.id }, { evidenceRefs: observation.evidenceRefs, reversible: true });
      const nextPlan = this.kernel.getProjection().plans.find((item) => item.id === task.activePlanId);
      if (!nextPlan) return this.completeTask(task.id, "Action completed with a receipt.");
      return this.proposeNextAction(task.id, nextPlan);
    } catch (error) {
      const category = classifyFailure(error);
      const observation = compactObservation({ status: "failed", error: error.message, summary: error.message }, { elapsedMs: Date.now() - startedAt });
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
        return this.executeAction(retry.id);
      }
      return this.blockTask(task.id, `${category}: ${error.message}`, { actionId: action.id, observationId: observation.id });
    }
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
    if (this.task()?.provider === "maple" && typeof this.createSuggestion === "function") {
      this.createSuggestion({
        threadId: this.task()?.threadId || null,
        projectId: this.task()?.projectId || null,
        kind: "provider-escalation",
        title: "Maple-Preview is blocked",
        summary: "Retry this bounded task with an authenticated Codex or Claude subscription lane.",
        reason,
        evidenceRefs: this.task()?.evidenceRefs || [],
        recommendedAction: { command: "task.escalate-provider", providers: ["codex", "claude"] },
      });
    }
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

module.exports = { AgentOrchestrator, defaultPlanSteps };
