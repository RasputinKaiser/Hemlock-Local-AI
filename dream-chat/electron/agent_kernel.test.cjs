const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AgentKernel } = require("./agent_kernel.cjs");

function makeKernel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-agent-kernel-"));
  const task = {
    schema: "hemlock.agent.task.v1",
    id: "task-test",
    objective: "Test the durable agent projection",
    status: "accepted",
    phase: "plan",
    budget: { maxCommands: 2, commandsUsed: 0, maxTrainingCycles: 1, trainingCyclesUsed: 0 },
  };
  return { root, kernel: new AgentKernel({ root, repoRoot: "/tmp/hemlock-project", task }) };
}

test("persists task, operation, candidate, and source policy projections", () => {
  const { root, kernel } = makeKernel();
  try {
    const operation = kernel.startOperation({ taskId: "task-test", command: "verify", capability: "verify", payload: { profile: "app-build" }, descriptor: { timeoutMs: 1000 } });
    assert.equal(operation.status, "running");
    assert.equal(kernel.getProjection().task.budget.commandsUsed, 1);
    kernel.finishOperation(operation.id, { status: "completed", result: { exitCode: 0 }, evidenceRefs: ["receipt.json"] });

    const first = kernel.createCandidate({ sourceId: "computer-history", title: "Review activity", summary: "A local observation needs review.", confidence: 0.8 });
    const duplicate = kernel.createCandidate({ sourceId: "computer-history", title: "Review activity", summary: "A local observation needs review.", confidence: 0.8 });
    assert.equal(first.id, duplicate.id);
    assert.equal(kernel.getProjection().candidates.length, 1);

    kernel.setSourcePolicy("calendar", { enabled: true, permissionState: "user-enabled" });
    assert.equal(kernel.source("calendar").enabled, true);
    assert.equal(fs.existsSync(path.join(root, "workspaces")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enforces command and training budgets", () => {
  const { root, kernel } = makeKernel();
  try {
    kernel.startOperation({ taskId: "task-test", command: "verify", capability: "verify", descriptor: {} });
    kernel.finishOperation(kernel.getProjection().operations.at(-1).id, { status: "completed", result: { exitCode: 0 } });
    kernel.startOperation({ taskId: "task-test", command: "verify", capability: "verify", descriptor: {} });
    assert.throws(() => kernel.startOperation({ taskId: "task-test", command: "verify", capability: "verify", descriptor: {} }), /command budget exhausted/i);
    assert.throws(() => kernel.startOperation({ taskId: "task-test", command: "dream", capability: "train", descriptor: {} }), /command budget exhausted/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supersedes malformed structured-context candidates during restore", () => {
  const { root, kernel } = makeKernel();
  try {
    const candidate = kernel.createCandidate({ sourceId: "computer-history", title: "Review recent [object Object] activity", summary: "A structured activity value was not normalized." });
    const restored = new AgentKernel({ root, repoRoot: "/tmp/hemlock-project", task: kernel.getProjection().task });
    const repaired = restored.getProjection().candidates.find((item) => item.id === candidate.id);
    assert.equal(repaired.status, "dismissed");
    assert.equal(repaired.dismissedReason, "superseded_by_context_normalization");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
