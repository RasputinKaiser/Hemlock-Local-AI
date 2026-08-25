const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChangeSetApplier, lineDelta, insideRoot } = require("./changeset_apply.cjs");
const { CHANGE_SET_SCHEMA } = require("./coding_workspace.cjs");
const { sourceDigest } = require("./artifact_registry.cjs");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture({ tamperDigest = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-changeset-apply-"));
  const workspace = path.join(root, "workspace-repo");
  fs.mkdirSync(workspace, { recursive: true });
  const changesetRoot = path.join(root, "changesets");
  const source = { "index.js": "export const value = 2;\n", "src/new.js": "export const extra = true;\n" };
  const manifest = {
    schema: CHANGE_SET_SCHEMA,
    id: "artifact-test-artifact-r3",
    status: "waiting_for_approval",
    taskId: "task-1",
    artifactId: "test-artifact",
    artifactRevision: 3,
    artifactDigest: sourceDigest(source),
    artifactSource: source,
    createdAt: new Date().toISOString(),
    approvalRequired: true,
    claimBoundary: "test",
  };
  if (tamperDigest) manifest.artifactSource["index.js"] = "export const value = 999;\n";
  fs.mkdirSync(path.join(changesetRoot, manifest.id), { recursive: true });
  fs.writeFileSync(path.join(changesetRoot, manifest.id, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const events = [];
  const applier = new ChangeSetApplier({
    changesetRoot,
    onEvent: (type, status, payload, extra) => events.push({ type, status, payload, extra }),
  });
  return { root, workspace, changesetRoot, manifest, applier, events };
}

function initRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "hemlock@example.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Hemlock Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
}

test("dryRun returns the plan and writes nothing", () => {
  const item = fixture();
  try {
    initRepo(item.workspace);
    const before = git(["status", "--porcelain", "--untracked-files=all"], item.workspace);
    const plan = item.applier.apply({
      changeSetId: item.manifest.id,
      threadWorkspaceRoot: item.workspace,
      dryRun: true,
    });
    assert.equal(plan.status, "planned");
    assert.equal(plan.dryRun, true);
    assert.equal(plan.totalFiles, 2);
    assert.equal(plan.branch, "hemlock/test-artifact");
    assert.deepEqual(plan.plan.map((entry) => entry.path).sort(), ["index.js", "src/new.js"]);
    for (const entry of plan.plan) assert.equal(entry.existed, false);
    const after = git(["status", "--porcelain", "--untracked-files=all"], item.workspace);
    assert.equal(after, before);
    const initialBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], item.workspace).trim();
    assert.ok(["master", "main"].includes(initialBranch), `unexpected initial branch ${initialBranch}`);
    assert.equal(fs.existsSync(path.join(item.changesetRoot, item.manifest.id, "apply-receipt.json")), false);
    assert.equal(item.events.some((event) => event.type === "change-set.apply-planned"), true);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("path traversal outside the target repository is rejected without writes", () => {
  const item = fixture();
  try {
    // A hostile exporter can write any manifest to disk; compute the digest by the
    // same recipe without the registry's path validation in the way.
    const crypto = require("node:crypto");
    item.manifest.artifactSource = { "../escape.js": "nope\n" };
    item.manifest.artifactDigest = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(item.manifest.artifactSource)).digest("hex");
    fs.writeFileSync(path.join(item.changesetRoot, item.manifest.id, "manifest.json"), `${JSON.stringify(item.manifest, null, 2)}\n`, "utf8");
    const escapeTarget = path.resolve(item.workspace, "..", "escape.js");
    assert.throws(
      () => item.applier.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: item.workspace }),
      /Invalid task-local artifact path/i,
    );
    assert.equal(fs.existsSync(escapeTarget), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("digest mismatch refuses a stale change set", () => {
  const item = fixture({ tamperDigest: true });
  try {
    assert.throws(
      () => item.applier.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: item.workspace, dryRun: true }),
      /stale.*Re-export the artifact/is,
    );
    // A live-artifact resolver also catches drift between export time and now.
    const guarded = new ChangeSetApplier({
      changesetRoot: item.changesetRoot,
      readArtifactManifest: () => ({ digest: "sha256:no-longer-current" }),
    });
    assert.throws(
      () => guarded.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: item.workspace, dryRun: true }),
      /stale.*Re-export the artifact/is,
    );
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("targets outside the allowed thread workspace are refused", () => {
  const item = fixture();
  try {
    assert.throws(
      () => item.applier.apply({ changeSetId: item.manifest.id, targetRepo: os.tmpdir(), threadWorkspaceRoot: item.workspace }),
      /outside the allowed workspace/i,
    );
    assert.throws(
      () => item.applier.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: null }),
      /no workspace root/i,
    );
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("uncommitted changes to change-set files refuse without force", () => {
  const item = fixture();
  try {
    initRepo(item.workspace);
    fs.writeFileSync(path.join(item.workspace, "index.js"), "local work in progress\n", "utf8");
    assert.throws(
      () => item.applier.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: item.workspace }),
      /uncommitted changes.*force/is,
    );
    assert.equal(fs.readFileSync(path.join(item.workspace, "index.js"), "utf8"), "local work in progress\n");
    const receipt = item.applier.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: item.workspace, force: true });
    assert.equal(receipt.status, "applied");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("happy-path apply creates branch, commit, and a full receipt", () => {
  const item = fixture();
  try {
    initRepo(item.workspace);
    const receipt = item.applier.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: item.workspace });
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.gitTracked, true);
    assert.deepEqual(receipt.applied.sort(), ["index.js", "src/new.js"]);
    assert.match(receipt.commitMessage, /^Hemlock artifact test-artifact \(r3\)$/);
    assert.equal(receipt.branch, "hemlock/test-artifact");
    assert.match(receipt.commitSha, /^[0-9a-f]{40}$/);
    const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], item.workspace).trim();
    assert.equal(currentBranch, "hemlock/test-artifact");
    assert.equal(fs.readFileSync(path.join(item.workspace, "index.js"), "utf8"), "export const value = 2;\n");
    assert.equal(fs.readFileSync(path.join(item.workspace, "src/new.js"), "utf8"), "export const extra = true;\n");
    const commitMessage = git(["show", "--format=%B", "-s", "HEAD"], item.workspace).trim();
    assert.equal(commitMessage, "Hemlock artifact test-artifact (r3)");
    // Receipt file exists on disk and carries the same evidence.
    const stored = JSON.parse(fs.readFileSync(path.join(item.changesetRoot, item.manifest.id, "apply-receipt.json"), "utf8"));
    assert.equal(stored.schema, "hemlock.agent.change-set.apply.v1");
    assert.equal(stored.branch, receipt.branch);
    assert.equal(stored.commitSha, receipt.commitSha);
    assert.equal(stored.claimBoundary.length > 0, true);
    // Manifest is transitioned out of waiting_for_approval.
    const updated = JSON.parse(fs.readFileSync(path.join(item.changesetRoot, item.manifest.id, "manifest.json"), "utf8"));
    assert.equal(updated.status, "applied_to_repo");
    // Agent event records the accepted apply with evidence refs.
    const appliedEvent = item.events.find((event) => event.type === "change-set.applied-to-repo");
    assert.equal(appliedEvent?.status, "applied");
    assert.equal(appliedEvent.payload.commitSha, receipt.commitSha);
    assert.ok(appliedEvent.extra.evidenceRefs.includes(receipt.receiptPath));
    // Re-applying a consumed change set is refused.
    assert.throws(
      () => item.applier.apply({ changeSetId: item.manifest.id, threadWorkspaceRoot: item.workspace }),
      /already applied_to_repo/i,
    );
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("artifactId resolves the latest exported revision and non-git targets write untracked", () => {
  const item = fixture();
  try {
    const older = path.join(item.changesetRoot, "artifact-test-artifact-r2");
    fs.mkdirSync(older, { recursive: true });
    fs.writeFileSync(path.join(older, "manifest.json"), `${JSON.stringify({ ...item.manifest, id: "artifact-test-artifact-r2", artifactRevision: 2 }, null, 2)}\n`, "utf8");
    const plainDir = path.join(item.root, "plain-dir");
    fs.mkdirSync(plainDir, { recursive: true });
    const receipt = item.applier.apply({ artifactId: "test-artifact", threadWorkspaceRoot: plainDir });
    assert.equal(receipt.gitTracked, false);
    assert.equal(receipt.branch, null);
    assert.equal(receipt.commitSha, null);
    assert.equal(receipt.changeSetId, "artifact-test-artifact-r3"); // latest wins
    assert.equal(fs.readFileSync(path.join(plainDir, "index.js"), "utf8"), "export const value = 2;\n");
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("lineDelta and insideRoot helpers behave honestly", () => {
  assert.deepEqual(lineDelta("a\nb\nc\n", "a\nx\nc\n"), { added: 1, removed: 1 });
  assert.deepEqual(lineDelta(null, "new\n"), { added: 1, removed: 0 });
  assert.deepEqual(lineDelta("old\n", null), { added: 0, removed: 1 });
  assert.equal(insideRoot("/tmp/repo", "/tmp/repo/sub/file.js"), true);
  assert.equal(insideRoot("/tmp/repo", "/tmp/other/file.js"), false);
});
