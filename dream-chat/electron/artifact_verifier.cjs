const crypto = require("node:crypto");
const { sourceDigest } = require("./artifact_registry.cjs");

const VERIFICATION_SCHEMA = "hemlock.agent.artifact.verification.v1";

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`;
}

function issue(code, message, severity = "error", details = {}) {
  return { code, message, severity, ...details };
}

function verifyArtifactSource(artifact) {
  const issues = [];
  const source = artifact?.source;
  if (!artifact?.id || !artifact?.taskId) issues.push(issue("manifest_identity_missing", "The artifact manifest is missing its task or artifact identity."));
  if (!Number.isInteger(Number(artifact?.revision)) || Number(artifact.revision) < 1) issues.push(issue("revision_missing", "The artifact has no complete source revision."));
  if (!source || typeof source !== "object" || Array.isArray(source) || !Object.keys(source).length) issues.push(issue("source_missing", "The artifact source map is empty."));
  const entrypoint = String(artifact?.entrypoint || "");
  if (!entrypoint || !source?.[entrypoint]) issues.push(issue("entrypoint_missing", `The declared entrypoint is not present: ${entrypoint || "(empty)"}.`));
  if (source && typeof source === "object") {
    for (const [file, contents] of Object.entries(source)) {
      if (typeof contents !== "string") issues.push(issue("source_not_text", `Artifact source is not text: ${file}.`, "error", { file }));
      if (/^(?:https?:)?\/\//i.test(contents) && /(?:<script|<iframe|fetch\s*\(|XMLHttpRequest|src\s*=)/i.test(contents)) issues.push(issue("external_runtime_reference", `External runtime access is not supported in scratch preview: ${file}.`, "error", { file }));
    }
  }
  if (source?.[entrypoint]) {
    const entry = source[entrypoint];
    const kind = String(artifact.kind || "").toLowerCase();
    if (kind === "html" && !/<(?:html|body|main|svg)\b/i.test(entry)) issues.push(issue("html_structure_missing", "The HTML entrypoint has no renderable document structure."));
    if (kind === "svg" && !/<svg\b/i.test(entry)) issues.push(issue("svg_structure_missing", "The SVG entrypoint does not contain an SVG root."));
    if (kind === "json") {
      try { JSON.parse(entry); } catch (error) { issues.push(issue("json_invalid", `The JSON entrypoint is invalid: ${error.message}.`)); }
    }
  }
  let calculatedDigest = null;
  try { calculatedDigest = sourceDigest(source || {}); } catch (error) { issues.push(issue("source_digest_failed", error.message)); }
  if (artifact.digest && calculatedDigest && artifact.digest !== calculatedDigest) issues.push(issue("revision_digest_mismatch", "The manifest digest does not match the source map.", "error", { expected: artifact.digest, actual: calculatedDigest }));
  return { status: issues.some((item) => item.severity === "error") ? "failed" : "passed", issues, artifactId: artifact?.id || null, revision: Number(artifact?.revision || 0), digest: calculatedDigest };
}

function verifyPreviewReport({ artifact, session, report } = {}) {
  const issues = [];
  const inspection = report?.inspection || {};
  const dom = inspection.dom || inspection;
  const consoleErrors = Array.isArray(report?.consoleErrors) ? report.consoleErrors.filter(Boolean).slice(0, 20) : [];
  if (!report || report.schema !== "hemlock.agent.artifact.preview.report.v1") issues.push(issue("report_missing", "The renderer did not return a preview inspection report."));
  if (report?.taskId !== session?.taskId || report?.artifactId !== session?.artifactId || Number(report?.revision) !== Number(session?.revision)) issues.push(issue("stale_report", "The preview report belongs to a different task, artifact, or revision."));
  if (report?.sessionId !== session?.id) issues.push(issue("session_mismatch", "The preview report belongs to a different preview session."));
  if (!report?.ready || !dom || typeof dom !== "object") issues.push(issue("preview_not_ready", "The isolated preview did not reach a reportable ready state."));
  const hasRenderedContent = (Array.isArray(dom.elements) && dom.elements.length > 0) || (typeof dom.bodyText === "string" && dom.bodyText.trim().length > 0);
  if (!hasRenderedContent) issues.push(issue("entrypoint_not_rendered", "The preview report contains no rendered DOM content."));
  if (consoleErrors.length) issues.push(issue("console_errors", `The preview emitted ${consoleErrors.length} console/runtime error${consoleErrors.length === 1 ? "" : "s"}.`, "error", { consoleErrors }));
  const inspectionDigest = report?.inspectionDigest || digest(JSON.stringify({ inspection, consoleErrors, taskId: report?.taskId, artifactId: report?.artifactId, revision: report?.revision }));
  return {
    schema: VERIFICATION_SCHEMA,
    status: issues.length ? "failed" : "passed",
    taskId: session?.taskId || null,
    artifactId: session?.artifactId || null,
    revision: Number(session?.revision || 0),
    sessionId: session?.id || null,
    inspectionDigest,
    issues,
    consoleErrors,
    static: verifyArtifactSource(artifact),
  };
}

module.exports = { VERIFICATION_SCHEMA, digest, verifyArtifactSource, verifyPreviewReport };
