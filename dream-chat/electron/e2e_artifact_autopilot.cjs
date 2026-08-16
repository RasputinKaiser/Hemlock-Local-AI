const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator, defaultPlanSteps } = require("./agent_orchestrator.cjs");
const { ACTION_SCHEMA, createAction } = require("./agent_contracts.cjs");
const { ArtifactRegistry } = require("./artifact_registry.cjs");
const { PreviewSessionManager } = require("./preview_policy.cjs");

function envelope(action) { return JSON.stringify({ schema: ACTION_SCHEMA, status: "proposed", ...action }); }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-artifact-autopilot-"));
  const task = {
    schema: "hemlock.agent.task.v1",
    id: "task-autopilot",
    objective: "Build this as a verified scratch animation",
    intent: "coding",
    interactionMode: "build",
    phase: "plan",
    status: "planning",
    foregroundStep: "Review plan",
    budget: { maxAgentSteps: 8, maxCommands: 24, maxRetriesPerOperation: 1, maxMutationSets: 1, maxArtifactRepairs: 2, commandsUsed: 0, agentStepsUsed: 0 },
  };
  const kernel = new AgentKernel({ root, repoRoot: path.join(root, "repo"), task });
  const registry = new ArtifactRegistry({ root, workspaceId: "workspace-local" });
  const previews = new PreviewSessionManager();
  const events = [];
  let artifactId = null;
  let inspectCalls = 0;
  let inferenceCalls = 0;
  let repairCalls = 0;
  const actions = [
    "not json",
    envelope(createAction({ taskId: task.id, step: 1, commandId: "artifact.create", shortRationale: "Create the bounded scratch artifact." })),
    envelope({ ...createAction({ taskId: task.id, step: 2, commandId: "none", shortRationale: "Author the artifact." }), commandId: "none", expectedEvidence: { "artifact://revision": true }, input: { source: { "index.html": 42 } } }),
    envelope(createAction({ taskId: task.id, step: 3, commandId: "artifact.preview.open", shortRationale: "Open the isolated preview." })),
    envelope(createAction({ taskId: task.id, step: 4, commandId: "artifact.preview.inspect", shortRationale: "Verify the rendered preview." })),
  ];
  const repairResponses = [
    "not a repair envelope",
    envelope({ ...createAction({ taskId: task.id, step: 5, commandId: "artifact.update", shortRationale: "Repair the runtime error." }), input: { source: { "index.html": "<!doctype html><html><body><main aria-label=\"Recovered\">Recovered artifact</main><script>console.log('healthy')</script></body></html>" } } }),
  ];
  let currentTask = task;
  const commandRegistry = Object.fromEntries(["artifact.create", "artifact.author", "artifact.update", "artifact.restore", "artifact.preview.open", "artifact.preview.inspect"].map((command) => [command, { capability: "artifact" }]));
  const executeCommand = async (command, input = {}) => {
    if (command === "artifact.create") {
      const artifact = registry.create({ taskId: task.id, artifactId: "artifact-autopilot", title: "Autopilot artifact", kind: "html", entrypoint: "index.html" });
      artifactId = artifact.id;
      return { ...artifact, evidenceRefs: [registry.manifestPath(task.id, artifact.id)], summary: "Created scratch artifact." };
    }
    if (command === "artifact.author") {
      const artifact = registry.author({ taskId: task.id, artifactId, kind: "html", filename: "index.html", runtimeTemplate: "html", objective: task.objective, source: { "index.html": "<!doctype html><html><body><main aria-label=\"Fallback\">Fallback artifact</main></body></html>" }, status: "previewable" });
      return { ...artifact, evidenceRefs: [registry.manifestPath(task.id, artifact.id), path.join(registry.artifactRoot(task.id, artifact.id), "revisions", `r${artifact.revision}`)], summary: "Author fallback revision." };
    }
    if (command === "artifact.update") {
      const artifact = registry.update({ taskId: task.id, artifactId, source: input.source, status: "previewable" });
      return { ...artifact, evidenceRefs: [registry.manifestPath(task.id, artifact.id), path.join(registry.artifactRoot(task.id, artifact.id), "revisions", `r${artifact.revision}`)], summary: "Repair revision recorded." };
    }
    if (command === "artifact.restore") return registry.restore({ taskId: task.id, artifactId, revision: input.revision });
    if (command === "artifact.preview.open") {
      const artifact = registry.read(task.id, artifactId);
      const session = previews.open({ taskId: task.id, artifactId, revision: input.revision || artifact.revision });
      return { schema: "hemlock.agent.preview.open.v1", status: "ready", session, artifact, evidenceRefs: [registry.manifestPath(task.id, artifactId)], summary: "Preview opened." };
    }
    if (command === "artifact.preview.inspect") {
      inspectCalls += 1;
      const session = previews.get(input.sessionId);
      if (inspectCalls === 1) return { schema: "hemlock.agent.preview.inspect.v1", status: "blocked", session, verification: { schema: "hemlock.agent.artifact.verification.v1", status: "failed", issues: [{ code: "console_errors", message: "runtime error: boom" }], inspectionDigest: "sha256:bad" }, evidenceRefs: ["receipt://preview-failed"], summary: "Preview verification failed." };
      return { schema: "hemlock.agent.preview.inspect.v1", status: "passed", session, verification: { schema: "hemlock.agent.artifact.verification.v1", status: "passed", issues: [], inspectionDigest: "sha256:good", receiptPath: "receipt://preview-good" }, evidenceRefs: ["receipt://preview-good"], summary: "Preview verification passed." };
    }
    throw new Error(`Unexpected fixture command: ${command}`);
  };
  const orchestrator = new AgentOrchestrator({
    kernel,
    commandRegistry,
    getTask: () => currentTask,
    setTask: (patch) => { currentTask = { ...currentTask, ...patch }; kernel.syncTask(currentTask); return currentTask; },
    emit: (type, status, payload) => events.push({ type, status, payload }),
    executeCommand,
    inferAction: async (prompt) => {
      inferenceCalls += 1;
      if (prompt.repair?.schema === "hemlock.agent.artifact.repair.v1") { repairCalls += 1; return repairResponses.shift(); }
      return actions.shift();
    },
  });
  try {
    const plan = orchestrator.proposePlan(task, { steps: [
      { commandId: "artifact.create", label: "Create scratch artifact", expectedEvidence: ["artifact://manifest"] },
      { commandId: "artifact.author", label: "Author artifact", expectedEvidence: ["artifact://revision"] },
      { commandId: "artifact.preview.open", label: "Open preview", expectedEvidence: ["preview://session"] },
      { commandId: "artifact.preview.inspect", label: "Verify preview", expectedEvidence: ["preview://inspection"] },
    ] }).plan;
    const result = await orchestrator.approvePlan(task.id, plan.id);
    assert.equal(result.status, "completed");
    assert.equal(currentTask.status, "completed");
    assert.equal(currentTask.artifactRepair.status, "passed");
    assert.equal(currentTask.artifactRepair.attempt, 2);
    assert.equal(repairCalls, 2);
    assert.equal(inspectCalls, 2);
    assert.equal(kernel.getProjection().actions.at(-1).kind, "complete");
    assert.equal(events.some((event) => event.type === "artifact.repair.exhausted"), false);
    const artifact = registry.read(task.id, artifactId);
    assert.equal(artifact.revision, 2);
    assert.equal(artifact.source["index.html"].includes("Recovered artifact"), true);
    const metrics = { completed: true, inferenceCalls, terminalInferenceCalls: 0, repairCalls, repairAttempts: currentTask.artifactRepair.attempt, previewInspectionCalls: inspectCalls, artifactRevisionCount: artifact.revision, repositoryTouched: false, falseSuccess: false };
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
