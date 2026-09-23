import test from "node:test";
import assert from "node:assert/strict";
import { groupEvidence, receiptTargetWindow } from "./evidenceLedger.js";

test("groups receipts by type prefix, newest item first, with counts", () => {
  const receipts = [
    { id: "a", type: "command.completed", createdAt: "2026-08-22T10:00:00Z" },
    { id: "b", type: "context.refreshed", createdAt: "2026-08-22T11:00:00Z" },
    { id: "c", type: "command.failed", createdAt: "2026-08-22T12:00:00Z" },
    { id: "d", createdAt: "2026-08-22T09:00:00Z" },
  ];
  const groups = groupEvidence(receipts);
  assert.deepEqual(groups.map((group) => [group.prefix, group.count]), [
    ["command", 2],
    ["context", 1],
    ["event", 1],
  ]);
  assert.equal(groups[0].latest.id, "c");
  assert.deepEqual(groups[0].items.map((item) => item.id), ["c", "a"]);
  assert.equal(groups[1].items.length, 1);
});

test("orders groups by their newest receipt, not by insertion order", () => {
  const groups = groupEvidence([
    { id: "old", type: "artifact.written", createdAt: "2026-08-20T09:00:00Z" },
    { id: "new", type: "thread.searched", createdAt: "2026-08-22T12:30:00Z" },
  ]);
  assert.deepEqual(groups.map((group) => group.prefix), ["thread", "artifact"]);
});

test("tolerates empty and malformed input", () => {
  assert.deepEqual(groupEvidence([]), []);
  assert.deepEqual(groupEvidence(null), []);
  assert.deepEqual(groupEvidence([null, undefined]), []);
});

test("receiptTargetWindow deep-links to the window that owns the evidence", () => {
  assert.equal(receiptTargetWindow({ type: "experiment.completed", refs: ["/tmp/experiment-dataset.jsonl"] }), "grove");
  assert.equal(receiptTargetWindow({ type: "dream.completed", refs: ["/tmp/dream-run/receipt.json"] }), "dream");
  assert.equal(receiptTargetWindow({ type: "sips.cycle.completed", refs: ["/tmp/sips/cycle/receipt.json"] }), "sips");
  assert.equal(receiptTargetWindow({ type: "shell.exec.completed", refs: ["/tmp/exec.json"] }), "activity");
  assert.equal(receiptTargetWindow({ type: "memory.promoted", refs: [] }), "memory");
  assert.equal(receiptTargetWindow({ type: "artifact.revision.created", refs: ["/tmp/artifacts/a"] }), "artifact");
});

test("receiptTargetWindow returns null when nothing matches unambiguously", () => {
  assert.equal(receiptTargetWindow({ type: "session.started", refs: [] }), null);
  assert.equal(receiptTargetWindow({}), null);
  assert.equal(receiptTargetWindow(null), null);
});
