const assert = require("node:assert/strict");
const test = require("node:test");
const { ArtifactRegistry } = require("./artifact_registry.cjs");
const { verifyArtifactSource, verifyPreviewReport } = require("./artifact_verifier.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-artifact-verify-"));
  const registry = new ArtifactRegistry({ root, workspaceId: "workspace-local" });
  registry.create({ taskId: "task-verify", artifactId: "artifact-verify", kind: "html", entrypoint: "index.html", title: "Verified preview" });
  const artifact = registry.author({ taskId: "task-verify", artifactId: "artifact-verify", kind: "html", filename: "index.html", runtimeTemplate: "html", objective: "A verified preview", source: { "index.html": "<!doctype html><html><body><main aria-label=\"Demo\">Hello</main></body></html>" }, status: "previewable" });
  return { root, artifact };
}

test("static artifact verification requires an entrypoint and matching digest", () => {
  const { root, artifact } = fixture();
  try {
    assert.equal(verifyArtifactSource(artifact).status, "passed");
    assert.equal(verifyArtifactSource({ ...artifact, entrypoint: "missing.html" }).status, "failed");
    assert.equal(verifyArtifactSource({ ...artifact, digest: "sha256:stale" }).issues.some((item) => item.code === "revision_digest_mismatch"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("preview verification rejects stale reports and runtime errors", () => {
  const { root, artifact } = fixture();
  const session = { taskId: artifact.taskId, artifactId: artifact.id, revision: artifact.revision, id: "preview-verify" };
  try {
    const passed = verifyPreviewReport({ artifact, session, report: { schema: "hemlock.agent.artifact.preview.report.v1", taskId: artifact.taskId, artifactId: artifact.id, revision: artifact.revision, sessionId: session.id, ready: true, inspection: { dom: { bodyText: "Hello", elements: [{ tag: "main" }] } }, consoleErrors: [] } });
    assert.equal(passed.status, "passed");
    const empty = verifyPreviewReport({ artifact, session, report: { schema: "hemlock.agent.artifact.preview.report.v1", taskId: artifact.taskId, artifactId: artifact.id, revision: artifact.revision, sessionId: session.id, ready: true, inspection: { dom: { bodyText: "", elements: [] } }, consoleErrors: [] } });
    assert.equal(empty.issues.some((item) => item.code === "entrypoint_not_rendered"), true);
    const stale = verifyPreviewReport({ artifact, session, report: { schema: "hemlock.agent.artifact.preview.report.v1", taskId: artifact.taskId, artifactId: artifact.id, revision: artifact.revision - 1, sessionId: session.id, ready: true, inspection: { dom: { bodyText: "Hello" } }, consoleErrors: [] } });
    assert.equal(stale.issues.some((item) => item.code === "stale_report"), true);
    const runtime = verifyPreviewReport({ artifact, session, report: { schema: "hemlock.agent.artifact.preview.report.v1", taskId: artifact.taskId, artifactId: artifact.id, revision: artifact.revision, sessionId: session.id, ready: true, inspection: { dom: { bodyText: "Hello" } }, consoleErrors: [{ level: "error", message: "boom" }] } });
    assert.equal(runtime.issues.some((item) => item.code === "console_errors"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
