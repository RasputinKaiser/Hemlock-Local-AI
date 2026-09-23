const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { appendJsonlLine, quarantineCorruptFile, readJsonFile: readJsonDurable, readJsonlFile, writeFileAtomic, writeJsonAtomic } = require("./durable_io.cjs");

const THREAD_SCHEMA = "hemlock.agent.thread.v1";
const PROJECT_SCHEMA = "hemlock.agent.project.v1";
const CHECKPOINT_SCHEMA = "hemlock.agent.checkpoint.v1";
const SUGGESTION_SCHEMA = "hemlock.agent.suggestion.v1";
const DEFAULT_PROVIDER_CAPS = Object.freeze({ maple: 1, codex: 2, claude: 2 });
const TERMINAL_THREAD_STATUSES = new Set(["completed", "cancelled", "archived"]);
const RUNNING_THREAD_STATUSES = new Set(["accepted", "planning", "running", "verifying", "repairing"]);
// Statuses that claim live work; a thread left in one of these after a switch
// or delete would advertise a run that nothing is performing.
const PARKABLE_THREAD_STATUSES = new Set([...RUNNING_THREAD_STATUSES, "waiting_for_approval", "waiting_for_user"]);

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function writeJson(filePath, value) {
  // Temp + fsync + rename (durable_io): a crash mid-write must not leave a
  // truncated registry, checkpoint, suggestion, or lease file behind.
  writeJsonAtomic(filePath, value);
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
    taskHistory: Array.isArray(input.taskHistory) ? input.taskHistory.slice(-32) : [],
    activePlanId: input.activePlanId || null,
    activeActionId: input.activeActionId || null,
    checkpointId: input.checkpointId || null,
    conversationRef: input.conversationRef || null,
    forkedFrom: input.forkedFrom || null,
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
  constructor({ root, defaultWorkspaceRoot, providerCaps = {}, onIntegrity = null } = {}) {
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
    this.onIntegrity = typeof onIntegrity === "function" ? onIntegrity : null;
    this._integrityNoted = new Set();
    this.defaultWorkspaceRoot = defaultWorkspaceRoot ? resolveExistingDirectory(defaultWorkspaceRoot) : null;
    // Validate-on-read: an unparseable registry is quarantined and the rotated
    // .bak (written by persist()) is used as the last-good copy; wrong-shape
    // JSON that still parses falls through to the quarantine below.
    let stored = readJsonDurable(this.registryPath, null, {
      label: "threads-registry",
      backupPath: `${this.registryPath}.bak`,
      onIntegrity: (recovery) => this._reportIntegrity(recovery),
    });
    if (stored?.schema !== "hemlock.agent.thread.registry.v1" && fs.existsSync(this.registryPath)) {
      // Parsed, but not as a registry. Quarantine so the failure is
      // inspectable instead of being silently overwritten.
      const quarantinePath = quarantineCorruptFile(this.registryPath);
      this._reportIntegrity({ file: this.registryPath, label: "threads-registry", reason: "unexpected-schema", recovered: "defaults", quarantinePath });
      stored = null;
    }
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

  // One integrity report per file+reason per manager lifetime — a corrupt
  // file that keeps being read must not spam the durable event journal.
  _reportIntegrity(recovery) {
    const key = `${recovery?.file || ""}|${recovery?.reason || ""}`;
    if (this._integrityNoted.has(key)) return;
    this._integrityNoted.add(key);
    if (!this.onIntegrity) return;
    try { this.onIntegrity(recovery); } catch { /* reporting never breaks recovery */ }
  }

  persist() {
    this.state.updatedAt = nowIso();
    writeJson(this.registryPath, this.state);
    // Rotate a copy of the just-written good registry aside; the constructor
    // falls back to it when the primary fails to parse.
    try { fs.copyFileSync(this.registryPath, `${this.registryPath}.bak`); } catch { /* backup is best-effort */ }
    return this.state;
  }

  snapshot() {
    return {
      schema: "hemlock.agent.thread.registry.v1",
      projects: this.state.projects.map((item) => ({ ...item })),
      threads: this.state.threads.map((item) => ({ ...item, evidenceRefs: [...(item.evidenceRefs || [])], suggestions: [...(item.suggestions || [])], taskHistory: [...(item.taskHistory || [])] })),
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
      if (existing.status === "archived") this.restoreThread(existing.id);
      this.state.activeThreadId ||= existing.id;
      this.persist();
      return { ...this.thread(existing.id) };
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
    this.parkForSwitch(thread.id);
    this.state.activeThreadId = thread.id;
    this.persist();
    this.checkpoint(thread.id, { phase: "conversation", status: "ready", reason: "thread-created" });
    return { ...thread };
  }

  updateThread(threadId, patch = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const allowed = ["title", "provider", "model", "reasoning", "autonomy", "status", "phase", "taskId", "taskHistory", "activePlanId", "activeActionId", "checkpointId", "taskSnapshot", "blockedReason", "evidenceRefs", "suggestions", "metrics", "conversationRef", "lastOpenedAt", "archivedAt"];
    // A thread hosts a sequence of tasks; when the pointer moves, record the
    // previous task so task→thread history survives the overwrite.
    if (Object.prototype.hasOwnProperty.call(patch, "taskId") && patch.taskId && thread.taskId && patch.taskId !== thread.taskId) {
      const history = Array.isArray(thread.taskHistory) ? thread.taskHistory : [];
      thread.taskHistory = [...history.filter((item) => item !== thread.taskId), thread.taskId].slice(-32);
    }
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) thread[key] = patch[key];
    thread.updatedAt = nowIso();
    this.persist();
    return { ...thread };
  }

  // Switching away mid-task must not leave durable state claiming live work:
  // an outgoing thread in a live status parks as "paused" (explicitly
  // resumable) behind a checkpoint that records where it stopped, and its
  // taskSnapshot is parked with it so a switch-back never resurrects "running".
  parkForSwitch(incomingThreadId) {
    const outgoing = this.thread(this.state.activeThreadId);
    if (!outgoing || outgoing.id === incomingThreadId) return;
    if (!PARKABLE_THREAD_STATUSES.has(outgoing.status)) return;
    try {
      this.checkpoint(outgoing.id, {
        taskId: outgoing.taskSnapshot?.id || outgoing.taskId,
        phase: "paused",
        status: "paused",
        reason: "thread-switched-away",
      });
    } catch { /* a missing workspace must not block the switch */ }
    const taskSnapshot = outgoing.taskSnapshot && typeof outgoing.taskSnapshot === "object"
      ? { ...outgoing.taskSnapshot, status: "paused", phase: "paused", blockedReason: outgoing.taskSnapshot.blockedReason || "Switched to another thread; resume it to continue." }
      : null;
    this.updateThread(outgoing.id, {
      status: "paused",
      phase: "paused",
      blockedReason: "Switched to another thread; resume it to continue.",
      ...(taskSnapshot ? { taskSnapshot } : {}),
    });
  }

  switchThread(threadId) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (thread.status === "archived") throw new Error("Archived threads must be restored before they can be selected.");
    this.parkForSwitch(thread.id);
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
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (thread.status === "archived") return { ...thread };
    try {
      this.checkpoint(threadId, { phase: "archived", status: "archived", reason: "thread-archived" });
    } catch { /* a missing workspace must not block the archive */ }
    const updated = this.updateThread(threadId, { status: "archived", phase: "archived", archivedAt: nowIso(), blockedReason: null });
    this.releaseThreadLeases(threadId, "archived");
    this.reassignActivePointers(threadId);
    return updated;
  }

  restoreThread(threadId) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (thread.status !== "archived") throw new Error(`Only archived threads can be restored (status: ${thread.status}).`);
    return this.updateThread(threadId, { status: "ready", phase: "conversation", archivedAt: null, blockedReason: null });
  }

  renameThread(threadId, title) {
    const next = String(title || "").trim().slice(0, 160);
    if (!next) throw new Error("A thread title is required.");
    return this.updateThread(threadId, { title: next });
  }

  // Fork is provenance, not history copy: a fresh thread that inherits the
  // source's workspace, provider lane, and autonomy policy, stamped with
  // forkedFrom plus a seed checkpoint and conversation note so the lineage is
  // inspectable later. The active thread never moves — the fork only joins
  // the registry listing.
  forkThread(threadId, { title } = {}) {
    const source = this.thread(threadId);
    if (!source) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const thread = normalizeThread({
      title: String(title || `Fork of ${source.title}`).trim() || `Fork of ${source.id}`,
      workspaceRoot: source.workspaceRoot,
      provider: source.provider,
      model: source.model,
      reasoning: source.reasoning,
      autonomy: source.autonomy,
      forkedFrom: source.id,
    }, { projectId: source.projectId });
    this.state.threads.push(thread);
    this.persist();
    this.checkpoint(thread.id, {
      phase: "conversation",
      status: "ready",
      reason: `thread-forked:${source.id}`,
      evidenceRefs: [`thread://${source.id}`],
    });
    this.appendConversation(thread.id, {
      role: "system",
      content: `Forked from ${source.id} (${source.title}) — provenance only; the earlier conversation stays with the source thread.`,
    });
    return { ...thread };
  }

  // Deleting a thread drops its registry entry plus every durable artifact the
  // manager owns for it: checkpoint files, the conversation log (and its reset
  // archives), and suggestions. Live work must be cancelled first unless the
  // caller forces it; provider waiters and writer leases are released either
  // way so nothing stays hung on a thread that no longer exists.
  deleteThread(threadId, { force = false } = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (!force && PARKABLE_THREAD_STATUSES.has(thread.status)) {
      const error = new Error("The thread still has live work; cancel it or pass force to delete anyway.");
      error.code = "THREAD_ACTIVE";
      throw error;
    }
    this.releaseThreadLeases(threadId);
    const files = [];
    try { fs.rmSync(path.join(this.checkpointRoot, threadId), { recursive: true, force: true }); } catch { /* best effort */ }
    const conversationPath = thread.conversationRef || path.join(this.conversationRoot, `${threadId}.jsonl`);
    try {
      const directory = path.dirname(conversationPath);
      const base = path.basename(conversationPath);
      for (const name of fs.readdirSync(directory)) {
        if (name === base || name.startsWith(`${base}.`)) files.push(path.join(directory, name));
      }
    } catch { /* the conversation directory may not exist yet */ }
    for (const suggestion of this.listSuggestions({ threadId })) {
      files.push(path.join(this.suggestionRoot, `${suggestion.suggestionId}.json`));
    }
    for (const file of files) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort cleanup */ }
    }
    this.state.threads = this.state.threads.filter((item) => item.id !== threadId);
    this.reassignActivePointers(threadId);
    this.persist();
    return { threadId, deleted: true, removedFiles: files.length };
  }

  // When a thread stops being selectable (archived or deleted), pointers that
  // still name it must move to the next usable thread or become null — never
  // dangle at a thread switchThread would reject.
  reassignActivePointers(excludedThreadId) {
    const pick = (projectId) => this.state.threads
      .filter((item) => item.id !== excludedThreadId && item.status !== "archived" && (!projectId || item.projectId === projectId))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
    let changed = false;
    if (this.state.activeThreadId === excludedThreadId) {
      this.state.activeThreadId = pick(null)?.id || null;
      changed = true;
    }
    for (const project of this.state.projects) {
      if (project.activeThreadId === excludedThreadId) {
        project.activeThreadId = pick(project.id)?.id || null;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  releaseThreadLeases(threadId, verb = "deleted") {
    for (const [root, entry] of [...this.activeWriters.entries()]) {
      if (entry.threadId !== threadId) continue;
      this.activeWriters.delete(root);
      try { fs.rmSync(path.join(this.leaseRoot, `${digest(root)}.json`), { force: true }); } catch { /* best effort cleanup */ }
    }
    for (const [lane, queue] of [...this.waiters.entries()]) {
      const remaining = [];
      for (const waiter of queue) {
        if (waiter.threadId === threadId) waiter.reject?.(new Error(`The owning thread was ${verb}: ${threadId}`));
        else remaining.push(waiter);
      }
      if (remaining.length) this.waiters.set(lane, remaining);
      else this.waiters.delete(lane);
    }
    for (const [lane, active] of [...this.activeProviders.entries()]) {
      if (active.has(threadId)) this.releaseProvider(lane, threadId);
    }
  }

  cancelThread(threadId) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const updated = this.updateThread(threadId, { status: "cancelled", phase: "cancelled" });
    this.releaseThreadLeases(threadId, "cancelled");
    return updated;
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
      blockedReason: fields.blockedReason || null,
      createdAt: nowIso(),
    };
    writeJson(path.join(this.checkpointRoot, threadId, `${checkpoint.id}.json`), checkpoint);
    this.updateThread(threadId, { checkpointId: checkpoint.id, phase: checkpoint.phase, status: checkpoint.status, evidenceRefs: checkpoint.evidenceRefs });
    return checkpoint;
  }

  checkpoints(threadId) {
    const directory = path.join(this.checkpointRoot, threadId);
    try {
      return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => readJsonDurable(path.join(directory, name), null, { label: "thread-checkpoint", onIntegrity: (recovery) => this._reportIntegrity(recovery) })).filter(Boolean);
    } catch { return []; }
  }

  latestCheckpoint(threadId) {
    return this.checkpoints(threadId).at(-1) || null;
  }

  // Bounded search over thread titles plus conversation bodies. Only the most
  // recently updated `scanLimit` threads are scanned so a large registry stays
  // cheap; results are capped at `limit`.
  searchThreads(query, { limit = 20, scanLimit = 12, conversationLimit = 200 } = {}) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return [];
    const ordered = [...this.state.threads].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const results = [];
    for (const thread of ordered.slice(0, Math.max(1, scanLimit))) {
      if (results.length >= limit) break;
      if (String(thread.title || "").toLowerCase().includes(needle)) {
        results.push({ threadId: thread.id, title: thread.title, matchedIn: "title", snippet: null });
        continue;
      }
      let hit = null;
      try {
        hit = this.readConversation(thread.id, { limit: conversationLimit }).find((message) => String(message.content || "").toLowerCase().includes(needle)) || null;
      } catch { hit = null; }
      if (hit) {
        const content = String(hit.content || "");
        const at = content.toLowerCase().indexOf(needle);
        const start = Math.max(0, at - 40);
        const end = Math.min(content.length, at + needle.length + 60);
        results.push({
          threadId: thread.id,
          title: thread.title,
          matchedIn: "conversation",
          snippet: `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`,
        });
      }
    }
    return results.slice(0, Math.max(1, limit));
  }

  // Roll a thread's durable working state back to a recorded checkpoint. The
  // conversation log itself is preserved; what rolls back is the resume point
  // (phase/status/evidence refs/plan and action pointers). A marker checkpoint
  // is written so the restored state becomes the resumption point.
  restoreCheckpoint(threadId, checkpointId) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (thread.status === "archived") throw new Error("Archived threads must be restored before a checkpoint rollback.");
    const restored = this.checkpoints(threadId).find((item) => item.id === checkpointId);
    if (!restored) throw new Error(`Hemlock checkpoint was not found for thread ${threadId}: ${checkpointId}`);
    // Never resurrect an in-flight or archived status from history: an active
    // run status would claim work is happening when nothing is, so it parks as
    // "paused" (explicitly resumable) instead.
    let status = restored.status;
    if (RUNNING_THREAD_STATUSES.has(status)) status = "paused";
    if (status === "archived") status = "ready";
    const updated = this.updateThread(threadId, {
      phase: restored.phase,
      status,
      checkpointId: restored.id,
      activePlanId: null,
      activeActionId: null,
      blockedReason: null,
    });
    const marker = this.checkpoint(threadId, {
      taskId: restored.taskId,
      phase: restored.phase,
      status,
      activePlanStep: restored.activePlanStep,
      evidenceRefs: restored.evidenceRefs,
      reason: `checkpoint-restored:${restored.id}`,
    });
    return { thread: this.thread(threadId) || updated, restoredCheckpoint: { ...restored }, checkpoint: marker };
  }

  appendConversation(threadId, message = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const conversationPath = thread.conversationRef || path.join(this.conversationRoot, `${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
    const entry = { id: String(message.id || id("message")), threadId, role: ["user", "assistant", "system"].includes(message.role) ? message.role : "assistant", content: String(message.content || "").slice(0, 12000), channels: Array.isArray(message.channels) ? message.channels.slice(0, 12) : [], provider: message.provider || thread.provider, model: message.model ?? thread.model, reasoning: message.reasoning ?? thread.reasoning, createdAt: message.createdAt || nowIso(), rawOutputRef: message.rawOutputRef || null, ...(message.partial ? { partial: true, stopReason: String(message.stopReason || "cancelled") } : {}) };
    // fsync'd append: a conversation line is durable before the call returns,
    // and a torn tail line is dropped by readConversation's per-line recovery.
    appendJsonlLine(conversationPath, entry);
    if (thread.conversationRef !== conversationPath) this.updateThread(threadId, { conversationRef: conversationPath });
    return entry;
  }

  // T8-F2: fresh context. Archives the existing conversation file next to the
  // original (timestamped) and clears it, keeping the thread identity so
  // checkpoints, artifacts, and receipts stay linked. The model's next prompt
  // starts from zero history — no more relitigating old refusals.
  resetConversation(threadId) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const conversationPath = thread.conversationRef || path.join(this.conversationRoot, `${threadId}.jsonl`);
    let archivedMessages = 0;
    let archivePath = null;
    if (fs.existsSync(conversationPath)) {
      const original = fs.readFileSync(conversationPath, "utf8");
      archivedMessages = original.split("\n").filter((line) => line.trim()).length;
      archivePath = `${conversationPath}.${Date.now()}-archive.jsonl`;
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      writeFileAtomic(archivePath, original);
      writeFileAtomic(conversationPath, "");
    }
    return { threadId, archivedMessages, archivePath };
  }

  readConversation(threadId, { limit = 80 } = {}) {
    const thread = this.thread(threadId);
    if (!thread?.conversationRef) return [];
    const { rows } = readJsonlFile(thread.conversationRef, {
      tail: Math.max(1, limit),
      label: "thread-conversation",
      onIntegrity: (recovery) => this._reportIntegrity(recovery),
    });
    return rows;
  }

  // Bounded tail trim: keeps the newest `keep` messages (bounded by
  // maxChars) and rewrites the log in place, archiving the dropped prefix
  // beside the original like resetConversation does. Used when a full
  // reset is too blunt — the thread keeps recent context while the oldest
  // history stops riding every prompt. Returns counts for the
  // context.compacted receipt.
  trimConversation(threadId, { keep = 24, maxChars = 48000 } = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    const conversationPath = thread.conversationRef || path.join(this.conversationRoot, `${threadId}.jsonl`);
    if (!fs.existsSync(conversationPath)) return { threadId, kept: 0, dropped: 0, archivePath: null };
    const lines = fs.readFileSync(conversationPath, "utf8").split(/\r?\n/).filter(Boolean);
    const kept = [];
    let chars = 0;
    for (let index = lines.length - 1; index >= 0 && kept.length < Math.max(1, keep); index -= 1) {
      if (kept.length && chars + lines[index].length > maxChars) break;
      chars += lines[index].length;
      kept.unshift(lines[index]);
    }
    const dropped = lines.length - kept.length;
    let archivePath = null;
    if (dropped > 0) {
      archivePath = `${conversationPath}.${Date.now()}-trim-archive.jsonl`;
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      writeFileAtomic(archivePath, `${lines.slice(0, dropped).join("\n")}\n`);
      writeFileAtomic(conversationPath, `${kept.join("\n")}\n`);
    }
    return { threadId, kept: kept.length, dropped, archivePath };
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
      entries = fs.readdirSync(this.suggestionRoot).filter((name) => name.endsWith(".json")).sort().map((name) => readJsonDurable(path.join(this.suggestionRoot, name), null, { label: "thread-suggestion", onIntegrity: (recovery) => this._reportIntegrity(recovery) })).filter(Boolean);
    } catch { entries = []; }
    return entries.filter((item) => (!threadId || item.threadId === threadId) && (!status || item.status === status));
  }

  transitionSuggestion(suggestionId, status) {
    const filePath = path.join(this.suggestionRoot, `${suggestionId}.json`);
    const suggestion = readJsonDurable(filePath, null, { label: "thread-suggestion", onIntegrity: (recovery) => this._reportIntegrity(recovery) });
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
    return new Promise((resolve, reject) => {
      const queue = this.waiters.get(lane) || [];
      queue.push({ threadId, resolve, reject, startedAt: Date.now() });
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
  PARKABLE_THREAD_STATUSES,
  ThreadManager,
  digest,
  pathWithin,
  resolveExistingDirectory,
  workspaceFingerprint,
};
