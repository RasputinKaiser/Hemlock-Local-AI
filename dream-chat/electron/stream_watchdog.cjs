"use strict";

// T8-S3: Pure first-token stall decision for the Maple SSE watchdog.
// A request that has been accepted but has produced no stream bytes for
// `stallMs` is considered wedged; the caller (main.cjs) then aborts the
// fetch so the bounded transport recovery can take over.

const DEFAULT_STALL_MS = 45000;

function firstTokenWatchdog({ now = Date.now(), startedAt = null, firstByteAt = null, stallMs = DEFAULT_STALL_MS } = {}) {
  if (!Number.isFinite(startedAt)) return { stalled: false };
  if (firstByteAt != null) return { stalled: false };
  const elapsedMs = Math.max(0, Number(now) - startedAt);
  return {
    stalled: elapsedMs >= stallMs,
    elapsedMs,
    stallMs: Number(stallMs),
  };
}

module.exports = { firstTokenWatchdog, DEFAULT_STALL_MS };
