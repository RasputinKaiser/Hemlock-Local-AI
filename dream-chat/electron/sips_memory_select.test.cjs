// Feedback-aware recall and memory-select for the SIPS runtime — the Python
// side of memory_fitness parity. Drives sips_runtime.py directly against a
// throwaway sipsDir, same pattern as memory_feedback.test.cjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PYTHON = process.env.HEMLOCK_TEST_PYTHON || "python3";
const RUNTIME = path.join(__dirname, "sips_runtime.py");

function runSips(payload) {
  const stdout = execFileSync(PYTHON, [RUNTIME, JSON.stringify(payload)], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(stdout.trim());
}

function tempSipsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-memory-select-"));
}

function seed(root, sipsDir, title, body, status = "candidate") {
  const result = runSips({ root, sipsDir, action: "record", title, body, status, tags: "sips,test" });
  assert.equal(result.status, "recorded");
  return result.record;
}

test("recall annotates records with fitness and feedback counts", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const trusted = seed(root, sipsDir, "Trusted lesson", "trusted lesson body");
  seed(root, sipsDir, "Unvoted lesson", "unvoted lesson body");
  runSips({ root, sipsDir, action: "memory-feedback", recordId: trusted.id, kind: "useful" });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: trusted.id, kind: "useful" });

  const result = runSips({ root, sipsDir, action: "recall", query: "lesson" });
  assert.equal(result.records.length, 2);
  // Equal term score -> fitness breaks the tie: the +16 record leads.
  assert.equal(result.records[0].id, trusted.id);
  assert.equal(result.records[0].fitness, 66);
  assert.deepEqual(result.records[0].feedback, { useful: 2, irrelevant: 0 });
  assert.equal(result.records[1].fitness, 50);
  assert.equal(result.records[0].effectiveStatus, "candidate");
});

test("recall excludes demoted records and transition audit notes by default", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const kept = seed(root, sipsDir, "Kept lesson", "kept lesson body");
  const demoted = seed(root, sipsDir, "Demoted lesson", "demoted lesson body");
  runSips({ root, sipsDir, action: "memory-transition", transition: "demote", targetId: demoted.id, note: "noise" });

  const result = runSips({ root, sipsDir, action: "recall", query: "lesson" });
  const ids = result.records.map((record) => record.id);
  assert.deepEqual(ids, [kept.id], "demoted record and its demote audit note must leave the recall pool");
  // Opt-in escape hatch restores the audit view.
  const audit = runSips({ root, sipsDir, action: "recall", query: "lesson", includeDemoted: true, includeAudit: true });
  assert.equal(audit.records.length, 3);
  const gone = audit.records.find((record) => record.id === demoted.id);
  assert.equal(gone.effectiveStatus, "demoted");
});

test("memory-select ranks by fitness, drops net-noise, and ships a trainable example", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const noisy = seed(root, sipsDir, "Noisy", "noisy lesson body");
  const good = seed(root, sipsDir, "Good", "good lesson body", "active");
  const plain = seed(root, sipsDir, "Plain", "plain lesson body");
  for (let i = 0; i < 3; i += 1) runSips({ root, sipsDir, action: "memory-feedback", recordId: noisy.id, kind: "irrelevant" });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: good.id, kind: "useful" });

  const result = runSips({ root, sipsDir, action: "memory-select", limit: 8 });
  assert.equal(result.schema, "hemlock.sips.memory-select.v1");
  const ids = result.records.map((record) => record.id);
  assert.deepEqual(ids, [good.id, plain.id], "auto-demote-worthy noise is excluded even without a demote transition");
  assert.equal(result.records[0].fitness, 58);
  const example = result.records[0].suggestedExample;
  assert.equal(example.metadata.source, "memory");
  assert.equal(example.metadata.recordId, good.id);
  assert.equal(example.messages.at(-1).role, "assistant");
  assert.match(example.messages.at(-1).content, /good lesson body/);
  assert.ok(fs.existsSync(result.memoryPath));
});

test("memory-select honors minFitness and status filters", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const active = seed(root, sipsDir, "Active", "active lesson body", "active");
  seed(root, sipsDir, "Candidate", "candidate lesson body");
  runSips({ root, sipsDir, action: "memory-feedback", recordId: active.id, kind: "useful" });

  const strict = runSips({ root, sipsDir, action: "memory-select", minFitness: 55 });
  assert.deepEqual(strict.records.map((record) => record.id), [active.id]);
  const onlyActive = runSips({ root, sipsDir, action: "memory-select", status: "active" });
  assert.deepEqual(onlyActive.records.map((record) => record.id), [active.id]);
});
