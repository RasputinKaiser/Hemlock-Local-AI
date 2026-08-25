"use strict";

// Post-apply verification helpers for the conversational Build flow (T6-V1).
// Pure logic only: choosing an allowlisted verification profile from the files
// a change set touched, and shaping the receipt into the compact
// hemlock.agent.verification.v1 summary that the renderer's verification card
// displays. Nothing here spawns processes or touches the filesystem.

const VERIFICATION_SCHEMA = "hemlock.agent.verification.v1";
const OUTPUT_TAIL_CHARS = 800;

function normalizeProfiles(profiles) {
  return Object.entries(profiles && typeof profiles === "object" ? profiles : {})
    .filter(([, profile]) => profile && typeof profile === "object")
    .map(([id, profile]) => ({
      id,
      label: String(profile.label || id),
      command: String(profile.command || ""),
      timeoutMs: Number(profile.timeoutMs) || 30000,
    }));
}

function isPythonPath(value) {
  return value.endsWith(".py");
}

function isSourcePath(value) {
  return /\.(cjs|mjs|js|jsx|ts|tsx|json|css|html)$/.test(value);
}

function commandMentions(profile, pattern) {
  return pattern.test(`${profile.command} ${profile.label}`.toLowerCase());
}

// Choose the allowlisted verification profile that best matches the paths a
// change set touched. Only allowlisted entries can ever be returned; null
// means "skip honestly" — the caller records a skipped verification instead
// of inventing or widening a command.
//
// Selection order:
//   1. Python-only edits → the python/pytest-shaped profile.
//   2. Source edits → an explicit test-runner profile ("npm test"-shaped or
//      `node --test`), never a plain build/lint profile.
//   3. Otherwise null.
function chooseVerificationProfile(profiles, appliedPaths = []) {
  const candidates = normalizeProfiles(profiles);
  if (!candidates.length) return null;
  const paths = (Array.isArray(appliedPaths) ? appliedPaths : [appliedPaths])
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);
  if (!paths.length) return null;
  if (paths.some(isPythonPath)) {
    const pythonProfile = candidates.find((profile) => commandMentions(profile, /python|pytest/));
    if (pythonProfile) return pythonProfile;
  }
  if (paths.some(isSourcePath)) {
    // Prefer an explicit "npm test"-shaped runner before any other test
    // runner shape.
    const npmTest = candidates.find((profile) => commandMentions(profile, /(^|[\s/])npm([\s]+run)?[\s]+test($|\s)/));
    if (npmTest) return npmTest;
    const testRunner = candidates.find((profile) => (
      commandMentions(profile, /(^|[\s/])node[\s]+--test/)
      || commandMentions(profile, /(^|[\s/])(npx|vitest|jest|mocha)[\s]/)
    ));
    if (testRunner) return testRunner;
  }
  return null;
}

// Compact card-facing summary. status mirrors runVerification's own receipt
// rule: exit code 0 passes; anything else (including a timeout kill) fails.
function verificationSummary({ choice = null, receipt = {}, durationMs = 0, changeSetId = null } = {}) {
  const exitCode = Number.isFinite(Number(receipt.exitCode)) ? Number(receipt.exitCode) : null;
  const output = `${receipt.stdout || ""}\n${receipt.stderr || ""}`.trim();
  return {
    schema: VERIFICATION_SCHEMA,
    status: exitCode === 0 && !receipt.timedOut ? "passed" : "failed",
    profile: choice ? choice.id : null,
    label: choice ? choice.label : null,
    command: choice ? choice.command : String(receipt.command || ""),
    exitCode,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
    changeSetId: changeSetId || null,
    ranAt: new Date().toISOString(),
  };
}

// Recorded when no allowlisted profile matches the applied files — visible in
// Chat rather than silently doing nothing.
function skippedVerification(reason = "no matching profile") {
  return {
    schema: VERIFICATION_SCHEMA,
    status: "skipped",
    reason: String(reason || "no matching profile").slice(0, 300),
    ranAt: new Date().toISOString(),
  };
}

module.exports = {
  VERIFICATION_SCHEMA,
  OUTPUT_TAIL_CHARS,
  chooseVerificationProfile,
  verificationSummary,
  skippedVerification,
};
