const test = require("node:test");
const assert = require("node:assert/strict");
const { MAPLE_LAUNCH_SCHEMA, createMapleLaunchResult } = require("./maple_runtime.cjs");

test("Maple launch receipt separates process health from inference", () => {
  const result = createMapleLaunchResult({ startedAt: Date.now() - 5, server: { processReady: true, inferenceReady: false, adapterPath: "" } });
  assert.equal(result.schema, MAPLE_LAUNCH_SCHEMA);
  assert.equal(result.status, "ready");
  assert.equal(result.processReady, true);
  assert.equal(result.inferenceReady, false);
  assert.match(result.claimBoundary, /does not run an inference request/);
});

test("Maple launch receipt records startup failure without claiming readiness", () => {
  const error = Object.assign(new Error("model missing"), { code: "ENOENT", signal: "SIGTERM" });
  const result = createMapleLaunchResult({ server: { processReady: false, inferenceReady: false }, error });
  assert.equal(result.status, "failed");
  assert.equal(result.processReady, false);
  assert.equal(result.inferenceReady, false);
  assert.equal(result.error, "model missing");
  assert.equal(result.errorCode, "ENOENT");
  assert.equal(result.errorSignal, "SIGTERM");
});
