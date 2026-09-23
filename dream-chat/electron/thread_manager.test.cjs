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

test("switching away from a running thread parks it instead of claiming live work", () => {
  const item = fixture();
  try {
    const first = item.manager.ensureDefaultThread();
    item.manager.updateThread(first.id, {
      status: "running",
      phase: "executing",
      taskId: "task-live",
      taskSnapshot: { id: "task-live", status: "running", phase: "executing" },
    });
    const second = item.manager.createThread({ workspaceRoot: item.projectB, title: "Other work" });
    const parked = item.manager.thread(first.id);
    assert.equal(parked.status, "paused");
    assert.equal(parked.phase, "paused");
    assert.equal(parked.taskSnapshot.status, "paused");
    assert.match(parked.blockedReason, /switched to another thread/i);
    assert.equal(item.manager.latestCheckpoint(first.id).reason, "thread-switched-away");
    assert.equal(item.manager.snapshot().activeThreadId, second.id);
    // Switching back is allowed: paused is resumable, not terminal.
    assert.equal(item.manager.switchThread(first.id).id, first.id);
    // A parked thread does not park again when switched away from.
    item.manager.switchThread(second.id);
    assert.equal(item.manager.thread(first.id).status, "paused");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("archive reassigns active pointers, restore un-archives, rename validates", () => {
  const item = fixture();
  try {
    const first = item.manager.ensureDefaultThread();
    const second = item.manager.createThread({ workspaceRoot: item.projectB, title: "Soon archived" });
    assert.equal(item.manager.snapshot().activeThreadId, second.id);
    item.manager.archiveThread(second.id);
    assert.equal(item.manager.thread(second.id).status, "archived");
    assert.equal(item.manager.snapshot().activeThreadId, first.id);
    assert.equal(item.manager.project(item.manager.thread(second.id).projectId).activeThreadId, null);
    assert.throws(() => item.manager.switchThread(second.id), /restored/);
    assert.throws(() => item.manager.restoreThread(first.id), /only archived/i);
    const restored = item.manager.restoreThread(second.id);
    assert.equal(restored.status, "ready");
    assert.equal(restored.archivedAt, null);
    assert.equal(item.manager.renameThread(second.id, "  Renamed thread  ").title, "Renamed thread");
    assert.throws(() => item.manager.renameThread(second.id, "   "), /title is required/i);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("deleteThread removes registry entry and owned files, refuses live work without force", () => {
  const item = fixture();
  try {
    const thread = item.manager.createThread({ workspaceRoot: item.projectA, title: "Disposable" });
    item.manager.appendConversation(thread.id, { role: "user", content: "hi" });
    item.manager.checkpoint(thread.id, { phase: "conversation", status: "ready" });
    item.manager.createSuggestion({ threadId: thread.id, title: "Try this" });
    item.manager.updateThread(thread.id, { status: "running", phase: "executing", taskId: "task-x" });
    assert.throws(() => item.manager.deleteThread(thread.id), /live work/);
    const result = item.manager.deleteThread(thread.id, { force: true });
    assert.equal(result.deleted, true);
    assert.equal(item.manager.thread(thread.id), null);
    assert.equal(item.manager.snapshot().threads.some((item) => item.id === thread.id), false);
    assert.equal(item.manager.listSuggestions({ threadId: thread.id }).length, 0);
    assert.equal(item.manager.checkpoints(thread.id).length, 0);
    assert.equal(fs.existsSync(item.manager.thread(thread.id)?.conversationRef || ""), false);
    assert.notEqual(item.manager.snapshot().activeThreadId, thread.id);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("cancelling a queued waiter thread rejects its pending provider acquire", async () => {
  const item = fixture();
  try {
    const first = item.manager.createThread({ workspaceRoot: item.projectA, title: "Lane holder" });
    const second = item.manager.createThread({ workspaceRoot: item.projectB, title: "Waiting" });
    const lease = await item.manager.acquireProvider("maple", first.id);
    const waiting = item.manager.acquireProvider("maple", second.id);
    item.manager.cancelThread(second.id);
    await assert.rejects(waiting, /cancelled/);
    lease.release();
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("taskHistory records previous task ids when the pointer moves", () => {
  const item = fixture();
  try {
    const thread = item.manager.ensureDefaultThread();
    item.manager.updateThread(thread.id, { taskId: "task-1" });
    item.manager.updateThread(thread.id, { taskId: "task-2" });
    item.manager.updateThread(thread.id, { taskId: "task-3" });
    assert.deepEqual(item.manager.thread(thread.id).taskHistory, ["task-1", "task-2"]);
    const restored = new ThreadManager({ root: item.runtime, defaultWorkspaceRoot: item.projectA });
    assert.deepEqual(restored.thread(thread.id).taskHistory, ["task-1", "task-2"]);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("corrupt registry recovers from backup and quarantines the bad file", () => {
  const item = fixture();
  try {
    const thread = item.manager.createThread({ workspaceRoot: item.projectA, title: "Durable" });
    const registryPath = path.join(item.runtime, "threads", "registry.json");
    fs.writeFileSync(registryPath, "{ not json", "utf8");
    const recovered = new ThreadManager({ root: item.runtime, defaultWorkspaceRoot: item.projectA });
    assert.ok(recovered.thread(thread.id), "expected recovery from registry.json.bak");
    const quarantined = fs.readdirSync(path.dirname(registryPath)).filter((name) => name.startsWith("registry.json.corrupt-"));
    assert.equal(quarantined.length, 1);
    // A corrupt registry with no usable backup starts clean instead of crashing.
    fs.writeFileSync(registryPath, "{ not json again", "utf8");
    fs.rmSync(`${registryPath}.bak`, { force: true });
    const fresh = new ThreadManager({ root: item.runtime, defaultWorkspaceRoot: item.projectA });
    assert.equal(fresh.snapshot().threads.length, 0);
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
