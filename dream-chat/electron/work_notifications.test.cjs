const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Pure policy helpers — no mocks needed for the logic under test.
const {
  DEFAULT_THRESHOLD_MS,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NOTIFICATION_BODY_MAX_LENGTH,
  clampText,
  shouldNotify,
  formatDuration,
  createWorkNotifier,
} = require(path.resolve(__dirname, "work_notifications.cjs"));

test("shouldNotify threshold boundary cases", () => {
  // Inclusive threshold: exactly at threshold counts as long enough.
  assert.equal(shouldNotify(DEFAULT_THRESHOLD_MS - 1, DEFAULT_THRESHOLD_MS), false, "just under threshold stays silent");
  assert.equal(shouldNotify(DEFAULT_THRESHOLD_MS, DEFAULT_THRESHOLD_MS), true, "exactly at threshold notifies");
  assert.equal(shouldNotify(DEFAULT_THRESHOLD_MS * 10, DEFAULT_THRESHOLD_MS), true, "well over threshold notifies");
  // Degenerate inputs never notify.
  assert.equal(shouldNotify(NaN), false);
  assert.equal(shouldNotify(undefined), false);
  assert.equal(shouldNotify(-1, DEFAULT_THRESHOLD_MS), false);
});

test("formatDuration formats seconds, minutes+seconds, and hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(3_600_000), "1h 0m");
  assert.equal(formatDuration(7_530_000), "2h 5m"); // 2h 5m 30s -> seconds dropped
  assert.equal(formatDuration(120_000), "2m");
});

function makeNotifier({ nowSequence, config } = {}) {
  const sent = [];
  let tick = 0;
  const now = Array.isArray(nowSequence) ? () => nowSequence[Math.min(tick++, nowSequence.length - 1)] : () => Date.now();
  const notifier = createWorkNotifier({
    notify: (payload) => {
      sent.push(payload);
      return { shown: true };
    },
    now,
    config,
  });
  return { notifier, sent };
}

test("long job finish emits success title/body with duration", () => {
  const { notifier, sent } = makeNotifier({ nowSequence: [1_000, 91_000] }); // 90s run
  const started = notifier.onJobStarted("job-1", "Dream training");
  assert.equal(started.label, "Dream training");

  const result = notifier.onJobFinished("job-1", { ok: true });
  assert.equal(result.notified, true);
  assert.equal(sent.length, 1);
  const { title, body } = sent[0];
  assert.equal(typeof title, "string");
  assert.ok(title.length <= NOTIFICATION_TITLE_MAX_LENGTH);
  assert.equal(title, "Dream training");
  assert.ok(body.length <= NOTIFICATION_BODY_MAX_LENGTH);
  assert.equal(body, "Dream training finished · took 1m 30s");
  assert.deepEqual(notifier.pending(), [], "finished job leaves the pending queue");
});

test("long job failure emits stopped body with reason", () => {
  const { notifier, sent } = makeNotifier({ nowSequence: [0, 65_000] }); // 65s run
  notifier.onJobStarted("job-2", "SIPS cycle · fix login bug");
  const result = notifier.onJobFinished("job-2", { ok: false, detail: "exit code 1" });

  assert.equal(result.notified, true);
  assert.deepEqual(sent[0], {
    title: "SIPS cycle · fix login bug",
    body: "SIPS cycle · fix login bug stopped · exit code 1",
  });
});

test("failure with no detail falls back to a reason instead of trailing separator", () => {
  const { notifier, sent } = makeNotifier({ nowSequence: [0, 60_000] });
  notifier.onJobStarted("job-3", "Dream training");
  notifier.onJobFinished("job-3", { ok: false });
  assert.equal(sent[0].body, "Dream training stopped · unknown reason");
});

test("jobs under threshold produce NO notification but still dequeue", () => {
  const { notifier, sent } = makeNotifier({ nowSequence: [0, 29_999] });
  notifier.onJobStarted("short-job", "Dream training");
  const result = notifier.onJobFinished("short-job", { ok: true });

  assert.equal(result.notified, false);
  assert.equal(result.reason, "below-threshold");
  assert.equal(sent.length, 0, "no notification for short jobs");
  assert.deepEqual(notifier.pending(), [], "short jobs still leave the queue on finish");
});

test("finish without start is handled gracefully", () => {
  const { notifier, sent } = makeNotifier();
  const result = notifier.onJobFinished("ghost-job", { ok: true });

  assert.equal(result.notified, false);
  assert.equal(result.reason, "unknown-job");
  assert.equal(sent.length, 0);
  assert.doesNotThrow(() => notifier.onJobFinished(null));
});

test("config.thresholdMs overrides the default threshold", () => {
  const { notifier, sent } = makeNotifier({ nowSequence: [0, 5_000], config: { thresholdMs: 4_000 } });
  notifier.onJobStarted("quick", "Tiny task");
  assert.equal(notifier.onJobFinished("quick", { ok: true }).notified, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "Tiny task finished · took 5s");

  const { notifier: strict, sent: strictSent } = makeNotifier({ nowSequence: [0, 5_000], config: { thresholdMs: 6_000 } });
  strict.onJobStarted("slow-threshold", "Tiny task");
  assert.equal(strict.onJobFinished("slow-threshold", { ok: true }).notified, false);
  assert.equal(strictSent.length, 0);
});

test("clamping matches notification:show length rules", () => {
  const longLabel = "x".repeat(NOTIFICATION_TITLE_MAX_LENGTH + 40);
  assert.equal(clampText(longLabel, NOTIFICATION_TITLE_MAX_LENGTH).length, NOTIFICATION_TITLE_MAX_LENGTH);

  const { notifier, sent } = makeNotifier({ nowSequence: [0, DEFAULT_THRESHOLD_MS + 1] });
  notifier.onJobStarted("big", `  ${longLabel}   `);
  notifier.onJobFinished("big", { ok: false, detail: "y".repeat(NOTIFICATION_BODY_MAX_LENGTH + 100) });

  assert.ok(sent[0].title.length <= NOTIFICATION_TITLE_MAX_LENGTH);
  assert.ok(sent[0].body.length <= NOTIFICATION_BODY_MAX_LENGTH);
  assert.ok(!sent[0].body.includes("\n"), "whitespace is collapsed");
});

test("createWorkNotifier requires a notify function and duplicate starts replace cleanly", () => {
  assert.throws(() => createWorkNotifier({}), /requires a notify/);

  const { notifier, sent } = makeNotifier({ nowSequence: [0, 40_000, 80_000] });
  notifier.onJobStarted("dup", "First label");
  notifier.onJobStarted("dup", "Second label");
  const pending = notifier.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].label, "Second label", "latest start wins");
  assert.equal(notifier.onJobFinished("dup", { ok: true }).notified, true);
  assert.equal(sent[0].body, "Second label finished · took 40s");
});
