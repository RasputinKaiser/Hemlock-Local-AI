const test = require("node:test");
const assert = require("node:assert/strict");
const { PreviewSessionManager } = require("./preview_policy.cjs");

test("preview manager enforces registered actions, pause, visibility, and budgets", () => {
  let now = 1000;
  const manager = new PreviewSessionManager({ now: () => now, budget: { maxPreviewActions: 2, maxPreviewScreenshots: 1 } });
  const session = manager.open({ taskId: "task", artifactId: "art", revision: 1 });
  assert.equal(manager.authorize(session.id, "click", { target: "button" }).allowed, true);
  assert.throws(() => manager.authorize(session.id, "eval", {}), /not registered/);
  assert.equal(manager.authorize(session.id, "screenshot", {}).allowed, true);
  assert.equal(manager.authorize(session.id, "screenshot", {}).reason, "preview_action_budget_exhausted");
  const second = manager.open({ taskId: "task", artifactId: "art", revision: 1 });
  manager.pause(second.id);
  assert.equal(manager.authorize(second.id, "click", {}).reason, "preview_paused");
});

test("hidden screenshot returns preview_not_visible and interaction is preview-only", () => {
  const manager = new PreviewSessionManager();
  const session = manager.open({ taskId: "task", artifactId: "art", revision: 1 });
  manager.get(session.id).visible = false;
  assert.equal(manager.authorize(session.id, "screenshot", {}).reason, "preview_not_visible");
  const record = manager.complete(session.id, { target: "button", result: "passed", previewOnlyMutation: false });
  assert.equal(record.previewOnlyMutation, true);
});
