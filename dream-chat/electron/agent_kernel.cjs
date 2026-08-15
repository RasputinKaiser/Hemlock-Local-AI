const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function nowIso() {
  return new Date().toISOString();
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

function defaultSources(repoRoot) {
  return [
    {
      sourceId: "computer-history",
      displayName: "Computer History",
      enabled: true,
      scope: "local-user",
      retention: "30d",
      redactionRules: ["secrets", "credentials", "raw-screen-content"],
      permissionState: "user-enabled",
      freshness: "unknown",
      lastObservedAt: null,
    },
    {
      sourceId: "local-project",
      displayName: "Hemlock project and worktree",
      enabled: true,
      scope: repoRoot,
      retention: "project-lifetime",
      redactionRules: ["secrets"],
      permissionState: "implicit-project-scope",
      freshness: "unknown",
      lastObservedAt: null,
    },
    {
      sourceId: "openchronicle",
      displayName: "OpenChronicle project context",
      enabled: true,
      scope: repoRoot,
      retention: "30d",
      redactionRules: ["secrets", "raw-screen-content"],
      permissionState: "user-enabled",
      freshness: "unknown",
      lastObservedAt: null,
    },
    {
      sourceId: "local-notes",
      displayName: "Selected local notes",
      enabled: false,
      scope: "user-selected",
      retention: "30d",
      redactionRules: ["secrets", "credentials", "private-content"],
      permissionState: "not-enabled",
      freshness: "unknown",
      lastObservedAt: null,
    },
    {
      sourceId: "local-task-boards",
      displayName: "Local task boards",
      enabled: false,
      scope: "user-selected",
      retention: "30d",
      redactionRules: ["secrets", "credentials", "private-content"],
      permissionState: "not-enabled",
      freshness: "unknown",
      lastObservedAt: null,
    },
    {
      sourceId: "calendar",
      displayName: "Calendar",
      enabled: false,
      scope: "user-selected",
      retention: "30d",
      redactionRules: ["private-events", "attendees", "locations"],
      permissionState: "not-enabled",
      freshness: "unknown",
      lastObservedAt: null,
    },
    {
      sourceId: "mail-and-messages",
      displayName: "Mail and messages",
      enabled: false,
      scope: "user-selected",
      retention: "7d",
      redactionRules: ["private-content", "credentials", "financial-data"],
      permissionState: "not-enabled",
      freshness: "unknown",
      lastObservedAt: null,
    },
  ];
}

class AgentKernel {
  constructor({ root, repoRoot, task }) {
    this.root = path.resolve(root);
    this.repoRoot = path.resolve(repoRoot);
    this.workspaceId = `workspace-${digest(this.repoRoot).slice(0, 16)}`;
    this.workspaceRoot = path.join(this.root, "workspaces", this.workspaceId);
    this.statePath = path.join(this.workspaceRoot, "projection.json");
    this.journalPath = path.join(this.workspaceRoot, "projection.jsonl");
    fs.mkdirSync(this.workspaceRoot, { recursive: true });

    const stored = readJson(this.statePath, null);
    this.state = stored && stored.schema === "hemlock.agent.projection.v1"
      ? stored
      : {
        schema: "hemlock.agent.projection.v1",
        workspaceId: this.workspaceId,
        repoRoot: this.repoRoot,
        updatedAt: nowIso(),
        task: task || null,
        operations: [],
        queue: { schema: "hemlock.agent.queue.v1", active: null, pending: [], count: 0 },
        plans: [],
        actions: [],
        observations: [],
        episodes: [],
        candidates: [],
        sources: defaultSources(this.repoRoot),
        contextQuality: null,
        memory: { candidates: 0, promoted: 0, lastUpdatedAt: null },
        training: { status: "idle", lastRunId: null, candidatePath: null },
        storage: { root: this.root, workspaceRoot: this.workspaceRoot },
      };

    this.state.task = task || this.state.task;
    this.state.operations = Array.isArray(this.state.operations) ? this.state.operations : [];
    this.state.queue = this.state.queue && typeof this.state.queue === "object"
      ? this.state.queue
      : { schema: "hemlock.agent.queue.v1", active: null, pending: [], count: 0 };
    this.state.plans = Array.isArray(this.state.plans) ? this.state.plans : [];
    this.state.actions = Array.isArray(this.state.actions) ? this.state.actions : [];
    this.state.observations = Array.isArray(this.state.observations) ? this.state.observations : [];
    this.state.episodes = Array.isArray(this.state.episodes) ? this.state.episodes : [];
    this.state.candidates = Array.isArray(this.state.candidates) ? this.state.candidates : [];
    const sourceDefaults = defaultSources(this.repoRoot);
    const existingSources = Array.isArray(this.state.sources) ? this.state.sources : [];
    this.state.sources = existingSources.length
      ? [...existingSources, ...sourceDefaults.filter((source) => !existingSources.some((item) => item.sourceId === source.sourceId))]
      : sourceDefaults;
    const repairedCandidateIds = this.state.candidates
      .filter((candidate) => candidate.status === "candidate" && /\[object Object\]/i.test(`${candidate.title} ${candidate.summary}`))
      .map((candidate) => {
        candidate.status = "dismissed";
        candidate.updatedAt = nowIso();
        candidate.dismissedAt = candidate.updatedAt;
        candidate.dismissedReason = "superseded_by_context_normalization";
        return candidate.id;
      });
    this.persist(repairedCandidateIds.length ? "candidate.records.repaired" : "kernel.restored", repairedCandidateIds.length ? { candidateIds: repairedCandidateIds, reason: "Malformed structured context was superseded after normalization." } : {});
  }

  persist(type = "projection.updated", payload = {}) {
    this.state.updatedAt = nowIso();
    writeJson(this.statePath, this.state);
    appendJsonl(this.journalPath, {
      schema: "hemlock.agent.projection.event.v1",
      id: `projection-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      type,
      createdAt: this.state.updatedAt,
      payload,
    });
  }

  syncTask(task) {
    this.state.task = task;
    this.persist("task.projection.updated", { task });
    return this.state.task;
  }

  setQueueState(queue) {
    this.state.queue = queue && typeof queue === "object"
      ? JSON.parse(JSON.stringify(queue))
      : { schema: "hemlock.agent.queue.v1", active: null, pending: [], count: 0 };
    this.persist("task.queue.updated", { queue: this.state.queue });
    return this.state.queue;
  }

  source(sourceId) {
    return this.state.sources.find((item) => item.sourceId === sourceId) || null;
  }

  getSources() {
    return this.state.sources.map((source) => ({ ...source }));
  }

  setSourcePolicy(sourceId, patch = {}) {
    const current = this.source(sourceId);
    if (!current) throw new Error(`Hemlock source is not registered: ${sourceId}`);
    const allowed = ["enabled", "scope", "retention", "redactionRules", "permissionState"];
    const next = Object.fromEntries(allowed
      .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
      .map((key) => [key, patch[key]]));
    if (Object.prototype.hasOwnProperty.call(next, "enabled") && typeof next.enabled !== "boolean") {
      throw new Error("Source enabled state must be boolean.");
    }
    if (Object.prototype.hasOwnProperty.call(next, "redactionRules") && !Array.isArray(next.redactionRules)) {
      throw new Error("Source redactionRules must be an array.");
    }
    Object.assign(current, next, { lastPolicyChangedAt: nowIso() });
    this.persist("context.source.policy.updated", { sourceId, policy: current });
    return { schema: "hemlock.agent.source.policy.v1", status: "updated", source: { ...current } };
  }

  startOperation({ taskId, command, capability, payload = {}, descriptor = {} }) {
    const task = this.state.task || {};
    const budget = task.budget || {};
    const countable = descriptor.countsAgainstBudget !== false;
    const used = Number(budget.commandsUsed || 0);
    const maximum = Number(budget.maxCommands || 24);
    if (countable && used >= maximum) {
      const error = new Error(`Hemlock command budget exhausted (${used}/${maximum}).`);
      error.code = "COMMAND_BUDGET_EXHAUSTED";
      throw error;
    }
    const isTraining = capability === "train";
    const trainingUsed = Number(budget.trainingCyclesUsed || 0);
    const trainingMaximum = Number(budget.maxTrainingCycles || 1);
    if (isTraining && trainingUsed >= trainingMaximum) {
      const error = new Error(`Hemlock training-cycle budget exhausted (${trainingUsed}/${trainingMaximum}).`);
      error.code = "TRAINING_BUDGET_EXHAUSTED";
      throw error;
    }
    const operationId = `op-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const operation = {
      schema: "hemlock.agent.operation.v1",
      id: operationId,
      taskId: taskId || task.id || null,
      parentOperationId: descriptor.parentOperationId || null,
      command,
      capability: capability || "read",
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      timeoutMs: descriptor.timeoutMs || null,
      cancellation: { requested: false, at: null },
      budget: { counted: countable, usedBefore: used, maximum },
      inputDigest: digest(JSON.stringify(payload)),
      outputDigest: null,
      evidenceRefs: [],
      reversible: descriptor.reversible === true,
      approval: descriptor.approval || "none",
    };
    this.state.operations = [...this.state.operations.filter((item) => item.status === "running" || item.id !== operationId), operation].slice(-80);
    if (countable) this.state.task = {
      ...task,
      budget: {
        ...budget,
        commandsUsed: used + 1,
        ...(isTraining ? { trainingCyclesUsed: trainingUsed + 1 } : {}),
      },
    };
    this.persist("operation.started", { operation });
    return operation;
  }

  finishOperation(operationId, { status, result, evidenceRefs = [], error = null } = {}) {
    const operation = this.state.operations.find((item) => item.id === operationId);
    if (!operation) return null;
    if (["cancelled", "completed", "failed", "blocked"].includes(operation.status)) return operation;
    operation.status = status || (error ? "failed" : "completed");
    operation.finishedAt = nowIso();
    operation.outputDigest = result == null ? null : digest(JSON.stringify(result));
    operation.evidenceRefs = evidenceRefs;
    if (error) operation.error = error;
    this.persist("operation.finished", { operation });
    return operation;
  }

  createPlan(plan) {
    if (!plan?.id) throw new Error("A durable plan needs an id.");
    const existing = this.state.plans.find((item) => item.id === plan.id);
    if (existing) return existing;
    this.state.plans = [...this.state.plans, { ...plan }].slice(-40);
    this.persist("plan.proposed", { plan });
    return plan;
  }

  transitionPlan(planId, transition, patch = {}) {
    const plan = this.state.plans.find((item) => item.id === planId);
    if (!plan) throw new Error(`Hemlock plan was not found: ${planId}`);
    const statuses = { approve: "approved", reject: "rejected", complete: "completed", block: "blocked" };
    if (!statuses[transition]) throw new Error(`Unsupported plan transition: ${transition}`);
    if (["approved", "rejected", "completed", "blocked"].includes(plan.status) && plan.status !== statuses[transition]) return plan;
    plan.status = statuses[transition];
    Object.assign(plan, patch);
    if (transition === "approve") plan.approvedAt = nowIso();
    if (transition === "reject") {
      plan.rejectedAt = nowIso();
      plan.rejectionReason = patch.reason || plan.rejectionReason || null;
    }
    this.persist(`plan.${transition}d`, { plan });
    return plan;
  }

  createAction(action) {
    if (!action?.id) throw new Error("A durable action needs an id.");
    const existing = this.state.actions.find((item) => item.id === action.id);
    if (existing) return existing;
    this.state.actions = [...this.state.actions, { ...action }].slice(-120);
    this.persist("action.proposed", { action });
    return action;
  }

  transitionAction(actionId, transition, patch = {}) {
    const action = this.state.actions.find((item) => item.id === actionId);
    if (!action) throw new Error(`Hemlock action was not found: ${actionId}`);
    const statuses = {
      validate: "validated",
      start: "running",
      complete: "completed",
      fail: "failed",
      block: "blocked",
      cancel: "cancelled",
      reject: "rejected",
    };
    if (!statuses[transition]) throw new Error(`Unsupported action transition: ${transition}`);
    if (["completed", "failed", "blocked", "cancelled", "rejected"].includes(action.status) && action.status !== statuses[transition]) return action;
    action.status = statuses[transition];
    Object.assign(action, patch);
    const stamp = nowIso();
    if (transition === "validate") action.validatedAt = stamp;
    if (transition === "start") action.startedAt = stamp;
    if (["complete", "fail", "block", "cancel", "reject"].includes(transition)) action.completedAt = stamp;
    this.persist(`action.${transition}d`, { action });
    return action;
  }

  recordObservation(observation) {
    if (!observation?.id) throw new Error("A durable observation needs an id.");
    const existing = this.state.observations.find((item) => item.id === observation.id);
    if (existing) return existing;
    this.state.observations = [...this.state.observations, { ...observation }].slice(-120);
    this.persist("observation.recorded", { observation });
    return observation;
  }

  appendEpisodeEvent(taskId, event) {
    const existingForTask = this.state.episodes.find((item) => item.taskId === (taskId || this.state.task?.id));
    const id = String(event?.id || existingForTask?.id || `episode-${taskId || this.state.task?.id || Date.now()}`);
    const current = this.state.episodes.find((item) => item.id === id) || {
      schema: "hemlock.agent.episode.v1",
      id,
      taskId: taskId || this.state.task?.id || null,
      objective: this.state.task?.objective || "Hemlock task",
      intent: this.state.task?.intent || "conversation",
      actions: [],
      observations: [],
      userCorrections: [],
      verificationReceipts: [],
      changeSetRefs: [],
      outcome: "running",
      candidateLessons: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (event.action) current.actions = [...current.actions, event.action].slice(-24);
    if (event.observation) current.observations = [...current.observations, event.observation].slice(-24);
    if (event.userCorrection) current.userCorrections = [...current.userCorrections, event.userCorrection].slice(-12);
    if (event.verificationReceipt) current.verificationReceipts = [...current.verificationReceipts, event.verificationReceipt].slice(-12);
    if (event.changeSetRef) current.changeSetRefs = [...current.changeSetRefs, event.changeSetRef].slice(-8);
    if (event.candidateLesson) current.candidateLessons = [...current.candidateLessons, event.candidateLesson].slice(-8);
    if (event.outcome) current.outcome = event.outcome;
    current.updatedAt = nowIso();
    this.state.episodes = [...this.state.episodes.filter((item) => item.id !== id), current].slice(-40);
    this.persist("episode.updated", { episode: current });
    return current;
  }

  getTaskHistory(taskId = this.state.task?.id) {
    const taskOperations = this.state.operations.filter((item) => item.taskId === taskId);
    const taskActionIds = new Set(this.state.actions.filter((item) => item.taskId === taskId).map((item) => item.observationId).filter(Boolean));
    return {
      plans: this.state.plans.filter((item) => item.taskId === taskId),
      actions: this.state.actions.filter((item) => item.taskId === taskId),
      observations: this.state.observations.filter((item) => taskActionIds.has(item.id) || (item.operationId && taskOperations.some((op) => op.id === item.operationId))),
      operations: taskOperations,
      episodes: this.state.episodes.filter((item) => item.taskId === taskId),
    };
  }

  cancelOperations(taskId) {
    const updated = [];
    for (const operation of this.state.operations) {
      if (operation.taskId !== taskId || !["running", "waiting_for_approval"].includes(operation.status)) continue;
      operation.status = "cancelled";
      operation.finishedAt = nowIso();
      operation.cancellation = { requested: true, at: operation.finishedAt };
      updated.push(operation.id);
    }
    if (updated.length) this.persist("operation.cancelled", { taskId, operationIds: updated });
    return updated;
  }

  createCandidate(input = {}) {
    const title = String(input.title || "Hemlock observation").trim();
    const summary = String(input.summary || input.body || "").trim();
    if (!summary) throw new Error("A Hemlock candidate needs a summary.");
    const fingerprint = digest(`${input.sourceId || "unknown"}:${title}:${summary}`).slice(0, 20);
    const existing = this.state.candidates.find((item) => item.fingerprint === fingerprint && !["dismissed", "converted"].includes(item.status));
    if (existing) return existing;
    const candidate = {
      schema: "hemlock.agent.candidate.v1",
      id: `candidate-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      fingerprint,
      kind: input.kind || "observation",
      title,
      summary,
      sourceId: input.sourceId || "local-project",
      sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs : [],
      reason: String(input.reason || "Surfaced for review").trim(),
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.5,
      verifyBeforeUse: input.verifyBeforeUse !== false,
      status: "candidate",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      acceptedAt: null,
      dismissedAt: null,
    };
    this.state.candidates = [...this.state.candidates, candidate].slice(-120);
    this.persist("candidate.created", { candidate });
    return candidate;
  }

  transitionCandidate(candidateId, transition) {
    const candidate = this.state.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`Hemlock candidate was not found: ${candidateId}`);
    const allowed = { accept: "accepted", dismiss: "dismissed", snooze: "snoozed", convert: "converted" };
    if (!allowed[transition]) throw new Error(`Unsupported candidate transition: ${transition}`);
    candidate.status = allowed[transition];
    candidate.updatedAt = nowIso();
    if (transition === "accept") candidate.acceptedAt = candidate.updatedAt;
    if (transition === "dismiss") candidate.dismissedAt = candidate.updatedAt;
    this.persist("candidate.transitioned", { candidateId, transition, candidate });
    return candidate;
  }

  ingestEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "context.quality.updated") {
      this.state.contextQuality = event.payload?.quality || null;
      const providers = event.payload?.providers || [];
      for (const provider of providers) {
        const source = this.source(provider.id);
        if (source) Object.assign(source, { freshness: provider.status, lastObservedAt: provider.lastUpdatedAt || nowIso() });
      }
    }
    if (event.type === "memory.candidate.created") this.state.memory.candidates += 1;
    if (event.type === "memory.promoted") this.state.memory.promoted += 1;
    if (event.type.startsWith("memory.")) this.state.memory.lastUpdatedAt = event.createdAt || nowIso();
    if (event.type === "dream.started") this.state.training = { ...this.state.training, status: "training", lastRunId: event.payload?.runId || null };
    if (event.type === "dream.completed") this.state.training = { ...this.state.training, status: "candidate", candidatePath: event.payload?.adapterPath || null, lastRunId: event.payload?.runId || this.state.training.lastRunId };
    if (event.type === "dream.failed") this.state.training = { ...this.state.training, status: "failed", lastRunId: event.payload?.runId || this.state.training.lastRunId };
    if (event.type === "sips.cycle.completed") this.state.training = { ...this.state.training, status: event.status === "passed" ? "candidate" : "blocked", lastRunId: event.payload?.runId || this.state.training.lastRunId };
    if (event.type === "conversation.episode.completed" && event.payload?.episode) {
      this.state.episodes = [...this.state.episodes.filter((item) => item.id !== event.payload.episode.id), event.payload.episode].slice(-40);
    }
    this.state.updatedAt = event.createdAt || nowIso();
    writeJson(this.statePath, this.state);
  }

  getProjection() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

module.exports = { AgentKernel, digest };
