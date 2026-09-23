// Memory consolidation + staleness/provenance listing — drives sips_runtime.py
// directly against a throwaway sipsDir, same pattern as memory_feedback.test.cjs.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-memory-consolidate-"));
}

function seed(root, sipsDir, title, body, status = "candidate", extra = {}) {
  const result = runSips({ root, sipsDir, action: "record", title, body, status, tags: "sips,test", ...extra });
  assert.equal(result.status, "recorded");
  return result.record;
}

// Two records that share the repeated "SIPS cycle failed · …" stem with only
// a small tail difference — the exact near-duplicate shape consolidation
// exists for — plus one unrelated record that must never cluster with them.
function seedDuplicatePair(root, sipsDir) {
  const first = seed(root, sipsDir, "SIPS cycle failed · verify profile", "SIPS cycle failed: the verify profile timed out after waiting for the build step to finish.");
  const second = seed(root, sipsDir, "SIPS cycle failed · verify profile", "SIPS cycle failed: the verify profile timed out after waiting for the build step.");
  const other = seed(root, sipsDir, "Grove watering schedule", "Water the grove plants every Sunday morning before the heat.");
  return { first, second, other };
}

test("memory-consolidate merges a near-duplicate cluster into the fittest record", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const { first, second, other } = seedDuplicatePair(root, sipsDir);
  // Earned fitness decides the keeper: one useful vote makes `second` the
  // highest-fitness member even though `first` is older.
  runSips({ root, sipsDir, action: "memory-feedback", recordId: second.id, kind: "useful" });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: first.id, kind: "useful" });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: first.id, kind: "useful" });

  const result = runSips({ root, sipsDir, action: "memory-consolidate" });
  assert.equal(result.schema, "hemlock.sips.memory-consolidate.v1");
  assert.equal(result.status, "consolidated");
  assert.equal(result.merged, 1);
  assert.deepEqual(result.keptIds, [first.id], "2 useful votes beat 1 — the fittest record is kept");
  const cluster = result.clusters[0];
  assert.deepEqual(cluster.absorbedIds, [second.id]);
  assert.equal(cluster.links[0].id, second.id);
  assert.ok(cluster.links[0].similarity >= 0.7);
  assert.ok(cluster.auditId, "merge overlay note id is reported for rollback");
  assert.equal(cluster.demoteIds.length, 1);

  // The absorbed record is demoted with the consolidation reason, not deleted.
  const listed = runSips({ root, sipsDir, action: "memory-list" });
  const absorbed = listed.records.find((record) => record.id === second.id);
  assert.equal(absorbed.effectiveStatus, "demoted");
  assert.equal(absorbed.consolidatedInto, first.id);
  assert.equal(absorbed.lastTransition.type, "demote");

  // The keeper carries mergedFrom provenance and the absorbed record's votes.
  const kept = listed.records.find((record) => record.id === first.id);
  assert.deepEqual(kept.mergedFrom, [second.id]);
  assert.deepEqual(kept.feedback, { useful: 3, irrelevant: 0 }, "feedback counts are summed onto the keeper");
  assert.equal(kept.fitness, 74); // 50 + 24, capped contribution of 3 useful
  assert.ok(fs.existsSync(result.memoryPath));

  // The unrelated record was never touched.
  const untouched = listed.records.find((record) => record.id === other.id);
  assert.equal(untouched.effectiveStatus, "candidate");
  assert.equal(untouched.mergedFrom, undefined);

  // Recall no longer surfaces the absorbed duplicate.
  const recalled = runSips({ root, sipsDir, action: "recall", query: "verify profile" });
  assert.deepEqual(recalled.records.map((record) => record.id), [first.id]);
});

test("memory-consolidate appends only complementary body sentences", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const first = seed(root, sipsDir, "Build note", "The build needs Xcode tools installed first and a license check.");
  const second = seed(root, sipsDir, "Build note", "The build needs Xcode tools installed first and a license check. Run the verify profile afterwards.");
  // A useful vote makes the shorter record the keeper, so the merge must
  // append the absorbed record's novel tail to see any new text at all.
  runSips({ root, sipsDir, action: "memory-feedback", recordId: first.id, kind: "useful" });
  const result = runSips({ root, sipsDir, action: "memory-consolidate" });
  assert.equal(result.merged, 1);
  const cluster = result.clusters[0];
  assert.equal(cluster.keptId, first.id);
  assert.deepEqual(cluster.absorbedIds, [second.id]);
  // The duplicate sentence is not doubled; only the novel tail is appended.
  const merged = cluster.mergedBody;
  assert.ok(merged.includes("Xcode tools installed first"), "kept body survives");
  assert.ok(merged.includes("Run the verify profile afterwards"), "novel complementary detail merges");
  assert.equal(merged.match(/Xcode tools/g).length, 1);
});

test("memory-consolidate dryRun previews clusters without writing", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  seedDuplicatePair(root, sipsDir);
  const memoryPath = path.join(sipsDir, "memory.jsonl");
  const before = fs.readFileSync(memoryPath, "utf8");

  const preview = runSips({ root, sipsDir, action: "memory-consolidate", dryRun: true });
  assert.equal(preview.status, "preview");
  assert.equal(preview.merged, 1);
  assert.equal(preview.clusters[0].absorbedIds.length, 1);
  assert.equal(fs.readFileSync(memoryPath, "utf8"), before, "dryRun must not append to the ledger");
});

test("memory-consolidate is rollback-safe: absorbed records are demoted, overlay is revocable", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const { first, second } = seedDuplicatePair(root, sipsDir);
  const result = runSips({ root, sipsDir, action: "memory-consolidate" });
  const cluster = result.clusters[0];

  // Undo step 1: roll back the consolidate overlay note — mergedFrom drops.
  runSips({ root, sipsDir, action: "memory-transition", transition: "rollback", targetId: cluster.auditId, note: "undo merge" });
  // Undo step 2: promote the absorbed record back into the pool.
  runSips({ root, sipsDir, action: "memory-transition", transition: "promote", targetId: second.id, note: "restore" });

  const listed = runSips({ root, sipsDir, action: "memory-list" });
  const restored = listed.records.find((record) => record.id === second.id);
  assert.equal(restored.effectiveStatus, "active", "promote restores a consolidation-demoted record");
  const kept = listed.records.find((record) => record.id === first.id);
  assert.equal(kept.mergedFrom, undefined, "rolled-back overlay no longer applies");
});

test("memory-consolidate does not re-merge already-absorbed records", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  seedDuplicatePair(root, sipsDir);
  runSips({ root, sipsDir, action: "memory-consolidate" });
  const again = runSips({ root, sipsDir, action: "memory-consolidate", dryRun: true });
  assert.equal(again.merged, 0, "demoted records leave the pool; nothing left to merge");
});

test("memory-list returns staleness and provenance fields per record", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const receiptPath = path.join(sipsDir, "cycle-1", "receipt.json");
  const record = seed(root, sipsDir, "Provenance check", "provenance lesson body", "candidate", { evidencePath: receiptPath, provenance: "test receipt" });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "useful" });

  const result = runSips({ root, sipsDir, action: "memory-list" });
  assert.equal(result.schema, "hemlock.sips.memory-list.v1");
  const listed = result.records.find((item) => item.id === record.id);
  assert.equal(listed.ageDays, 0);
  assert.ok(listed.lastUsedAt, "feedback vote stamps lastUsedAt");
  assert.deepEqual(listed.sourceRefs, [receiptPath]);
  assert.equal(listed.effectiveStatus, "candidate");
  assert.deepEqual(listed.feedback, { useful: 1, irrelevant: 0 });
  assert.equal(listed.fitness, 58);
  assert.ok(listed.recencyBonus > 0, "fresh record earns the recency bonus");
  assert.ok(listed.rankScore > listed.fitness);
});

test("memory-list flags near-duplicates without merging them", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const { first, second, other } = seedDuplicatePair(root, sipsDir);
  const listed = runSips({ root, sipsDir, action: "memory-list" });
  const keeper = listed.records.find((record) => record.nearDuplicateOf === null && record.clusterSize === 2);
  assert.ok(keeper, "one record is the cluster keeper");
  const dupe = listed.records.find((record) => record.nearDuplicateOf === keeper.id);
  assert.ok(dupe, "the near-duplicate points at its keeper");
  assert.ok([first.id, second.id].includes(dupe.id));
  const solo = listed.records.find((record) => record.id === other.id);
  assert.equal(solo.nearDuplicateOf, undefined);
  assert.equal(solo.clusterSize, undefined);
  // Nothing was demoted: listing is read-only.
  assert.equal(listed.records.filter((record) => record.effectiveStatus === "demoted").length, 0);
});

test("recall annotates records with ageDays, lastUsedAt, and sourceRefs", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const receiptPath = path.join(sipsDir, "run-9", "receipt.json");
  const record = seed(root, sipsDir, "Recall annotation", "recall annotation body", "candidate", { evidencePath: receiptPath });
  runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "useful" });
  const recalled = runSips({ root, sipsDir, action: "recall", query: "annotation" });
  const hit = recalled.records.find((item) => item.id === record.id);
  assert.equal(hit.ageDays, 0);
  assert.ok(hit.lastUsedAt);
  assert.deepEqual(hit.sourceRefs, [receiptPath]);
});

test("a transition-promoted record reports effective status 'active' to feedback", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  // Candidates promoted via memory.promote keep status "candidate" in their
  // own fields — the feedback path must answer with the REPLAYED status or
  // the host's auto-demote gate (recordStatus === "active") never fires.
  const record = seed(root, sipsDir, "Promoted lesson", "promoted lesson body", "candidate");
  runSips({ root, sipsDir, action: "memory-transition", transition: "promote", targetId: record.id });
  const feedback = runSips({ root, sipsDir, action: "memory-feedback", recordId: record.id, kind: "irrelevant" });
  assert.equal(feedback.recordStatus, "active", "effective status, not the raw ledger field");
});

test("memory-consolidate ignores demoted records and audit notes", () => {
  const root = tempSipsDir();
  const sipsDir = path.join(root, "sips");
  const { first } = seedDuplicatePair(root, sipsDir);
  // A demoted record that still looks like the cluster must not be merged again.
  const demoted = seed(root, sipsDir, "SIPS cycle failed · verify profile", "SIPS cycle failed: the verify profile timed out after waiting for the build step.");
  runSips({ root, sipsDir, action: "memory-transition", transition: "demote", targetId: demoted.id, note: "noise" });
  const result = runSips({ root, sipsDir, action: "memory-consolidate" });
  assert.equal(result.merged, 1);
  assert.ok(!result.clusters[0].absorbedIds.includes(demoted.id));
  assert.ok(!result.clusters[0].absorbedIds.includes(result.clusters[0].auditId));
  void first;
});
