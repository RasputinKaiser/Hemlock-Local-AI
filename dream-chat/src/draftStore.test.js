import test from "node:test";
import assert from "node:assert/strict";
import { clearDraft, draftKey, DRAFT_KEY_PREFIX, readDraft, writeDraft } from "./draftStore.js";

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

test("draftKey namespaces drafts per thread", () => {
  assert.equal(draftKey("t-1"), `${DRAFT_KEY_PREFIX}t-1`);
  assert.equal(draftKey(null), `${DRAFT_KEY_PREFIX}`);
});

test("write/read round-trips a draft; blank clears the key", () => {
  const storage = fakeStorage();
  assert.equal(writeDraft(storage, "t-1", "  remember this "), true);
  assert.equal(readDraft(storage, "t-1"), "  remember this ");
  writeDraft(storage, "t-1", "   ");
  assert.equal(readDraft(storage, "t-1"), "");
  assert.equal(storage.map.has(draftKey("t-1")), false, "blank drafts remove the key, clearing on send");
});

test("clearDraft removes a stored draft", () => {
  const storage = fakeStorage();
  writeDraft(storage, "t-2", "draft");
  clearDraft(storage, "t-2");
  assert.equal(readDraft(storage, "t-2"), "");
});

test("threads are isolated and missing storage degrades quietly", () => {
  const storage = fakeStorage();
  writeDraft(storage, "a", "alpha");
  writeDraft(storage, "b", "beta");
  assert.equal(readDraft(storage, "a"), "alpha");
  assert.equal(readDraft(storage, "b"), "beta");
  assert.equal(readDraft(null, "a"), "");
  assert.equal(readDraft(storage, null), "");
  assert.equal(writeDraft(null, "a", "x"), false);
  assert.equal(writeDraft(storage, "", "x"), false);
});

test("a throwing storage object never breaks the composer", () => {
  const hostile = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  assert.equal(readDraft(hostile, "t"), "");
  assert.equal(writeDraft(hostile, "t", "x"), false);
  assert.equal(clearDraft(hostile, "t"), false);
});
