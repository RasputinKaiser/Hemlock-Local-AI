import test from "node:test";
import assert from "node:assert/strict";
import {
  eventSearchText,
  filterTranscript,
  highlightSegments,
  matchesQuery,
  messageKind,
  messageSearchText,
  normalizeQuery,
  SEARCH_KINDS,
} from "./transcriptSearch.js";

test("normalizeQuery trims and tolerates junk", () => {
  assert.equal(normalizeQuery("  retry  "), "retry");
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery(null), "");
  assert.equal(normalizeQuery(42), "42");
});

test("messageKind buckets user/model/host honestly", () => {
  assert.equal(messageKind({ role: "user" }), "you");
  assert.equal(messageKind({ role: "assistant" }), "model");
  assert.equal(messageKind({ role: "system", kind: "host-footnote" }), "host");
  assert.equal(messageKind({}), "host");
});

test("messageSearchText covers content and every channel", () => {
  const text = messageSearchText({
    role: "assistant",
    provider: "maple",
    content: "fallback",
    channels: [{ name: "reasoning", text: "thinking about hemlocks" }, { name: "content", text: "the answer" }],
  });
  assert.ok(text.includes("the answer"));
  assert.ok(text.includes("thinking about hemlocks"));
  assert.ok(text.includes("maple"));
});

test("eventSearchText covers type, note, command, scalars, and evidence refs", () => {
  const text = eventSearchText(
    {
      type: "action.scored",
      status: "recorded",
      payload: { commandId: "code.apply", margin: 1.2, nested: { skip: true }, command: "verify" },
      evidenceRefs: ["receipt://code-apply"],
    },
    "chose a step",
  );
  for (const part of ["action.scored", "chose a step", "code.apply", "verify", "1.2", "receipt://code-apply"]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes("skip"), "nested objects stay out of the searchable text");
});

test("matchesQuery is case-insensitive and empty-query permissive", () => {
  assert.equal(matchesQuery("Hello Hemlock", "hemlock"), true);
  assert.equal(matchesQuery("Hello", "absent"), false);
  assert.equal(matchesQuery("anything", "  "), true);
  assert.equal(matchesQuery(null, "x"), false);
});

test("filterTranscript is inactive without query or kind", () => {
  const result = filterTranscript({ messages: [{ role: "user", content: "hi" }], events: [] });
  assert.equal(result.active, false);
  assert.equal(result.total, 1);
});

test("filterTranscript matches messages by text and events by note/type", () => {
  const messages = [
    { id: "u1", role: "user", content: "build a lantern" },
    { id: "a1", role: "assistant", content: "here is the lantern" },
    { id: "u2", role: "user", content: "now make it glow" },
  ];
  const events = [
    { id: "e1", type: "plan.proposed", createdAt: "t" },
    { id: "e2", type: "action.scored", payload: { commandId: "artifact.author" } },
  ];
  const result = filterTranscript({
    messages,
    events,
    query: "lantern",
    eventText: (event) => (event.id === "e1" ? "bounded plan proposed" : ""),
  });
  assert.equal(result.active, true);
  assert.deepEqual([...result.messageIndexes], [0, 1]);
  assert.equal(result.eventIds.has("e2"), false);
  const planHit = filterTranscript({ messages: [], events, query: "bounded", eventText: (event) => (event.id === "e1" ? "bounded plan proposed" : "") });
  assert.equal(planHit.eventIds.has("e1"), true);
});

test("kind filters restrict which row families can match", () => {
  const messages = [
    { role: "user", content: "shared word" },
    { role: "assistant", content: "shared word" },
    { role: "system", kind: "host-footnote", content: "shared word" },
  ];
  const events = [{ id: "e1", type: "task.paused", payload: { reason: "shared word" } }];
  const you = filterTranscript({ messages, events, query: "shared", kind: "you" });
  assert.deepEqual([...you.messageIndexes], [0]);
  assert.equal(you.eventIds.size, 0);
  const host = filterTranscript({ messages, events, query: "shared", kind: "host" });
  assert.deepEqual([...host.messageIndexes], [2]);
  assert.equal(host.eventIds.has("e1"), true);
  const model = filterTranscript({ messages, events, query: "shared", kind: "model" });
  assert.deepEqual([...model.messageIndexes], [1]);
});

test("kind-only filtering works with an empty query", () => {
  const result = filterTranscript({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], query: "", kind: "model" });
  assert.equal(result.active, true);
  assert.deepEqual([...result.messageIndexes], [1]);
});

test("unknown kinds degrade to all; events without ids still filter", () => {
  const events = [{ type: "task.blocked", payload: { reason: "needs input" } }];
  const result = filterTranscript({ messages: [], events, query: "needs", kind: "bogus" });
  assert.equal(result.eventIds.has(events[0]), true);
});

test("highlightSegments splits on case-insensitive matches", () => {
  assert.deepEqual(highlightSegments("no query", ""), [{ text: "no query", match: false }]);
  assert.deepEqual(highlightSegments("a LANTERN and a lantern", "lantern"), [
    { text: "a ", match: false },
    { text: "LANTERN", match: true },
    { text: " and a ", match: false },
    { text: "lantern", match: true },
  ]);
  assert.deepEqual(highlightSegments("abc", "abc"), [{ text: "abc", match: true }]);
  assert.deepEqual(highlightSegments(null, "x"), [{ text: "", match: false }]);
});

test("SEARCH_KINDS stays a stable chip order", () => {
  assert.deepEqual(SEARCH_KINDS, ["all", "you", "model", "host"]);
});
