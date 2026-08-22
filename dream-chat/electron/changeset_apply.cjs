const fs = require("node:fs");
const path = require("node:path");
const { CHANGE_SET_SCHEMA, fileDigest, relativePath } = require("./coding_workspace.cjs");
const { sourceDigest } = require("./artifact_registry.cjs");

const APPLY_SCHEMA = "hemlock.agent.change-set.apply.v1";

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

// Honest bounded diff metric: trim the shared prefix/suffix lines, count what
// remains. Not a minimal edit script — a truthful "this many lines differ".
function lineDelta(before, after) {
  const beforeLines = String(before ?? "").split("\n");
  const afterLines = String(after ?? "").split("\n");
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1;
  let endBefore = beforeLines.length;
  let endAfter = afterLines.length;
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  return { added: endAfter - start, removed: endBefore - start };
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeBranchSegment(value) {
  const segment = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(segment)) throw new Error(`Change-set branch segment is not safe: ${value}`);
  return segment;
}

class ChangeSetApplier {
  constructor({ changesetRoot, readArtifactManifest = null, runGit = null, onEvent = () => {} } = {}) {
    if (!changesetRoot) throw new Error("ChangeSetApplier needs a changesetRoot.");
    this.changesetRoot = path.resolve(changesetRoot);
    this.readArtifactManifest = readArtifactManifest;
    this.runGit = runGit || this.defaultRunGit;
    this.onEvent = onEvent;
  }

  defaultRunGit(args, { cwd } = {}) {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 });
    return { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
  }

  changeSetDir(changeSetId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(changeSetId || ""))) throw new Error("Invalid Hemlock change-set ID.");
    return path.join(this.changesetRoot, changeSetId);
  }

  // Accepts {changeSetId} or {artifactId} (latest revision wins).
  locate({ changeSetId, artifactId } = {}) {
    if (changeSetId) {
      const dir = this.changeSetDir(changeSetId);
      const manifest = this.readJson(path.join(dir, "manifest.json"));
      if (!manifest) throw new Error(`Hemlock change set was not found: ${changeSetId}`);
      return { dir, manifest };
    }
    if (!artifactId) throw new Error("changeset.apply needs a changeSetId or artifactId.");
    if (!fs.existsSync(this.changesetRoot)) throw new Error(`No exported change sets exist yet (looked in ${this.changesetRoot}).`);
    const pattern = new RegExp(`^artifact-${String(artifactId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-r(\\d+)$`);
    let best = null;
    for (const entry of fs.readdirSync(this.changesetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = pattern.exec(entry.name);
      if (!match) continue;
      const manifest = this.readJson(path.join(this.changesetRoot, entry.name, "manifest.json"));
      if (manifest?.schema !== CHANGE_SET_SCHEMA) continue;
      if (!best || Number(match[1]) > best.revision) best = { dir: path.join(this.changesetRoot, entry.name), manifest, revision: Number(match[1]) };
    }
    if (!best) throw new Error(`No exported change set was found for artifact: ${artifactId}`);
    return { dir: best.dir, manifest: best.manifest };
  }

  readJson(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
  }

  // Staleness: the change set's own digest must match its staged source, and
  // when a live artifact resolver is wired, the artifact must still be on the
  // exported revision.
  assertFresh({ dir, manifest }) {
    let staged;
    try { staged = sourceDigest(manifest.artifactSource || {}); } catch (error) { throw new Error(`Change set source is unreadable: ${error.message}`); }
    if (manifest.artifactDigest && staged !== manifest.artifactDigest) {
      const error = new Error(`Change set is stale: staged digest ${manifest.artifactDigest} no longer matches its source (${staged}). Re-export the artifact.`);
      error.code = "CHANGESET_STALE";
      throw error;
    }
    if (this.readArtifactManifest && manifest.taskId && manifest.artifactId) {
      const live = this.readArtifactManifest(manifest.taskId, manifest.artifactId);
      if (live && live.digest !== manifest.artifactDigest) {
        const error = new Error(`Change set is stale: artifact ${manifest.artifactId} is now at digest ${live.digest}, but this change set carries ${manifest.artifactDigest}. Re-export the artifact.`);
        error.code = "CHANGESET_STALE";
        throw error;
      }
    }
    return { dir, manifest, stagedDigest: staged };
  }

  // The allowlist is the active thread's workspace root: the target repo must
  // equal it or live inside it.
  resolveTargetRepo({ targetRepo, threadWorkspaceRoot }) {
    if (!threadWorkspaceRoot) throw new Error("The active thread has no workspace root, so no repository is allowed for this apply.");
    const allowedRoot = path.resolve(threadWorkspaceRoot);
    const resolved = path.resolve(String(targetRepo || allowedRoot));
    if (!insideRoot(allowedRoot, resolved)) {
      const error = new Error(`Target repository is outside the allowed workspace: ${resolved} is not inside ${allowedRoot}.`);
      error.code = "TARGET_NOT_ALLOWED";
      throw error;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Target repository directory does not exist: ${resolved}`);
    return resolved;
  }

  planFiles({ manifest, targetRepo }) {
    const source = manifest.artifactSource || {};
    if (!Object.keys(source).length) throw new Error("The change set carries no files to apply.");
    const plan = [];
    for (const [file, content] of Object.entries(source)) {
      const relative = relativePath(file); // throws on traversal ("..", absolute, empty parts)
      const target = path.join(targetRepo, relative);
      if (!insideRoot(targetRepo, target)) {
        const error = new Error(`Change-set path escapes the target repository: ${file}`);
        error.code = "PATH_ESCAPE";
        throw error;
      }
      const existed = fs.existsSync(target);
      const before = existed ? fs.readFileSync(target, "utf8") : null;
      const { added, removed } = lineDelta(before, content);
      plan.push({ path: relative, absolutePath: target, existed, beforeDigest: fileDigest(target), added, removed, content });
    }
    return plan;
  }

  apply({ changeSetId, artifactId, targetRepo, dryRun = false, force = false, threadWorkspaceRoot, reason = "Artifact change set applied to repository" } = {}) {
    const located = this.assertFresh(this.locate({ changeSetId, artifactId }));
    const { dir, manifest } = located;
    if (manifest.status && !["waiting_for_approval"].includes(manifest.status) && !dryRun) {
      const error = new Error(`Change set ${manifest.id} is already ${manifest.status}; only a waiting change set can be applied.`);
      error.code = "CHANGESET_NOT_PENDING";
      this.onEvent("change-set.apply-rejected", "rejected", { changeSetId: manifest.id, reason: error.message, code: error.code }, { reversible: true });
      throw error;
    }
    const repo = this.resolveTargetRepo({ targetRepo, threadWorkspaceRoot });
    const plan = this.planFiles({ manifest, targetRepo: repo });
    const branch = `hemlock/${safeBranchSegment(manifest.artifactId || manifest.id)}`;
    const commitMessage = `Hemlock artifact ${String(manifest.artifactId || manifest.id)} (r${manifest.artifactRevision ?? 0})`;
    const title = manifest.artifactId ? `Hemlock artifact ${manifest.artifactId}` : manifest.id;

    if (dryRun) {
      const receipt = {
        schema: APPLY_SCHEMA,
        status: "planned",
        changeSetId: manifest.id,
        artifactId: manifest.artifactId || null,
        artifactRevision: manifest.artifactRevision ?? null,
        targetRepo: repo,
        dryRun: true,
        branch,
        commitMessage,
        plan: plan.map(({ path: filePath, existed, added, removed, beforeDigest }) => ({ path: filePath, existed, added, removed, beforeDigest })),
        totalFiles: plan.length,
        claimBoundary: "Dry run only: no files were written, no git state was changed.",
      };
      this.onEvent("change-set.apply-planned", "planned", { changeSetId: manifest.id, totalFiles: receipt.totalFiles, targetRepo: repo }, { reversible: true });
      return receipt;
    }

    const gitAvailable = this.runGit(["rev-parse", "--is-inside-work-tree"], { cwd: repo }).exitCode === 0;
    let appliedBranch = null;
    let commitSha = null;

    if (gitAvailable) {
      // --untracked-files=all: an untracked local file at a change-set path is still
      // the user's work — refuse without force just like a tracked modification.
      const dirty = this.runGit(["status", "--porcelain", "--untracked-files=all", "--", ...plan.map((item) => item.path)], { cwd: repo });
      if (dirty.exitCode !== 0) throw new Error(`Could not read git status in ${repo}: ${dirty.stderr || dirty.stdout}`);
      const conflicted = dirty.stdout.split("\n").filter(Boolean);
      if (conflicted.length && !force) {
        const error = new Error(`The target repository has uncommitted changes to change-set files (${conflicted.join(", ")}). Re-run with force to apply anyway.`);
        error.code = "TARGET_DIRTY";
        this.onEvent("change-set.apply-rejected", "rejected", { changeSetId: manifest.id, targetRepo: repo, reason: error.message, code: error.code, conflicted }, { reversible: true });
        throw error;
      }
      const exists = this.runGit(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repo });
      const checkout = exists.exitCode === 0
        ? this.runGit(["checkout", branch], { cwd: repo })
        : this.runGit(["checkout", "-b", branch], { cwd: repo });
      if (checkout.exitCode !== 0) throw new Error(`Could not switch to branch ${branch}: ${checkout.stderr || checkout.stdout}`);
      appliedBranch = branch;
    }

    const applied = [];
    try {
      for (const item of plan) {
        atomicWrite(item.absolutePath, item.content);
        applied.push(item.path);
      }
      if (gitAvailable) {
        const add = this.runGit(["add", "--", ...plan.map((item) => item.path)], { cwd: repo });
        if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
        const commit = this.runGit(["commit", "-m", commitMessage, "--", ...plan.map((item) => item.path)], { cwd: repo });
        if (commit.exitCode !== 0 && !/nothing to commit/.test(commit.stdout || "")) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
        const head = this.runGit(["rev-parse", "HEAD"], { cwd: repo });
        if (head.exitCode === 0) commitSha = head.stdout.trim();
      }
    } catch (error) {
      this.onEvent("change-set.apply-failed", "failed", { changeSetId: manifest.id, targetRepo: repo, error: error.message, appliedBeforeFailure: applied, branch: appliedBranch }, { reversible: true });
      throw error;
    }

    const receipt = {
      schema: APPLY_SCHEMA,
      status: "applied",
      changeSetId: manifest.id,
      taskId: manifest.taskId || null,
      artifactId: manifest.artifactId || null,
      artifactRevision: manifest.artifactRevision ?? null,
      artifactDigest: manifest.artifactDigest || null,
      title,
      targetRepo: repo,
      gitTracked: gitAvailable,
      applied,
      branch: appliedBranch,
      commitSha,
      commitMessage,
      reason: String(reason).slice(0, 1000),
      appliedAt: new Date().toISOString(),
      claimBoundary: "The exported artifact revision was written to the target repository on the recorded branch; verification is still required.",
    };
    const receiptPath = path.join(dir, "apply-receipt.json");
    atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    manifest.status = "applied_to_repo";
    manifest.appliedAt = receipt.appliedAt;
    manifest.applyReceiptPath = receiptPath;
    atomicWrite(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    this.onEvent("change-set.applied-to-repo", "applied", { changeSetId: manifest.id, artifactId: receipt.artifactId, revision: receipt.artifactRevision, targetRepo: repo, branch: appliedBranch, commitSha, applied }, { evidenceRefs: [receiptPath], reversible: true });
    return { ...receipt, receiptPath, evidenceRefs: [receiptPath, path.join(dir, "manifest.json")] };
  }
}

module.exports = { ChangeSetApplier, APPLY_SCHEMA, lineDelta, insideRoot };
