const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_HISTORY_ROOT = path.join(
  os.homedir(),
  "Library",
  "Group Containers",
  "2DC432GLL2.com.openai.sky.CUAService",
  "Library",
  "Caches",
  "ComputerUse",
  "Skysight",
  "segments",
);

function nowIso() {
  return new Date().toISOString();
}

function safeJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function readLines(filePath, limit = 80) {
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function displayValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    for (const key of ["name", "title", "label", "value", "text", "bundle_id", "bundleId"]) {
      if (value[key] != null && String(value[key]).trim()) return String(value[key]);
    }
    try { return JSON.stringify(value); } catch { return "Unknown activity"; }
  }
  return String(value);
}

function redact(value) {
  return displayValue(value)
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted-secret]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted-token]")
    .replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "[redacted-email]")
    .replace(/(password|passwd|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function ageSeconds(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? Math.max(0, Math.round((Date.now() - time) / 1000)) : null;
}

function runLocal(command, args, { cwd, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function latestSegment(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort()
      .at(-1) || "";
  } catch {
    return "";
  }
}

function normalizeHistoryEvent(event) {
  const app = event.app_name || event.appName || event.application || event.app || event.bundle_id || "Unknown app";
  const window = event.window_title || event.windowTitle || event.window || event.title || "";
  const capturedAt = event.timestamp || event.createdAt || event.created_at || event.time || null;
  return {
    id: event.id || `obs-${capturedAt || Date.now()}-${app}`,
    source: "computer-history",
    app: redact(app),
    window: redact(window),
    capturedAt: capturedAt ? new Date(capturedAt).toISOString() : nowIso(),
    state: "observed",
    confidence: event.capture_consistency?.status === "window_changed_during_capture" ? 0.42 : 0.7,
    sensitivity: "classified",
    evidenceRefs: event.file_stem ? [`computer-history://${event.file_stem}`] : [],
  };
}

class ContextBroker {
  constructor({ repoRoot, sipsDir, getTask, emit, getSourcePolicy, onCandidate }) {
    this.repoRoot = repoRoot;
    this.sipsDir = sipsDir;
    this.getTask = getTask;
    this.emit = emit;
    this.getSourcePolicy = getSourcePolicy || (() => null);
    this.onCandidate = onCandidate || null;
    this.contextDir = path.join(sipsDir, "context");
    this.journalPath = path.join(this.contextDir, "journal.jsonl");
    this.statePath = path.join(this.contextDir, "state.json");
    this.historyRoot = process.env.HEMLOCK_COMPUTER_HISTORY_ROOT || DEFAULT_HISTORY_ROOT;
    this.openChronicle = process.env.HEMLOCK_OPENCHRONICLE || path.join(os.homedir(), ".local", "bin", "openchronicle");
    fs.mkdirSync(this.contextDir, { recursive: true });
    this.state = safeJson(this.statePath, this.defaultState());
  }

  defaultState() {
    return {
      schema: "hemlock.agent.context.v1",
      id: `ctx-${Date.now()}`,
      updatedAt: nowIso(),
      observations: [],
      focusHypotheses: [],
      activeWorkstreams: [{
        id: "workstream-hemlock",
        label: "Hemlock",
        scope: this.repoRoot,
        status: "active",
        confidence: 0.96,
        lastSeenAt: nowIso(),
        evidenceRefs: [`repo://${this.repoRoot}`],
      }],
      recentTransitions: [],
      recalledMemory: [],
      quality: {
        status: "needs-refresh",
        confidence: 0,
        freshnessSeconds: null,
        sourceCoverage: 0,
        requiresRefresh: true,
      },
      redaction: { status: "applied", rawContentIncluded: false, categories: [] },
      providers: [],
      evidenceRefs: [],
      journalEntries: 0,
    };
  }

  getState() {
    return this.state;
  }

  sourceEnabled(sourceId) {
    const policy = this.getSourcePolicy(sourceId);
    return policy ? policy.enabled !== false : true;
  }

  setSourcePolicy(sourceId, policy) {
    if (!this.state.sources) this.state.sources = [];
    const existing = this.state.sources.find((item) => item.sourceId === sourceId);
    const next = { sourceId, ...(existing || {}), ...policy };
    this.state.sources = existing
      ? this.state.sources.map((item) => item.sourceId === sourceId ? next : item)
      : [...this.state.sources, next];
    this.state.updatedAt = nowIso();
    fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
    return next;
  }

  appendJournal(entry) {
    const record = { schema: "hemlock.context.journal.v1", id: `ctxevt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, createdAt: nowIso(), ...entry };
    fs.appendFileSync(this.journalPath, `${JSON.stringify(record)}\n`, "utf-8");
    this.state.journalEntries += 1;
    return record;
  }

  async inspectComputerHistory() {
    if (!this.sourceEnabled("computer-history")) {
      return { id: "computer-history", status: "disabled", reason: "Computer History is disabled for this workspace.", confidence: 0, observations: [] };
    }
    const segment = latestSegment(this.historyRoot);
    if (!segment) {
      return { id: "computer-history", status: "unavailable", reason: "No local Skysight segment was discovered.", confidence: 0, observations: [] };
    }
    const metadata = safeJson(path.join(segment, "metadata.json"), {});
    const eventsPath = metadata.eventsPath || path.join(segment, "events.jsonl");
    const rawEvents = readLines(eventsPath, 80);
    const segmentEvidence = `computer-history://${path.basename(segment)}`;
    const observations = rawEvents.map(normalizeHistoryEvent).slice(-24).map((observation) => ({
      ...observation,
      evidenceRefs: observation.evidenceRefs?.length ? observation.evidenceRefs : [segmentEvidence],
    }));
    const latest = observations.at(-1);
    const freshnessSeconds = ageSeconds(latest?.capturedAt);
    const status = freshnessSeconds !== null && freshnessSeconds <= 900 ? "fresh" : "stale";
    return {
      id: "computer-history",
      status,
      lastUpdatedAt: latest?.capturedAt || metadata.startedAt || nowIso(),
      freshnessSeconds,
      confidence: observations.length ? Math.max(0.2, Math.min(0.92, observations.at(-1).confidence + (observations.length > 3 ? 0.08 : 0))) : 0.1,
      captureHealth: observations.length ? "available" : "empty",
      segment: path.basename(segment),
      evidenceRefs: [segmentEvidence],
      observations,
    };
  }

  async inspectOpenChronicle() {
    if (!this.sourceEnabled("openchronicle") && !this.sourceEnabled("local-project")) {
      return { id: "openchronicle", status: "disabled", reason: "Project context sources are disabled for this workspace.", confidence: 0, observations: [] };
    }
    if (!fs.existsSync(this.openChronicle)) {
      return { id: "openchronicle", status: "unavailable", reason: `Executable not found at ${this.openChronicle}`, confidence: 0, observations: [] };
    }
    const result = await runLocal(this.openChronicle, ["status"], { cwd: this.repoRoot, timeoutMs: 5000 });
    const status = result.exitCode === 0 ? "available" : "degraded";
    return {
      id: "openchronicle",
      status,
      confidence: status === "available" ? 0.65 : 0.2,
      lastUpdatedAt: nowIso(),
      freshnessSeconds: 0,
      captureHealth: status,
      summary: redact((result.stdout || result.stderr).trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(" · ")),
      capabilities: ["status", "local-mcp"],
      evidenceRefs: [`executable://${this.openChronicle}`],
      observations: [],
    };
  }

  async refresh({ reason = "automatic", task = this.getTask?.() } = {}) {
    const [computerHistory, openChronicle] = await Promise.all([
      this.inspectComputerHistory(),
      this.inspectOpenChronicle(),
    ]);
    const providers = [computerHistory, openChronicle];
    const observations = providers.flatMap((provider) => provider.observations || []).slice(-24);
    const freshProviders = providers.filter((provider) => ["fresh", "available"].includes(provider.status));
    const latestObservation = observations.at(-1);
    const taskConfidence = task?.objective ? 0.96 : 0.45;
    const contextConfidence = Math.min(0.99, Math.max(taskConfidence, ...providers.map((provider) => provider.confidence || 0)));
    const freshnessSeconds = latestObservation ? ageSeconds(latestObservation.capturedAt) : null;
    const qualityStatus = freshProviders.length === 0 ? "needs-refresh" : freshnessSeconds !== null && freshnessSeconds > 900 ? "stale" : "fresh";
    const focusHypotheses = [
      ...(task?.objective ? [{ id: "focus-hemlock", label: "Hemlock active task", objective: task.objective, confidence: taskConfidence, state: "inferred", evidenceRefs: [`task://${task.id}`, `repo://${this.repoRoot}`] }] : []),
      ...observations.slice(-3).map((observation) => ({ id: `focus-${observation.id}`, label: `${observation.app}${observation.window ? ` · ${observation.window}` : ""}`, confidence: observation.confidence, state: "observed", evidenceRefs: observation.evidenceRefs })),
    ];
    const nextState = {
      schema: "hemlock.agent.context.v1",
      id: `ctx-${Date.now()}`,
      updatedAt: nowIso(),
      taskId: task?.id || null,
      observations: observations.map(({ content, ...observation }) => observation),
      focusHypotheses,
      activeWorkstreams: [{
        id: "workstream-hemlock",
        label: "Hemlock",
        scope: this.repoRoot,
        objective: task?.objective || "Explore the Hemlock workspace",
        status: task?.status === "blocked" ? "blocked" : "active",
        confidence: taskConfidence,
        lastSeenAt: nowIso(),
        evidenceRefs: [`repo://${this.repoRoot}`, ...(task?.evidenceRefs || [])],
      }],
      recentTransitions: observations.slice(-8).map((observation) => ({ app: observation.app, window: observation.window, at: observation.capturedAt, source: observation.source })),
      recalledMemory: this.state.recalledMemory || [],
      quality: {
        status: qualityStatus,
        confidence: Number(contextConfidence.toFixed(2)),
        freshnessSeconds,
        sourceCoverage: Number((freshProviders.length / providers.length).toFixed(2)),
        requiresRefresh: qualityStatus !== "fresh",
      },
      sources: this.state.sources || [],
      redaction: { status: "applied", rawContentIncluded: false, categories: ["raw-screen-content-not-copied"] },
      providers: providers.map(({ observations: _observations, ...provider }) => provider),
      evidenceRefs: providers.flatMap((provider) => provider.evidenceRefs || []).slice(0, 12),
      journalEntries: this.state.journalEntries || 0,
    };
    this.state = nextState;
    this.appendJournal({ type: "context.snapshot", reason, quality: nextState.quality, providerStatuses: providers.map((provider) => ({ id: provider.id, status: provider.status, confidence: provider.confidence })), focus: focusHypotheses.slice(0, 3) });
    this.state.journalEntries = this.state.journalEntries;
    fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
    const ambientObservation = observations.at(-1);
    if (ambientObservation && ambientObservation.confidence >= 0.65 && ambientObservation.source === "computer-history") {
      this.onCandidate?.({
        kind: "ambient-observation",
        title: `Review recent ${ambientObservation.app} activity`,
        summary: `${ambientObservation.app}${ambientObservation.window ? ` · ${ambientObservation.window}` : ""} was observed recently. Decide whether it should become a Hemlock task or remain context only.`,
        sourceId: ambientObservation.source,
        sourceRefs: ambientObservation.evidenceRefs || [],
        reason: "Recent enabled Computer History activity may explain what matters next.",
        confidence: ambientObservation.confidence,
      });
    }
    this.emit?.("context.quality.updated", qualityStatus === "fresh" ? "passed" : "degraded", { quality: this.state.quality, providers: this.state.providers, reason }, { evidenceRefs: this.state.evidenceRefs, reversible: true });
    return this.state;
  }

  search(query = "") {
    const needle = String(query).trim().toLowerCase();
    if (!needle) return this.state;
    const matches = [...(this.state.observations || []), ...(this.state.focusHypotheses || []), ...(this.state.activeWorkstreams || []), ...(this.state.sources || [])].filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
    return { schema: "hemlock.agent.context.search.v1", status: "ready", query, matches, quality: this.state.quality, evidenceRefs: matches.flatMap((item) => item.evidenceRefs || []) };
  }
}

module.exports = { ContextBroker };
