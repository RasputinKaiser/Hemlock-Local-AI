const test = require("node:test");
const assert = require("node:assert/strict");
const { Utf8SseParser, parseSsePayload, extractModelDelta, digest } = require("./stream_protocol.cjs");

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

test("digest is stable and names the algorithm", () => {
  assert.match(digest("Hemlock"), /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest("Hemlock"), digest("Hemlock"));
});
