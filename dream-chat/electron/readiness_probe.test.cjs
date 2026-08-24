const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// T9-H1 readiness policy. Pure tests here; the wiring in main.cjs is guarded
// by source assertions at the bottom (main.cjs has no test export seam —
// same pattern as crash_policy.test.cjs).
const { nextReadinessDelay, classifyHealthFailure, missingCheckpointItem } = require(path.resolve(__dirname, "readiness_probe.cjs"));

test("nextReadinessDelay: exponential backoff growth", () => {
  const startedAt = Date.now();
  assert.equal(nextReadinessDelay({ attempt: 0, startedAt, timeoutMs: 60000 }).delayMs, 250);
  assert.equal(nextReadinessDelay({ attempt: 1, startedAt, timeoutMs: 60000 }).delayMs, 500);
  assert.equal(nextReadinessDelay({ attempt: 2, startedAt, timeoutMs: 60000 }).delayMs, 1000);
});

test("nextReadinessDelay: caps at 2000ms", () => {
  const startedAt = Date.now();
  for (const attempt of [3, 4, 10, 100]) {
    assert.equal(nextReadinessDelay({ attempt, startedAt, timeoutMs: 600000 }).delayMs, 2000);
  }
});

test("nextReadinessDelay: not done while inside the deadline", () => {
  const step = nextReadinessDelay({ attempt: 0, startedAt: Date.now(), timeoutMs: 60000 });
  assert.equal(step.done, false);
  assert.ok(step.delayMs > 0);
});

test("nextReadinessDelay: deadline triggers done with reason", () => {
  const step = nextReadinessDelay({ attempt: 0, startedAt: Date.now() - 60001, timeoutMs: 60000 });
  assert.equal(step.done, true);
  assert.equal(step.reason, "readiness deadline exceeded");
  assert.equal(step.delayMs, 0);
});

test("nextReadinessDelay: garbage input fails closed", () => {
  for (const garbage of [undefined, {}, null, { attempt: -1, startedAt: Date.now(), timeoutMs: 1000 }, { attempt: 1.5, startedAt: Date.now(), timeoutMs: 1000 }, { attempt: 0, startedAt: NaN, timeoutMs: 1000 }, { attempt: 0, startedAt: Date.now(), timeoutMs: 0 }, { attempt: 0, startedAt: Date.now() + 5000, timeoutMs: 1000 }]) {
    const step = nextReadinessDelay(garbage);
    assert.deepEqual(step, { done: true, delayMs: 0, reason: "invalid probe state" }, `expected invalid probe state for ${JSON.stringify(garbage)}`);
  }
});

test("classifyHealthFailure: ECONNREFUSED (direct and undici cause)", () => {
  assert.equal(classifyHealthFailure({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8080" }), "connection-refused");
  assert.equal(classifyHealthFailure({ message: "fetch failed", cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } }), "connection-refused");
});

test("classifyHealthFailure: abort / timeout variants", () => {
  assert.equal(classifyHealthFailure({ name: "AbortError", code: "ABORT_ERR", message: "This operation was aborted" }), "timeout");
  assert.equal(classifyHealthFailure({ code: "ETIMEDOUT", message: "request timed out" }), "timeout");
  assert.equal(classifyHealthFailure({ code: "UND_ERR_ABORTED", message: "Request aborted" }), "timeout");
  assert.equal(classifyHealthFailure(new Error("socket hang up on timeout")), "timeout");
});

test("classifyHealthFailure: http status >= 400", () => {
  assert.equal(classifyHealthFailure({ status: 404, message: "Maple-Preview health returned HTTP 404" }), "http-error");
  assert.equal(classifyHealthFailure({ status: 502, message: "bad gateway" }), "http-error");
  assert.equal(classifyHealthFailure({ message: "health returned HTTP 500" }), "http-error");
});

test("classifyHealthFailure: unknown and non-object inputs", () => {
  assert.equal(classifyHealthFailure(new Error("something exploded")), "unknown");
  assert.equal(classifyHealthFailure(null), "unknown");
  assert.equal(classifyHealthFailure(undefined), "unknown");
  assert.equal(classifyHealthFailure("fetch failed"), "unknown");
});

test("missingCheckpointItem: valid MLX checkpoint passes", () => {
  assert.equal(missingCheckpointItem(["config.json", "model.safetensors", "tokenizer.model"]), null);
  assert.equal(missingCheckpointItem(["config.json", "model-00001-of-00002.safetensors"]), null);
});

test("missingCheckpointItem: names what is missing", () => {
  assert.equal(missingCheckpointItem(["tokenizer.model"]), "config.json");
  assert.equal(missingCheckpointItem(["config.json", "README.md"]), "safetensors weights");
  assert.equal(missingCheckpointItem([]), "config.json");
  assert.equal(missingCheckpointItem(undefined), "config.json");
});

// Source assertions on main.cjs wiring (no test seam in the Electron entry).
test("main.cjs wires readiness helpers into the spawn/readiness region", () => {
  const source = require("node:fs").readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  assert.match(source, /require\("\.\/readiness_probe\.cjs"\)/);
  assert.match(source, /nextReadinessDelay\(/);
  assert.match(source, /classifyHealthFailure\(lastError\)/);
  assert.match(source, /\[hemlock\] Maple health check waiting: /);
  assert.match(source, /did not become ready \(last: \$\{classifyHealthFailure\(lastError\)\}\)/);
  assert.match(source, /is not a valid MLX checkpoint/);
});
