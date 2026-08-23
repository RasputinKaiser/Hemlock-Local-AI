"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { chooseVerificationProfile, verificationSummary, skippedVerification, OUTPUT_TAIL_CHARS } = require("./verification_profile.cjs");

const PROFILES = {
  "app-build": { label: "Hemlock UI build", command: "npm run build", timeoutMs: 180000 },
  "diff-check": { label: "Git diff check", command: "git diff --check", timeoutMs: 30000 },
  "python-tests": { label: "Focused MLX tuner tests", command: "python -S -m pytest -q tests/test_tuner_utils.py", timeoutMs: 300000 },
  "node-tests": { label: "Electron suite", command: "node --test electron/*.test.cjs", timeoutMs: 120000 },
};

test("chooses a test-runner profile for source edits, never a build or lint profile", () => {
  const choice = chooseVerificationProfile(PROFILES, ["src/main.jsx", "src/styles.css"]);
  assert.ok(choice, "expected a profile for source edits");
  assert.equal(choice.id, "node-tests");
  assert.equal(choice.command, "node --test electron/*.test.cjs");
});

test("prefers an npm test-shaped profile over node --test when both exist", () => {
  const profiles = {
    ...PROFILES,
    "npm-test": { label: "npm test", command: "npm test", timeoutMs: 60000 },
  };
  const choice = chooseVerificationProfile(profiles, ["electron/main.cjs"]);
  assert.equal(choice.id, "npm-test");
});

test("chooses the python profile for .py edits", () => {
  const choice = chooseVerificationProfile(PROFILES, ["tests/test_tuner_utils.py"]);
  assert.equal(choice.id, "python-tests");
});

test("returns null honestly when no profile matches", () => {
  // No test-runner profile exists for source edits: skip, do not fall back to
  // the build profile.
  const { "node-tests": _omit, ...noTestRunner } = PROFILES;
  assert.equal(chooseVerificationProfile(noTestRunner, ["src/main.jsx"]), null);
  assert.equal(chooseVerificationProfile(PROFILES, ["README.md", "docs/notes.rst"]), null);
  assert.equal(chooseVerificationProfile(PROFILES, []), null);
  assert.equal(chooseVerificationProfile({}, ["src/main.jsx"]), null);
  assert.equal(chooseVerificationProfile(null, ["src/main.jsx"]), null);
});

test("never returns a profile outside the allowlist", () => {
  const choice = chooseVerificationProfile(PROFILES, ["src/main.jsx"]);
  assert.ok(PROFILES[choice.id], "chosen profile id must exist in the allowlist");
});

test("summarizes a receipt into the card shape", () => {
  const choice = { id: "node-tests", label: "Electron suite", command: "node --test electron/*.test.cjs" };
  const summary = verificationSummary({
    choice,
    receipt: { exitCode: 0, timedOut: false, stdout: "ok 1 - passes", stderr: "" },
    durationMs: 1234,
    changeSetId: "changeset-1",
  });
  assert.equal(summary.schema, "hemlock.agent.verification.v1");
  assert.equal(summary.status, "passed");
  assert.equal(summary.profile, "node-tests");
  assert.equal(summary.command, "node --test electron/*.test.cjs");
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.durationMs, 1234);
  assert.equal(summary.outputTail, "ok 1 - passes");
  assert.equal(summary.changeSetId, "changeset-1");
  assert.ok(summary.ranAt);
});

test("marks nonzero exits, timeouts, and thrown errors as failed with a bounded tail", () => {
  const failed = verificationSummary({ choice: { id: "node-tests", label: "x", command: "node --test" }, receipt: { exitCode: 1, stdout: "not ok\n".repeat(300) }, durationMs: 10 });
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.outputTail.length <= OUTPUT_TAIL_CHARS);
  assert.ok(failed.outputTail.endsWith("not ok"));
  const timedOut = verificationSummary({ choice: { id: "node-tests", label: "x", command: "node --test" }, receipt: { exitCode: null, timedOut: true, stderr: "killed" }, durationMs: 5000 });
  assert.equal(timedOut.status, "failed");
  const missing = verificationSummary({ choice: { id: "node-tests", label: "x", command: "node --test" }, receipt: {}, durationMs: 0 });
  assert.equal(missing.status, "failed");
  assert.equal(missing.exitCode, null);
});

test("skipped verification records an honest reason", () => {
  const skipped = skippedVerification();
  assert.equal(skipped.schema, "hemlock.agent.verification.v1");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "no matching profile");
  assert.ok(skipped.ranAt);
});
