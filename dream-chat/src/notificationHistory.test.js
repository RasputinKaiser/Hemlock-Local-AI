import test from "node:test";
import assert from "node:assert/strict";
import { NOTIFICATION_HISTORY_LIMIT, notificationHistory } from "./notificationHistory.js";

const at = (ms) => new Date(ms).toISOString();

test("terminal work events become history rows with event timestamps and routing", () => {
  const events = [
    { id: "e1", type: "command.started", status: "running", createdAt: at(1000), payload: {} },
    { id: "e2", type: "sips.cycle.completed", status: "passed", createdAt: at(2000), payload: { summary: "cycle done" } },
    { id: "e3", type: "dream.failed", status: "failed", createdAt: at(3000), payload: { error: "mlx died" } },
  ];
  const items = notificationHistory(events);
  assert.equal(items.length, 2, "non-terminal events stay out of history");
  assert.equal(items[0].eventId, "e3", "newest first");
  assert.equal(items[0].title, "Dream run failed");
  assert.equal(items[0].tone, "warn");
  assert.equal(items[0].windowId, "dream");
  assert.equal(items[0].body, "mlx died");
  assert.equal(items[0].at, 3000, "rows are stamped with the event's own time");
  assert.equal(items[1].windowId, "sips");
  assert.equal(items[1].status, "passed");
});

test("history survives what would have expired or been dismissed as a toast", () => {
  const events = [
    { id: "old", type: "task.completed", status: "completed", createdAt: at(1000), payload: {} },
    { id: "new", type: "task.blocked", status: "blocked", createdAt: at(999999), payload: { reason: "needs review" } },
  ];
  const items = notificationHistory(events);
  assert.deepEqual(items.map((item) => item.eventId), ["new", "old"], "expired toasts remain in the record");
  assert.equal(items[0].body, "needs review");
});

test("the list is bounded, defensive, and deduped by event id only as given", () => {
  assert.deepEqual(notificationHistory(null), []);
  assert.deepEqual(notificationHistory("nope"), []);
  const events = Array.from({ length: NOTIFICATION_HISTORY_LIMIT + 10 }, (_, index) => ({
    id: `e${index}`, type: "task.completed", status: "completed", createdAt: at(index * 1000), payload: {},
  }));
  const items = notificationHistory(events);
  assert.equal(items.length, NOTIFICATION_HISTORY_LIMIT);
  assert.equal(items[0].eventId, `e${NOTIFICATION_HISTORY_LIMIT + 9}`);
  assert.equal(notificationHistory(events, { limit: 2 }).length, 2);
});
