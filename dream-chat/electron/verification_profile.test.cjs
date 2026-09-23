"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  chooseVerificationProfile,
  verificationSummary,
  skippedVerification,
} = require("./verification_profile.cjs");

const PROFILES = {
  "app-build": { label: "UI build", command: "npm run build", timeoutMs: 180000 },
  "agent-tests": { label: "Agent tests", command: "npm run test:agent", timeoutMs: 120000 },
  "diff-check": { label: "Git diff check", command: "git diff --check", timeoutMs: 30000 },
  "python-tests": { label: "Python tests", command: "python -m pytest -q tests/", timeoutMs: 300000 },
};

test("python edits choose the python-shaped profile", () => {
  const choice = chooseVerificationProfile(PROFILES, ["electron/dream_train.py"]);
  assert.equal(choice.id, "python-tests");
});

test("source edits prefer a test runner over a build profile", () => {
  const choice = chooseVerificationProfile(PROFILES, ["electron/main.cjs"]);
  assert.equal(choice.id, "agent-tests", "npm run test:agent must match the test-runner rule");
});

test("named test scripts on other package managers also match", () => {
  const profiles = { pnpm: { label: "pnpm tests", command: "pnpm test:unit", timeoutMs: 60000 } };
  const choice = chooseVerificationProfile(profiles, ["src/app.jsx"]);
  assert.equal(choice.id, "pnpm");
});

test("build/lint profiles never satisfy a source edit", () => {
  const profiles = {
    build: { label: "build", command: "npm run build", timeoutMs: 60000 },
    lint: { label: "lint", command: "npm run lint", timeoutMs: 60000 },
  };
  assert.equal(chooseVerificationProfile(profiles, ["electron/main.cjs"]), null);
});

test("no matching profile returns null so the caller records a skip", () => {
  assert.equal(chooseVerificationProfile(PROFILES, ["assets/logo.png"]), null);
  assert.equal(chooseVerificationProfile(PROFILES, []), null);
  assert.equal(chooseVerificationProfile({}, ["electron/main.cjs"]), null);
  assert.equal(chooseVerificationProfile(null, ["x.js"]), null);
});

test("verificationSummary mirrors exit-code semantics", () => {
  const choice = { id: "agent-tests", label: "Agent tests", command: "npm run test:agent" };
  const pass = verificationSummary({ choice, receipt: { exitCode: 0, stdout: "ok" }, durationMs: 12.6, changeSetId: "cs-1" });
  assert.equal(pass.status, "passed");
  assert.equal(pass.changeSetId, "cs-1");
  const fail = verificationSummary({ choice, receipt: { exitCode: 1, stderr: "boom" }, durationMs: 5 });
  assert.equal(fail.status, "failed");
  const timedOut = verificationSummary({ choice, receipt: { exitCode: 0, timedOut: true }, durationMs: 5 });
  assert.equal(timedOut.status, "failed", "a timed-out pass is not a pass");
});

test("skippedVerification records an honest skip", () => {
  const skipped = skippedVerification("no matching profile");
  assert.equal(skipped.schema, "hemlock.agent.verification.v1");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "no matching profile");
});
