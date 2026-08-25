const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGroundedContext, MAX_BLOCK_CHARS } = require("./prompt_context.cjs");

function record(overrides = {}) {
  return { id: "mem_1", title: "Lesson", body: "Body text", status: "candidate", createdAt: "2026-08-20T10:00:00Z", ...overrides };
}

test("empty or missing recall yields no block and no citations", () => {
  assert.deepEqual(buildGroundedContext(), { systemBlock: null, citations: [] });
  assert.deepEqual(buildGroundedContext({ recall: null }), { systemBlock: null, citations: [] });
  assert.deepEqual(buildGroundedContext({ recall: { records: [] } }), { systemBlock: null, citations: [] });
});

test("candidate-only recall is never injected", () => {
  const result = buildGroundedContext({ recall: { records: [record()] } });
  assert.equal(result.systemBlock, null);
  assert.deepEqual(result.citations, []);
});

test("mixed statuses inject only promoted records", () => {
  const result = buildGroundedContext({
    recall: {
      records: [
        record({ id: "mem_c", status: "candidate" }),
        record({ id: "mem_a", title: "Promoted lesson", body: "Use the bounded verify profile.", status: "active", createdAt: "2026-08-21T09:00:00Z" }),
        record({ id: "mem_d", status: "demoted" }),
      ],
    },
  });
  assert.match(result.systemBlock, /^\[Hemlock memory · 1 record\(s\) · verify-before-use\]\n- Promoted lesson: Use the bounded verify profile\.$/);
  assert.deepEqual(result.citations, [{ id: "mem_a", title: "Promoted lesson" }]);
});

test("records without a status field are excluded (not provably promoted)", () => {
  const result = buildGroundedContext({ recall: { records: [{ id: "mem_x", title: "No status", body: "?" }] } });
  assert.equal(result.systemBlock, null);
});

test("block is capped at 1200 chars without breaking mid-word where avoidable", () => {
  const records = Array.from({ length: 40 }, (_, index) =>
    record({ id: `mem_${index}`, body: `lesson about bounded verification and receipts number ${index} `.repeat(8), status: "active" }));
  const result = buildGroundedContext({ recall: { records } });
  assert.ok(result.systemBlock.length <= MAX_BLOCK_CHARS, `block length ${result.systemBlock.length}`);
  assert.ok(result.systemBlock.startsWith("[Hemlock memory ·"));
});

test("ordering is newest-promoted first and deterministic", () => {
  const records = [
    record({ id: "mem_old", createdAt: "2026-08-01T00:00:00Z", status: "active" }),
    record({ id: "mem_new", createdAt: "2026-08-22T00:00:00Z", status: "active" }),
    record({ id: "mem_mid", createdAt: "2026-08-10T00:00:00Z", status: "active" }),
  ];
  const first = buildGroundedContext({ recall: { records } });
  const second = buildGroundedContext({ recall: { records } });
  assert.deepEqual(first.citations.map((citation) => citation.id), ["mem_new", "mem_mid", "mem_old"]);
  assert.deepEqual(first, second);
});
