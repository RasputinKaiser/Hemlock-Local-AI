// Pure derivation helpers for the Threads management surface. No React and no
// host calls — the window maps these over ctx state so list/search/derive
// logic stays testable without a DOM (same pattern as agentTimeline.js).

// Statuses that still claim live or resumable work. Deleting one of these
// needs the host's force path (it cancels the run before removal); pausing
// only makes sense here too.
export const LIVE_THREAD_STATUSES = new Set([
  "accepted",
  "planning",
  "running",
  "verifying",
  "repairing",
  "waiting_for_approval",
  "waiting_for_user",
  "paused",
  "blocked",
]);
export const TERMINAL_THREAD_STATUSES = new Set(["completed", "cancelled", "archived"]);

const byUpdatedDesc = (a, b) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""));

// Open vs archived sections, each newest-first by updatedAt.
export function splitThreads(threads = []) {
  const list = Array.isArray(threads) ? threads.filter(Boolean) : [];
  return {
    open: list.filter((item) => item.status !== "archived").sort(byUpdatedDesc),
    archived: list.filter((item) => item.status === "archived").sort(byUpdatedDesc),
  };
}

// The detail pane follows the user's pick while it exists; otherwise it
// tracks the active thread. A deleted selection falls back honestly.
export function resolveSelectedThread(threads = [], selectedId = null, activeId = null) {
  const list = Array.isArray(threads) ? threads : [];
  return list.find((item) => item?.id === selectedId)
    || list.find((item) => item?.id === activeId)
    || null;
}

// StatusLamp state for a thread status. Only the lamp vocabulary the
// stylesheet defines is emitted — anything else reads as the neutral base dot.
export function threadStatusLamp(status) {
  const value = String(status || "ready");
  if (["accepted", "planning", "running", "verifying", "repairing"].includes(value)) return "working";
  if (["blocked", "cancelled"].includes(value)) return "down";
  if (["ready", "completed"].includes(value)) return "ready";
  return "idle"; // paused, waiting_*, archived, unknown → neutral base lamp
}

export function defaultForkTitle(thread) {
  const base = String(thread?.title || "").trim() || "Hemlock thread";
  return `Fork of ${base}`.slice(0, 160);
}

// "3 prior tasks" / "1 prior task" / null — the list row only shows the chip
// when a thread has actually hosted previous tasks.
export function taskHistoryLabel(thread) {
  const count = Array.isArray(thread?.taskHistory) ? thread.taskHistory.length : 0;
  if (!count) return null;
  return `${count} prior task${count === 1 ? "" : "s"}`;
}

// Normalize one durable checkpoint for the detail list. Restore markers get
// flagged so the UI can label them instead of presenting them as work states.
export function checkpointRow(checkpoint, { currentCheckpointId = null } = {}) {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const reason = String(checkpoint.reason || "");
  return {
    id: String(checkpoint.id || ""),
    phase: checkpoint.phase || null,
    status: checkpoint.status || null,
    reason: reason || null,
    taskId: checkpoint.taskId || null,
    isRestoreMarker: reason.startsWith("checkpoint-restored:") || reason.startsWith("thread-forked:"),
    isCurrent: Boolean(currentCheckpointId) && checkpoint.id === currentCheckpointId,
    createdAt: checkpoint.createdAt || null,
  };
}

export function checkpointRows(checkpoints = [], { currentCheckpointId = null } = {}) {
  const list = Array.isArray(checkpoints) ? checkpoints : [];
  return list.map((item) => checkpointRow(item, { currentCheckpointId })).filter(Boolean).reverse(); // newest first
}

// Last-N conversation preview for the detail pane — bounded text so a long
// message cannot flood the pane.
export function conversationPreview(messages = [], { limit = 40, textLimit = 320 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  return list.slice(-Math.max(1, limit)).map((message) => {
    const text = String(message?.content || "");
    return {
      id: String(message?.id || `${message?.role || "message"}-${message?.createdAt || ""}`),
      role: ["user", "assistant", "system"].includes(message?.role) ? message.role : "system",
      text: text.length > textLimit ? `${text.slice(0, textLimit - 1).trimEnd()}…` : text,
      truncated: text.length > textLimit,
      createdAt: message?.createdAt || null,
      provider: message?.provider || null,
    };
  });
}

// Host-side search rows (thread.search) normalized for the result list.
export function searchResultRows(results = []) {
  const list = Array.isArray(results) ? results : [];
  return list
    .filter((item) => item && item.threadId)
    .map((item) => ({
      threadId: String(item.threadId),
      title: String(item.title || "Untitled thread"),
      matchedIn: item.matchedIn === "conversation" ? "conversation" : "title",
      snippet: typeof item.snippet === "string" ? item.snippet : null,
    }));
}

// Which actions the detail pane may honestly offer for a thread in a given
// status. Buttons stay visible but disabled only where the host would reject
// them — the returned flags drive both.
export function threadActions(thread, activeId = null) {
  if (!thread) return { canSwitch: false, canPause: false, canResume: false, canArchive: false, canRestore: false, canFork: false, canCancel: false, canDelete: false };
  const archived = thread.status === "archived";
  const terminal = TERMINAL_THREAD_STATUSES.has(thread.status);
  return {
    canSwitch: !archived && thread.id !== activeId,
    canPause: !terminal && thread.status !== "paused",
    canResume: thread.status === "paused" || thread.status === "blocked",
    canArchive: !archived,
    canRestore: archived,
    canFork: true,
    canCancel: !terminal,
    canDelete: true,
  };
}
