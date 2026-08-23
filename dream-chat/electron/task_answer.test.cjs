"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertAnswerable } = require("./task_answer.cjs");

const WAITING_TASK = {
  id: "t-1",
  phase: "waiting_for_user",
  status: "waiting_for_approval",
  threadId: "thread-1",
};

test("accepts a non-empty answer while the task waits on the user", () => {
  const gate = assertAnswerable(WAITING_TASK, "  Use the local model  ");
  assert.equal(gate.ok, true);
  assert.equal(gate.text, "Use the local model");
});

test("rejects when the task is not in the waiting_for_user phase", () => {
  const gate = assertAnswerable({ ...WAITING_TASK, phase: "work", status: "running" }, "hello");
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /not waiting for an answer/);
  assert.match(gate.reason, /work \(running\)/);
});

test("rejects when the task status is not waiting_for_approval", () => {
  const gate = assertAnswerable({ ...WAITING_TASK, status: "running" }, "hello");
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /not waiting for an answer/);
});

test("rejects empty and whitespace-only answers", () => {
  for (const answer of ["", "   ", null, undefined]) {
    const gate = assertAnswerable(WAITING_TASK, answer);
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /empty answer/);
  }
});

test("rejects a missing task and a task without a thread honestly", () => {
  assert.equal(assertAnswerable(null, "hi").ok, false);
  const noThread = assertAnswerable({ ...WAITING_TASK, threadId: undefined }, "hi");
  assert.equal(noThread.ok, false);
  assert.match(noThread.reason, /no thread/);
});
