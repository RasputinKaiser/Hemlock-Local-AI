const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyInferenceError } = require("./error_taxonomy.cjs");

test("classifyInferenceError recognizes transport death in all its shapes", () => {
  for (const error of [
    new Error("terminated"),
    Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    Object.assign(new Error("request failed"), { code: "ECONNRESET" }),
    Object.assign(new Error("request failed"), { code: "UND_ERR_SOCKET" }),
    new Error("TypeError: fetch failed"),
    new Error("http: premature close"),
    Object.assign(new Error("pipe broken"), { code: "EPIPE" }),
  ]) {
    const result = classifyInferenceError(error);
    assert.equal(result.kind, "transport-death", `expected transport-death for ${error.message}`);
    assert.equal(result.retryable, true);
    assert.ok(result.userMessage.length > 0);
  }
});

test("classifyInferenceError recognizes first-token stall by watchdog code", () => {
  const error = new Error("first-token stall (no SSE bytes in 45s)");
  error.code = "MAPLE_FIRST_TOKEN_STALL";
  assert.deepEqual(
    { kind: classifyInferenceError(error).kind, retryable: classifyInferenceError(error).retryable },
    { kind: "stall", retryable: true },
  );
});

test("classifyInferenceError recognizes GPU server errors (HTTP 500 naming Metal)", () => {
  const error = Object.assign(new Error("Metal CommandBuffer execution failure"), { status: 500 });
  const result = classifyInferenceError(error);
  assert.equal(result.kind, "gpu-server-error");
  assert.equal(result.retryable, true);
});

test("classifyInferenceError does not treat non-GPU HTTP 500 as gpu-server-error", () => {
  const error = Object.assign(new Error("internal error"), { status: 502 });
  assert.equal(classifyInferenceError(error).kind, "unknown");
});

test("classifyInferenceError recognizes user cancellation", () => {
  const byCode = Object.assign(new Error("aborted"), { code: "CANCELLED" });
  const byReason = Object.assign(new Error("abort"), { reason: "cancelled" });
  for (const error of [byCode, byReason]) {
    const result = classifyInferenceError(error);
    assert.equal(result.kind, "cancelled-by-user");
    assert.equal(result.userMessage, "Cancelled.");
    assert.equal(result.retryable, false);
  }
});

test("classifyInferenceError recognizes invalid MLX checkpoints", () => {
  const result = classifyInferenceError(new Error("not a valid MLX checkpoint: weights missing"));
  assert.deepEqual({ kind: result.kind, retryable: result.retryable }, { kind: "model-invalid", retryable: false });
});

test("classifyInferenceError recognizes server-not-ready launch failures", () => {
  for (const message of ["server did not become ready in time", "server exited before becoming ready"]) {
    const result = classifyInferenceError(new Error(message));
    assert.deepEqual({ kind: result.kind, retryable: result.retryable }, { kind: "server-not-ready", retryable: false });
  }
});

test("classifyInferenceError classifies ordinary model errors as unknown and non-retryable", () => {
  const error = Object.assign(new Error("Maple-Preview returned HTTP 400"), { status: 400 });
  assert.deepEqual(
    { kind: classifyInferenceError(error).kind, retryable: classifyInferenceError(error).retryable },
    { kind: "unknown", retryable: false },
  );
});

test("classifyInferenceError survives null and garbage input as unknown", () => {
  for (const garbage of [null, undefined, 42, {}, "just a string", Symbol("x")]) {
    const result = classifyInferenceError(garbage);
    assert.equal(result.kind, "unknown");
    assert.equal(result.retryable, false);
    assert.equal(typeof result.userMessage, "string");
  }
});
