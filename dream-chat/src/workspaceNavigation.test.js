import test from "node:test";
import assert from "node:assert/strict";
import { APP_GROUPS, APP_SHORTCUTS, PINNED_APPS, dockActivityBadges, dockApps, focusHandoffId, nextWindowInCycle, shortcutApp, windowCycleOrder } from "./workspaceNavigation.js";
import { WINDOW_DEFINITIONS } from "./windowManager.js";

test("each app has one stable numeric shortcut and one library category", () => {
  const ids = Object.keys(WINDOW_DEFINITIONS).sort();
  assert.deepEqual([...APP_SHORTCUTS].sort(), ids);
  assert.deepEqual(APP_GROUPS.flatMap(group => group.ids).sort(), ids);
  assert.equal(shortcutApp("2"), "chat");
  assert.equal(shortcutApp("0"), "settings");
  assert.equal(shortcutApp("x"), null);
});

test("idle dock prioritizes frequent work without losing open or minimized apps", () => {
  const windows = Object.fromEntries(Object.keys(WINDOW_DEFINITIONS).map(id => [id, { state: "closed" }]));
  assert.deepEqual(dockApps(WINDOW_DEFINITIONS, windows).map(([id]) => id).sort(), [...PINNED_APPS].sort());
  windows.dream.state = "minimized";
  windows.receipts.state = "normal";
  const shown = dockApps(WINDOW_DEFINITIONS, windows).map(([id]) => id);
  assert.ok(shown.includes("dream"));
  assert.ok(shown.includes("receipts"));
  assert.ok(!shown.includes("sips"));
});

test("window cycling runs front-to-back and skips closed and minimized windows", () => {
  const windows = {
    center: { state: "normal", zOrder: 3 },
    chat: { state: "normal", zOrder: 1 },
    artifact: { state: "maximized", zOrder: 2 },
    dream: { state: "minimized", zOrder: 9 },
    map: { state: "closed", zOrder: 8 },
  };
  assert.deepEqual(windowCycleOrder(windows), ["center", "artifact", "chat"]);
  assert.equal(nextWindowInCycle(windows, "center"), "artifact", "⌘` moves to the next window behind the frontmost");
  assert.equal(nextWindowInCycle(windows, "chat"), "center", "the cycle wraps from the back to the front");
  assert.equal(nextWindowInCycle(windows, "dream"), "center", "a minimized active id falls to the frontmost window");
  assert.equal(nextWindowInCycle(windows, null), "center");
  assert.equal(nextWindowInCycle({ chat: windows.chat }, "chat"), null, "a single open window does not cycle");
});

test("focus handoff lands on the next frontmost window after a dismiss", () => {
  const windows = {
    center: { state: "normal", zOrder: 1 },
    chat: { state: "normal", zOrder: 3 },
    artifact: { state: "normal", zOrder: 2 },
  };
  assert.equal(focusHandoffId(windows, "chat"), "artifact", "closing the front window returns focus to the previously focused one");
  assert.equal(focusHandoffId(windows, "center"), "chat");
  assert.equal(focusHandoffId({ chat: windows.chat }, "chat"), null, "closing the last open window leaves nothing to focus");
  assert.equal(focusHandoffId(windows, "dream"), "chat", "dismissing an absent id still yields the frontmost window");
});

test("dock badges derive from task status, dream state, and unseen artifact revisions", () => {
  assert.deepEqual(dockActivityBadges("chat", { taskStatus: "waiting_for_approval" }), [
    { id: "approval", icon: "warning", tone: "amber", label: "Approval needed" },
  ], "a parked-for-approval task earns a distinct amber chip");
  assert.deepEqual(dockActivityBadges("chat", { taskStatus: "running" }).map((badge) => badge.id), ["working"]);
  assert.deepEqual(dockActivityBadges("chat", { taskStatus: "completed" }), []);
  assert.deepEqual(dockActivityBadges("chat", { taskStatus: "waiting_for_approval" })[0].tone, "amber");
  assert.deepEqual(dockActivityBadges("dream", { isDreaming: true }).map((badge) => badge.id), ["dreaming"]);
  assert.deepEqual(dockActivityBadges("dream", { isDreaming: false }), []);
  const revisionEvents = [
    { type: "artifact.updated", payload: { artifact: { id: "a1", revision: 2 } } },
  ];
  assert.deepEqual(dockActivityBadges("artifact", { unseenEvents: revisionEvents }).map((badge) => badge.id), ["revision"]);
  assert.deepEqual(dockActivityBadges("artifact", { unseenEvents: [{ type: "artifact.created", payload: { artifact: { id: "a1", revision: 0 } } }] }), [], "a first-draft create is not a revision event");
  assert.deepEqual(dockActivityBadges("artifact", { unseenEvents: [{ type: "task.updated", payload: {} }] }), []);
  assert.deepEqual(dockActivityBadges("map", { taskStatus: "running", isDreaming: true, unseenEvents: revisionEvents }), [], "other windows stay unbadged");
});
