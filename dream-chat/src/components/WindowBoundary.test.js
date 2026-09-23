import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importJsx } from "../testSupport/jsxLoader.js";

const { WindowBoundary } = await importJsx(new URL("./WindowBoundary.jsx", import.meta.url));

test("a healthy window passes its children through untouched", () => {
  const markup = renderToStaticMarkup(React.createElement(WindowBoundary, { windowId: "chat", label: "Chat" }, React.createElement("p", null, "window body")));
  assert.match(markup, /window body/);
  assert.doesNotMatch(markup, /hit an error/);
});

test("a render error degrades to an inline alert card with a reload control", () => {
  const boundary = new WindowBoundary({ windowId: "chat", label: "Chat / Code", children: null });
  boundary.state = WindowBoundary.getDerivedStateFromError(new Error("boom in render"));
  const markup = renderToStaticMarkup(boundary.render());
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Chat \/ Code hit an error/);
  assert.match(markup, /boom in render/);
  assert.match(markup, />Reload window</);
  assert.equal(boundary.state.error.message, "boom in render");
});

test("componentDidCatch logs to the console without throwing", () => {
  const boundary = new WindowBoundary({ windowId: "artifact" });
  const calls = [];
  const original = console.error;
  console.error = (...args) => calls.push(args);
  try {
    boundary.componentDidCatch(new Error("render blew up"), { componentStack: "\n  at ArtifactStudio" });
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /window "artifact" render crashed/);
  assert.match(String(calls[0][2]), /ArtifactStudio/);
});

test("componentDidCatch reports a bounded crash receipt to the desktop bridge", async () => {
  const boundary = new WindowBoundary({ windowId: "grove", label: "Understory Grove" });
  const reports = [];
  const previousWindow = globalThis.window;
  globalThis.window = { mapleDesktop: { reportRendererError: (payload) => { reports.push(payload); return Promise.resolve({ status: "recorded" }); } } };
  try {
    boundary.componentDidCatch(new Error("mesh exploded"), { componentStack: "\n    at GroveSurface\n    at App" });
    await Promise.resolve();
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(reports.length, 1);
  assert.equal(reports[0].windowId, "grove");
  assert.equal(reports[0].component, "GroveSurface");
  assert.match(reports[0].message, /mesh exploded/);
  assert.ok(reports[0].stack.length <= 2048, "stack is bounded for the receipt");
});

test("componentDidCatch stays quiet when no desktop bridge exists", () => {
  const boundary = new WindowBoundary({ windowId: "chat" });
  const previousWindow = globalThis.window;
  globalThis.window = {};
  const original = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => boundary.componentDidCatch(new Error("offline"), { componentStack: "" }));
  } finally {
    console.error = original;
    globalThis.window = previousWindow;
  }
});
