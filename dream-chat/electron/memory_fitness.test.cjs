const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Pure scoring/ranking policy — no mocks needed for the logic under test.
const {
  scoreRecord,
  rankForRecall,
  shouldAutoDemote,
  applyFeedback,
  selectForTraining,
} = require(path.resolve(__dirname, "memory_fitness.cjs"));

// ---------------------------------------------------------------------------
// scoreRecord
// ---------------------------------------------------------------------------

test("scoreRecord returns safe default for empty/garbage inputs", () => {
  // A record with no signal at all sits at the neutral base score.
  assert.equal(scoreRecord({}), 50);
  assert.equal(scoreRecord(), 50);
  assert.equal(scoreRecord(null), 50);
  assert.equal(scoreRecord(undefined), 50);
  // Garbage field values are ignored, not NaN-poisoned.
  assert.equal(scoreRecord({ uses: "many", useful: null, irrelevant: {}, promotedAt: "not-a-date" }), 50);
  assert.ok(Number.isInteger(scoreRecord({ uses: NaN, useful: Infinity })));
});

test("scoreRecord adds useful votes up to the contribution cap", () => {
  assert.equal(scoreRecord({ useful: 1 }), 58); // +8
  assert.equal(scoreRecord({ useful: 3 }), 74); // +24
  assert.equal(scoreRecord({ useful: 4 }), 80); // 32 -> capped at +30
  assert.equal(scoreRecord({ useful: 25 }), 80); // far past the cap stays flat
});

test("scoreRecord subtracts irrelevant votes down to the contribution floor", () => {
  assert.equal(scoreRecord({ irrelevant: 1 }), 38); // -12
  assert.equal(scoreRecord({ irrelevant: 3 }), 14); // -36
  assert.equal(scoreRecord({ irrelevant: 4 }), 10); // -48 -> floored at -40
  assert.equal(scoreRecord({ irrelevant: 20 }), 10);
});

test("scoreRecord combines both vote kinds then clamps to 0..100", () => {
  // Cap + floor cancel to the base.
  assert.equal(scoreRecord({ useful: 10, irrelevant: 10 }), 40);
  // All-irrelevant never dips below 0 even after clamping arithmetic.
  const sunk = scoreRecord({ irrelevant: 99 });
  assert.equal(sunk, 10);
  assert.ok(sunk >= 0 && sunk <= 100);
  // Many-useful never exceeds the cap-driven ceiling.
  assert.ok(scoreRecord({ useful: 999 }) <= 100);
});

test("scoreRecord grants full recency bonus for fresh promotions", () => {
  const now = new Date("2026-08-22T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  // Well inside the 7-day full-bonus window.
  assert.equal(scoreRecord({ promotedAt: new Date(now - 1 * day).toISOString() }, { now }), 60);
  // Exactly at 7 days: full bonus holds (decay runs 7 -> 90 days).
  assert.equal(scoreRecord({ promotedAt: new Date(now - 7 * day).toISOString() }, { now }), 60);
  // No promotion timestamp, or an unparseable one: no bonus.
  assert.equal(scoreRecord({ promotedAt: null }, { now }), 50);
});

test("scoreRecord linearly decays the recency bonus to zero at 90 days", () => {
  const now = new Date("2026-08-22T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const opts = { now };
  // Halfway down the 7->90 day decay slope (~48.5 days old) -> ~+5.
  const halfLife = scoreRecord({ promotedAt: new Date(now - 48.5 * day).toISOString() }, opts);
  assert.equal(halfLife, 55); // 50 + 5 (rounded)
  // Exactly 90 days old: decayed fully away.
  assert.equal(scoreRecord({ promotedAt: new Date(now - 90 * day).toISOString() }, opts), 50);
  // Past 90 days: no negative spillover.
  assert.equal(scoreRecord({ promotedAt: new Date(now - 200 * day).toISOString() }, opts), 50);
  // Future-dated promotions are treated as maximally fresh, not time travel.
  assert.equal(scoreRecord({ promotedAt: new Date(now + 5 * day).toISOString() }, opts), 60);
});

test("scoreRecord recency follows the freshest of promotedAt, lastUsedAt, createdAt", () => {
  const now = new Date("2026-08-22T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const opts = { now };
  // An old promotion stops earning the bonus on its own…
  const stale = { promotedAt: new Date(now - 120 * day).toISOString() };
  assert.equal(scoreRecord(stale, opts), 50);
  // …but a recent recall-use vote refreshes the same stale record.
  assert.equal(scoreRecord({ ...stale, lastUsedAt: new Date(now - 2 * day).toISOString() }, opts), 60);
  // A freshly captured record (createdAt only) is fresh too — a 3-month-old
  // lesson cannot outrank it on silence alone.
  assert.equal(scoreRecord({ createdAt: new Date(now - 1 * day).toISOString() }, opts), 60);
  // The oldest timestamp never drags the freshest down.
  assert.equal(scoreRecord({ createdAt: new Date(now - 200 * day).toISOString(), lastUsedAt: new Date(now - 1 * day).toISOString() }, opts), 60);
  // The bonus stays gentle: freshness alone (+10) never beats two useful
  // votes (+16) on an equally stale record.
  const oldConfirmed = { useful: 2, createdAt: new Date(now - 200 * day).toISOString() };
  const freshUnvoted = { createdAt: new Date(now - 1 * day).toISOString() };
  assert.ok(scoreRecord(oldConfirmed, opts) > scoreRecord(freshUnvoted, opts));
});

test("scoreRecord rounds to an integer", () => {
  const now = new Date("2026-08-22T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const s = scoreRecord({ promotedAt: new Date(now - 50 * day).toISOString() }, { now });
  assert.ok(Number.isInteger(s), `expected integer, got ${s}`);
});

// ---------------------------------------------------------------------------
// rankForRecall
// ---------------------------------------------------------------------------

function makeRecords() {
  return [
    { id: "a", useful: 0, irrelevant: 0, promotedAt: "2026-01-01T00:00:00Z" },
    { id: "b", useful: 2, irrelevant: 0, promotedAt: "2026-01-01T00:00:00Z" },
    { id: "c", useful: 0, irrelevant: 3, promotedAt: "2026-06-01T00:00:00Z" },
    { id: "d", useful: 2, irrelevant: 0, promotedAt: "2026-05-01T00:00:00Z" },
    { id: "e", useful: 1, irrelevant: 0, promotedAt: null },
  ];
}

test("rankForRecall sorts by score descending", () => {
  const records = makeRecords();
  const ranked = rankForRecall(records);
  // b,d tie at 66; d's promotion (May) is newer than b's (Jan) so d leads.
  // Then e (+8 -> 58), a (50), c (-36 -> 14).
  assert.deepEqual(ranked.map((r) => r.id), ["d", "b", "e", "a", "c"]);
});

test("rankForRecall tie-breaks by promotedAt desc then id asc", () => {
  const now = new Date("2026-08-22T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const tied = [
    { id: "x", useful: 0, promotedAt: "2026-03-01T00:00:00Z" },
    { id: "m", useful: 0, promotedAt: "2026-07-01T00:00:00Z" },
    { id: "z", useful: 0, promotedAt: "2026-07-01T00:00:00Z" },
    { id: "q", useful: 0, promotedAt: null },
  ];
  const ranked = rankForRecall(tied, { now });
  // Same score everywhere: newer promotion first among m/z, then x (real,
  // older date), then undated q dead last.
  assert.deepEqual(ranked.map((r) => r.id), ["m", "z", "x", "q"]);
  void day;
});

test("rankForRecall does not mutate its input", () => {
  const records = makeRecords();
  const snapshot = JSON.parse(JSON.stringify(records));
  const ranked = rankForRecall(records);
  assert.deepEqual(records, snapshot, "input array and records must be untouched");
  assert.notEqual(ranked, records, "must return a new array");
  ranked.forEach((r, i) => assert.notEqual(r, records[i], "records themselves are copies"));
});

test("rankForRecall handles empty and garbage collections safely", () => {
  assert.deepEqual(rankForRecall([]), []);
  assert.deepEqual(rankForRecall(null), []);
  assert.deepEqual(rankForRecall(undefined), []);
  assert.deepEqual(rankForRecall("nope"), []);
  // Individual garbage entries degrade to base score instead of throwing.
  assert.doesNotThrow(() => rankForRecall([null, undefined, { id: "ok" }]));
});

// ---------------------------------------------------------------------------
// shouldAutoDemote
// ---------------------------------------------------------------------------

test("shouldAutoDemote fires only when irrelevant >= 3 AND irrelevant > useful", () => {
  assert.equal(shouldAutoDemote({ irrelevant: 3, useful: 0 }), true);
  assert.equal(shouldAutoDemote({ irrelevant: 4, useful: 3 }), true, "spec edge: 4>3 and >=3");
  // Threshold edges from the task brief.
  assert.equal(shouldAutoDemote({ irrelevant: 3, useful: 3 }), false, "equal votes do not demote");
  assert.equal(shouldAutoDemote({ irrelevant: 3, useful: 4 }), false, "useful outweighs");
  assert.equal(shouldAutoDemote({ irrelevant: 2, useful: 0 }), false, "below threshold");
  assert.equal(shouldAutoDemote({}), false);
  assert.equal(shouldAutoDemote(null), false);
  assert.equal(shouldAutoDemote({ irrelevant: "lots", useful: NaN }), false);
});

// ---------------------------------------------------------------------------
// applyFeedback
// ---------------------------------------------------------------------------

test("applyFeedback increments the right counter on a NEW record", () => {
  const before = Object.freeze({ uses: 1, useful: 2, irrelevant: 0, promotedAt: "2026-01-01T00:00:00Z" });

  const used = applyFeedback(before, "used");
  assert.deepEqual(used, { uses: 2, useful: 2, irrelevant: 0, promotedAt: "2026-01-01T00:00:00Z" });
  assert.notEqual(used, before, "must not hand back the same object");

  const praised = applyFeedback(before, "useful");
  assert.equal(praised.useful, 3);
  assert.equal(before.useful, 2, "original untouched");

  const panned = applyFeedback(before, "irrelevant");
  assert.equal(panned.irrelevant, 1);
  assert.equal(before.irrelevant, 0);
});

test("applyFeedback leaves unknown feedback kinds unchanged", () => {
  const before = { uses: 1, useful: 0, irrelevant: 0, promotedAt: null };
  assert.deepEqual(applyFeedback(before, "starred"), before);
  assert.deepEqual(applyFeedback(before, ""), before);
  assert.deepEqual(applyFeedback(before, undefined), before);
});

test("applyFeedback stamps lastUsedAt only when a timestamp is supplied", () => {
  const before = { uses: 0, useful: 0, irrelevant: 0, promotedAt: null };
  const stamped = applyFeedback(before, "useful", "2026-08-22T12:00:00Z");
  assert.equal(stamped.useful, 1);
  assert.equal(stamped.lastUsedAt, "2026-08-22T12:00:00Z");
  // An older stamp never regresses a fresher lastUsedAt.
  const regressed = applyFeedback(stamped, "used", "2026-01-01T00:00:00Z");
  assert.equal(regressed.lastUsedAt, "2026-08-22T12:00:00Z");
  const advanced = applyFeedback(stamped, "irrelevant", "2026-08-23T00:00:00Z");
  assert.equal(advanced.lastUsedAt, "2026-08-23T00:00:00Z");
  // No timestamp argument: no lastUsedAt key materializes.
  assert.equal("lastUsedAt" in applyFeedback(before, "used"), false);
});

test("applyFeedback defends against missing/garbage records", () => {
  // A missing record behaves like a blank one and gains the feedback.
  assert.deepEqual(applyFeedback(undefined, "useful"), { uses: 0, useful: 1, irrelevant: 0, promotedAt: null });
  assert.deepEqual(applyFeedback(null, "irrelevant"), { uses: 0, useful: 0, irrelevant: 1, promotedAt: null });
});

// ---------------------------------------------------------------------------
// selectForTraining
// ---------------------------------------------------------------------------

test("selectForTraining returns scored {record, score} pairs sorted by fitness", () => {
  const records = [
    { id: "low", body: "weak lesson", useful: 0, irrelevant: 1 }, // 38 < base
    { id: "high", body: "trusted lesson", useful: 3 },
    { id: "mid", body: "neutral lesson" },
  ];
  const picked = selectForTraining(records);
  assert.deepEqual(picked.map((p) => p.record.id), ["high", "mid"], "sub-base scores are excluded by default");
  assert.equal(picked[0].score, 74);
  assert.ok(picked.every((p) => typeof p.score === "number"));
  // Returned records are copies — mutating one must not touch the input.
  picked[0].record.body = "mutated";
  assert.equal(records[1].body, "trusted lesson");
});

test("selectForTraining excludes demoted, auto-demote-worthy, and empty records", () => {
  const records = [
    { id: "demoted", body: "curated out", status: "demoted", useful: 9 },
    { id: "rolled", body: "rolled back", status: "rolled_back", useful: 9 },
    { id: "noise", body: "net noise", useful: 0, irrelevant: 4 },
    { id: "empty", body: "   ", useful: 5 },
    { id: "good", body: "a real lesson", useful: 1 },
  ];
  const picked = selectForTraining(records);
  assert.deepEqual(picked.map((p) => p.record.id), ["good"]);
});

test("selectForTraining honors minScore and limit", () => {
  const records = [
    { id: "a", body: "x", useful: 3 },   // 74
    { id: "b", body: "x", useful: 1 },   // 58
    { id: "c", body: "x" },              // 50
  ];
  assert.deepEqual(selectForTraining(records, { minScore: 60 }).map((p) => p.record.id), ["a"]);
  assert.deepEqual(selectForTraining(records, { limit: 2 }).map((p) => p.record.id), ["a", "b"]);
  assert.deepEqual(selectForTraining(records, { limit: 0 }), []);
});

test("selectForTraining handles garbage collections safely", () => {
  assert.deepEqual(selectForTraining(null), []);
  assert.deepEqual(selectForTraining(undefined), []);
  assert.deepEqual(selectForTraining("nope"), []);
  assert.doesNotThrow(() => selectForTraining([null, { id: "ok", body: "fine" }]));
});
