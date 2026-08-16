const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const THREAD_SCHEMA = "hemlock.agent.thread.v1";
const PROJECT_SCHEMA = "hemlock.agent.project.v1";
const CHECKPOINT_SCHEMA = "hemlock.agent.checkpoint.v1";
const SUGGESTION_SCHEMA = "hemlock.agent.suggestion.v1";
const DEFAULT_PROVIDER_CAPS = Object.freeze({ maple: 1, codex: 2, claude: 2 });
const TERMINAL_THREAD_STATUSES = new Set(["completed", "cancelled", "archived"]);
const RUNNING_THREAD_STATUSES = new Set(["accepted", "planning", "running", "verifying", "repairing"]);

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function resolveExistingDirectory(value, label = "workspace directory") {
  const requested = String(value || "").trim();
  if (!requested) throw new Error(`A ${label} is required.`);
  const absolute = path.resolve(requested);
  let stats;
  try { stats = fs.statSync(absolute); } catch { throw new Error(`The ${label} does not exist: ${absolute}`); }
  if (!stats.isDirectory()) throw new Error(`The ${label} must be a directory: ${absolute}`);
  try { return fs.realpathSync.native(absolute); } catch { return absolute; }
}

function pathWithin(root, target) {
  const canonicalize = (value) => {
    const absolute = path.resolve(value);
    let existing = absolute;
    while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
    let canonicalExisting = existing;
    try { canonicalExisting = fs.realpathSync.native(existing); } catch { /* compare the best available path */ }
    return path.join(canonicalExisting, path.relative(existing, absolute));
  };
  const relative = path.relative(canonicalize(root), canonicalize(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function workspaceFingerprint(root, { maxFiles = 2400 } = {}) {
  const absolute = resolveExistingDirectory(root);
  const rows = [];
  const ignored = new Set([".git", "node_modules", "dist", "build", ".cache", ".next", "coverage", ".hemlock"]);
  const visit = (directory, relative = "") => {
    if (rows.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (rows.length >= maxFiles || ignored.has(entry.name)) continue;
      const absoluteEntry = path.join(directory, entry.name);
      const relativeEntry = path.join(relative, entry.name);
      try {
        const stats = fs.statSync(absoluteEntry);
        if (stats.isDirectory()) visit(absoluteEntry, relativeEntry);
        else if (stats.isFile()) rows.push(`${relativeEntry}:${stats.size}:${Math.round(stats.mtimeMs)}`);
      } catch {
        rows.push(`${relativeEntry}:unreadable`);
      }
    }
  };
  visit(absolute);
  return digest(`${absolute}\n${rows.join("\n")}`);
}

function normalizeProvider(provider) {
  return ["maple", "codex", "claude"].includes(String(provider)) ? String(provider) : "maple";
}

function normalizeThread(input = {}, { projectId = null } = {}) {
  const now = nowIso();
  return {
    schema: THREAD_SCHEMA,
    id: String(input.id || id("thread")),
    projectId: input.projectId || projectId,
    title: String(input.title || input.objective || "New Hemlock thread").trim().slice(0, 160),
    workspaceRoot: input.workspaceRoot || null,
    provider: normalizeProvider(input.provider),
    model: input.model || null,
    reasoning: input.reasoning || null,
    autonomy: input.autonomy || "bounded-local",
    status: input.status || "ready",
    phase: input.phase || "conversation",
    taskId: input.taskId || null,
    activePlanId: input.activePlanId || null,
    activeActionId: input.activeActionId || null,
    checkpointId: input.checkpointId || null,
    conversationRef: input.conversationRef || null,
    taskSnapshot: input.taskSnapshot || null,
    blockedReason: input.blockedReason || null,
    evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [],
    suggestions: Array.isArray(input.suggestions) ? input.suggestions : [],
    metrics: {
      inferenceCalls: 0,
      providerWaitMs: 0,
      repairCalls: 0,
      verificationRuns: 0,
      artifactRevisionCount: 0,
      ...input.metrics,
    },
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastOpenedAt: input.lastOpenedAt || null,
    archivedAt: input.archivedAt || null,
  };
}

class ThreadManager {
  constructor({ root, defaultWorkspaceRoot, providerCaps = {} } = {}) {
    if (!root) throw new Error("ThreadManager needs a runtime root.");
    this.root = path.resolve(root);
    this.registryPath = path.join(this.root, "threads", "registry.json");
    this.checkpointRoot = path.join(this.root, "threads", "checkpoints");
    this.conversationRoot = path.join(this.root, "threads", "conversations");
    this.suggestionRoot = path.join(this.root, "threads", "suggestions");
    this.leaseRoot = path.join(this.root, "threads", "leases");
    this.providerCaps = { ...DEFAULT_PROVIDER_CAPS, ...providerCaps };
    this.waiters = new Map();
    this.activeProviders = new Map();
    this.activeWriters = new Map();
    this.providerWaitStarted = new Map();
    this.defaultWorkspaceRoot = defaultWorkspaceRoot ? resolveExistingDirectory(defaultWorkspaceRoot) : null;
    const stored = readJson(this.registryPath, null);
    this.state = stored?.schema === "hemlock.agent.thread.registry.v1"
      ? stored
      : { schema: "hemlock.agent.thread.registry.v1", projects: [], threads: [], activeThreadId: null, providerCaps: this.providerCaps, updatedAt: nowIso() };
    this.state.projects = Array.isArray(this.state.projects) ? this.state.projects : [];
    this.state.threads = Array.isArray(this.state.threads) ? this.state.threads : [];
    this.state.providerCaps = { ...DEFAULT_PROVIDER_CAPS, ...this.state.providerCaps, ...providerCaps };
    this.providerCaps = this.state.providerCaps;
    this.recoverLeases();
    this.persist();
  }

  persist() {
    this.state.updatedAt = nowIso();
    writeJson(this.registryPath, this.state);
    return this.state;
  }

  snapshot() {
    return {
      schema: "hemlock.agent.thread.registry.v1",
      projects: this.state.projects.map((item) => ({ ...item })),
      threads: this.state.threads.map((item) => ({ ...item, evidenceRefs: [...(item.evidenceRefs || [])], suggestions: [...(item.suggestions || [])] })),
      activeThreadId: this.state.activeThreadId,
      providerCaps: { ...this.providerCaps },
      providerActive: Object.fromEntries([...this.activeProviders.entries()].map(([provider, entries]) => [provider, [...entries]])),
      writerLocks: Object.fromEntries([...this.activeWriters.entries()].map(([root, entry]) => [root, { ...entry }])),
    };
  }

  setProviderCaps(patch = {}) {
    const next = { ...this.providerCaps };
    for (const provider of ["maple", "codex", "claude"]) {
      if (!Object.prototype.hasOwnProperty.call(patch, provider)) continue;
      const value = Number(patch[provider]);
      if (!Number.isInteger(value) || value < 1 || value > 8) {
        const error = new Error(`Provider capacity for ${provider} must be an integer from 1 to 8.`);
        error.code = "PROVIDER_CAPACITY_INVALID";
        throw error;
      }
      next[provider] = value;
    }
    this.providerCaps = next;
    this.state.providerCaps = { ...next };
    this.persist();
    return { ...next };
  }

  project(projectId) {
    return this.state.projects.find((item) => item.id === projectId) || null;
  }

  thread(threadId = this.state.activeThreadId) {
    return this.state.threads.find((item) => item.id === threadId) || null;
  }

  registerProject({ projectId, displayName, workspaceRoot } = {}) {
    const root = resolveExistingDirectory(workspaceRoot || this.defaultWorkspaceRoot, "project directory");
    const existing = projectId ? this.project(projectId) : this.state.projects.find((item) => item.workspaceRoot === root);
    if (existing) {
      existing.displayName = String(displayName || existing.displayName || path.basename(root)).slice(0, 160);
      existing.workspaceRoot = root;
      existing.rootDigest = workspaceFingerprint(root);
      existing.lastOpenedAt = nowIso();
      this.persist();
      return { ...existing };
    }
    const project = {
      schema: PROJECT_SCHEMA,
      id: String(projectId || id("project")),
      displayName: String(displayName || path.basename(root) || "Hemlock project").slice(0, 160),
      workspaceRoot: root,
      rootDigest: workspaceFingerprint(root),
      lastOpenedAt: nowIso(),
      lastContextRefreshAt: null,
      enabledSources: [],
      projectBrief: null,
      activeThreadId: null,
      createdAt: nowIso(),
    };
    this.state.projects.push(project);
    this.persist();
    return { ...project };
  }

  ensureDefaultThread({ workspaceRoot = this.defaultWorkspaceRoot, task = null } = {}) {
    if (!workspaceRoot) return null;
    const project = this.registerProject({ workspaceRoot, displayName: path.basename(workspaceRoot) });
    const existing = this.state.threads.find((item) => item.projectId === project.id && item.id === "thread-default");
    if (existing) {
      this.state.activeThreadId ||= existing.id;
      this.persist();
      return { ...existing };
    }
    const thread = normalizeThread({ id: "thread-default", title: task?.objective || `${project.displayName} workspace`, workspaceRoot: project.workspaceRoot, taskId: task?.id || null, status: task?.status || "ready", phase: task?.phase || "conversation", provider: task?.provider || "maple", model: task?.model || null, reasoning: task?.reasoning || null }, { projectId: project.id });
    this.state.threads.push(thread);
    project.activeThreadId = thread.id;
    this.state.activeThreadId ||= thread.id;
    this.persist();
    return { ...thread };
  }

  createThread(input = {}) {
    const project = input.projectId ? this.project(input.projectId) : this.registerProject({ displayName: input.projectName, workspaceRoot: input.workspaceRoot });
    if (!project) throw new Error("A project directory is required before creating a repository thread.");
    const root = resolveExistingDirectory(input.workspaceRoot || project.workspaceRoot, "thread workspace directory");
    if (!pathWithin(project.workspaceRoot, root) && !pathWithin(root, project.workspaceRoot)) throw new Error("A thread workspace must stay within its selected project directory.");
    const thread = normalizeThread({ ...input, projectId: project.id, workspaceRoot: root });
    this.state.threads.push(thread);
    project.activeThreadId = thread.id;
    this.state.activeThreadId = thread.id;
    this.persist();
    this.checkpoint(thread.id, { phase: "conversation", status: "ready", reason: "thread-created" });
    return { ...thread };
  }

  updateThread(threadId, patch = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const allowed = ["title", "provider", "model", "reasoning", "autonomy", "status", "phase", "taskId", "activePlanId", "activeActionId", "checkpointId", "taskSnapshot", "blockedReason", "evidenceRefs", "suggestions", "metrics", "conversationRef", "lastOpenedAt", "archivedAt"];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) thread[key] = patch[key];
    thread.updatedAt = nowIso();
    this.persist();
    return { ...thread };
  }

  switchThread(threadId) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (thread.status === "archived") throw new Error("Archived threads must be restored before they can be selected.");
    this.state.activeThreadId = thread.id;
    thread.lastOpenedAt = nowIso();
    const project = this.project(thread.projectId);
    if (project) project.activeThreadId = thread.id;
    this.persist();
    return { ...thread };
  }

  pauseThread(threadId, reason = "Paused by user") {
    return this.updateThread(threadId, { status: "paused", phase: "paused", blockedReason: reason });
  }

  resumeThread(threadId) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (TERMINAL_THREAD_STATUSES.has(thread.status)) throw new Error(`The thread is terminal: ${thread.status}.`);
    const checkpoint = this.latestCheckpoint(threadId);
    const currentDigest = workspaceFingerprint(thread.workspaceRoot);
    if (checkpoint?.currentWorkspaceDigest && checkpoint.currentWorkspaceDigest !== currentDigest) {
      const error = new Error("The workspace changed while this thread was paused; Hemlock needs a fresh inspection before resuming.");
      error.code = "WORKSPACE_DRIFT";
      throw error;
    }
    return this.updateThread(threadId, { status: checkpoint?.status === "blocked" ? "blocked" : "running", phase: checkpoint?.phase || "executing", blockedReason: null });
  }

  archiveThread(threadId) {
    return this.updateThread(threadId, { status: "archived", phase: "archived", archivedAt: nowIso() });
  }

  cancelThread(threadId) {
    return this.updateThread(threadId, { status: "cancelled", phase: "cancelled" });
  }

  checkpoint(threadId, fields = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const checkpoint = {
      schema: CHECKPOINT_SCHEMA,
      id: id("checkpoint"),
      threadId,
      taskId: fields.taskId || thread.taskId || null,
      projectId: fields.projectId || thread.projectId || null,
      workspaceRoot: fields.workspaceRoot || thread.workspaceRoot || null,
      provider: fields.provider || thread.provider,
      model: fields.model ?? thread.model,
      reasoning: fields.reasoning ?? thread.reasoning,
      phase: fields.phase || thread.phase,
      status: fields.status || thread.status,
      activePlanStep: fields.activePlanStep ?? null,
      pendingAction: fields.pendingAction || null,
      completedCommandSummaries: Array.isArray(fields.completedCommandSummaries) ? fields.completedCommandSummaries.slice(-16) : [],
      evidenceRefs: Array.isArray(fields.evidenceRefs) ? fields.evidenceRefs.slice(-32) : [],
      currentWorkspaceDigest: fields.currentWorkspaceDigest || (thread.workspaceRoot ? workspaceFingerprint(thread.workspaceRoot) : null),
      lastGoodRevision: fields.lastGoodRevision ?? null,
      artifactRepair: fields.artifactRepair || null,
      verificationIssues: Array.isArray(fields.verificationIssues) ? fields.verificationIssues.slice(-16) : [],
      autonomyPolicy: fields.autonomyPolicy || thread.autonomy,
      reason: fields.reason || null,
      createdAt: nowIso(),
    };
    writeJson(path.join(this.checkpointRoot, threadId, `${checkpoint.id}.json`), checkpoint);
    this.updateThread(threadId, { checkpointId: checkpoint.id, phase: checkpoint.phase, status: checkpoint.status, evidenceRefs: checkpoint.evidenceRefs });
    return checkpoint;
  }

  checkpoints(threadId) {
    const directory = path.join(this.checkpointRoot, threadId);
    try {
      return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => readJson(path.join(directory, name), null)).filter(Boolean);
    } catch { return []; }
  }

  latestCheckpoint(threadId) {
    return this.checkpoints(threadId).at(-1) || null;
  }

  appendConversation(threadId, message = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const conversationPath = thread.conversationRef || path.join(this.conversationRoot, `${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
    const entry = { id: String(message.id || id("message")), threadId, role: ["user", "assistant", "system"].includes(message.role) ? message.role : "assistant", content: String(message.content || "").slice(0, 12000), channels: Array.isArray(message.channels) ? message.channels.slice(0, 12) : [], provider: message.provider || thread.provider, model: message.model ?? thread.model, reasoning: message.reasoning ?? thread.reasoning, createdAt: message.createdAt || nowIso(), rawOutputRef: message.rawOutputRef || null };
    fs.appendFileSync(conversationPath, `${JSON.stringify(entry)}\n`, "utf8");
    if (thread.conversationRef !== conversationPath) this.updateThread(threadId, { conversationRef: conversationPath });
    return entry;
  }

  readConversation(threadId, { limit = 80 } = {}) {
    const thread = this.thread(threadId);
    if (!thread?.conversationRef) return [];
    try {
      return fs.readFileSync(thread.conversationRef, "utf8").split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit)).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch { return []; }
  }

  createSuggestion(input = {}) {
    const thread = input.threadId ? this.thread(input.threadId) : null;
    const suggestion = {
      schema: SUGGESTION_SCHEMA,
      suggestionId: String(input.suggestionId || id("suggestion")),
      threadId: input.threadId || null,
      projectId: input.projectId || thread?.projectId || null,
      kind: String(input.kind || "next-action"),
      title: String(input.title || "Hemlock has a suggested next step").slice(0, 160),
      summary: String(input.summary || "Review the evidence-backed next action.").slice(0, 1000),
      reason: String(input.reason || "A local task event produced this suggestion.").slice(0, 1000),
      evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.slice(0, 16) : [],
      recommendedAction: input.recommendedAction || null,
      status: "unread",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJson(path.join(this.suggestionRoot, suggestion.suggestionId + ".json"), suggestion);
    if (thread) thread.suggestions = [...(thread.suggestions || []), suggestion.suggestionId].slice(-32);
    this.persist();
    return suggestion;
  }

  listSuggestions({ threadId, status } = {}) {
    let entries = [];
    try {
      entries = fs.readdirSync(this.suggestionRoot).filter((name) => name.endsWith(".json")).sort().map((name) => readJson(path.join(this.suggestionRoot, name), null)).filter(Boolean);
    } catch { entries = []; }
    return entries.filter((item) => (!threadId || item.threadId === threadId) && (!status || item.status === status));
  }

  transitionSuggestion(suggestionId, status) {
    const filePath = path.join(this.suggestionRoot, `${suggestionId}.json`);
    const suggestion = readJson(filePath, null);
    if (!suggestion) throw new Error(`Hemlock suggestion was not found: ${suggestionId}`);
    if (!["unread", "accepted", "dismissed", "snoozed"].includes(status)) throw new Error(`Unsupported suggestion status: ${status}`);
    suggestion.status = status;
    suggestion.updatedAt = nowIso();
    writeJson(filePath, suggestion);
    this.persist();
    return suggestion;
  }

  acquireProvider(provider, threadId) {
    const lane = normalizeProvider(provider);
    const active = this.activeProviders.get(lane) || new Set();
    const cap = Math.max(1, Number(this.providerCaps[lane] || 1));
    if (active.size < cap) {
      active.add(threadId);
      this.activeProviders.set(lane, active);
      return Promise.resolve({ provider: lane, threadId, queuedMs: 0, release: () => this.releaseProvider(lane, threadId) });
    }
    return new Promise((resolve) => {
      const queue = this.waiters.get(lane) || [];
      queue.push({ threadId, resolve, startedAt: Date.now() });
      this.waiters.set(lane, queue);
    });
  }

  releaseProvider(provider, threadId) {
    const lane = normalizeProvider(provider);
    const active = this.activeProviders.get(lane) || new Set();
    active.delete(threadId);
    this.activeProviders.set(lane, active);
    const queue = this.waiters.get(lane) || [];
    const next = queue.shift();
    if (next) {
      active.add(next.threadId);
      this.activeProviders.set(lane, active);
      next.resolve({ provider: lane, threadId: next.threadId, queuedMs: Date.now() - next.startedAt, release: () => this.releaseProvider(lane, next.threadId) });
    }
    if (!queue.length) this.waiters.delete(lane);
    return true;
  }

  async withProvider(provider, threadId, operation) {
    const lease = await this.acquireProvider(provider, threadId);
    try { return await operation(lease); } finally { lease.release(); }
  }

  acquireWriter(threadId, workspaceRoot) {
    const root = resolveExistingDirectory(workspaceRoot, "thread workspace directory");
    const existing = this.activeWriters.get(root);
    if (existing && existing.threadId !== threadId) {
      const error = new Error(`The workspace is already being mutated by thread ${existing.threadId}.`);
      error.code = "WORKSPACE_BUSY";
      error.workspaceRoot = root;
      error.ownerThreadId = existing.threadId;
      throw error;
    }
    const entry = { threadId, workspaceRoot: root, acquiredAt: nowIso(), pid: process.pid };
    this.activeWriters.set(root, entry);
    writeJson(path.join(this.leaseRoot, `${digest(root)}.json`), entry);
    return { ...entry, release: () => this.releaseWriter(threadId, root) };
  }

  releaseWriter(threadId, workspaceRoot) {
    const root = resolveExistingDirectory(workspaceRoot, "thread workspace directory");
    const entry = this.activeWriters.get(root);
    if (!entry || entry.threadId !== threadId) return false;
    this.activeWriters.delete(root);
    try { fs.rmSync(path.join(this.leaseRoot, `${digest(root)}.json`), { force: true }); } catch { /* best effort cleanup */ }
    return true;
  }

  recoverLeases() {
    try {
      for (const name of fs.readdirSync(this.leaseRoot)) {
        if (name.endsWith(".json")) fs.rmSync(path.join(this.leaseRoot, name), { force: true });
      }
    } catch { /* no stale lease directory yet */ }
  }

  assertScopedPath(threadId, targetPath, { allowMissing = true } = {}) {
    const thread = this.thread(threadId);
    if (!thread?.workspaceRoot) throw new Error("The thread has no assigned workspace directory.");
    const absolute = path.resolve(targetPath);
    if (!pathWithin(thread.workspaceRoot, absolute)) {
      const error = new Error(`Path is outside the assigned thread workspace: ${absolute}`);
      error.code = "WORKSPACE_SCOPE";
      throw error;
    }
    if (!allowMissing && !fs.existsSync(absolute)) throw new Error(`Scoped path does not exist: ${absolute}`);
    return absolute;
  }
}

module.exports = {
  CHECKPOINT_SCHEMA,
  DEFAULT_PROVIDER_CAPS,
  PROJECT_SCHEMA,
  SUGGESTION_SCHEMA,
  THREAD_SCHEMA,
  TERMINAL_THREAD_STATUSES,
  RUNNING_THREAD_STATUSES,
  ThreadManager,
  digest,
  pathWithin,
  resolveExistingDirectory,
  workspaceFingerprint,
};
