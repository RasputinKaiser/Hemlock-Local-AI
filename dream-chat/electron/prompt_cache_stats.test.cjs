"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { cacheStats } = require("./prompt_cache_stats.cjs");

test("full cache hit reports ratio 1", () => {
  assert.equal(cacheStats({ promptTokens: 100, cachedTokens: 100 }).hitRatio, 1);
});

test("zero cache hit reports ratio 0", () => {
  assert.equal(cacheStats({ promptTokens: 100, cachedTokens: 0 }).hitRatio, 0);
});

test("missing cachedTokens reports null ratio", () => {
  assert.equal(cacheStats({ promptTokens: 100, cachedTokens: null }).hitRatio, null);
  assert.equal(cacheStats({ promptTokens: 100 }).hitRatio, null);
});

test("falsy promptTokens with known cachedTokens reports ratio 0", () => {
  assert.equal(cacheStats({ promptTokens: 0, cachedTokens: 50 }).hitRatio, 0);
  assert.equal(cacheStats({ promptTokens: null, cachedTokens: 50 }).hitRatio, 0);
});

test("ratio clamps to 1 when cachedTokens exceeds promptTokens", () => {
  assert.equal(cacheStats({ promptTokens: 10, cachedTokens: 25 }).hitRatio, 1);
});

test("partial hits land between 0 and 1", () => {
  assert.equal(cacheStats({ promptTokens: 200, cachedTokens: 50 }).hitRatio, 0.25);
});

const { aggregateCacheStats } = require("./prompt_cache_stats.cjs");

test("aggregateCacheStats sums normalized and raw usage shapes", () => {
  const stats = aggregateCacheStats([
    { promptTokens: 100, cachedTokens: 40 },
    { prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } },
    { prompt_tokens: 50, cached_tokens: 25 },
  ]);
  assert.equal(stats.samples, 3);
  assert.equal(stats.cacheReports, 3);
  assert.equal(stats.promptTokens, 350);
  assert.equal(stats.cachedTokens, 165);
  assert.ok(Math.abs(stats.hitRatio - 165 / 350) < 1e-9);
});

test("aggregateCacheStats reports null ratio when no entry reports cache info", () => {
  const stats = aggregateCacheStats([{ promptTokens: 100 }, { prompt_tokens: 50 }]);
  assert.equal(stats.hitRatio, null);
  assert.equal(stats.cacheReports, 0);
  // One reporting entry is enough for a real ratio.
  assert.equal(aggregateCacheStats([{ promptTokens: 100 }, { promptTokens: 100, cachedTokens: 50 }]).hitRatio, 0.25);
});

test("aggregateCacheStats handles empty and garbage input", () => {
  assert.deepEqual(aggregateCacheStats([]), { samples: 0, cacheReports: 0, promptTokens: 0, cachedTokens: 0, hitRatio: null });
  assert.equal(aggregateCacheStats(null).hitRatio, null);
  assert.doesNotThrow(() => aggregateCacheStats([null, "junk", { cachedTokens: "abc" }]));
  // A known cached count with no prompt tokens is a real zero, not null.
  assert.equal(aggregateCacheStats([{ cachedTokens: 10 }]).hitRatio, 0);
});
