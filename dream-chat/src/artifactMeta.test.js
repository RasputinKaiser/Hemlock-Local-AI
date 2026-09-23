import test from "node:test";
import assert from "node:assert/strict";
import { displayArtifactTitle, evidenceFlags, revisionBadge } from "./artifactMeta.js";

test("displayArtifactTitle unwraps the revise-instruction envelope", () => {
  const wrapped = `Revise the task artifact "Night Garden" (artifactId: artifact-123). Instruction: add stars`;
  assert.equal(displayArtifactTitle(wrapped), "Night Garden");
});

test("displayArtifactTitle truncates long titles and tolerates junk", () => {
  const long = `x`.repeat(80);
  assert.equal(displayArtifactTitle(long).length, 60);
  assert.ok(displayArtifactTitle(long).endsWith("…"));
  assert.equal(displayArtifactTitle(""), "Untitled artifact");
  assert.equal(displayArtifactTitle(null), "Untitled artifact");
});

test("evidenceFlags surfaces host fallback and repair evidence", () => {
  const artifact = { evidence: [
    { type: "authoring.started" },
    { type: "authoring.host_fallback", reason: "Maple did not return a usable structured authoring envelope." },
  ] };
  const flags = evidenceFlags(artifact);
  assert.equal(flags.fallback.reason.includes("usable"), true);
  assert.equal(flags.repaired, null);
  assert.equal(flags.fallbackIndex, 1);
  assert.equal(flags.repairedIndex, -1);
});

test("evidenceFlags also reads a nested manifest copy", () => {
  const flags = evidenceFlags({ manifest: { evidence: [{ type: "authoring.repaired_source", reason: "repair pass" }] } });
  assert.equal(flags.repaired.reason, "repair pass");
  assert.equal(flags.fallback, null);
  assert.deepEqual(evidenceFlags(null), { fallback: null, repaired: null, fallbackIndex: -1, repairedIndex: -1 });
});

test("evidenceFlags ordering lets the caller pick the latest signal", () => {
  const flags = evidenceFlags({ evidence: [
    { type: "authoring.host_fallback", reason: "scaffold" },
    { type: "authoring.repaired_source", reason: "repair pass" },
  ] });
  assert.ok(flags.repairedIndex > flags.fallbackIndex);
});

test("revisionBadge normalizes status and short digest", () => {
  const badge = revisionBadge({ status: "ready", digest: "sha256:abcdef0123456789", createdAt: "2026-01-01" });
  assert.equal(badge.status, "ready");
  assert.equal(badge.shortDigest, "abcdef0123");
  assert.equal(revisionBadge({}).status, "drafting");
});
