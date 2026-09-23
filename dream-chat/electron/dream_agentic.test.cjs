// Agent-spine SFT source + dataset preview tests. These drive dream_train.py's
// dataset path only (no model weights): fixture kernel journals on disk,
// build_agentic_rows/write_dataset/datasetOnly via python3 -c and the CLI.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PYTHON = process.env.HEMLOCK_TEST_PYTHON || "python3";
const ELECTRON = __dirname;
const SYSTEM_PROMPT = [
  "You are Maple-Preview operating inside Hemlock.",
  "Return exactly one compact JSON choice in the content channel — no prose, no markdown, nothing else:",
  '{"kind":"tool","commandId":"<one allowedNextCommands entry>","input":{},"shortRationale":"one-line reason"}',
  "kind may instead be answer, ask_user, or blocked: terminal choices with no commandId.",
  "The host assigns id, taskId, step, approval, expectedEvidence, and status. Never emit them.",
].join("\n");
const REGISTRY = {
  "context.query": { label: "Query thread context", capability: "context", auto: true, approval: "none", inputHint: "{query:string}" },
  "receipts.query": { label: "Query receipts", capability: "read", auto: true, approval: "none", inputHint: "{limit?:number}" },
  "artifact.create": { label: "Create artifact", capability: "artifact", auto: false, approval: "plan", inputHint: "{artifactId?, title?, kind?}" },
  "dream": { label: "Train Dream", capability: "train", auto: false, approval: "explicit" },
};

function py(snippet) {
  const script = `import sys, json; sys.path.insert(0, ${JSON.stringify(ELECTRON)}); import dream_train; ${snippet}`;
  const stdout = execFileSync(PYTHON, ["-c", script], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}

function tempDir(prefix = "hemlock-agentic-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Kernel projection journal lines (hemlock.agent.projection.event.v1). An
// action's terminal event carries the full record — matching transitionAction,
// which persists the mutated action object on action.completed/failed/etc.
function journalEvent(type, createdAt, payload) {
  return { schema: "hemlock.agent.projection.event.v1", id: `evt-${createdAt}`, type, createdAt, payload };
}

function actionRecord(id, taskId, step, commandId, input, status, observationId, extra = {}) {
  return {
    id,
    taskId,
    step,
    kind: commandId ? "tool" : "answer",
    commandId,
    input,
    shortRationale: `step ${step} rationale`,
    status,
    observationId,
    proposedAt: `2026-01-01T00:00:0${step}Z`,
    ...extra,
  };
}

// Writes a projection.jsonl describing one task whose plan has one step per
// action. `specs`: [{commandId, input, actionStatus, observationStatus}].
function writeSpine(dir, taskId, specs) {
  const lines = [
    journalEvent("task.projection.updated", "2026-01-01T00:00:00Z", { task: { id: taskId, objective: "Audit the receipts", intent: "improve", autonomy: "supervised", interactionMode: "task" } }),
    journalEvent("plan.proposed", "2026-01-01T00:00:00Z", {
      plan: { id: `plan-${taskId}`, taskId, steps: specs.map((spec, i) => ({ commandId: spec.commandId || "answer", label: `step ${i + 1}` })) },
    }),
  ];
  specs.forEach((spec, i) => {
    const step = i + 1;
    const actionId = `a${step}`;
    const observationId = `o${step}`;
    const terminalType = spec.actionStatus === "completed" ? "action.completed" : spec.actionStatus === "blocked" ? "action.blockd" : `action.${spec.actionStatus}d`;
    lines.push(journalEvent("action.proposed", `2026-01-01T00:01:0${step}Z`, {
      action: actionRecord(actionId, taskId, step, spec.commandId, spec.input, "proposed", null),
    }));
    lines.push(journalEvent(terminalType, `2026-01-01T00:02:0${step}Z`, {
      action: actionRecord(actionId, taskId, step, spec.commandId, spec.input, spec.actionStatus, spec.actionStatus === "completed" ? observationId : null),
    }));
    lines.push(journalEvent("observation.recorded", `2026-01-01T00:03:0${step}Z`, {
      observation: { id: observationId, operationId: `op${step}`, taskId, status: spec.observationStatus, summary: `obs ${step}`, evidenceRefs: [] },
    }));
  });
  const file = path.join(dir, "projection.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

function agenticPayload(journalPaths, maxSteps = 96) {
  return { schema: "hemlock.dream.agentic-spine.v1", journalPaths, registry: REGISTRY, systemPrompt: SYSTEM_PROMPT, maxSteps };
}

// Embed a JS value into a python3 -c snippet as a parsed JSON literal.
function pyJson(value) {
  return `json.loads(${JSON.stringify(JSON.stringify(value))})`;
}

test("agentic source mines only executed actions with passed observations", () => {
  const dir = tempDir();
  const spine = writeSpine(dir, "task-1", [
    { commandId: "context.query", input: { query: "dream" }, actionStatus: "completed", observationStatus: "passed" },
    { commandId: "receipts.query", input: { limit: 5 }, actionStatus: "failed", observationStatus: "failed" },
    { commandId: "receipts.query", input: { limit: 10 }, actionStatus: "completed", observationStatus: "blocked" },
    { commandId: "artifact.create", input: { title: "Report" }, actionStatus: "completed", observationStatus: "passed" },
  ]);
  const runDir = tempDir();
  const result = py(`
import json, pathlib
data_dir, train, valid, manifest = dream_train.write_dataset(
    ${JSON.stringify(runDir)}, [], [], [],
    agentic=${pyJson(agenticPayload([spine]))}, tokenizer=None)
rows = []
for name in ("train", "valid"):
    rows += [json.loads(l) for l in pathlib.Path(data_dir, f"{name}.jsonl").read_text().splitlines() if l.strip()]
print(json.dumps({"manifest": manifest, "rows": rows}))
`);
  const spineRows = result.rows.filter((row) => row.metadata.source === "agent-spine");
  assert.equal(result.manifest.sources["agent-spine"], 2);
  assert.equal(result.manifest.agenticSpine.skipped["not-completed"], 1, "failed action excluded");
  assert.equal(result.manifest.agenticSpine.skipped["observation-not-passed"], 1, "blocked observation excluded");
  assert.equal(spineRows.length, 2);
  for (const row of spineRows) {
    assert.equal(row.messages.length, 3);
    assert.equal(row.messages[0].role, "system");
    assert.ok(row.messages[0].content.startsWith("You are Maple-Preview operating inside Hemlock."));
    const request = JSON.parse(row.messages[1].content);
    assert.equal(request.task.id, "task-1");
    assert.ok(Array.isArray(request.allowedNextCommands) && request.allowedNextCommands.length > 0);
    assert.ok("progress" in request && "completed" in request && "nextStep" in request);
    const envelope = JSON.parse(row.messages[2].content);
    assert.equal(envelope.kind, "tool");
    assert.ok(envelope.commandId && envelope.shortRationale);
    assert.ok(!("status" in envelope) && !("taskId" in envelope), "host-assigned fields stay out of the envelope");
    assert.equal(row.metadata.executedEnvelope, true);
    assert.equal(row.metadata.observationStatus, "passed");
  }
});

test("agentic rows dedup on the executed envelope (kind, commandId, input)", () => {
  const dir = tempDir();
  const spine = writeSpine(dir, "task-1", [
    { commandId: "context.query", input: { query: "dream" }, actionStatus: "completed", observationStatus: "passed" },
    { commandId: "context.query", input: { query: "dream" }, actionStatus: "completed", observationStatus: "passed" },
    { commandId: "context.query", input: { query: "grafts" }, actionStatus: "completed", observationStatus: "passed" },
  ]);
  const runDir = tempDir();
  const manifest = py(`
import json
_, _, _, manifest = dream_train.write_dataset(
    ${JSON.stringify(runDir)}, [], [], [],
    agentic=${pyJson(agenticPayload([spine]))}, tokenizer=None)
print(json.dumps(manifest))
`);
  assert.equal(manifest.sources["agent-spine"], 2, "identical executed envelopes collapse");
  assert.equal(manifest.nearDuplicatesRemoved, 1);
});

test("agentic source respects the share cap against other sources", () => {
  const dir = tempDir();
  const spine = writeSpine(dir, "task-1", Array.from({ length: 8 }, (_, i) => ({
    commandId: "context.query", input: { query: `topic-${i}` }, actionStatus: "completed", observationStatus: "passed",
  })));
  const runDir = tempDir();
  const manifest = py(`
import json
chat = [{"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"answer number {i} with substance"}], "metadata": {"source": "chat"}} for i in range(2)]
_, _, _, manifest = dream_train.write_dataset(
    ${JSON.stringify(runDir)}, [], [], chat,
    agentic=${pyJson(agenticPayload([spine]))}, tokenizer=None)
print(json.dumps(manifest))
`);
  // 10 rows total, 60% cap → at most 6 agent-spine rows.
  assert.ok(manifest.sources["agent-spine"] <= 6, `agent-spine capped: ${JSON.stringify(manifest.sources)}`);
  assert.equal(manifest.sources.chat, 2);
  assert.ok(manifest.balanceDropped >= 2);
  assert.equal(manifest.agenticSpine.filesRead, 1);
  assert.equal(manifest.agenticSpine.eligible, 8);
});

test("datasetOnly preview composes the dataset and returns manifest + samples without training", () => {
  const dir = tempDir();
  const spine = writeSpine(dir, "task-1", [
    { commandId: "context.query", input: { query: "dream" }, actionStatus: "completed", observationStatus: "passed" },
  ]);
  const runDir = tempDir();
  const payload = {
    runDir,
    datasetOnly: true,
    previewSamples: 4,
    facts: ["Ian prefers tea"],
    examples: [],
    conversation: [],
    agentic: agenticPayload([spine]),
  };
  const stdout = execFileSync(PYTHON, [path.join(ELECTRON, "dream_train.py"), JSON.stringify(payload)], { encoding: "utf8", timeout: 30000 });
  const events = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const done = events.at(-1);
  assert.equal(done.stage, "dataset.preview");
  assert.equal(done.progress, 100);
  const preview = done.preview;
  assert.equal(preview.schema, "hemlock.dream.dataset-preview.v1");
  assert.equal(preview.manifest.sources["agent-spine"], 1);
  assert.equal(preview.manifest.sources["personal-fact"], 3);
  assert.ok(preview.manifest.datasetDigest && preview.manifest.datasetDigest.length === 64);
  assert.ok(preview.manifest.tokenRange.max > 0);
  assert.ok(Array.isArray(preview.samples) && preview.samples.length >= 4);
  assert.ok(preview.samples.every((sample) => sample.source && sample.rowHash));
  assert.ok(fs.existsSync(preview.trainPath) && fs.existsSync(preview.validPath));
  assert.match(preview.claimBoundary, /no model weights were trained/i);
});
