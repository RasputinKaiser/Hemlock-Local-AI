const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSelection,
  parseCodexEvent,
  parseClaudeEvent,
  parseProviderLine,
} = require("./provider_adapters.cjs");

test("normalizes provider defaults without accepting an unknown provider", () => {
  assert.deepEqual(normalizeSelection({}), {
    provider: "maple",
    model: "default_model",
    reasoning: "native",
    label: "Maple-Preview",
    shortLabel: "MAPLE",
    kind: "local",
  });
  assert.equal(normalizeSelection({ provider: "not-a-provider" }).provider, "maple");
  assert.equal(normalizeSelection({ provider: "codex", reasoning: "xhigh" }).provider, "codex");
  assert.equal(normalizeSelection({ provider: "codex", reasoning: "xhigh" }).reasoning, "xhigh");
  assert.equal(normalizeSelection({ provider: "claude", model: "opus", reasoning: "max" }).model, "opus");
});

test("parses Codex JSONL deltas and avoids duplicating the completed agent message", () => {
  const state = { text: "" };
  assert.equal(parseCodexEvent({ type: "item.delta", delta: "hello" }, state).delta, "hello");
  assert.equal(parseCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "hello world" } }, state).delta, " world");
  assert.equal(parseCodexEvent({ type: "turn.completed", usage: { input_tokens: 2 } }, state).done, true);
  assert.equal(state.text, "hello world");
});

test("parses Claude stream-json text deltas and final result", () => {
  const state = { text: "" };
  assert.equal(parseClaudeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } }, state).delta, "hello");
  assert.equal(parseClaudeEvent({ type: "result", result: "hello world" }, state).delta, " world");
  assert.equal(state.text, "hello world");
});

test("blocks Claude result events that report authentication failure", () => {
  const parsed = parseClaudeEvent({ type: "result", is_error: true, api_error_status: 401, result: "OAuth access token has been revoked." });
  assert.match(parsed.error, /revoked/);
});

test("keeps an unstructured CLI line usable as a bounded final response", () => {
  assert.deepEqual(parseProviderLine("claude", "plain output"), { delta: "plain output", event: null });
});
