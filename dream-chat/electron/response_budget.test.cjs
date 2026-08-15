const test = require("node:test");
const assert = require("node:assert/strict");
const { responseBudget } = require("./response_budget.cjs");

test("adaptive response budgets reserve a smaller conversational greeting", () => {
  assert.equal(responseBudget("Hey Maple, how are you?"), 320);
});

test("adaptive response budgets use the normal conversational default", () => {
  assert.equal(responseBudget("Tell me what is happening in this workspace."), 512);
});

test("adaptive response budgets expand detail-oriented requests", () => {
  assert.equal(responseBudget("Please explain why this design works, compare the alternatives, and go deeper."), 768);
});
