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
