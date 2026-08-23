const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Crash-loop policy (T7.5-R1). Pure policy tests here; the wiring in main.cjs
// is guarded by source assertions at the bottom (main.cjs has no test export
// seam — see maple_notify.test.cjs for the same pattern).
const { recordCrash, shouldRespawn } = require(path.resolve(__dirname, "crash_policy.cjs"));

const WINDOW = 600000;

test("shouldRespawn: under threshold respawns", () => {
  const now = 1_000_000;
  const verdict = shouldRespawn({ crashTimestamps: [now - 5000, now - 3000], now });
  assert.equal(verdict.respawn, true);
});

test("shouldRespawn: at threshold blocks with honest reason", () => {
  const now = 1_000_000;
  const verdict = shouldRespawn({ crashTimestamps: [now - 9000, now - 6000, now - 1000], now });
  assert.equal(verdict.respawn, false);
  assert.equal(verdict.reason, "crash loop suspected: 3 maple crashes in 10 minutes");
});

test("shouldRespawn: crashes outside window do not count", () => {
  const now = 1_000_000;
  const timestamps = [now - WINDOW - 1, now - WINDOW - 5000, now - WINDOW - 60000, now - 2000];
  const verdict = shouldRespawn({ crashTimestamps: timestamps, now });
  assert.equal(verdict.respawn, true);
});

test("shouldRespawn: empty history respawns", () => {
  assert.equal(shouldRespawn({ crashTimestamps: [], now: 1_000_000 }).respawn, true);
});

test("shouldRespawn: null / garbage history fails open", () => {
  for (const garbage of [null, undefined, "nope", 42, {}, [null, "x", NaN, undefined]]) {
    const verdict = shouldRespawn({ crashTimestamps: garbage, now: 1_000_000 });
    assert.equal(verdict.respawn, true, `expected fail-open for ${JSON.stringify(garbage)}`);
  }
});

test("shouldRespawn: missing options object entirely fails open", () => {
  assert.equal(shouldRespawn().respawn, true);
});

test("recordCrash appends and prunes entries older than the window", () => {
  const now = 1_000_000;
  const history = [now - WINDOW - 1, now - WINDOW + 1, now - 100];
  const next = recordCrash(history, now);
  assert.deepEqual(next, [now - WINDOW + 1, now - 100, now]);
});

test("recordCrash does not mutate the input array", () => {
  const now = 1_000_000;
  const history = [now - 100];
  const snapshot = [...history];
  const next = recordCrash(history, now);
  assert.deepEqual(history, snapshot);
  assert.notEqual(history, next);
  assert.equal(next.length, 2);
});

test("recordCrash tolerates null/garbage input histories", () => {
  const now = 1_000_000;
  assert.deepEqual(recordCrash(null, now), [now]);
  assert.deepEqual(recordCrash(["x", NaN], now), [now]);
});

// --- Wiring guards (source-level, main.cjs has no export seam) ---

test("main.cjs wires crash recording into the child exit handler and gates restarts", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  // Crash history recorded on unexpected child death...
  assert.match(src, /mapleCrashTimestamps\s*=\s*recordCrash\(mapleCrashTimestamps/);
  // ...the restart gate consults the policy before relaunching...
  assert.match(src, /shouldRespawn\(\{\s*crashTimestamps:\s*mapleCrashTimestamps/);
  // ...a blocked loop emits an honest receipt...
  assert.match(src, /maple\.crashloop\.detected/, "missing maple.crashloop.detected agent event");
  // ...degraded state carries crashLooped/crashLoopReason...
  assert.match(src, /crashLooped:\s*true,\s*crashLoopReason:\s*verdict\.reason/);
  // ...and a user-initiated maple.launch resets the budget.
  assert.match(src, /launchMapleRuntime\(\{\s*resetCrashLoop:\s*true\s*\}\)/);
});
