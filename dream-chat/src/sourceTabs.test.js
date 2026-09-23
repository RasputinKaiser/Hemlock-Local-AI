import test from "node:test";
import assert from "node:assert/strict";
import { sourceFileNames, resolveActiveFile, fileStats, formatBytes, combinedSource, byteLength } from "./sourceTabs.js";

test("sourceFileNames sorts and drops non-string entries", () => {
  assert.deepEqual(sourceFileNames({ "b.css": "x", "a.html": "y", "bad": 4 }), ["a.html", "b.css"]);
  assert.deepEqual(sourceFileNames(null), []);
  assert.deepEqual(sourceFileNames("str"), []);
});

test("resolveActiveFile keeps the preferred tab, falls back to entrypoint then first", () => {
  const source = { "index.html": "a", "style.css": "b" };
  assert.equal(resolveActiveFile(source, "style.css"), "style.css");
  assert.equal(resolveActiveFile(source, "gone.js", "index.html"), "index.html");
  assert.equal(resolveActiveFile(source, "gone.js"), "index.html");
  assert.equal(resolveActiveFile({}, "x"), null);
});

test("fileStats counts UTF-8 bytes and lines", () => {
  assert.deepEqual(fileStats("a\nb\n"), { bytes: 4, lines: 3 });
  assert.equal(fileStats("").lines, 0);
  assert.equal(byteLength("héllo"), 6);
});

test("formatBytes picks readable units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("combinedSource joins files with // name headers", () => {
  assert.equal(combinedSource({ "a.html": "one", "b.css": "two" }), "// a.html\none\n\n// b.css\ntwo");
});
