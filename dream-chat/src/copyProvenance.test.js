import test from "node:test";
import assert from "node:assert/strict";
import { withProvenance } from "./copyProvenance.js";

test("builds a provenance header from provider short label, time, and thread title", () => {
  const result = withProvenance(
    { role: "assistant", provider: "maple", time: "14:02", content: "Hello there.\nSecond line." },
    { threadTitle: "Hemlock thread", providerLabel: "MAPLE" },
  );
  assert.equal(result, "[MAPLE · 14:02 · Hemlock thread]\n\nHello there.\nSecond line.");
});

test("appends rawOutputRef to the header when present", () => {
  const result = withProvenance(
    { provider: "codex", time: "09:15", content: "Done.", rawOutputRef: "raw://resp_42" },
    { threadTitle: "Refactor plan", providerLabel: "CODEX" },
  );
  assert.equal(result, "[CODEX · 09:15 · Refactor plan · raw://resp_42]\n\nDone.");
});

test("degrades gracefully: omits missing time, title, and rawOutputRef instead of inventing them", () => {
  assert.equal(withProvenance({ content: "Just text." }, {}), "[Unknown]\n\nJust text.");
  assert.equal(
    withProvenance({ time: "11:00", content: "Hi." }, { providerLabel: "CLAUDE" }),
    "[CLAUDE · 11:00]\n\nHi.",
  );
});

test("falls back to the content channel when message.content is empty, and returns empty string for empty messages", () => {
  const viaChannel = withProvenance(
    { channels: [{ name: "reasoning", text: "hidden" }, { name: "content", source: "maple", text: "Visible answer." }] },
    { providerLabel: "MAPLE", threadTitle: "Thread" },
  );
  assert.equal(viaChannel, "[MAPLE · Thread]\n\nVisible answer.");
  assert.equal(withProvenance({ content: "   " }, { providerLabel: "MAPLE" }), "");
  assert.equal(withProvenance(null, {}), "");
});
