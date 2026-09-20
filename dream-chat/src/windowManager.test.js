import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_SCHEMA, createWindowState, focusWindow, migrateWindowState, moveWindow, normalizeZOrder,
  resizeWindow, snapBounds, toggleMaximize, keyboardPlacement, setWindowState, openWindowBounds, pointerSnapCommand,
} from "./windowManager.js";

const canvas = { width: 1240, height: 700 };

test("creates v2 state with bounded preferred and restore bounds", () => {
  const state = createWindowState("center", { workspaceId: "w", state: "normal", canvas });
  assert.equal(state.schema, WINDOW_SCHEMA);
  assert.equal(state.windowId, "center");
  assert.deepEqual(state.minimumSize, { width: 720, height: 500 });
  assert.deepEqual(state.restoreBounds, state.bounds);
});

test("migrates v1/v2-ish legacy records per window and retains narrow fallback", () => {
  const migrated = migrateWindowState({
    center: { id: "center", open: true, x: 9999, y: -4, width: 1200, height: 800, zIndex: 999 },
    chat: { id: "chat", open: false, width: "bad" },
    unknown: { open: true },
  }, { workspaceId: "w", canvas: { width: 700, height: 300 } });
  assert.equal(migrated.center.schema, WINDOW_SCHEMA);
  assert.equal(migrated.center.bounds.x, 0);
  assert.equal(migrated.center.bounds.y, 0);
  assert.equal(migrated.chat.state, "closed");
  assert.ok(Object.values(migrated).every((item) => item.zOrder <= Object.keys(migrated).length));
});

test("resizes from every edge and corner while preserving minimum size and canvas visibility", () => {
  const state = createWindowState("chat", { state: "normal", canvas, bounds: { x: 100, y: 100, width: 700, height: 500 } });
  for (const edge of ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"]) {
    const resized = resizeWindow(state, edge, edge.includes("left") ? 400 : -400, edge.includes("top") ? 300 : -300, canvas);
    assert.ok(resized.bounds.width >= 520);
    assert.ok(resized.bounds.height >= 480);
    assert.ok(resized.bounds.x >= 0 && resized.bounds.y >= 0);
    assert.ok(resized.bounds.x + resized.bounds.width <= canvas.width);
    assert.ok(resized.bounds.y + resized.bounds.height <= canvas.height);
  }
});

test("restoring a saved session adopts current minimum sizing constraints", () => {
  const previous = createWindowState("chat", { state: "normal", canvas });
  const migrated = migrateWindowState({ chat: { ...previous, minimumSize: { width: 520, height: 380 }, bounds: { x: 0, y: 0, width: 520, height: 380 } } }, { canvas });
  assert.equal(migrated.chat.minimumSize.height, 480);
  assert.equal(migrated.chat.bounds.height, 480);
});

test("resizing to canvas edges keeps the opposite edges anchored", () => {
  const state = createWindowState("chat", { state: "normal", canvas, bounds: { x: 100, y: 100, width: 700, height: 500 } });
  const left = resizeWindow(state, "left", -1000, 0, canvas).bounds;
  assert.deepEqual(left, { x: 0, y: 100, width: 800, height: 500 });
  const right = resizeWindow(state, "right", 1000, 0, canvas).bounds;
  assert.equal(right.x, 100);
  assert.equal(right.x + right.width, canvas.width);
  const top = resizeWindow(state, "top", 0, -1000, canvas).bounds;
  assert.equal(top.y, 0);
  assert.equal(top.y + top.height, 600);
  const bottom = resizeWindow(state, "bottom", 0, 1000, canvas).bounds;
  assert.equal(bottom.y, 100);
  assert.equal(bottom.y + bottom.height, canvas.height);
});

test("pointer snapping is explicit and Option suppresses placement", () => {
  assert.equal(pointerSnapCommand(600, 5, canvas), "maximize");
  assert.equal(pointerSnapCommand(5, 200, canvas), "half-left");
  assert.equal(pointerSnapCommand(1238, 200, canvas), "half-right");
  assert.equal(pointerSnapCommand(500, 200, canvas), null);
  assert.equal(pointerSnapCommand(5, 200, canvas, { altKey: true }), null);
  const state = createWindowState("chat", { state: "normal", canvas });
  assert.equal(moveWindow(state, 0, 0, canvas, { enabled: false }).snapTarget, null);
});

test("moves, snaps only when deliberately close (7px), and Option disables snapping", () => {
  const state = createWindowState("chat", { state: "normal", canvas, bounds: { x: 20, y: 20, width: 520, height: 380 } });
  assert.equal(moveWindow(state, -14, 0, canvas).snapTarget, "left", "within 7px snaps");
  assert.notEqual(moveWindow(state, -8, 0, canvas).snapTarget, "left", "8px away must NOT snap");
  assert.equal(moveWindow(state, -8, 0, canvas, { altKey: true }).snapTarget, null);
  assert.equal(snapBounds({ x: 300, y: 0, width: 520, height: 380 }, canvas).snapTarget, "top");
  assert.equal(snapBounds({ x: 300, y: 10, width: 520, height: 380 }, canvas).snapTarget, null, "10px from top must NOT snap");
  assert.equal(snapBounds({ x: 300, y: 5, width: 520, height: 380 }, canvas).snapTarget, "top", "5px from top snaps");
});

test("maximise/restore preserves exact valid bounds and keyboard placement is bounded", () => {
  const state = createWindowState("chat", { state: "normal", canvas, bounds: { x: 117, y: 83, width: 700, height: 500 } });
  const maximized = toggleMaximize(state, canvas);
  assert.equal(maximized.state, "maximized");
  const restored = toggleMaximize(maximized, canvas);
  assert.deepEqual(restored.bounds, state.bounds);
  assert.equal(keyboardPlacement(state, "half-left", canvas).snapTarget, "left");
  assert.equal(keyboardPlacement(state, "minimize", canvas).state, "minimized");
});

test("z order is compact and focus does not grow forever", () => {
  let windows = {
    a: createWindowState("chat", { zOrder: 1000 }),
    b: createWindowState("sips", { zOrder: 2 }),
    c: createWindowState("memory", { zOrder: 800 }),
  };
  windows = normalizeZOrder(windows, "b");
  assert.equal(windows.b.zOrder, 3);
  assert.deepEqual(Object.values(windows).map((item) => item.zOrder).sort((a, b) => a - b), [1, 2, 3]);
});

test("focusing an open window re-clamps stale bounds onto the current canvas", () => {
  // Regression: artifact window persisted at x=645 against a canvas that later
  // shrank; clicking its dock item only re-ordered z and the window stayed invisible.
  const smallCanvas = { width: 640, height: 700 };
  const windows = {
    artifact: {
      ...createWindowState("artifact", { state: "normal", canvas, bounds: { x: 600, y: 0, width: 560, height: 400 } }),
      state: "normal",
    },
  };
  const focused = focusWindow(windows, "artifact", undefined, smallCanvas);
  assert.equal(focused.artifact.state, "normal");
  assert.equal(focused.artifact.bounds.x + focused.artifact.bounds.width <= smallCanvas.width, true);
  assert.equal(focused.artifact.zOrder, 1);
});

test("minimizing releases focus and dock focus restores the previous maximized state", () => {
  const original = createWindowState("chat", { state: "normal", focus: true, canvas, bounds: { x: 117, y: 83, width: 700, height: 500 } });
  const maximized = toggleMaximize(original, canvas);
  const minimized = setWindowState(maximized, "minimized", canvas);
  assert.equal(minimized.focus, false);
  assert.equal(minimized.minimizedFrom, "maximized");
  const repeated = setWindowState(minimized, "minimized", canvas);
  const restored = focusWindow({ chat: repeated }, "chat", undefined, canvas).chat;
  assert.equal(restored.state, "maximized");
  assert.deepEqual(toggleMaximize(restored, canvas).bounds, original.bounds);
});

test("dock open restores minimized windows without cascading or losing maximization", () => {
  const original = createWindowState("chat", { state: "normal", canvas, bounds: { x: 117, y: 83, width: 700, height: 500 } });
  const other = createWindowState("center", { state: "normal", canvas });
  for (const source of [original, toggleMaximize(original, canvas)]) {
    const minimized = setWindowState(source, "minimized", canvas);
    const restored = openWindowBounds({ chat: minimized, center: other }, "chat", canvas).chat;
    assert.equal(restored.state, source.state);
    assert.deepEqual(restored.bounds, source.bounds);
    assert.deepEqual(restored.restoreBounds, source.restoreBounds);
    assert.equal(restored.zOrder, 2);
  }
});

test("keyboard minimize and restore retain normal and maximized geometry", () => {
  const original = createWindowState("chat", { state: "normal", canvas, bounds: { x: 117, y: 83, width: 700, height: 500 }, restoreBounds: { x: 0, y: 0, width: 520, height: 380 } });
  for (const source of [original, toggleMaximize(original, canvas)]) {
    const minimized = keyboardPlacement(source, "minimize", canvas);
    const restored = keyboardPlacement(minimized, "restore", canvas);
    assert.equal(restored.state, source.state);
    assert.deepEqual(restored.bounds, source.bounds);
    assert.deepEqual(restored.restoreBounds, source.restoreBounds);
  }
});

test("minimized restore metadata survives persistence and old records default safely", () => {
  for (const value of [
    { state: "minimized", minimizedFrom: "maximized" },
    { open: true, minimized: true, maximized: true },
  ]) {
    const windows = migrateWindowState({ chat: value }, { canvas });
    assert.equal(focusWindow(windows, "chat", undefined, canvas).chat.state, "maximized");
    assert.equal(windows.chat.focus, false);
  }
  for (const minimizedFrom of [undefined, "closed", "invalid"]) {
    const windows = migrateWindowState({ chat: { state: "minimized", minimizedFrom } }, { canvas });
    assert.equal(focusWindow(windows, "chat", undefined, canvas).chat.state, "normal");
  }
});

test("restoring a minimized window re-clamps stale bounds to a smaller canvas", () => {
  const smallCanvas = { width: 640, height: 450 };
  const original = createWindowState("chat", { state: "normal", canvas, bounds: { x: 500, y: 200, width: 700, height: 500 } });
  const minimized = setWindowState(original, "minimized", canvas);
  const restored = openWindowBounds({ chat: minimized }, "chat", smallCanvas).chat;
  assert.ok(restored.bounds.x + restored.bounds.width <= smallCanvas.width);
  assert.ok(restored.bounds.y + restored.bounds.height <= smallCanvas.height);
});

test("focusing the already-focused top window is referentially idempotent", () => {
  const windows = {
    chat: createWindowState("chat", { state: "normal", canvas }),
    center: createWindowState("center", { state: "normal", canvas }),
  };
  const focused = focusWindow(windows, "chat", "first", canvas);
  assert.equal(focusWindow(focused, "chat", "later", canvas), focused);
  const smaller = focusWindow(focused, "chat", "later", { width: 640, height: 450 });
  assert.notEqual(smaller, focused, "idempotence must not skip stale-bound clamping");
  assert.ok(smaller.chat.bounds.width <= 640);
  assert.ok(smaller.chat.bounds.height <= 450);
});

test("an already-focused window is raised if its z-order is stale", () => {
  const windows = {
    chat: createWindowState("chat", { state: "normal", focus: true, zOrder: 1, canvas }),
    center: createWindowState("center", { state: "normal", zOrder: 2, canvas }),
  };
  assert.equal(focusWindow(windows, "chat", undefined, canvas).chat.zOrder, 2);
});

test("legacy minimized flags cannot re-minimize a restored persisted v2 window", () => {
  const migrated = migrateWindowState({ chat: { open: true, minimized: true, maximized: true } }, { canvas });
  const restored = focusWindow(migrated, "chat", undefined, canvas);
  const reloaded = migrateWindowState(JSON.parse(JSON.stringify(restored)), { canvas });
  assert.equal(reloaded.chat.state, "maximized");
  assert.deepEqual(reloaded.chat.restoreBounds, restored.chat.restoreBounds);
  const normal = toggleMaximize(reloaded.chat, canvas);
  const minimized = setWindowState(normal, "minimized", canvas);
  const minimizedReload = migrateWindowState(JSON.parse(JSON.stringify({ chat: minimized })), { canvas });
  assert.equal(focusWindow(minimizedReload, "chat", undefined, canvas).chat.state, "normal");
});
