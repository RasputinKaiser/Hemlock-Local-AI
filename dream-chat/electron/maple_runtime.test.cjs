const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAPLE_LAUNCH_SCHEMA,
  compactInferenceMessages,
  createMapleLaunchResult,
  isMapleTransportError,
} = require("./maple_runtime.cjs");

test("Maple conversation compaction preserves the latest request while bounding prior history", () => {
  const messages = [
    { role: "system", content: "local context" },
    { role: "user", content: "old request ".repeat(2000) },
    { role: "assistant", content: "old answer ".repeat(2000) },
    { role: "user", content: "latest request" },
  ];
  const compacted = compactInferenceMessages(messages, { maxMessages: 8, maxChars: 1000 });
  assert.equal(compacted.at(-1).content, "latest request");
  assert.equal(compacted[0].role, "system");
  assert.ok(compacted.reduce((total, message) => total + message.content.length, 0) <= 1000);
});

test("Maple transport recovery recognizes dead local sockets but not model HTTP errors", () => {
  assert.equal(isMapleTransportError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
  assert.equal(isMapleTransportError(Object.assign(new Error("Maple-Preview returned HTTP 400"), { status: 400 })), false);
});

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

test("Compaction keeps a trailing assistant reply after the latest user message", () => {
  // Regression (T6-G2): a thread ending in an assistant reply used to lose that
  // reply even with a huge char budget — the history walk stopped at the
  // latest user message. The answer to the question in the prompt must stay.
  const thread = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello there, this is the reply" },
  ];
  const compacted = compactInferenceMessages(thread);
  assert.deepEqual(compacted, thread);
  // Same guarantee under a tight-but-sufficient budget.
  const tight = compactInferenceMessages(thread, { maxMessages: 4, maxChars: 500 });
  assert.deepEqual(tight, thread);
});
