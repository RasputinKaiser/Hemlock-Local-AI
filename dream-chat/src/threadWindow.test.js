import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_THREAD_STATUSES,
  TERMINAL_THREAD_STATUSES,
  checkpointRows,
  conversationPreview,
  defaultForkTitle,
  resolveSelectedThread,
  searchResultRows,
  splitThreads,
  taskHistoryLabel,
  threadActions,
  threadStatusLamp,
} from "./threadWindow.js";

const fixture = [
  { id: "t-old", title: "Old thread", status: "ready", provider: "maple", updatedAt: "2026-08-20T10:00:00Z", taskHistory: ["task-1", "task-2"] },
  { id: "t-new", title: "New thread", status: "running", provider: "codex", updatedAt: "2026-08-24T10:00:00Z", taskHistory: [] },
  { id: "t-arc", title: "Archived thread", status: "archived", provider: "maple", updatedAt: "2026-08-22T10:00:00Z", taskHistory: ["task-9"] },
];

test("splitThreads separates archived rows and sorts each section newest-first", () => {
  const { open, archived } = splitThreads(fixture);
  assert.deepEqual(open.map((item) => item.id), ["t-new", "t-old"]);
  assert.deepEqual(archived.map((item) => item.id), ["t-arc"]);
  assert.deepEqual(splitThreads(null), { open: [], archived: [] });
  assert.deepEqual(splitThreads([null, undefined]).open, []);
});

test("resolveSelectedThread prefers the pick, falls back to active, then nothing", () => {
  assert.equal(resolveSelectedThread(fixture, "t-old", "t-new").id, "t-old");
  assert.equal(resolveSelectedThread(fixture, "missing", "t-new").id, "t-new");
  assert.equal(resolveSelectedThread(fixture, null, null), null);
  assert.equal(resolveSelectedThread([], "a", "b"), null);
});

test("threadStatusLamp only emits the lamp vocabulary the stylesheet defines", () => {
  assert.equal(threadStatusLamp("running"), "working");
  assert.equal(threadStatusLamp("verifying"), "working");
  assert.equal(threadStatusLamp("blocked"), "down");
  assert.equal(threadStatusLamp("cancelled"), "down");
  assert.equal(threadStatusLamp("ready"), "ready");
  assert.equal(threadStatusLamp("completed"), "ready");
  for (const status of ["paused", "archived", "waiting_for_approval", "waiting_for_user", "mystery"]) {
    assert.equal(threadStatusLamp(status), "idle", status);
  }
  assert.equal(threadStatusLamp(null), "ready", "a missing status reads as the ready default");
});

test("taskHistoryLabel reports prior tasks honestly", () => {
  assert.equal(taskHistoryLabel(fixture[0]), "2 prior tasks");
  assert.equal(taskHistoryLabel({ taskHistory: ["task-1"] }), "1 prior task");
  assert.equal(taskHistoryLabel({ taskHistory: [] }), null);
  assert.equal(taskHistoryLabel({}), null);
});

test("defaultForkTitle prefixes and stays inside the title bound", () => {
  assert.equal(defaultForkTitle({ title: "Source" }), "Fork of Source");
  assert.equal(defaultForkTitle({}), "Fork of Hemlock thread");
  assert.ok(defaultForkTitle({ title: "x".repeat(200) }).length <= 160);
});

test("checkpointRows normalizes, flags markers, and lists newest first", () => {
  const rows = checkpointRows([
    { id: "c1", phase: "conversation", status: "ready", reason: "thread-created", createdAt: "2026-08-24T10:00:00Z" },
    { id: "c2", phase: "paused", status: "paused", reason: "checkpoint-restored:c1", createdAt: "2026-08-24T11:00:00Z" },
  ], { currentCheckpointId: "c1" });
  assert.deepEqual(rows.map((row) => row.id), ["c2", "c1"]);
  assert.equal(rows[0].isRestoreMarker, true);
  assert.equal(rows[1].isRestoreMarker, false);
  assert.equal(rows[1].isCurrent, true);
  assert.deepEqual(checkpointRows(null), []);
  assert.deepEqual(checkpointRows([null]), []);
});

test("conversationPreview tails the log and bounds message text", () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", content: `message ${index}`, createdAt: `2026-08-24T10:${String(index).padStart(2, "0")}:00Z` }));
  const preview = conversationPreview(messages, { limit: 40 });
  assert.equal(preview.length, 40);
  assert.equal(preview[0].id, "m10");
  const long = conversationPreview([{ role: "assistant", content: "y".repeat(500) }], { textLimit: 40 });
  assert.equal(long[0].truncated, true);
  assert.ok(long[0].text.length <= 40);
  assert.equal(conversationPreview([{ role: "nonsense", content: "hi" }])[0].role, "system");
  assert.deepEqual(conversationPreview(undefined), []);
});

test("searchResultRows keeps only well-formed host matches", () => {
  const rows = searchResultRows([
    { threadId: "t1", title: "Alpha", matchedIn: "conversation", snippet: "…hit…" },
    { threadId: "t2", matchedIn: "title" },
    { title: "no id" },
    null,
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { threadId: "t1", title: "Alpha", matchedIn: "conversation", snippet: "…hit…" });
  assert.equal(rows[1].matchedIn, "title");
  assert.equal(rows[1].snippet, null);
});

test("threadActions mirrors the host's honest action surface", () => {
  const running = threadActions(fixture[1], "t-new");
  assert.equal(running.canSwitch, false, "the active thread cannot switch to itself");
  assert.equal(running.canPause, true);
  assert.equal(running.canResume, false);
  assert.equal(running.canCancel, true);
  const paused = threadActions({ id: "t-p", status: "paused" }, "t-new");
  assert.equal(paused.canSwitch, true);
  assert.equal(paused.canResume, true);
  assert.equal(paused.canPause, false);
  const archived = threadActions(fixture[2], "t-new");
  assert.equal(archived.canSwitch, false);
  assert.equal(archived.canArchive, false);
  assert.equal(archived.canRestore, true);
  assert.equal(archived.canCancel, false);
  assert.equal(archived.canFork, true, "forking an archived thread is allowed provenance");
  const cancelled = threadActions({ id: "t-c", status: "cancelled" }, null);
  assert.equal(cancelled.canCancel, false);
  assert.deepEqual(threadActions(null).canDelete, false);
});

test("status sets stay disjoint so delete/cancel guards cannot both fire", () => {
  for (const status of TERMINAL_THREAD_STATUSES) assert.equal(LIVE_THREAD_STATUSES.has(status), false, status);
});
