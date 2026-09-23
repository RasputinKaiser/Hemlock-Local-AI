"use strict";

// T8-S3: Pure first-token stall decision for the Maple SSE watchdog.
// A request that has been accepted but has produced no stream bytes for
// `stallMs` is considered wedged; the caller (main.cjs) then aborts the
// fetch so the bounded transport recovery can take over.

// A 2-bit local model prefilling a cold prompt can legitimately take over a
// minute before the first SSE byte, so the stall bound is generous; the
// watchdog exists to catch a wedged request, not to time-box slow prefills.
const DEFAULT_STALL_MS = 120000;

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
