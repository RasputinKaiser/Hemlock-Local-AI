// Pure transcript-timeline helpers for the Chat window: which host events earn
// an inline receipt row, where each row lands between messages, and how plan
// steps map to visual states. Kept free of React/DOM so it is testable with
// node:test like evidenceLedger.js. Nothing here invents state — every row is
// derived from durable host events and the projected action list.

// Host events worth an inline receipt in the transcript. Deliberately excludes
// per-step noise (inference.started/completed, context.quality.updated,
// plan.awaiting_approval duplicates plan.proposed) — those stay in Activity.
export const TRANSCRIPT_EVENT_TYPES = new Set([
  "task.created",
  "task.paused",
  "task.resumed",
  "task.cancelled",
  "task.queued",
  "task.queue.started",
  "task.queue.completed",
  "task.queue.failed",
  "task.queue.cancelled",
  "task.blocked",
  "task.completed",
  "task.question",
  "task.answered",
  "task.steered",
  "task.steering.received",
  "task.steering.restarted",
  "plan.proposed",
  "plan.approved",
  "plan.auto_approved",
  "plan.rejected",
  "plan.adapted",
  "action.proposed",
  "action.validated",
  "action.scored",
  "action.rejected",
  "action.completed",
  "action.retry.proposed",
  "action.command.recovered",
  "action.redirected",
  "action.inference.failed",
  "action.inference.fallback",
  "action.parse.failed",
  "action.autonomy.bypass",
  "command.started",
  "command.completed",
  "command.blocked",
  "observation.recorded",
  "verification.started",
  "verification.ran",
  "verification.completed",
  "memory.recalled",
  "improve.proposed",
  "artifact.author.ensure",
  "artifact.author.recovered",
  "artifact.author.repaired",
  "artifact.verification.failed",
  "artifact.verification.completed",
  "artifact.preview.ready",
  "artifact.interaction.blocked",
  "artifact.restore.failed",
  "artifact.repair.started",
  "artifact.repair.completed",
  "artifact.repair.failed",
  "artifact.repair.exhausted",
  "comparison.completed",
  "comparison.failed",
  "comparison.blocked",
  "experiment.completed",
  "sips.cycle.started",
  "sips.cycle.completed",
  "sips.cycle.failed",
  "dream.started",
  "dream.completed",
  "dream.failed",
  "dream.blocked",
  "dream.adapter.grafted",
  "dream.adapter.detached",
  "dream.fuse.started",
  "dream.fused",
  "inference.failed",
  "inference.retrying",
  "inference.stopped",
  "maple.recovery",
  "maple.runtime.restarted",
  "maple.crashloop.detected",
  "conversation.partial",
  "operation.cancelled",
]);

export function isTimelineEvent(event) {
  return Boolean(event && TRANSCRIPT_EVENT_TYPES.has(event.type));
}

function eventTaskId(event) {
  return event?.taskId || event?.payload?.taskId || event?.payload?.task?.id || null;
}

function timestampOf(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

// Bucket timeline events between messages by timestamp. An event lands after
// the last message that is dated no later than it; undated messages are
// pass-through anchors so a missing createdAt never swallows an event. Events
// older than the first dated message collect in `before`; undated events (or
// any event when no message carries a date) collect in `tail`, rendered after
// the last message and before the live stream. Message order and event
// arrival order are preserved within each bucket — stable, honest ordering
// with no re-sorting of records.
export function buildTranscriptTimeline(messages = [], events = [], taskId = null) {
  const ats = [];
  let lastSeen = null;
  for (const message of messages) {
    const at = timestampOf(message?.createdAt);
    if (at != null) lastSeen = at;
    ats.push(at ?? lastSeen);
  }
  const before = [];
  const after = new Map();
  const tail = [];
  for (const event of events) {
    if (!isTimelineEvent(event)) continue;
    // Task-scoped events only render on their own task; taskless events
    // (dream.*, inference.failed) are session-wide and always show.
    if (eventTaskId(event) && eventTaskId(event) !== taskId) continue;
    const at = timestampOf(event.createdAt);
    let index = -1;
    if (at != null) {
      for (let i = 0; i < messages.length; i += 1) {
        if (ats[i] != null && ats[i] <= at) index = i;
      }
    }
    if (index >= 0) {
      // Keyed by message index — never by id, which can be missing or reused.
      if (!after.has(index)) after.set(index, []);
      after.get(index).push(event);
    } else if (!messages.length || at == null || ats.every((value) => value == null || value < at)) {
      tail.push(event);
    } else {
      before.push(event);
    }
  }
  return { before, after, tail };
}

// Compact scalar contract for a registered action's bounded input — rendered
// as chips on action receipt rows. Values are previewed verbatim (truncated),
// objects are summarized by key list so the row stays one line tall.
export function inputContract(input, { max = 4, valueLength = 42 } = {}) {
  if (!input || typeof input !== "object") return [];
  return Object.entries(input)
    .filter(([, value]) => value != null && value !== "")
    .slice(0, max)
    .map(([key, value]) => {
      const text = typeof value === "object"
        ? `{${Object.keys(value).slice(0, 4).join(",")}}`
        : String(value);
      return { key, value: text.length > valueLength ? `${text.slice(0, valueLength - 1)}…` : text };
    });
}

// action.scored payload → normalized receipt. All fields optional; the caller
// decides which chips to render. margin/logprob are left raw (caller formats).
export function scoreReceipt(payload = {}) {
  return {
    winner: payload.winner?.commandId || payload.winner?.kind || null,
    winnerKind: payload.winner?.kind || null,
    runnerUp: payload.runnerUp?.commandId || payload.runnerUp?.kind || null,
    margin: Number.isFinite(payload.margin) ? payload.margin : null,
    avgLogprob: Number.isFinite(payload.avgLogprob) ? payload.avgLogprob : null,
    candidateCount: Number.isFinite(payload.candidateCount) ? payload.candidateCount : null,
    cachedTokens: Number.isFinite(payload.cachedTokens) ? payload.cachedTokens : null,
    elapsedMs: Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : null,
    complete: payload.complete === true,
    degraded: payload.status === "degraded" || Boolean(payload.error),
  };
}

// Plan step visual states derived from the durable projection: the host
// remaps step.status on adaptive inserts, but ordinary progression is only
// observable through the completed action count — mirror the orchestrator's
// own rule (index < actions → completed, index === actions → current).
export function planStepStates(steps = [], completedActions = 0, { planStatus = "", taskStatus = "" } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const done = Math.max(0, completedActions);
  const running = ["running", "paused", "waiting_for_approval", "waiting_for_user", "verifying"].includes(taskStatus);
  return list.map((step, index) => {
    if (planStatus === "completed" || step?.status === "completed" || index < done) return "done";
    if (taskStatus === "blocked" && index === done) return "blocked";
    if (index === done) return running ? "current" : "ready";
    return "queued";
  });
}

export function planProgress(steps = [], completedActions = 0, planStatus = "") {
  const total = Array.isArray(steps) ? steps.length : 0;
  if (!total) return null;
  const done = planStatus === "completed" ? total : Math.min(Math.max(0, completedActions), total);
  return { done, total, label: `${done}/${total} steps`, ratio: done / total };
}

// Honesty markers the orchestrator tucks inside an artifact.author action's
// input evidence (agent_orchestrator.cjs ~L1430): authoring.host_fallback means
// the visible artifact is the canned scaffold, not model output;
// authoring.repaired_source means one bounded repair inference wrote it. These
// are evidence entries, not standalone events — surface them on the receipt row
// so placeholder/repaired content can never pass as authored.
export const AUTHORING_FLAG_COPY = {
  "authoring.host_fallback": "Placeholder content — the model did not return usable source, so the host scaffold was kept.",
  "authoring.repaired_source": "Repaired content — a bounded repair inference produced this source after the model's envelope failed.",
};

export function authoringEvidence(event) {
  const payload = event?.payload || {};
  const pools = [
    payload.evidence,
    payload.input?.evidence,
    payload.action?.input?.evidence,
    payload.action?.evidence,
    payload.observation?.evidence,
  ];
  const flags = [];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const item of pool) {
      if (!item || typeof item !== "object") continue;
      if (!AUTHORING_FLAG_COPY[item.type]) continue;
      if (!flags.some((flag) => flag.type === item.type && flag.reason === item.reason)) {
        flags.push({ type: item.type, reason: String(item.reason || "") });
      }
    }
  }
  return flags;
}
