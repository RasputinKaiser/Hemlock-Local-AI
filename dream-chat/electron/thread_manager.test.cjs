const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ThreadManager, workspaceFingerprint } = require("./thread_manager.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-threads-"));
  const runtime = path.join(root, "runtime");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.writeFileSync(path.join(projectA, "README.md"), "A\n");
  fs.writeFileSync(path.join(projectB, "README.md"), "B\n");
  return { root, runtime, projectA, projectB, manager: new ThreadManager({ root: runtime, defaultWorkspaceRoot: projectA }) };
}

test("creates isolated projects and threads with durable checkpoints", () => {
  const item = fixture();
  try {
    const first = item.manager.ensureDefaultThread();
    const second = item.manager.createThread({ workspaceRoot: item.projectB, title: "Second project", provider: "codex", model: "gpt-5.6-luna", reasoning: "high" });
    assert.notEqual(first.id, second.id);
    assert.equal(item.manager.snapshot().threads.length, 2);
    const checkpoint = item.manager.checkpoint(second.id, { phase: "verifying", status: "running", activePlanStep: 4, evidenceRefs: ["receipt://test"] });
    assert.equal(checkpoint.threadId, second.id);
    assert.equal(item.manager.latestCheckpoint(second.id).id, checkpoint.id);
    assert.equal(item.manager.switchThread(second.id).id, second.id);
    assert.equal(item.manager.thread(second.id).checkpointId, checkpoint.id);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("provider slots allow Maple one lane and subscription lanes in parallel", async () => {
  const item = fixture();
  try {
    const first = item.manager.createThread({ workspaceRoot: item.projectA, title: "Maple one", provider: "maple" });
    const second = item.manager.createThread({ workspaceRoot: item.projectB, title: "Maple two", provider: "maple" });
    const codex = item.manager.createThread({ workspaceRoot: item.projectB, title: "Codex", provider: "codex" });
    const mapleOne = await item.manager.acquireProvider("maple", first.id);
    let mapleTwoReady = false;
    const mapleTwo = item.manager.acquireProvider("maple", second.id).then((lease) => { mapleTwoReady = true; return lease; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(mapleTwoReady, false);
    mapleOne.release();
    const mapleTwoLease = await mapleTwo;
    mapleTwoLease.release();
    const codexOne = await item.manager.acquireProvider("codex", codex.id);
    const codexTwo = await item.manager.acquireProvider("codex", first.id);
    assert.equal(codexOne.provider, "codex");
    assert.equal(codexTwo.provider, "codex");
    codexOne.release();
    codexTwo.release();
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("same workspace writer lock blocks a different thread and scope rejects escapes", () => {
  const item = fixture();
  try {
    const first = item.manager.createThread({ workspaceRoot: item.projectA, title: "Writer one" });
    const second = item.manager.createThread({ workspaceRoot: item.projectA, title: "Writer two" });
    const lease = item.manager.acquireWriter(first.id, item.projectA);
    assert.throws(() => item.manager.acquireWriter(second.id, item.projectA), /already being mutated/i);
    assert.equal(item.manager.assertScopedPath(first.id, path.join(item.projectA, "src", "new.js")), path.join(item.projectA, "src", "new.js"));
    assert.throws(() => item.manager.assertScopedPath(first.id, path.join(item.projectA, "..", "escape.js")), /outside/i);
    lease.release();
    const secondLease = item.manager.acquireWriter(second.id, item.projectA);
    secondLease.release();
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("workspace fingerprints change when a project file changes", () => {
  const item = fixture();
  try {
    const before = workspaceFingerprint(item.projectA);
    fs.writeFileSync(path.join(item.projectA, "new.txt"), "changed\n");
    assert.notEqual(workspaceFingerprint(item.projectA), before);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("persists provider capacity changes and thread conversation references", () => {
  const item = fixture();
  try {
    const thread = item.manager.createThread({ workspaceRoot: item.projectA, title: "Durable chat" });
    assert.deepEqual(item.manager.setProviderCaps({ maple: 1, codex: 3 }), { maple: 1, codex: 3, claude: 2 });
    item.manager.appendConversation(thread.id, { role: "user", content: "Build the next version." });
    item.manager.appendConversation(thread.id, { role: "assistant", content: "I will inspect the assigned project first." });
    const restored = new ThreadManager({ root: item.runtime, defaultWorkspaceRoot: item.projectA });
    assert.equal(restored.snapshot().providerCaps.codex, 3);
    assert.deepEqual(restored.readConversation(thread.id).map((entry) => entry.role), ["user", "assistant"]);
    assert.match(restored.thread(thread.id).conversationRef, /thread-/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
