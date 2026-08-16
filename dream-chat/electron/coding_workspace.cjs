const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { digest, workspaceFingerprint } = require("./thread_manager.cjs");

const CHANGE_SET_SCHEMA = "hemlock.agent.change-set.v1";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PROTECTED_NAMES = new Set([".env", ".env.local", ".env.production", ".npmrc", ".pypirc", "id_rsa", "id_ed25519"]);

function id(prefix = "change") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function fileDigest(filePath) {
  try { return digest(fs.readFileSync(filePath)); } catch { return null; }
}

function relativePath(value) {
  const result = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!result || result.startsWith("/") || result.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error(`Invalid scoped source path: ${value}`);
  return result;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

class CodingWorkspace {
  constructor({ runtimeRoot, threadManager, emit = () => {} } = {}) {
    if (!runtimeRoot || !threadManager) throw new Error("CodingWorkspace needs runtimeRoot and threadManager.");
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.threadManager = threadManager;
    this.emit = emit;
    this.root = path.join(this.runtimeRoot, "threads", "change-sets");
  }

  thread(threadId) {
    const thread = this.threadManager.thread(threadId);
    if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
    if (!thread.workspaceRoot) throw new Error("The thread has no assigned workspace directory.");
    return thread;
  }

  normalizeSource(source, patches) {
    const entries = [];
    if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const [file, content] of Object.entries(source)) entries.push({ path: relativePath(file), content });
    }
    if (Array.isArray(patches)) {
      for (const patch of patches) entries.push({ path: relativePath(patch?.path), content: patch?.content });
    }
    if (!entries.length) throw new Error("A coding edit needs a complete source map or bounded complete-file patches.");
    const deduped = new Map();
    let totalBytes = 0;
    for (const entry of entries) {
      if (typeof entry.content !== "string") throw new Error(`Coding edit for ${entry.path} must provide complete text content.`);
      const size = Buffer.byteLength(entry.content, "utf8");
      if (size > MAX_FILE_BYTES) throw new Error(`Coding edit exceeds the ${MAX_FILE_BYTES} byte per-file limit: ${entry.path}`);
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Coding edit exceeds the ${MAX_TOTAL_BYTES} byte total limit.`);
      if (PROTECTED_NAMES.has(path.basename(entry.path)) || /(^|\/)(?:\.env(?:\.|$)|.*\.pem|.*\.key)$/.test(entry.path)) {
        const error = new Error(`Coding edits cannot automatically modify secret-sensitive paths: ${entry.path}`);
        error.code = "SECRET_SCOPE";
        throw error;
      }
      deduped.set(entry.path, entry.content);
    }
    return [...deduped.entries()].map(([file, content]) => ({ path: file, content }));
  }

  apply({ threadId, source, patches, baseDigests = {}, reason = "Maple coding edit" } = {}) {
    const thread = this.thread(threadId);
    const entries = this.normalizeSource(source, patches);
    const lease = this.threadManager.acquireWriter(threadId, thread.workspaceRoot);
    const changeSetId = id("changeset");
    const changeRoot = path.join(this.root, changeSetId);
    const before = [];
    const files = [];
    try {
      for (const entry of entries) {
        const target = this.threadManager.assertScopedPath(threadId, path.join(thread.workspaceRoot, entry.path));
        const expected = baseDigests[entry.path];
        const actual = fileDigest(target);
        if (expected && expected !== actual) {
          const error = new Error(`The base file changed before Maple could edit it: ${entry.path}`);
          error.code = "WORKSPACE_DRIFT";
          error.path = entry.path;
          throw error;
        }
        before.push({ path: entry.path, existed: fs.existsSync(target), digest: actual, content: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null });
      }
      for (const entry of entries) {
        const target = this.threadManager.assertScopedPath(threadId, path.join(thread.workspaceRoot, entry.path));
        atomicWrite(target, entry.content);
        files.push({ path: entry.path, beforeDigest: before.find((item) => item.path === entry.path)?.digest || null, afterDigest: fileDigest(target), bytes: Buffer.byteLength(entry.content, "utf8") });
      }
      const manifest = {
        schema: CHANGE_SET_SCHEMA,
        id: changeSetId,
        threadId,
        workspaceRoot: thread.workspaceRoot,
        reason: String(reason).slice(0, 1000),
        baseWorkspaceDigest: workspaceFingerprint(thread.workspaceRoot),
        files,
        before,
        rollbackPath: path.join(changeRoot, "rollback.json"),
        status: "applied",
        createdAt: new Date().toISOString(),
      };
      fs.mkdirSync(changeRoot, { recursive: true });
      const rollback = { schema: "hemlock.agent.change-set.rollback.v1", changeSetId, threadId, workspaceRoot: thread.workspaceRoot, before };
      fs.writeFileSync(path.join(changeRoot, "rollback.json"), `${JSON.stringify(rollback, null, 2)}\n`, "utf8");
      fs.writeFileSync(path.join(changeRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      this.emit("change-set.applied", "passed", { changeSet: manifest }, { evidenceRefs: [path.join(changeRoot, "manifest.json")] });
      return { ...manifest, evidenceRefs: [path.join(changeRoot, "manifest.json"), path.join(changeRoot, "rollback.json")] };
    } catch (error) {
      for (const item of before.slice().reverse()) {
        try {
          const target = this.threadManager.assertScopedPath(threadId, path.join(thread.workspaceRoot, item.path));
          if (item.existed) atomicWrite(target, item.content);
          else if (fs.existsSync(target)) fs.rmSync(target, { force: true });
        } catch { /* preserve the original failure; rollback best effort */ }
      }
      this.emit("change-set.failed", "failed", { threadId, error: error.message, code: error.code || null }, { reversible: true });
      throw error;
    } finally {
      lease.release();
    }
  }

  inspect({ threadId } = {}) {
    const thread = this.thread(threadId);
    return { schema: "hemlock.agent.workspace.inspection.v1", status: "passed", threadId, workspaceRoot: thread.workspaceRoot, workspaceDigest: workspaceFingerprint(thread.workspaceRoot), evidenceRefs: [thread.workspaceRoot] };
  }

  rollback({ threadId, changeSetId } = {}) {
    const thread = this.thread(threadId);
    const rollbackPath = path.join(this.root, String(changeSetId), "rollback.json");
    let rollback;
    try { rollback = JSON.parse(fs.readFileSync(rollbackPath, "utf8")); } catch { throw new Error(`Change-set rollback receipt was not found: ${changeSetId}`); }
    const lease = this.threadManager.acquireWriter(threadId, thread.workspaceRoot);
    try {
      for (const item of rollback.before || []) {
        const target = this.threadManager.assertScopedPath(threadId, path.join(thread.workspaceRoot, item.path));
        if (item.existed) atomicWrite(target, item.content);
        else if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      }
      this.emit("change-set.rolled-back", "passed", { threadId, changeSetId }, { evidenceRefs: [rollbackPath] });
      return { schema: CHANGE_SET_SCHEMA, status: "rolled-back", id: changeSetId, threadId, evidenceRefs: [rollbackPath] };
    } finally {
      lease.release();
    }
  }
}

module.exports = { CHANGE_SET_SCHEMA, CodingWorkspace, fileDigest, relativePath };
