import test from "node:test";
import assert from "node:assert/strict";
import { pushNotice, dismissNotice, MAX_NOTICES } from "./noticeStack.js";

test("pushNotice stacks newest first and caps the list", () => {
  let list = [];
  for (let i = 0; i < 5; i += 1) list = pushNotice(list, { text: `n${i}` });
  assert.equal(list.length, MAX_NOTICES);
  assert.equal(list[0].text, "n4");
});

test("consecutive duplicates bump the count instead of stacking", () => {
  let list = pushNotice([], { text: "same" });
  list = pushNotice(list, { text: "same" });
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  list = pushNotice(list, { text: "other" });
  list = pushNotice(list, { text: "same" });
  assert.equal(list[0].count, 1);
});

test("empty text and bad input are ignored", () => {
  assert.deepEqual(pushNotice(null, { text: "  " }), []);
  assert.equal(pushNotice([], { text: "ok" }).length, 1);
});

test("dismissNotice removes by id", () => {
  const list = pushNotice([], { id: "keep", text: "a" });
  const longer = pushNotice(list, { id: "drop", text: "b" });
  assert.deepEqual(dismissNotice(longer, "drop").map((n) => n.id), ["keep"]);
});
