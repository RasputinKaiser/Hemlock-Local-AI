// Work-notification policy for long-running local jobs (Lane B, main process).
//
// Long local work — Dream fine-tuning runs, Hemlock SIPS cycles — can outlive
// the user's attention on the Hemlock window. The main process is the
// legitimate observer of those children (it spawns and supervises them), so it
// announces completion through the same OS-notification routine that backs the
// renderer-facing "notification:show" IPC channel.
//
// Policy: a job only earns a notification when it ran at least
// thresholdMs (default 30s). Short jobs never notify — notification spam is
// worse than silence. All user-visible strings are clamped with the same
// length rules as notification:show (title <= 80, body <= 240, whitespace
// collapsed).

const NOTIFICATION_TITLE_MAX_LENGTH = 80;
const NOTIFICATION_BODY_MAX_LENGTH = 240;
const DEFAULT_THRESHOLD_MS = 30_000;

function clampText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// Inclusive threshold: a run of exactly thresholdMs counts as long enough to
// announce. Sub-threshold elapsed times never notify.
function shouldNotify(elapsedMs, thresholdMs = DEFAULT_THRESHOLD_MS) {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(thresholdMs)) return false;
  return elapsedMs >= thresholdMs;
}

// Compact human duration: "59s", "1m 1s", "59m 0s", "2h 5m" (hours drop
// seconds; sub-minute stays in seconds; zero renders as "0s").
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function createWorkNotifier({ notify, now = () => Date.now(), config = {} } = {}) {
  if (typeof notify !== "function") throw new Error("createWorkNotifier requires a notify(payload) function.");
  const thresholdMs = Number.isFinite(config.thresholdMs)
    ? config.thresholdMs
    : DEFAULT_THRESHOLD_MS;
  const running = new Map(); // jobId -> { label, startedAt }

  return {
    // Register a job start. Returns the recorded entry for observability.
    onJobStarted(jobId, label) {
      const id = String(jobId ?? "");
      if (!id) return null;
      const entry = { jobId: id, label: clampText(label, NOTIFICATION_TITLE_MAX_LENGTH) || id, startedAt: now() };
      running.set(id, entry);
      return { ...entry };
    },

    // Announce completion when the job was long enough to deserve it.
    // Unknown jobIds (finish-without-start, duplicate finish) are handled
    // gracefully: nothing is emitted, nothing throws.
    onJobFinished(jobId, { ok = true, detail = "" } = {}) {
      const id = String(jobId ?? "");
      const entry = running.get(id);
      if (!entry) return { notified: false, reason: "unknown-job" };
      running.delete(id);
      const elapsedMs = Math.max(0, now() - entry.startedAt);
      if (!shouldNotify(elapsedMs, thresholdMs)) {
        return { notified: false, reason: "below-threshold", elapsedMs };
      }
      const label = entry.label;
      const title = clampText(label, NOTIFICATION_TITLE_MAX_LENGTH);
      if (!title) return { notified: false, reason: "empty-title", elapsedMs };
      const body = ok
        ? clampText(`${label} finished · took ${formatDuration(elapsedMs)}`, NOTIFICATION_BODY_MAX_LENGTH)
        : clampText(`${label} stopped · ${detail || "unknown reason"}`, NOTIFICATION_BODY_MAX_LENGTH);
      const result = notify({ title, body });
      return { notified: Boolean(result?.shown ?? true), elapsedMs, title, body };
    },

    // Jobs that started but never finished (diagnostics only).
    pending() {
      return [...running.values()].map((entry) => ({ ...entry }));
    },
  };
}

module.exports = {
  DEFAULT_THRESHOLD_MS,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NOTIFICATION_BODY_MAX_LENGTH,
  clampText,
  shouldNotify,
  formatDuration,
  createWorkNotifier,
};
