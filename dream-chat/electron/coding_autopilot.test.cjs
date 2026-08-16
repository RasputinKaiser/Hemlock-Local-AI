const assert = require("node:assert/strict");
const test = require("node:test");
const { CodingAutopilot } = require("./coding_autopilot.cjs");

test("coding autopilot rolls back failed candidates and promotes the first verified repair", async () => {
  let calls = 0;
  const rolledBack = [];
  const events = [];
  const autopilot = new CodingAutopilot({
    maxAttempts: 2,
    inferRepair: async () => ({ input: { patches: [{ path: "index.js", content: `candidate-${++calls}` }] } }),
    apply: async ({ patches }) => ({ id: `change-${calls}`, evidenceRefs: [`changeset://${calls}`], patches }),
    verify: async ({ candidate }) => candidate.id === "change-2" ? { status: "passed", issues: [] } : { status: "blocked", issues: [{ code: "test_failed", message: "fixture failure" }] },
    rollback: async ({ changeSetId }) => { rolledBack.push(changeSetId); },
    emit: (type, status, payload) => events.push({ type, status, payload }),
  });
  const result = await autopilot.run({ threadId: "thread-1", taskId: "task-1", objective: "repair code", issues: [{ code: "test_failed", message: "initial" }] });
  assert.equal(result.status, "passed");
  assert.equal(result.attempt, 2);
  assert.deepEqual(rolledBack, ["change-1"]);
  assert.equal(events.some((event) => event.type === "code.repair.completed" && event.status === "passed"), true);
});
test("coding autopilot exhausts exactly two failed repairs", async () => {
  let calls = 0;
  const rolledBack = [];
  const result = await new CodingAutopilot({
    maxAttempts: 2,
    inferRepair: async () => ({ input: { patches: [{ path: "index.js", content: `candidate-${++calls}` }] } }),
    apply: async () => ({ id: `change-${calls}` }),
    verify: async () => ({ status: "blocked", issues: [{ code: "test_failed", message: "still failing" }] }),
    rollback: async ({ changeSetId }) => rolledBack.push(changeSetId),
  }).run({ threadId: "thread-1", taskId: "task-1", objective: "repair code" });
  assert.equal(result.status, "exhausted");
  assert.equal(calls, 2);
  assert.deepEqual(rolledBack, ["change-1", "change-2"]);
});
