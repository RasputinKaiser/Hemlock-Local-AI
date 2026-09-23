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

// Sum per-request usage into session totals so a Dream/SIPS receipt can carry
// one honest hit ratio instead of a per-message field the reader must
// recompute. Accepts both the normalized shape ({promptTokens, cachedTokens})
// and the raw OpenAI/MLX shape ({prompt_tokens, prompt_tokens_details:
// {cached_tokens}, cached_tokens}). Entries that never reported a cached
// count don't poison the ratio — hitRatio is null only when NO entry
// reported cache info at all.
function aggregateCacheStats(usages) {
  const list = Array.isArray(usages) ? usages : [];
  let promptTokens = 0;
  let cachedTokens = 0;
  let cacheReports = 0;
  for (const usage of list) {
    const u = usage && typeof usage === "object" ? usage : {};
    const prompt = Number(u.promptTokens ?? u.prompt_tokens ?? u.input_tokens);
    if (Number.isFinite(prompt) && prompt > 0) promptTokens += prompt;
    const cached = u.cachedTokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens;
    if (cached !== null && cached !== undefined && Number.isFinite(Number(cached))) {
      cachedTokens += Number(cached);
      cacheReports += 1;
    }
  }
  return {
    samples: list.length,
    cacheReports,
    promptTokens,
    cachedTokens,
    hitRatio: cacheReports ? (promptTokens ? Math.min(1, Math.max(0, cachedTokens / promptTokens)) : 0) : null,
  };
}

module.exports = { cacheStats, aggregateCacheStats };
