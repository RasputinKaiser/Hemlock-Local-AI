"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  COMPARISON_SCHEMA,
  COMPARISON_PROVIDERS,
  canRunComparison,
  lastUserMessage,
  buildComparisonRecord,
} = require("./comparison_lane.cjs");

test("canRunComparison accepts a distinct, supported target lane", () => {
  const guard = canRunComparison({ inFlight: false, targetProvider: "codex", currentProvider: "maple" });
  assert.equal(guard.ok, true);
  assert.equal(guard.targetProvider, "codex");
});

test("canRunComparison rejects the current provider", () => {
  const guard = canRunComparison({ inFlight: false, targetProvider: "maple", currentProvider: "maple" });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /must differ/);
});

test("canRunComparison rejects unsupported lanes", () => {
  for (const target of ["", "gpt", "Maple"]) {
    const guard = canRunComparison({ inFlight: false, targetProvider: target, currentProvider: "codex" });
    assert.equal(guard.ok, false);
    assert.match(guard.reason, /Unsupported comparison lane/);
  }
  assert.deepEqual(COMPARISON_PROVIDERS, ["maple", "codex", "claude"]);
});

test("canRunComparison serializes: only one comparison in flight", () => {
  const guard = canRunComparison({ inFlight: true, targetProvider: "claude", currentProvider: "maple" });
  assert.equal(guard.ok, false);
  assert.equal(guard.reason, "A comparison is already running");
});

test("lastUserMessage returns the newest user turn verbatim or null", () => {
  const conversation = [
    { role: "user", content: "first prompt" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second prompt  \n" },
    { role: "assistant", content: "final reply" },
  ];
  assert.equal(lastUserMessage(conversation), "second prompt");
  assert.equal(lastUserMessage([{ role: "assistant", content: "only model output" }]), null);
  assert.equal(lastUserMessage([]), null);
  assert.equal(lastUserMessage(undefined), null);
});

test("buildComparisonRecord pins the comparison schema and fields", () => {
  const record = buildComparisonRecord({
    targetProvider: "claude",
    answer: "verbatim answer",
    telemetry: { elapsedMs: 1200, completionTokens: 40 },
  });
  assert.equal(record.schema, COMPARISON_SCHEMA);
  assert.equal(record.schema, "hemlock.agent.comparison.v1");
  assert.equal(record.targetProvider, "claude");
  assert.equal(record.answer, "verbatim answer");
  assert.equal(record.telemetry.completionTokens, 40);
  assert.ok(!Number.isNaN(Date.parse(record.ranAt)));
  // Telemetry is optional and must never be fabricated.
  assert.equal(buildComparisonRecord({ targetProvider: "codex" }).telemetry, null);
});

test("buildComparisonRecord pins the exact promptText (T7-S4 FIX 1)", () => {
  const record = buildComparisonRecord({
    targetProvider: "codex",
    promptText: "the exact prompt that was re-run",
    answer: "lane answer",
    contextApplied: true,
  });
  assert.equal(record.promptText, "the exact prompt that was re-run");
  assert.equal(record.contextApplied, true);
  // Absent inputs stay honestly empty/false — never fabricated.
  const bare = buildComparisonRecord({ targetProvider: "codex" });
  assert.equal(bare.promptText, "");
  assert.equal(bare.contextApplied, false);
  // Non-boolean contextApplied coerces instead of passing through arbitrary values.
  assert.equal(buildComparisonRecord({ targetProvider: "codex", contextApplied: "yes" }).contextApplied, true);
});
