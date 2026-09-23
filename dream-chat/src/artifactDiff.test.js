import test from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffFile, diffFiles } from "./artifactDiff.js";

test("inserted lines produce only additions, not phantom remove/add pairs", () => {
  const ops = diffLines("a\nb\nc", "a\nX\nb\nc");
  assert.deepEqual(ops.map((op) => op.type), ["same", "added", "same", "same"]);
  assert.equal(ops.filter((op) => op.type === "removed").length, 0);
});

test("deleted lines produce only removals", () => {
  const ops = diffLines("a\nb\nc\nd", "a\nd");
  assert.deepEqual(ops.map((op) => op.type), ["same", "removed", "removed", "same"]);
});

test("changed region reports removed-then-added within the same hunk", () => {
  const ops = diffLines("head\nold one\nold two\ntail", "head\nnew\ntail");
  const middle = ops.filter((op) => op.type !== "same");
  assert.deepEqual(middle.map((op) => op.type), ["removed", "removed", "added"]);
  assert.equal(ops.at(0).type, "same");
  assert.equal(ops.at(-1).type, "same");
});

test("line numbers stay aligned to each side", () => {
  const ops = diffLines("a\nb\nc", "a\nx\nc");
  const removed = ops.find((op) => op.type === "removed");
  const added = ops.find((op) => op.type === "added");
  assert.equal(removed.before, 2);
  assert.equal(added.after, 2);
  assert.equal(ops.at(-1).after, 3);
});

test("identical inputs are all same ops", () => {
  const ops = diffLines("x\ny", "x\ny");
  assert.ok(ops.every((op) => op.type === "same"));
  assert.equal(ops.length, 2);
});

test("diffFile handles added and deleted files", () => {
  const added = diffFile({ file: "new.css", before: null, after: "a\nb" });
  assert.equal(added.isNew, true);
  assert.equal(added.added, 2);
  const deleted = diffFile({ file: "old.js", before: "x", after: null });
  assert.equal(deleted.isDeleted, true);
  assert.equal(deleted.removed, 1);
  const untouched = diffFile({ file: "same.txt", before: "v", after: "v" });
  assert.equal(untouched.changed, false);
});

test("diffFiles tolerates missing or empty input", () => {
  assert.deepEqual(diffFiles(null), []);
  assert.equal(diffFiles([{ file: "f", before: "a", after: "b" }])[0].changed, true);
});

test("oversized middles fall back to a replace block without crashing", () => {
  const before = Array.from({ length: 700 }, (_, i) => `b${i}`).join("\n");
  const after = Array.from({ length: 700 }, (_, i) => `a${i}`).join("\n");
  const ops = diffLines(before, after);
  assert.ok(ops.some((op) => op.type === "removed"));
  assert.ok(ops.some((op) => op.type === "added"));
});
