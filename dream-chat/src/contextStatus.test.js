import test from "node:test";
import assert from "node:assert/strict";
import { contextStatus } from "./contextStatus.js";

test("no quality data means no chip", () => {
  assert.equal(contextStatus({}), null);
  assert.equal(contextStatus({ contextSnapshot: null, agentProjection: null }), null);
  assert.equal(contextStatus({ contextSnapshot: { quality: null } }), null);
});

test("fresh quality with full coverage stays quiet", () => {
  const snapshot = { quality: { status: "fresh", sourceCoverage: 1, requiresRefresh: false } };
  assert.equal(contextStatus({ contextSnapshot: snapshot }), null);
});

test("stale, needs-refresh, and zero coverage all surface the chip", () => {
  for (const quality of [
    { status: "stale", sourceCoverage: 0.5 },
    { status: "needs-refresh", sourceCoverage: 0 },
    { status: "fresh", requiresRefresh: true },
    { status: "fresh", sourceCoverage: 0 },
  ]) {
    const chip = contextStatus({ contextSnapshot: { quality } });
    assert.ok(chip, JSON.stringify(quality));
    assert.match(chip.label, /context/);
    assert.match(chip.title, /Settings/);
  }
});

test("needs-refresh and zero coverage label differently from plain stale", () => {
  assert.equal(
    contextStatus({ contextSnapshot: { quality: { status: "needs-refresh" } } }).label,
    "context needs refresh",
  );
  assert.equal(
    contextStatus({ contextSnapshot: { quality: { status: "stale", sourceCoverage: 0.5 } } }).label,
    "context stale",
  );
});

test("falls back to the projection quality and formats the title", () => {
  const chip = contextStatus({
    agentProjection: { contextQuality: { status: "stale", sourceCoverage: 0.25, freshnessSeconds: 1900 } },
  });
  assert.equal(chip.status, "stale");
  assert.equal(chip.coverage, 0.25);
  assert.match(chip.title, /source coverage 25%/);
  assert.match(chip.title, /32m old/);
});
