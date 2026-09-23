// Crash-loop policy for the maple-server child process (T7.5-R1).
//
// Pure module: no Electron, no I/O, no clocks of its own — callers pass `now`.
// A real incident (2026-08-23) saw MLX Metal GPU-timeout SIGABRT the maple
// child 7 times in a row; without a bounded budget the launcher would thrash
// forever on a poison prompt. Policy: record crashes, respawn while under
// budget, refuse (and surface an honest degraded state) once over.
//
// Fail-open: null / garbage / empty history always respawns. Availability of
// the runtime is the default posture; only positive evidence of a loop blocks.

const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_WINDOW_MS = 600000; // 10 minutes

function isValidTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Append `now` to the crash history and prune entries older than windowMs.
// Returns a NEW array — the caller's array is never mutated, so an in-flight
// reader of the old history sees a consistent snapshot.
function recordCrash(timestamps, now, { windowMs = DEFAULT_WINDOW_MS } = {}) {
  const cutoff = now - windowMs;
  const kept = (Array.isArray(timestamps) ? timestamps : [])
    .filter((t) => isValidTimestamp(t) && t >= cutoff);
  return [...kept, now];
}

// Load-time sanitize for a persisted crash history (maple-runtime.json):
// keep only valid timestamps inside the current window — anything else is
// dead weight from a previous session.
function sanitizeCrashHistory(timestamps, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  const currentTime = isValidTimestamp(now) ? now : Date.now();
  const cutoff = currentTime - windowMs;
  return (Array.isArray(timestamps) ? timestamps : [])
    .filter((t) => isValidTimestamp(t) && t >= cutoff);
}

function shouldRespawn({
  crashTimestamps,
  now,
  maxCrashes = DEFAULT_MAX_CRASHES,
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  // Defensive: missing or non-array history fails open for availability.
  const timestamps = Array.isArray(crashTimestamps)
    ? crashTimestamps.filter(isValidTimestamp)
    : [];
  const currentTime = isValidTimestamp(now) ? now : Date.now();
  const withinWindow = timestamps.filter((t) => t >= currentTime - windowMs).length;
  if (withinWindow >= maxCrashes) {
    return {
      respawn: false,
      reason: `crash loop suspected: ${withinWindow} maple crashes in ${Math.round(windowMs / 60000)} minutes`,
    };
  }
  return { respawn: true, reason: "within crash budget" };
}

module.exports = {
  DEFAULT_MAX_CRASHES,
  DEFAULT_WINDOW_MS,
  recordCrash,
  sanitizeCrashHistory,
  shouldRespawn,
};
