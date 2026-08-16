const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ARTIFACT_SCHEMA = "hemlock.agent.artifact.v1";
const VALID_KINDS = new Set(["html", "javascript", "css", "svg", "image", "text", "ascii", "markdown", "json", "audio", "video", "binary"]);
const VALID_STATUSES = new Set(["drafting", "previewable", "ready", "failed", "superseded", "exported_to_change_set"]);
const RUNTIME_TEMPLATES = new Set(["html", "canvas", "text", "svg", "markdown", "json", "media", "binary"]);
const COMPATIBLE_RUNTIME_TEMPLATES = {
  html: new Set(["html", "canvas"]),
  svg: new Set(["svg", "html"]),
  javascript: new Set(["html", "canvas"]),
  css: new Set(["html"]),
  text: new Set(["text", "markdown"]),
  ascii: new Set(["text"]),
  markdown: new Set(["markdown", "text"]),
  json: new Set(["json"]),
  image: new Set(["media"]),
  audio: new Set(["media"]),
  video: new Set(["media"]),
  binary: new Set(["binary"]),
};

function nowIso() { return new Date().toISOString(); }
function digest(value) { return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`; }
function safeSegment(value, label) {
  const segment = String(value || "").trim();
  if (!segment || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(segment)) throw new Error(`Invalid artifact ${label}.`);
  return segment;
}
function safeRelativePath(value) {
  const candidate = String(value || "").replaceAll("\\", "/");
  if (!candidate || candidate.startsWith("/") || candidate.split("/").some((part) => !part || part === ".." || part === ".")) throw new Error(`Invalid task-local artifact path: ${value}`);
  return candidate;
}
function stableSource(source = {}) {
  if (typeof source === "string") return { "index.txt": source };
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Artifact source must be text or a relative file map.");
  const result = {};
  for (const [file, content] of Object.entries(source)) {
    const relative = safeRelativePath(file);
    if (typeof content !== "string") throw new Error(`Artifact source ${file} must be text in v1.`);
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error(`Artifact source ${file} exceeds the 2 MiB v1 file limit.`);
    result[relative] = content;
  }
  return Object.fromEntries(Object.keys(result).sort().map((key) => [key, result[key]]));
}
function sourceDigest(source) { return digest(JSON.stringify(stableSource(source))); }
function applyPatches(source, patches = []) {
  if (!Array.isArray(patches) || patches.length > 24) throw new Error("Artifact patches must be a bounded list of at most 24 file replacements.");
  const next = { ...(source || {}) };
  for (const patch of patches) {
    const file = safeRelativePath(patch?.path || patch?.file || "");
    if (typeof patch?.content !== "string") throw new Error(`Artifact patch ${file} must provide complete text content.`);
    if (patch.content.length > 2 * 1024 * 1024) throw new Error(`Artifact patch ${file} exceeds the 2 MiB v1 file limit.`);
    next[file] = patch.content;
  }
  return stableSource(next);
}

class ArtifactRegistry {
  constructor({ root, workspaceId, onEvent = () => {}, changeSet = null }) {
    this.root = path.resolve(root);
    this.workspaceId = safeSegment(workspaceId || "workspace-local", "workspace ID");
    this.workspaceRoot = path.join(this.root, "workspaces", this.workspaceId, "tasks");
    this.onEvent = onEvent;
    this.changeSet = changeSet;
  }

  taskRoot(taskId) { return path.join(this.workspaceRoot, safeSegment(taskId, "task ID")); }
  artifactRoot(taskId, artifactId) { return path.join(this.taskRoot(taskId), "artifacts", safeSegment(artifactId, "artifact ID")); }
  manifestPath(taskId, artifactId) { return path.join(this.artifactRoot(taskId, artifactId), "manifest.json"); }
  read(taskId, artifactId) {
    const manifest = this.readJson(this.manifestPath(taskId, artifactId), null);
    if (!manifest || manifest.schema !== ARTIFACT_SCHEMA) throw new Error(`Artifact was not found: ${artifactId}`);
    return manifest;
  }
  list(taskId = null) {
    const taskRoots = taskId ? [this.taskRoot(taskId)] : (fs.existsSync(this.workspaceRoot) ? fs.readdirSync(this.workspaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(this.workspaceRoot, entry.name)) : []);
    const artifacts = [];
    for (const taskRoot of taskRoots) {
      const artifactRoot = path.join(taskRoot, "artifacts");
      if (!fs.existsSync(artifactRoot)) continue;
      for (const entry of fs.readdirSync(artifactRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = this.readJson(path.join(artifactRoot, entry.name, "manifest.json"), null);
        if (manifest?.schema === ARTIFACT_SCHEMA) artifacts.push(manifest);
      }
    }
    return artifacts.sort((a, b) => String(a.timestamps?.updatedAt).localeCompare(String(b.timestamps?.updatedAt)));
  }
  readJson(filePath, fallback) { try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; } }
  writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
  emit(type, status, payload, evidenceRefs = []) { this.onEvent(type, status, payload, evidenceRefs); }

  create(input = {}) {
    const taskId = safeSegment(input.taskId, "task ID");
    const artifactId = safeSegment(input.artifactId || `artifact-${Date.now()}`, "artifact ID");
    const kind = String(input.kind || "html").toLowerCase();
    if (!VALID_KINDS.has(kind)) throw new Error(`Unsupported artifact kind: ${kind}`);
    const title = String(input.title || "Untitled artifact").trim().slice(0, 200) || "Untitled artifact";
    const entrypoint = safeRelativePath(input.entrypoint || (kind === "html" ? "index.html" : "index.txt"));
    const root = this.artifactRoot(taskId, artifactId);
    if (fs.existsSync(this.manifestPath(taskId, artifactId))) throw new Error(`Artifact already exists: ${artifactId}`);
    const createdAt = nowIso();
    const manifest = {
      schema: ARTIFACT_SCHEMA,
      id: artifactId,
      taskId,
      workspaceId: this.workspaceId,
      title,
      kind,
      mime: String(input.mime || (kind === "html" ? "text/html" : "text/plain")),
      entrypoint,
      status: "drafting",
      revision: 0,
      digest: null,
      source: {},
      changeSet: null,
      previewPolicy: { sandbox: true, network: false, hostAccess: false, arbitraryEval: false },
      timestamps: { createdAt, updatedAt: createdAt, lastPreviewAt: null },
      evidence: [],
      revisions: [],
      claimBoundary: "Artifact source is task scratch state under Hemlock application data; repository source is unchanged.",
    };
    this.writeJson(path.join(root, "manifest.json"), manifest);
    this.emit("artifact.created", "drafting", { artifact: manifest }, [path.join(root, "manifest.json")]);
    return manifest;
  }

  author(input = {}) {
    const artifact = this.read(input.taskId, input.artifactId);
    const kind = String(input.kind || artifact.kind).toLowerCase();
    const filename = safeRelativePath(input.filename || artifact.entrypoint);
    const runtimeTemplate = String(input.runtimeTemplate || input.runtime || "html").toLowerCase();
    const objective = String(input.objective || "").trim();
    if (!VALID_KINDS.has(kind) || !RUNTIME_TEMPLATES.has(runtimeTemplate) || !COMPATIBLE_RUNTIME_TEMPLATES[kind]?.has(runtimeTemplate) || !filename || !objective) throw new Error("artifact.author requires validated kind, filename, runtime template, and objective.");
    return this.update({
      taskId: input.taskId,
      artifactId: input.artifactId,
      source: input.source || { [filename]: "" },
      status: VALID_STATUSES.has(input.status) ? input.status : "drafting",
      evidence: [
        { type: "authoring.started", objective, runtimeTemplate },
        ...(Array.isArray(input.evidence) ? input.evidence : []),
      ],
    });
  }

  update(input = {}) {
    const artifact = this.read(input.taskId, input.artifactId);
    const source = input.source != null ? stableSource(input.source) : Array.isArray(input.patches) ? applyPatches(artifact.source, input.patches) : stableSource(artifact.source);
    const revision = artifact.revision + 1;
    const revisionId = `r${revision}`;
    const revisionRoot = path.join(this.artifactRoot(input.taskId, input.artifactId), "revisions", revisionId);
    for (const [relative, content] of Object.entries(source)) {
      const target = path.join(revisionRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
    const entrypoint = safeRelativePath(input.entrypoint || artifact.entrypoint);
    const record = { id: revisionId, revision, parent: artifact.revision ? `r${artifact.revision}` : null, digest: sourceDigest(source), createdAt: nowIso(), source, status: input.status || "drafting", entrypoint };
    const next = { ...artifact, entrypoint, status: VALID_STATUSES.has(input.status) ? input.status : "drafting", revision, digest: record.digest, source, timestamps: { ...artifact.timestamps, updatedAt: record.createdAt }, revisions: [...artifact.revisions, record], evidence: [...artifact.evidence, ...(Array.isArray(input.evidence) ? input.evidence : [])].slice(-80) };
    this.writeJson(this.manifestPath(input.taskId, input.artifactId), next);
    this.emit("artifact.revision.created", "drafting", { artifact: next, revision: record }, [this.manifestPath(input.taskId, input.artifactId), path.join(this.artifactRoot(input.taskId, input.artifactId), "revisions", revisionId)]);
    return next;
  }

  restore(input = {}) {
    const artifact = this.read(input.taskId, input.artifactId);
    const revision = Number(input.revision);
    const record = artifact.revisions.find((item) => item.revision === revision);
    if (!record) throw new Error(`Artifact revision was not found: r${revision}`);
    const next = { ...artifact, entrypoint: record.entrypoint || artifact.entrypoint, status: "ready", revision: record.revision, digest: record.digest, source: record.source, timestamps: { ...artifact.timestamps, updatedAt: nowIso() }, evidence: [...artifact.evidence, { type: "artifact.revision.restored", revision }].slice(-80) };
    this.writeJson(this.manifestPath(input.taskId, input.artifactId), next);
    const evidenceRefs = [this.manifestPath(input.taskId, input.artifactId), path.join(this.artifactRoot(input.taskId, input.artifactId), "revisions", `r${revision}`)];
    this.emit("artifact.revision.restored", "passed", { artifact: next, revision }, evidenceRefs);
    return { ...next, manifestPath: evidenceRefs[0], revisionPath: evidenceRefs[1], evidenceRefs, summary: `Restored artifact revision ${revision}.` };
  }

  inspect(input = {}) {
    const artifact = this.read(input.taskId, input.artifactId);
    return { schema: "hemlock.agent.artifact.inspection.v1", status: "ready", artifact, source: artifact.source, revision: artifact.revisions.at(-1) || null, evidenceRefs: [this.manifestPath(input.taskId, input.artifactId)] };
  }

  compare(input = {}) {
    const artifact = this.read(input.taskId, input.artifactId);
    const from = artifact.revisions.find((item) => item.revision === Number(input.from));
    const to = artifact.revisions.find((item) => item.revision === Number(input.to)) || artifact.revisions.at(-1);
    if (!from || !to) throw new Error("Both artifact revisions are required for comparison.");
    const files = [...new Set([...Object.keys(from.source), ...Object.keys(to.source)])].sort().map((file) => ({ file, before: from.source[file] ?? null, after: to.source[file] ?? null }));
    return { schema: "hemlock.agent.artifact.compare.v1", status: "ready", artifactId: artifact.id, from: from.revision, to: to.revision, files, digest: digest(JSON.stringify(files)), evidenceRefs: [this.manifestPath(input.taskId, input.artifactId)] };
  }

  freeze(input = {}) { return this.update({ ...input, status: "ready", evidence: [{ type: "artifact.frozen", revision: this.read(input.taskId, input.artifactId).revision }] }); }

  export(input = {}) {
    const artifact = this.read(input.taskId, input.artifactId);
    if (!artifact.revision || !artifact.source || !Object.keys(artifact.source).length) throw new Error("Only a complete artifact revision can be exported.");
    const changeSet = this.changeSet ? this.changeSet({ artifact, taskId: input.taskId }) : { status: "waiting_for_approval", artifactId: artifact.id, digest: artifact.digest };
    const next = { ...artifact, status: "exported_to_change_set", changeSet, timestamps: { ...artifact.timestamps, updatedAt: nowIso() } };
    this.writeJson(this.manifestPath(input.taskId, input.artifactId), next);
    this.emit("artifact.exported", "waiting_for_approval", { artifact: next, changeSet }, [this.manifestPath(input.taskId, input.artifactId)]);
    return { schema: "hemlock.agent.artifact.export.v1", status: "waiting_for_approval", artifact: next, changeSet, claimBoundary: "Export prepared the existing approval-gated change-set path; repository source was not mutated." };
  }
}

module.exports = { ArtifactRegistry, ARTIFACT_SCHEMA, VALID_KINDS, sourceDigest, stableSource, applyPatches, digest };
