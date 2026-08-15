const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ArtifactRegistry, ARTIFACT_SCHEMA } = require("./artifact_registry.cjs");

test("creates task-scoped artifact revisions with parent and digest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-artifact-"));
  const events = [];
  const registry = new ArtifactRegistry({ root, workspaceId: "workspace-test", onEvent: (...args) => events.push(args) });
  const created = registry.create({ taskId: "task-1", artifactId: "garden", kind: "html", title: "Night garden", entrypoint: "index.html" });
  const first = registry.author({ taskId: "task-1", artifactId: "garden", kind: "html", filename: "index.html", runtimeTemplate: "html", objective: "Make a garden", source: { "index.html": "<h1>Hemlock</h1>" } });
  const second = registry.update({ taskId: "task-1", artifactId: "garden", source: { "index.html": "<h1>Hemlock at night</h1>", "style.css": "body{color:green}" }, status: "previewable" });
  assert.equal(created.schema, ARTIFACT_SCHEMA);
  assert.equal(first.revision, 1);
  assert.equal(second.revisions.at(-1).parent, "r1");
  assert.match(second.digest, /^sha256:/);
  assert.equal(events.at(-1)[0], "artifact.revision.created");
  assert.ok(fs.existsSync(path.join(root, "workspaces", "workspace-test", "tasks", "task-1", "artifacts", "garden", "revisions", "r2", "style.css")));
});

test("rejects traversal and authoring without an objective", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-artifact-"));
  const registry = new ArtifactRegistry({ root, workspaceId: "workspace-test" });
  registry.create({ taskId: "task-1", artifactId: "safe", kind: "text" });
  assert.throws(() => registry.update({ taskId: "task-1", artifactId: "safe", source: { "../escape.txt": "no" } }), /Invalid task-local artifact path/);
  assert.throws(() => registry.author({ taskId: "task-1", artifactId: "safe", filename: "index.txt", runtimeTemplate: "text" }), /requires validated/);
});

test("preserves host authoring status and evidence on a complete revision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-artifact-"));
  const registry = new ArtifactRegistry({ root, workspaceId: "workspace-test" });
  registry.create({ taskId: "task-1", artifactId: "garden", kind: "html" });
  const authored = registry.author({
    taskId: "task-1",
    artifactId: "garden",
    kind: "html",
    filename: "index.html",
    runtimeTemplate: "html",
    objective: "Make a watchable garden",
    source: { "index.html": "<main>Hemlock</main>" },
    status: "previewable",
    evidence: [{ type: "authoring.host_fallback", reason: "test" }],
  });
  assert.equal(authored.status, "previewable");
  assert.equal(authored.revisions.at(-1).status, "previewable");
  assert.equal(authored.evidence.at(-1).type, "authoring.host_fallback");
});
