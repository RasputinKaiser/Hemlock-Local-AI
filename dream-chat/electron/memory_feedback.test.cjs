// T6-M1b: recall usefulness feedback — pure-logic tests.
//
// No IPC here: these drive the sips_runtime.py CLI directly against a throwaway
// sipsDir to verify (a) the additive feedback.jsonl ledger append, (b) the pure
// per-record vote aggregation that feeds the host decision, and (c) that the
// host's demote decision (memory_fitness.shouldAutoDemote) composes with the
// EXISTING memory-transition demote path (relation.type === "demote").
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PYTHON = process.env.HEMLOCK_TEST_PYTHON || "python3";
const RUNTIME = path.join(__dirname, "sips_runtime.py");
const { shouldAutoDemote } = require("./memory_fitness.cjs");

function runSips(payload) {
  const stdout = execFileSync(PYTHON, [RUNTIME, JSON.stringify(payload)], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(stdout.trim());
}

function tempSipsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-memory-feedback-"));
}

function seedActiveRecord(root, sipsDir, title) {
  const result = runSips({ root, sipsDir, action: "record", title, body: `${title} lesson body`, status: "active", tags: "sips,test" });
  assert.equal(result.status, "recorded");
  return result.record;
}

test("memory feedback appends votes to a sidecar ledger without touching memory.jsonl", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const record = seedActiveRecord(root, sipsDir, "Ledger isolation");
  const memoryPath = path.join(sipsDir, "memory.jsonl");
  const memoryBefore = fs.readFileSync(memoryPath, "utf8");

  const first = runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "useful", query: "ledger isolation" });
  assert.equal(first.status, "recorded");
  assert.equal(first.recordId, record.id);
  assert.deepEqual(first.counts, { useful: 1, irrelevant: 0 });
  assert.equal(first.recordStatus, "active");
  assert.equal(first.feedback.schema, "hemlock.sips.feedback.v1");
  assert.ok(fs.existsSync(path.join(sipsDir, "feedback.jsonl")));
  assert.equal(fs.readFileSync(memoryPath, "utf8"), memoryBefore, "memory.jsonl must stay byte-identical");
});

test("aggregate counts accumulate per record and ignore unknown kinds", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const kept = seedActiveRecord(root, sipsDir, "Kept lesson");
  const noisy = seedActiveRecord(root, sipsDir, "Noisy lesson");

  runSips({ root, sipsDir, action: "memory-feedback", recordId: kept.id, kind: "useful" });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: noisy.id, kind: "irrelevant" });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: noisy.id, kind: "irrelevant" });
  // A malformed ledger line (unknown kind) must be ignored by aggregation,
  // never counted as a vote.
  const feedbackPath = path.join(sipsDir, "feedback.jsonl");
  fs.appendFileSync(feedbackPath, `${JSON.stringify({ schema: "hemlock.sips.feedback.v1", recordId: noisy.id, kind: "bogus", at: "2026-01-01T00:00:00Z" })}\n`);

  assert.deepEqual(runSips({ root, sipsDir, action: "memory-feedback", recordId: kept.id, kind: "useful" }).counts, { useful: 2, irrelevant: 0 });
  const noisyCounts = runSips({ root, sipsDir, action: "memory-feedback", recordId: noisy.id, kind: "irrelevant" }).counts;
  assert.deepEqual(noisyCounts, { useful: 0, irrelevant: 3 }, "unknown kinds must not be counted as votes");
});

test("auto-demote criteria compose shouldAutoDemote with the existing demote transition", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const record = seedActiveRecord(root, sipsDir, "Auto-demote target");

  // Simulate the host wiring exactly: counts from the runtime, decision via
  // memory_fitness.shouldAutoDemote, demotion via the existing transition.
  let counts = runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "irrelevant" }).counts;
  assert.equal(shouldAutoDemote(counts), false, "one irrelevant vote must not demote");
  counts = runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "useful" }).counts;
  counts = runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "irrelevant" }).counts;
  counts = runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "irrelevant" }).counts;
  // 3 irrelevant vs 1 useful: crosses the threshold only now.
  assert.equal(shouldAutoDemote(counts), true);

  const demote = runSips({ root, sipsDir, action: "memory-transition", transition: "demote", targetId: record.id, note: "Auto-demoted after 3 not-relevant recall votes vs 1 useful votes.", provenance: "Hemlock recall usefulness auto-demote" });
  assert.equal(demote.transition, "demote");
  assert.equal(demote.record.relation.type, "demote");
  assert.equal(demote.record.relation.targetId, record.id);
  assert.equal(demote.record.status, "demoted");
});

test("useful votes hold the line: 2 irrelevant vs 2 useful stays active", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const record = seedActiveRecord(root, sipsDir, "Contested lesson");
  let counts = { useful: 0, irrelevant: 0 };
  for (const kind of ["irrelevant", "irrelevant", "useful", "useful"]) {
    counts = runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind }).counts;
  }
  assert.equal(shouldAutoDemote(counts), false, "irrelevant must strictly exceed useful AND reach 3 to auto-demote");
});

test("feedback rejects unknown kinds and missing record ids", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const record = seedActiveRecord(root, sipsDir, "Validation target");
  assert.throws(() => runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "meh" }));
  assert.throws(() => runSips({ root, sipsDir, action: "memory-feedback", recordId: "", kind: "useful" }));
});
