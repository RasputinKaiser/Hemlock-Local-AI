import test from "node:test";
import assert from "node:assert/strict";
import { PALETTE_ACTIONS, HARNESS_ACTIONS, buildInteractInput, summarizeInteraction, isRenderableScreenshotRef, paletteAction } from "./previewPalette.js";

test("palette exposes the host-registered interaction set", () => {
  const ids = PALETTE_ACTIONS.map((action) => action.id);
  for (const expected of ["click", "type", "key", "scroll", "hover", "focus", "wait", "screenshot", "inspect", "accessibility", "resize", "pause", "stop"]) {
    assert.ok(ids.includes(expected), expected);
  }
});

test("buildInteractInput cleans values and enforces required fields", () => {
  assert.deepEqual(buildInteractInput("click", { target: "#go" }), { previewAction: "click", target: "#go" });
  assert.deepEqual(buildInteractInput("scroll", { top: "400", target: "" }), { previewAction: "scroll", top: 400 });
  assert.throws(() => buildInteractInput("click", {}), /needs target/);
  assert.throws(() => buildInteractInput("wait", { ms: "soon" }), /must be a number/);
  assert.throws(() => buildInteractInput("nonsense", {}), /Unknown preview action/);
});

test("pause and stop route to the host preview.stop command", () => {
  assert.equal(paletteAction("pause").hostCommand, "preview.stop");
  assert.equal(paletteAction("stop").reason, "user_stopped");
  // Harness-only actions never hit preview.interact; screenshot is host-only.
  assert.equal(paletteAction("inspect").harnessOnly, true);
  assert.equal(HARNESS_ACTIONS.has("screenshot"), false);
  assert.equal(HARNESS_ACTIONS.has("click"), true);
});

test("summarizeInteraction reports status, digest and console errors", () => {
  const result = { status: "passed", interaction: { target: "#go", postDigest: "sha256:0123456789abcdef", consoleErrors: ["boom"], elapsedMs: 12 } };
  assert.equal(summarizeInteraction("click", result), "click passed · target #go · digest 0123456789 · 1 console error · 12ms");
  assert.match(summarizeInteraction("type", { status: "blocked", reason: "preview_paused" }), /blocked: preview_paused/);
  assert.match(summarizeInteraction("wait", null), /no response/);
});

test("isRenderableScreenshotRef only accepts displayable refs", () => {
  assert.equal(isRenderableScreenshotRef("data:image/png;base64,AAA"), true);
  assert.equal(isRenderableScreenshotRef("blob:https://x/1"), true);
  assert.equal(isRenderableScreenshotRef("/tmp/shot.png"), false);
  assert.equal(isRenderableScreenshotRef(null), false);
});
