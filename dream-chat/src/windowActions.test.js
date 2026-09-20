import test from "node:test";
import assert from "node:assert/strict";
import { createWindowState, toggleMaximize } from "./windowManager.js";
import { centerWindow, minimizeWorkspace, restoreWorkspace, windowMenuItems } from "./windowActions.js";
const canvas = { width: 1440, height: 800 };
const normal = id => createWindowState(id, { state: "normal", canvas, bounds: { x: 100, y: 80, width: 700, height: 500 } });

test("centering moves without resizing or retaining snap state", () => {
  const original = normal("chat");
  const centered = centerWindow(original, canvas);
  assert.equal(centered.bounds.width, original.bounds.width);
  assert.equal(centered.bounds.height, original.bounds.height);
  assert.equal(centered.bounds.x, Math.floor((canvas.width - original.bounds.width) / 2));
  assert.equal(centered.bounds.y, Math.floor((canvas.height - original.bounds.height) / 2));
  assert.equal(centered.snapTarget, null);
  assert.equal(original.bounds.x, 100);
});

test("resetting size uses app defaults and remains bounded on smaller desktops", () => {
  const result = centerWindow(toggleMaximize(normal("chat"), canvas), canvas, true);
  assert.equal(result.state, "normal");
  assert.equal(result.bounds.width, 880);
  assert.equal(result.bounds.height, 640);
  const small = centerWindow(normal("chat"), { width: 600, height: 400 }, true);
  assert.deepEqual(small.bounds, { x: 0, y: 0, width: 600, height: 400 });
});

test("show desktop preserves preexisting minimized windows and exact restore bounds", () => {
  const windows = {
    center: normal("center"),
    chat: toggleMaximize(normal("chat"), canvas),
    memory: createWindowState("memory", { state: "minimized", canvas }),
    settings: createWindowState("settings", { state: "closed", canvas }),
  };
  const hidden = minimizeWorkspace(windows, "chat", canvas);
  assert.deepEqual(hidden.snapshot.ids.sort(), ["center", "chat"]);
  assert.equal(hidden.windows.chat.state, "minimized");
  assert.equal(hidden.windows.chat.minimizedFrom, "maximized");
  const restored = restoreWorkspace(hidden.windows, hidden.snapshot, canvas);
  assert.equal(restored.activeId, "chat");
  assert.equal(restored.windows.chat.state, "maximized");
  assert.deepEqual(restored.windows.chat.restoreBounds, windows.chat.restoreBounds);
  assert.equal(restored.windows.memory.state, "minimized");
  assert.equal(restored.windows.settings.state, "closed");
  assert.equal(windows.chat.state, "maximized");
});

test("restore never resurrects a window closed after showing desktop", () => {
  const hidden = minimizeWorkspace({ chat: normal("chat") }, "chat", canvas);
  hidden.windows.chat = { ...hidden.windows.chat, state: "closed" };
  const restored = restoreWorkspace(hidden.windows, hidden.snapshot, canvas);
  assert.equal(restored.windows.chat.state, "closed");
  assert.equal(restored.activeId, null);
});

test("window menu reflects state and has unique executable action ids", () => {
  for (const state of ["normal", "maximized", "minimized"]) {
    const items = windowMenuItems(state);
    assert.equal(new Set(items.map(item => item.id)).size, items.length);
    assert.equal(items.find(item => item.id === "minimize").disabled, state === "minimized");
  }
  assert.ok(windowMenuItems("maximized").some(item => item.id === "restore" && item.icon === "restore"));
  assert.ok(windowMenuItems("normal").some(item => item.id === "maximize"));
});
