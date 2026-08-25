"use strict";

// Pure helper for prompt-cache telemetry (T8-S1). Converts raw token usage
// into a prompt-cache hit ratio clamped to [0, 1].
//
// Rules:
// - hitRatio = cachedTokens / promptTokens, clamped into [0, 1]
// - promptTokens falsy (0/null/undefined) -> 0 when cachedTokens is known
//   (nothing was cached against any prompt)
// - cachedTokens null/undefined (provider did not report it) -> null, so
//   callers can omit the field rather than report a misleading zero.
function cacheStats({ promptTokens, cachedTokens } = {}) {
  if (cachedTokens === null || cachedTokens === undefined) {
    return { hitRatio: null };
  }
  if (!promptTokens) {
    return { hitRatio: 0 };
  }
  return { hitRatio: Math.min(1, Math.max(0, cachedTokens / promptTokens)) };
}

module.exports = { cacheStats };
