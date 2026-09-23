"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { firstTokenWatchdog, DEFAULT_STALL_MS } = require("./stream_watchdog.cjs");

test("stalled exactly at the boundary (>= stallMs)", () => {
  const result = firstTokenWatchdog({ now: 1000 + DEFAULT_STALL_MS, startedAt: 1000, firstByteAt: null, stallMs: DEFAULT_STALL_MS });
  assert.equal(result.stalled, true);
});

test("not stalled before the boundary", () => {
  const result = firstTokenWatchdog({ now: 1000 + DEFAULT_STALL_MS - 1, startedAt: 1000, firstByteAt: null, stallMs: DEFAULT_STALL_MS });
  assert.equal(result.stalled, false);
});

test("bytes arrived -> never stalled", () => {
  const result = firstTokenWatchdog({ now: 1000 + DEFAULT_STALL_MS + 1000, startedAt: 1000, firstByteAt: 1005, stallMs: DEFAULT_STALL_MS });
  assert.equal(result.stalled, false);
});

test("null startedAt -> not stalled", () => {
  const result = firstTokenWatchdog({ now: 1000000, startedAt: null, firstByteAt: null, stallMs: DEFAULT_STALL_MS });
  assert.equal(result.stalled, false);
});
