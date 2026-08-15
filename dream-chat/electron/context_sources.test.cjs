const assert = require("node:assert/strict");
const test = require("node:test");
const { ContextSourceRegistry, normalizeObservation } = require("./context_sources.cjs");

function makeRegistry() {
  const policies = new Map([
    ["local-project", { sourceId: "local-project", enabled: true, scope: "/tmp/hemlock", retention: "project-lifetime", permissionState: "implicit-project-scope" }],
    ["computer-history", { sourceId: "computer-history", enabled: false, scope: "local-user", retention: "30d", permissionState: "not-enabled" }],
    ["local-notes", { sourceId: "local-notes", enabled: false, scope: "user-selected", retention: "30d", permissionState: "not-enabled" }],
  ]);
  const broker = { search: async () => ({ matches: [{ id: "segment-1", text: "user@example.com worked on Hemlock", sourceRef: "segment://1", confidence: 0.8 }], evidenceRefs: ["segment://1"] }) };
  return new ContextSourceRegistry({ repoRoot: "/tmp/hemlock", kernel: { source: (id) => policies.get(id) || { sourceId: id, enabled: false, permissionState: "not-enabled" } }, broker });
}

test("disabled personal sources cannot contribute observations", async () => {
  const registry = makeRegistry();
  const result = await registry.get("computer-history").query({ query: "Hemlock" });
  assert.equal(result.status, "not_enabled");
  assert.deepEqual(result.observations, []);
});

test("enabled observations retain provenance and redact sensitive content", async () => {
  const registry = makeRegistry();
  const result = await registry.get("local-project").query({ query: "Hemlock" });
  assert.equal(result.status, "fresh");
  assert.equal(result.observations[0].sourceId, "local-project");
  assert.equal(result.observations[0].sourceRef, "segment://1");
  assert.equal(result.observations[0].redactedContent.includes("[redacted-email]"), true);
  assert.equal(result.evidenceRefs[0], "segment://1");
});

test("observation normalization clamps confidence and records sensitivity", () => {
  const observation = normalizeObservation({ sourceId: "calendar", scope: "user-selected", summary: "A private event", confidence: 2, sensitivity: "sensitive", sourceRef: "calendar://1" });
  assert.equal(observation.confidence, 1);
  assert.equal(observation.sensitivity, "sensitive");
  assert.equal(observation.provenance.sourceRef, "calendar://1");
});
