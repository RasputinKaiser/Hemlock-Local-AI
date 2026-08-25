"use strict";

// T7-S1: answer-in-place gate. Pure validation so the host command
// "task.answer" rejects honestly when there is no live question to answer,
// and so the electron suite can pin the reject paths without a runtime.

function assertAnswerable(task, answer) {
  if (!task || typeof task !== "object" || !task.id) {
    return { ok: false, reason: "Hemlock has no active task to answer." };
  }
  if (task.phase !== "waiting_for_user" || task.status !== "waiting_for_approval") {
    return { ok: false, reason: `Hemlock is not waiting for an answer; current phase is ${task.phase || "unknown"} (${task.status || "unknown"}).` };
  }
  const text = String(answer ?? "").trim();
  if (!text) return { ok: false, reason: "An empty answer cannot unblock Hemlock." };
  if (!task.threadId) return { ok: false, reason: "The waiting task has no thread to record the answer in." };
  return { ok: true, reason: "", text };
}

module.exports = { assertAnswerable };
