import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { createWindowState, resizeWindow } from "../windowManager.js";

// Transform only the two JSX modules in memory using the installed Vite compiler.
// These tests exercise the real render tree and handlers, without an app build,
// browser, new test dependency, or source-text assertions.
async function loadJsx(name, imports = {}) {
  const url = new URL(name, import.meta.url);
  const source = await readFile(url, "utf8");
  const transformed = await transformWithOxc(source, url.pathname, { jsx: { runtime: "classic" } });
  let code = transformed.code.replaceAll('"react"', JSON.stringify(import.meta.resolve("react")));
  for (const [specifier, replacement] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const iconsUrl = await loadJsx("./Icons.jsx");
const { WindowFrame } = await import(await loadJsx("./WindowFrame.jsx", { "./Icons.jsx": iconsUrl }));
const canvas = { width: 1240, height: 700 };
const meta = { label: "Chat", icon: "chat" };

function fixture(overrides = {}) {
  const calls = [];
  const props = {
    windowState: createWindowState("chat", { state: "normal", canvas, bounds: { x: 100, y: 100, width: 700, height: 500 } }),
    meta, active: false, children: React.createElement("input", { "aria-label": "Message" }),
    ...Object.fromEntries(["onFocus", "onDragStart", "onResizeStart", "onResize", "onMinimize", "onMaximize", "onClose"].map((name) => [name, (...args) => calls.push([name, ...args])])),
    ...overrides,
  };
  return { props, calls, tree: WindowFrame(props) };
}

function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}

function event(extra = {}) {
  return {
    button: 0, isPrimary: true, pointerId: 1,
    defaultPrevented: false, propagationStopped: false,
    currentTarget: { setPointerCapture() {} },
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...extra,
  };
}

test("minimized and closed windows render nothing, including descendants and titlebars", () => {
  for (const state of ["closed", "minimized"]) {
    const { tree } = fixture({ windowState: createWindowState("chat", { state, canvas }) });
    assert.equal(renderToStaticMarkup(tree), "");
  }
});

test("maximized windows retain their z-order and have no resize handles", () => {
  const { tree } = fixture({ windowState: createWindowState("chat", { state: "maximized", zOrder: 19, canvas }) });
  assert.equal(tree.props.style.zIndex, 19);
  assert.equal(nodes(tree).filter((node) => node.props.className?.includes("window-resize-handle")).length, 0);
});

test("keyboard focus inside an inactive window raises it in capture phase", () => {
  const { tree, calls } = fixture();
  assert.equal(typeof tree.props.onFocusCapture, "function");
  tree.props.onFocusCapture(event());
  assert.deepEqual(calls, [["onFocus", "chat"]]);
});

test("pointer and keyboard activity in an already-active window do not repeatedly restore/focus it", () => {
  const { tree, calls } = fixture({ active: true });
  tree.props.onPointerDown?.(event());
  tree.props.onPointerDownCapture?.(event());
  tree.props.onFocusCapture?.(event());
  assert.deepEqual(calls, []);
});

test("pointer activation uses capture so stopped control events still raise the window", () => {
  const { tree, calls } = fixture();
  assert.equal(typeof tree.props.onPointerDownCapture, "function");
  tree.props.onPointerDownCapture(event());
  assert.deepEqual(calls, [["onFocus", "chat"]]);
});

test("titlebar dragging only starts for the primary pointer and primary button", () => {
  const { tree, calls } = fixture();
  const header = nodes(tree).find((node) => node.type === "header");
  for (const extra of [{ button: 1 }, { button: 2 }, { isPrimary: false }]) header.props.onPointerDown(event(extra));
  assert.deepEqual(calls, []);
  const primary = event();
  header.props.onPointerDown(primary);
  assert.deepEqual(calls, [["onDragStart", primary, "chat"]]);
});

test("double clicks on window controls never reach titlebar maximize", () => {
  const { tree, calls } = fixture();
  const header = nodes(tree).find((node) => node.type === "header");
  const controls = nodes(tree).find((node) => node.props.className === "window-controls");
  const doubleClick = event();
  controls.props.onDoubleClick?.(doubleClick);
  if (!doubleClick.propagationStopped) header.props.onDoubleClick(doubleClick);
  assert.deepEqual(calls, []);
  header.props.onDoubleClick(event());
  assert.deepEqual(calls, [["onMaximize", "chat"]]);
});

test("resize handles reject secondary pointer starts without capturing", () => {
  const { tree, calls } = fixture();
  const handles = nodes(tree).filter((node) => node.props.className?.includes("window-resize-handle"));
  assert.equal(handles.length, 8);
  let captures = 0;
  for (const handle of handles) {
    for (const extra of [{ button: 2 }, { isPrimary: false }]) handle.props.onPointerDown(event({ ...extra, currentTarget: { setPointerCapture() { captures += 1; } } }));
  }
  assert.equal(captures, 0);
  assert.deepEqual(calls, []);
  const primary = event();
  handles[0].props.onPointerDown(primary);
  assert.equal(calls[0][0], "onResizeStart");
});

test("all resize handles support axis-aware arrows and Shift coarse steps through bounded resizing", () => {
  const { tree, props, calls } = fixture();
  const handles = nodes(tree).filter((node) => node.props.className?.includes("window-resize-handle"));
  for (const handle of handles) {
    const edge = handle.props.className.split("resize-").at(-1);
    assert.equal(typeof handle.props.onKeyDown, "function");
    assert.notEqual(handle.props.tabIndex, -1);
    for (const [key, dx, dy] of [["ArrowLeft", -10, 0], ["ArrowRight", 10, 0], ["ArrowUp", 0, -10], ["ArrowDown", 0, 10]]) {
      calls.length = 0;
      const supported = dx ? /left|right/.test(edge) : /top|bottom/.test(edge);
      const keyEvent = event({ key });
      handle.props.onKeyDown(keyEvent);
      assert.equal(keyEvent.defaultPrevented, supported);
      if (!supported) { assert.deepEqual(calls, []); continue; }
      assert.equal(keyEvent.propagationStopped, true);
      assert.deepEqual(calls, [["onResize", "chat", edge, dx, dy]]);
      const resized = resizeWindow(props.windowState, edge, dx, dy, canvas);
      assert.notDeepEqual(resized.bounds, props.windowState.bounds);
      assert.ok(resized.bounds.width >= props.windowState.minimumSize.width);
      calls.length = 0;
      handle.props.onKeyDown(event({ key, shiftKey: true }));
      assert.deepEqual(calls, [["onResize", "chat", edge, dx * 5, dy * 5]]);
    }
    for (const extra of [{ key: "Enter" }, { key: "ArrowRight", metaKey: true }, { key: "ArrowDown", ctrlKey: true }, { key: "ArrowUp", altKey: true }]) {
      calls.length = 0;
      const ignored = event(extra);
      handle.props.onKeyDown(ignored);
      assert.deepEqual(calls, []);
      assert.equal(ignored.defaultPrevented, false);
    }
  }
});

test("resize handles are not keyboard-dead tab stops if a caller omits onResize", () => {
  const { tree } = fixture({ onResize: undefined });
  for (const handle of nodes(tree).filter((node) => node.props.className?.includes("window-resize-handle"))) assert.equal(handle.props.tabIndex, -1);
});