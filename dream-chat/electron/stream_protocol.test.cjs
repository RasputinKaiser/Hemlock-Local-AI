const test = require("node:test");
const assert = require("node:assert/strict");
const { Utf8SseParser, parseSsePayload, extractModelDelta, compactModelPayload, selectStructuredActionText, streamStateSnapshot, digest } = require("./stream_protocol.cjs");

test("parses split UTF-8 and SSE boundaries through DONE", () => {
  const parser = new Utf8SseParser();
  const text = "data: {\"choices\":[{\"delta\":{\"content\":\"caf";
  const bytes = new TextEncoder().encode("é\"}}]}\n\ndata: [DONE]\n\n");
  const first = parser.push(text);
  const second = parser.push(bytes.slice(0, 1));
  const third = parser.push(bytes.slice(1), { final: true });
  const events = [...first, ...second, ...third].map(parseSsePayload);
  assert.equal(events[0].payload.choices[0].delta.content, "café");
  assert.equal(events.at(-1).done, true);
});

test("preserves every string model channel alongside visible content", () => {
  const delta = extractModelDelta({ choices: [{ delta: { reasoning: "private", content: "visible" }, finish_reason: null }] });
  assert.equal(delta.text, "visible");
  assert.deepEqual(delta.channels, [
    { name: "reasoning", text: "private" },
    { name: "content", text: "visible" },
  ]);
  assert.equal(delta.finishReason, null);
  assert.equal(delta.usage, null);
});

test("treats repeated assistant role metadata as non-output", () => {
  const delta = extractModelDelta({ choices: [{ delta: { role: "assistant", reasoning: "thinking", content: "visible" }, finish_reason: null }] });
  assert.deepEqual(delta.channels, [
    { name: "reasoning", text: "thinking" },
    { name: "content", text: "visible" },
  ]);
});

test("compacts streamed payloads without dropping reasoning or content deltas", () => {
  const compact = compactModelPayload({
    id: "chat-1",
    model: "maple",
    choices: [{ delta: { role: "assistant", reasoning: "step", content: "json" }, finish_reason: null }],
  });
  assert.deepEqual(compact, {
    id: "chat-1",
    model: "maple",
    choices: [{ delta: { reasoning: "step", content: "json" } }],
  });
});

test("recovers an action envelope emitted in the reasoning channel", () => {
  const selected = selectStructuredActionText({
    role: "assistant",
    reasoning: 'I will select the next step. {"schema":"hemlock.agent.action.v1","commandId":"repo-map"}',
  });
  assert.equal(selected.channel, "reasoning");
  assert.match(selected.text, /hemlock\.agent\.action\.v1/);
});

test("serializes active stream state without leaking controllers or coalescer functions", () => {
  const snapshot = streamStateSnapshot({
    streamId: "stream-1",
    taskId: "task-1",
    kind: "agent_action",
    provider: "maple",
    sequence: 3,
    text: "visible",
    channels: { content: "visible", reasoning: "thinking" },
    terminal: false,
    startedAt: 1,
    frameCoalescer: { flush() {} },
    controller: { abort() {} },
  });
  assert.deepEqual(snapshot.channels, { content: "visible", reasoning: "thinking" });
  assert.equal("frameCoalescer" in snapshot, false);
  assert.equal("controller" in snapshot, false);
  assert.doesNotThrow(() => structuredClone(snapshot));
});

test("digest is stable and names the algorithm", () => {
  assert.match(digest("Hemlock"), /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest("Hemlock"), digest("Hemlock"));
});
