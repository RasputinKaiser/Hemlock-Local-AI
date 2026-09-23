import test from "node:test";
import assert from "node:assert/strict";
import {
  WORK_TOAST_LIMIT,
  WORK_TOAST_TTL_MS,
  pruneWorkToasts,
  pushWorkToast,
  workToastFor,
} from "./workToasts.js";

test("terminal work events become toasts pointing at their evidence window", () => {
  const toast = workToastFor({ id: "e1", type: "sips.cycle.completed", status: "passed", payload: { summary: "cycle done" } }, 1000);
  assert.equal(toast.windowId, "sips");
  assert.equal(toast.tone, "ok");
  assert.equal(toast.body, "cycle done");
  assert.equal(toast.expiresAt, 1000 + WORK_TOAST_TTL_MS);
});

test("failures render as warn toasts; unknown or id-less events stay silent", () => {
  assert.equal(workToastFor({ id: "e2", type: "dream.failed", status: "failed", payload: { error: "mlx died" } }).tone, "warn");
  assert.equal(workToastFor({ id: "e3", type: "dream.failed", status: "failed", payload: { error: "mlx died" } }).body, "mlx died");
  assert.equal(workToastFor({ id: "e4", type: "event.notlisted" }), null);
  assert.equal(workToastFor({ type: "task.completed" }), null);
  assert.equal(workToastFor(null), null);
});

test("consolidate and suggest events route to their evidence windows", () => {
  const merged = workToastFor({ id: "m1", type: "memory.consolidated", status: "recorded", payload: { merged: 2, clusters: [{ ids: ["a", "b", "c"] }] } });
  assert.equal(merged.windowId, "memory");
  assert.equal(merged.body, "2 absorbed · 1 cluster(s)");
  const suggest = workToastFor({ id: "s1", type: "world.suggest", status: "suggested", payload: { top: { experiment: "gravity", reason: "no receipts" } } });
  assert.equal(suggest.windowId, "grove");
  assert.equal(suggest.body, "gravity — no receipts");
});

test("push dedupes by event id and caps the stack", () => {
  let list = [];
  list = pushWorkToast(list, workToastFor({ id: "a", type: "task.completed" }));
  list = pushWorkToast(list, workToastFor({ id: "a", type: "task.completed" }));
  assert.equal(list.length, 1, "a replayed event must not double-ping");
  for (const id of ["b", "c", "d"]) {
    list = pushWorkToast(list, workToastFor({ id, type: "task.completed" }));
  }
  assert.equal(list.length, WORK_TOAST_LIMIT);
  assert.equal(list[0].eventId, "d", "newest toast leads the stack");
});

test("prune drops expired toasts and keeps unexpired ones", () => {
  const stale = { id: "t1", expiresAt: 500 };
  const fresh = { id: "t2", expiresAt: 5000 };
  const timeless = { id: "t3" };
  assert.deepEqual(pruneWorkToasts([stale, fresh, timeless], 1000).map((t) => t.id), ["t2", "t3"]);
});
