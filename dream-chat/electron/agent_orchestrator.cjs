const crypto = require("node:crypto");

const {
  DEFAULT_BUDGET,
  TERMINAL_TASK_STATUSES,
  classifyFailure,
  compactObservation,
  createAction,
  createObservation,
  createPlan,
  extractJsonObject,
  mergeBudget,
  validateAction,
} = require("./agent_contracts.cjs");

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
    return [{ commandId: "repo-map", label: "Map the current repository", expectedEvidence: ["repo://current-worktree"] }, { commandId: "repo.inspect", label: "Inspect relevant files before editing", expectedEvidence: ["repo://inspection"] }, { commandId: "git.status", label: "Check worktree scope before a change", expectedEvidence: ["git://status"] }, { commandId: "verification.list", label: "Select verification for the task", expectedEvidence: ["verification://profiles"] }];
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
  constructor({ kernel, commandRegistry, getTask, setTask, emit, executeCommand, inferAction }) {
    this.kernel = kernel;
    this.commandRegistry = commandRegistry || {};
    this.getTask = getTask;
    this.setTask = setTask;
    this.emit = emit || (() => {});
    this.executeCommand = executeCommand;
    this.inferAction = inferAction || null;
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
    const actionPrompt = {
      system: [
        "You are Maple-Preview operating inside Hemlock.",
        "Return exactly one JSON action envelope and no prose.",
        "Do not invent command IDs. Do not claim completion without an observation or receipt.",
        "If evidence is insufficient, return kind ask_user or blocked.",
        "Use the exact hemlock.agent.action.v1 envelope shape shown below; step is a number, kind is one of tool/ask_user/answer/complete/blocked, approval is one of none/plan/explicit, and status is proposed.",
        '{"schema":"hemlock.agent.action.v1","id":"action-unique","taskId":"current-task-id","step":1,"kind":"tool","commandId":"registered-command","input":{},"shortRationale":"Short bounded reason","expectedEvidence":["receipt://expected"],"approval":"none","status":"proposed"}',
        `For this turn use the next planned commandId exactly: ${plan.steps[history.actions.length]?.commandId || "none"}. The host validates it against the allowlist.`,
      ].join("\n"),
      task,
      plan,
      nextPlannedStep,
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
    const normalizeHostFields = (action, modelResult = {}) => {
      const requestedId = String(action?.id || "").trim();
      // The model-facing example intentionally uses a readable placeholder,
      // but action identity belongs to the host. Reusing that placeholder (or
      // any stale model id) can collide with a durable action from an earlier
      // session and make an otherwise validated action impossible to accept.
      const actionId = !requestedId || requestedId === "action-unique" || this.kernel.getProjection().actions.some((item) => item.id === requestedId)
        ? `action-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
        : requestedId;
      return validateAction({
        ...action,
        id: actionId,
        taskId: String(action?.taskId || task.id),
        step: Number.isInteger(action?.step) && action.step > 0 ? action.step : history.actions.length + 1,
        ...(nextPlannedStep?.commandId ? { kind: nextPlannedStep.kind || "tool", commandId: nextPlannedStep.commandId, expectedEvidence: nextPlannedStep.expectedEvidence || action?.expectedEvidence || [], approval: nextPlannedStep.approval || action?.approval || "none" } : {}),
        status: action?.status || "proposed",
        rawModelOutputRef: modelResult.rawOutputRef || null,
        modelChannels: Array.isArray(modelResult.channels) ? modelResult.channels : [],
        parseStatus: "valid",
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
        return { modelResult, action: normalizeHostFields(extractJsonObject(modelResult.content), modelResult) };
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
      action = await this.infer(task, plan, history) || this.deterministicAction(task, plan, history);
      if (TERMINAL_TASK_STATUSES.has(this.task()?.status)) return { schema: "hemlock.agent.task.result.v1", status: this.task().status, task: this.task() };
      action = { ...action, taskId, step: history.actions.length + 1 };
      validateAction(action, this.commandRegistry);
    } catch (error) {
      const nextStep = plan.steps[history.actions.length];
      if (nextStep?.commandId?.startsWith("artifact.") || !nextStep) {
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
      if (!history.observations.length || (["coding", "verify"].includes(task.intent) && !evidence.length)) {
        return this.blockTask(task.id, "Maple cannot claim completion before a structured observation or receipt is recorded.", { actionId: action.id });
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
        commandInput.artifactId ||= `artifact-${Date.now()}`;
        commandInput.title ||= String(task.objective || "Hemlock animation").split(/[:.!?]/, 1)[0].slice(0, 120) || "Hemlock animation";
        commandInput.kind ||= "html";
        commandInput.mime ||= "text/html";
        commandInput.entrypoint ||= "index.html";
      }
      if (action.commandId === "artifact.author" && !commandInput.artifactId) {
        const priorArtifact = this.kernel.getTaskHistory(task.id).observations.slice().reverse().map((item) => item.structuredOutput).find((output) => output?.schema === "hemlock.agent.artifact.v1" && output.id);
        if (priorArtifact?.id) commandInput.artifactId = priorArtifact.id;
      }
      const priorOutputs = this.kernel.getTaskHistory(task.id).observations.slice().reverse().map((item) => item.structuredOutput);
      const latestArtifact = priorOutputs.find((output) => output?.schema === "hemlock.agent.artifact.v1" && output.id);
      if (action.commandId === "artifact.author") {
        commandInput.kind ||= "html";
        commandInput.filename ||= "index.html";
        commandInput.runtimeTemplate ||= "html";
        commandInput.objective ||= task.objective;
        if (!commandInput.source) {
          commandInput.source = { "index.html": fallbackAnimationSource(task.objective) };
          commandInput.status = "previewable";
          commandInput.evidence = [{ type: "authoring.host_fallback", reason: "Maple did not return a usable structured authoring envelope." }];
        }
      }
      if (action.commandId === "artifact.preview.open" && !commandInput.artifactId && latestArtifact?.id) commandInput.artifactId = latestArtifact.id;
      if (action.commandId === "artifact.preview.inspect" && !commandInput.sessionId) {
        const latestPreview = priorOutputs.find((output) => output?.schema === "hemlock.agent.preview.open.v1" && output.session?.id);
        if (latestPreview?.session?.id) commandInput.sessionId = latestPreview.session.id;
      }
      const result = await this.executeCommand(action.commandId, { ...commandInput, __fromAgentAction: true, __approvedPlan: true, __agentActionId: action.id });
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
    this.updateTask({ phase: "complete", status: "completed", foregroundStep: "Evidence-backed task complete", blockedReason: null });
    const episode = this.kernel.appendEpisodeEvent(taskId, { outcome: "completed" });
    this.emit("episode.updated", "recorded", { episode }, { reversible: true });
    if (["coding", "verify"].includes(task?.intent)) {
      const evidenceRefs = this.kernel.getTaskHistory(taskId).observations.flatMap((item) => item.evidenceRefs || []).filter(Boolean);
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
