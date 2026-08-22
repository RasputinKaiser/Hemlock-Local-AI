import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_SCHEMA, createWindowState, focusWindow, migrateWindowState, moveWindow, normalizeZOrder,
  resizeWindow, snapBounds, toggleMaximize, keyboardPlacement,
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
    assert.ok(resized.bounds.height >= 380);
    assert.ok(resized.bounds.x >= 0 && resized.bounds.y >= 0);
    assert.ok(resized.bounds.x + resized.bounds.width <= canvas.width);
    assert.ok(resized.bounds.y + resized.bounds.height <= canvas.height);
  }
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
