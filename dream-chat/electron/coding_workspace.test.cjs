const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CodingWorkspace } = require("./coding_workspace.cjs");
const { ThreadManager } = require("./thread_manager.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-code-workspace-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "index.js"), "export const value = 1;\n");
  const threads = new ThreadManager({ root: path.join(root, "runtime"), defaultWorkspaceRoot: project });
  const thread = threads.createThread({ workspaceRoot: project, title: "Coding test" });
  return { root, project, threads, thread, workspace: new CodingWorkspace({ runtimeRoot: path.join(root, "runtime"), threadManager: threads }) };
}

test("applies scoped complete-file edits with rollback evidence", () => {
  const item = fixture();
  try {
    const result = item.workspace.apply({ threadId: item.thread.id, source: { "index.js": "export const value = 2;\n", "src/new.js": "export const extra = true;\n" }, reason: "test edit" });
    assert.equal(result.status, "applied");
    assert.match(fs.readFileSync(path.join(item.project, "index.js"), "utf8"), /value = 2/);
    assert.equal(fs.existsSync(path.join(item.project, "src/new.js")), true);
    const restored = item.workspace.rollback({ threadId: item.thread.id, changeSetId: result.id });
    assert.equal(restored.status, "rolled-back");
    assert.match(fs.readFileSync(path.join(item.project, "index.js"), "utf8"), /value = 1/);
    assert.equal(fs.existsSync(path.join(item.project, "src/new.js")), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
test("rejects path escapes, secret-sensitive files, and stale base digests", () => {
  const item = fixture();
  try {
    assert.throws(() => item.workspace.apply({ threadId: item.thread.id, source: { "../escape.js": "no" } }), /Invalid scoped source path/i);
    assert.throws(() => item.workspace.apply({ threadId: item.thread.id, source: { ".env": "TOKEN=bad" } }), /secret-sensitive/i);
    assert.throws(() => item.workspace.apply({ threadId: item.thread.id, source: { "index.js": "stale" }, baseDigests: { "index.js": "sha256:stale" } }), /base file changed/i);
    assert.match(fs.readFileSync(path.join(item.project, "index.js"), "utf8"), /value = 1/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
