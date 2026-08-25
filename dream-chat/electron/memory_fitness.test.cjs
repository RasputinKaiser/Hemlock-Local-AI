const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Pure scoring/ranking policy — no mocks needed for the logic under test.
const {
  scoreRecord,
  rankForRecall,
  shouldAutoDemote,
  applyFeedback,
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

test("applyFeedback defends against missing/garbage records", () => {
  // A missing record behaves like a blank one and gains the feedback.
  assert.deepEqual(applyFeedback(undefined, "useful"), { uses: 0, useful: 1, irrelevant: 0, promotedAt: null });
  assert.deepEqual(applyFeedback(null, "irrelevant"), { uses: 0, useful: 0, irrelevant: 1, promotedAt: null });
});
