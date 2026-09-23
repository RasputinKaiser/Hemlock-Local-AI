import test from "node:test";
import assert from "node:assert/strict";
import { readStudioPrefs, writeStudioPrefs, sanitizeStudioPrefs, STUDIO_PREFS_KEY } from "./studioPrefs.js";

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, value), map };
};

test("readStudioPrefs validates view, viewport and layout fractions", () => {
  const storage = memoryStorage({ [STUDIO_PREFS_KEY]: JSON.stringify({
    artifactView: "diff", previewViewport: "mobile", layout: { source: 0.8, diff: 1, preview: 1.4, evidence: 200 },
  }) });
  const prefs = readStudioPrefs(storage);
  assert.equal(prefs.artifactView, "diff");
  assert.equal(prefs.previewViewport, "mobile");
  assert.equal(prefs.layout.evidence, 200);
});

test("readStudioPrefs rejects invalid values and corrupt JSON", () => {
  const storage = memoryStorage({ [STUDIO_PREFS_KEY]: JSON.stringify({ artifactView: "bogus", previewViewport: "widescreen", layout: { source: -1 } }) });
  assert.deepEqual(readStudioPrefs(storage), {});
  assert.deepEqual(readStudioPrefs(memoryStorage({ [STUDIO_PREFS_KEY]: "{nope" })), {});
  assert.deepEqual(readStudioPrefs(null), {});
});

test("writeStudioPrefs persists only sanitized fields", () => {
  const storage = memoryStorage();
  const clean = writeStudioPrefs(storage, { artifactView: "source", previewViewport: "desktop", layout: { source: 0.7 }, artifactViewJunk: "x" });
  assert.deepEqual(clean, { artifactView: "source", previewViewport: "desktop", layout: { source: 0.7 } });
  assert.deepEqual(readStudioPrefs(storage), clean);
});

test("sanitizeStudioPrefs drops non-positive layout values", () => {
  assert.deepEqual(sanitizeStudioPrefs({ layout: { source: 0, diff: "x" } }), {});
});
