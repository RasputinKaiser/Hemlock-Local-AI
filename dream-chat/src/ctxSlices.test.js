import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OPTIONAL_CTX_KEYS,
  WINDOW_CTX_KEYS,
  createCtxSliceCache,
  pickCtx,
} from "./ctxSlices.js";

// Window id → source file and exported component names that read ctx.
const WINDOW_SOURCES = {
  center: ["./windows/CommandCenter.jsx", ["CommandCenter"]],
  chat: ["./windows/ChatWindow.jsx", ["ChatWindow"]],
  threads: ["./windows/ThreadsWindow.jsx", ["ThreadsWindow"]],
  artifact: ["./windows/ArtifactStudio.jsx", ["ArtifactStudio"]],
  sips: ["./windows/UtilityWindows.jsx", ["SipsWindow"]],
  memory: ["./windows/UtilityWindows.jsx", ["MemoryWindow"]],
  dream: ["./windows/UtilityWindows.jsx", ["DreamWindow"]],
  activity: ["./windows/UtilityWindows.jsx", ["ActivityWindow"]],
  receipts: ["./windows/UtilityWindows.jsx", ["ReceiptsWindow"]],
  map: ["./windows/UtilityWindows.jsx", ["MapWindow"]],
  grove: ["./windows/UtilityWindows.jsx", ["GroveWindow"]],
  settings: ["./windows/UtilityWindows.jsx", ["SettingsWindow"]],
};

// Slice a file's source into regions keyed by `export const|function <Name>`;
// a component's ctx reads live between its export marker and the next one.
function exportRegions(source) {
  const markers = [...source.matchAll(/export (?:const|function)\s+(\w+)/g)];
  const regions = new Map();
  markers.forEach((marker, index) => {
    const end = index + 1 < markers.length ? markers[index + 1].index : source.length;
    regions.set(marker[1], source.slice(marker.index, end));
  });
  return regions;
}

function ctxKeysUsed(region) {
  return new Set([...region.matchAll(/\bctx\.([A-Za-z_]\w*)/g)].map((match) => match[1]));
}

function ctxBagKeys() {
  const main = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  const match = main.match(/const ctx = \{([^}]+)\}/);
  assert.ok(match, "main.jsx must still build the ctx bag literal");
  return new Set(match[1].split(",").map((key) => key.trim()).filter(Boolean));
}

test("every ctx.X a window reads is declared in its KEYS list", () => {
  const fileRegions = new Map();
  for (const [windowId, [file, components]] of Object.entries(WINDOW_SOURCES)) {
    const declared = new Set(WINDOW_CTX_KEYS[windowId]);
    assert.ok(declared.size, `${windowId} has no declared ctx keys`);
    if (!fileRegions.has(file)) {
      fileRegions.set(file, exportRegions(readFileSync(new URL(file, import.meta.url), "utf8")));
    }
    const regions = fileRegions.get(file);
    for (const component of components) {
      const region = regions.get(component);
      assert.ok(region, `${component} not found in ${file}`);
      for (const key of ctxKeysUsed(region)) {
        assert.ok(declared.has(key), `${component} reads ctx.${key} but "${key}" is not in WINDOW_CTX_KEYS.${windowId}`);
      }
    }
  }
});

test("every declared key exists on the ctx bag or is a documented optional read", () => {
  const bag = ctxBagKeys();
  for (const [windowId, keys] of Object.entries(WINDOW_CTX_KEYS)) {
    for (const key of keys) {
      assert.ok(bag.has(key) || OPTIONAL_CTX_KEYS.has(key), `WINDOW_CTX_KEYS.${windowId} declares "${key}" but main.jsx ctx does not provide it`);
    }
  }
});

test("pickCtx reads only the declared fields", () => {
  const source = { a: 1, b: 2, c: 3 };
  assert.deepEqual(pickCtx(source, ["a", "c"]), { a: 1, c: 3 });
});

test("slice is stable while listed values are unchanged", () => {
  const slice = createCtxSliceCache();
  const keys = ["count", "label"];
  const first = slice({ count: 1, label: "one", other: "x" }, keys);
  const again = slice({ count: 1, label: "one", other: "y" }, keys);
  assert.equal(again, first, "unlisted churn must not invalidate the slice");
  const changed = slice({ count: 2, label: "one", other: "y" }, keys);
  assert.notEqual(changed, first, "a listed value change rebuilds the slice");
  assert.equal(changed.count, 2);
  assert.equal(changed.label, "one");
});

test("function fields keep stable identity and forward to the latest source", () => {
  const slice = createCtxSliceCache();
  const keys = ["count", "run"];
  const calls = [];
  const first = slice({ count: 1, run: () => calls.push("first") }, keys);
  const second = slice({ count: 1, run: () => calls.push("second") }, keys);
  assert.equal(second, first, "recreated closures must not invalidate the slice");
  assert.equal(typeof second.run, "function");
  second.run();
  assert.deepEqual(calls, ["second"], "the stable wrapper calls the newest bag function");
});
