const path = require("node:path");

function nowIso() { return new Date().toISOString(); }

function normalizeObservation({ sourceId, scope, kind = "observation", summary, sourceRef, confidence = 0.5, sensitivity = "normal", retentionClass = "30d", observedAt = nowIso(), freshness = "fresh", redactedContent = null }) {
  return {
    schema: "hemlock.context.observation.v1",
    id: `observation-${sourceId}-${Date.parse(observedAt) || Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sourceId,
    scope,
    observedAt,
    freshness,
    kind,
    summary: String(summary || "Local observation").slice(0, 1200),
    redactedContent,
    sourceRef: sourceRef || null,
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    sensitivity,
    retentionClass,
    provenance: { sourceId, sourceRef: sourceRef || null },
  };
}

class ContextSourceRegistry {
  constructor({ repoRoot, kernel, broker }) {
    this.repoRoot = repoRoot;
    this.kernel = kernel;
    this.broker = broker;
    this.adapters = new Map([
      ["computer-history", this.adapter("computer-history", "Computer History", "local-user")],
      ["local-project", this.adapter("local-project", "Hemlock project and worktree", repoRoot)],
      ["openchronicle", this.adapter("openchronicle", "OpenChronicle project context", repoRoot)],
      ["local-notes", this.disabledAdapter("local-notes", "Selected local notes")],
      ["local-task-boards", this.disabledAdapter("local-task-boards", "Local task boards")],
      ["calendar", this.disabledAdapter("calendar", "Calendar")],
      ["mail-and-messages", this.disabledAdapter("mail-and-messages", "Mail and messages")],
    ]);
  }

  policy(sourceId) {
    return this.kernel?.source(sourceId) || { sourceId, enabled: false, permissionState: "not-registered", freshness: "unavailable" };
  }

  adapter(sourceId, displayName, scope) {
    return {
      sourceId,
      displayName,
      getPolicy: () => this.policy(sourceId),
      query: async (input = {}) => this.querySource(sourceId, input),
      observe: async (cursor = {}) => this.querySource(sourceId, { ...cursor, observe: true }),
      redact: (observation) => this.redact(observation),
      health: () => ({ sourceId, displayName, scope, status: this.policy(sourceId).enabled === false ? "not_enabled" : "fresh", permissionState: this.policy(sourceId).permissionState || "unknown" }),
    };
  }

  disabledAdapter(sourceId, displayName) {
    return {
      sourceId,
      displayName,
      getPolicy: () => this.policy(sourceId),
      query: async () => ({ schema: "hemlock.context.query.v1", status: "not_enabled", observations: [], sourceId, reason: "This context lane requires explicit opt-in." }),
      observe: async () => ({ schema: "hemlock.context.observe.v1", status: "not_enabled", observations: [], sourceId }),
      redact: (observation) => this.redact(observation),
      health: () => ({ sourceId, displayName, status: this.policy(sourceId).enabled ? "unavailable" : "not_enabled", permissionState: this.policy(sourceId).permissionState || "not-enabled" }),
    };
  }

  redact(observation) {
    if (!observation || typeof observation !== "object") return observation;
    const value = JSON.stringify(observation)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/(?:sk|ghp|token|secret)[-_]?[A-Za-z0-9]{12,}/gi, "[redacted-token]");
    return { ...JSON.parse(value), redactionStatus: "redacted" };
  }

  async querySource(sourceId, input = {}) {
    const policy = this.policy(sourceId);
    if (policy.enabled === false) return { schema: "hemlock.context.query.v1", status: "not_enabled", sourceId, observations: [], reason: "This context lane requires explicit opt-in." };
    if (!this.broker) return { schema: "hemlock.context.query.v1", status: "unavailable", sourceId, observations: [] };
    if (!["computer-history", "local-project", "openchronicle"].includes(sourceId)) return { schema: "hemlock.context.query.v1", status: "unavailable", sourceId, observations: [] };
    const result = await this.broker.search(input.query || "");
    const observations = (result.observations || result.items || result.matches || []).map((item) => this.redact(normalizeObservation({
      sourceId,
      scope: policy.scope || this.repoRoot,
      kind: item.kind || "observation",
      summary: item.summary || item.title || item.text,
      redactedContent: item.redactedContent || item.text || null,
      sourceRef: item.sourceRef || item.file || item.id,
      confidence: item.confidence,
      freshness: item.freshness || "fresh",
      retentionClass: policy.retention,
      observedAt: item.observedAt || item.createdAt,
    })));
    return { schema: "hemlock.context.query.v1", status: "fresh", sourceId, observations, evidenceRefs: result.evidenceRefs || [] };
  }

  get(sourceId) { return this.adapters.get(sourceId) || null; }

  getState() {
    return [...this.adapters.values()].map((adapter) => ({ ...adapter.health(), policy: adapter.getPolicy() }));
  }

  async query(input = {}) {
    const sourceId = String(input.sourceId || "local-project");
    return (this.get(sourceId) || this.get("local-project")).query(input);
  }
}

module.exports = { ContextSourceRegistry, normalizeObservation };
