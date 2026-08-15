const crypto = require("node:crypto");

const PREVIEW_SCHEMA = "hemlock.agent.preview.v1";
const DEFAULT_BUDGET = Object.freeze({ maxPreviewActions: 24, maxPreviewRetriesPerAction: 2, maxPreviewScreenshots: 8, maxPreviewWallClockMs: 300000 });
const REGISTERED_ACTIONS = new Set(["inspect", "accessibility", "resize", "click", "type", "key", "scroll", "hover", "focus", "wait", "screenshot", "pause", "stop"]);

function digest(value) { return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`; }

class PreviewSessionManager {
  constructor({ now = () => Date.now(), emit = () => {}, budget = {} } = {}) {
    this.now = now;
    this.emit = emit;
    this.budget = { ...DEFAULT_BUDGET, ...budget };
    this.sessions = new Map();
  }
  open({ taskId, artifactId, revision }) {
    const id = `preview-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const session = { schema: PREVIEW_SCHEMA, id, taskId, artifactId, revision, status: "running", startedAt: this.now(), actions: 0, retries: {}, screenshots: 0, paused: false, visible: true, lastInspectionDigest: null };
    this.sessions.set(id, session);
    return { ...session };
  }
  get(sessionId) { const session = this.sessions.get(sessionId); if (!session) throw new Error(`Preview session was not found: ${sessionId}`); return session; }
  authorize(sessionId, action, input = {}) {
    const session = this.get(sessionId);
    if (!REGISTERED_ACTIONS.has(action)) throw new Error(`Preview action is not registered: ${action}`);
    if (session.status !== "running" || session.paused) return { allowed: false, reason: session.paused ? "preview_paused" : `preview_${session.status}` };
    if (this.now() - session.startedAt > this.budget.maxPreviewWallClockMs) return this.stop(sessionId, "preview_wall_clock_exhausted");
    if (session.actions >= this.budget.maxPreviewActions) return this.stop(sessionId, "preview_action_budget_exhausted");
    if (action === "screenshot" && session.screenshots >= this.budget.maxPreviewScreenshots) return this.stop(sessionId, "preview_screenshot_budget_exhausted");
    if (action === "screenshot" && session.visible === false) return { allowed: false, reason: "preview_not_visible" };
    const retryKey = String(input.actionId || input.target || action);
    if (input.retry === true) {
      session.retries[retryKey] = (session.retries[retryKey] || 0) + 1;
      if (session.retries[retryKey] > this.budget.maxPreviewRetriesPerAction) return { allowed: false, reason: "preview_retry_budget_exhausted" };
    }
    session.actions += 1;
    if (action === "screenshot") session.screenshots += 1;
    return { allowed: true, session: { ...session }, previewOnly: true };
  }
  complete(sessionId, input = {}) {
    const session = this.get(sessionId);
    const record = { schema: "hemlock.agent.preview.interaction.v1", taskId: session.taskId, artifactId: session.artifactId, revision: session.revision, target: input.target || null, input: input.input || null, preDigest: input.preDigest || null, postDigest: input.postDigest || null, result: input.result || "completed", consoleErrors: Array.isArray(input.consoleErrors) ? input.consoleErrors.slice(0, 20) : [], screenshotRef: input.screenshotRef || null, elapsedMs: Number(input.elapsedMs || 0), previewOnlyMutation: true, at: new Date(this.now()).toISOString() };
    if (input.inspection) session.lastInspectionDigest = digest(JSON.stringify(input.inspection));
    this.emit("artifact.interaction.completed", record.result === "blocked" ? "blocked" : "passed", { session: { ...session }, interaction: record });
    return record;
  }
  inspect(sessionId, input = {}) { const session = this.get(sessionId); session.lastInspectionDigest = input.digest || digest(JSON.stringify(input)); return { ...session }; }
  pause(sessionId) { const session = this.get(sessionId); session.paused = true; this.emit("artifact.interaction.blocked", "blocked", { session: { ...session }, reason: "preview_paused" }); return { ...session }; }
  stop(sessionId, reason = "user_stopped") { const session = this.get(sessionId); session.status = "stopped"; session.stopReason = reason; session.stoppedAt = this.now(); this.emit("artifact.preview.stopped", "completed", { session: { ...session } }); return { allowed: false, reason, session: { ...session } }; }
}

module.exports = { PreviewSessionManager, DEFAULT_BUDGET, REGISTERED_ACTIONS, PREVIEW_SCHEMA, digest };
