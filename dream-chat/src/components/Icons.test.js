import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdir, readFile } from "node:fs/promises";
import { importJsx } from "../testSupport/jsxLoader.js";
import { windowMenuItems } from "../windowActions.js";

const { Icon, ICON_NAMES } = await importJsx(new URL("./Icons.jsx", import.meta.url));

test("every glyph renders on the same optical grid and is decorative by default", () => {
  for (const name of ICON_NAMES) {
    const icon = Icon({ name, size: 16 });
    assert.equal(icon.props.viewBox, "0 0 24 24");
    assert.equal(icon.props.width, 16);
    assert.equal(icon.props.height, 16);
    assert.equal(icon.props["data-icon"], name);
    assert.equal(icon.props["aria-hidden"], true);
    assert.equal(icon.props.focusable, "false");
    assert.ok(renderToStaticMarkup(icon).length > 100);
  }
});

test("meaningful standalone icons support labels; unknown names do not pretend to be commands", () => {
  const html = renderToStaticMarkup(React.createElement(Icon, { name: "keyboard", label: "Keyboard shortcuts" }));
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Keyboard shortcuts"/);
  assert.doesNotMatch(html, /aria-hidden/);
  assert.equal(Icon({ name: "missing-glyph" }).props["data-icon"], "unknown");
});

test("all literal production Icon references and window commands have real glyphs", async () => {
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith(".jsx")) {
        const source = await readFile(file, "utf8");
        for (const match of source.matchAll(/<Icon\s+name="([^"]+)"/g)) assert.ok(ICON_NAMES.includes(match[1]), `${file.pathname}: ${match[1]}`);
      }
    }
  }
  await inspect(new URL("../", import.meta.url));
  for (const state of ["normal", "minimized", "maximized"]) for (const action of windowMenuItems(state)) assert.ok(ICON_NAMES.includes(action.icon));
});

test("app and window-state silhouettes are distinct", () => {
  const names = ["center", "chat", "artifact", "memory", "sips", "dream", "activity", "receipt", "map", "settings"];
  const shapes = names.map(name => renderToStaticMarkup(Icon({ name })).replace(/data-icon="[^"]+"/, ""));
  assert.equal(new Set(shapes).size, names.length);
  assert.notDeepEqual(Icon({ name: "maximize" }).props.children, Icon({ name: "restore" }).props.children);
  assert.notDeepEqual(Icon({ name: "apps" }).props.children, Icon({ name: "windows" }).props.children);
});
