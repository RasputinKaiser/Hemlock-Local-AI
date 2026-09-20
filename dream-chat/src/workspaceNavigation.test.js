import test from "node:test";
import assert from "node:assert/strict";
import { APP_GROUPS, APP_SHORTCUTS, PINNED_APPS, dockApps, shortcutApp } from "./workspaceNavigation.js";
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
