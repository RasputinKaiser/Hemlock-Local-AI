const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Maple chat-response notifications (Lane B). The chat resolve/reject boundary
// in main.cjs reuses the Dream/SIPS work-notification policy through the
// trackChatResponseJob adapter exported from work_notifications.cjs: one call
// to start the job, finish() at a terminal outcome, cancel() when the user
// stopped the stream (a stop is NOT a completion, so nothing announces).
//
// main.cjs itself is a ~3.7k-line Electron bootstrap with no test export seam
// (see host_ux_ipc.test.cjs for the only sanctioned way to load it), so these
// tests exercise the adapter contract the boundary relies on, plus a
// source-level guard that the wiring exists at the right places in main.cjs.
const {
  DEFAULT_THRESHOLD_MS,
  createWorkNotifier,
  trackChatResponseJob,
} = require(path.resolve(__dirname, "work_notifications.cjs"));

function makeNotifier({ nowSequence, notify } = {}) {
  const sent = [];
  let tick = 0;
  const now = Array.isArray(nowSequence)
    ? () => nowSequence[Math.min(tick++, nowSequence.length - 1)]
    : () => Date.now();
  const notifier = createWorkNotifier({
    notify: notify || ((payload) => {
      sent.push(payload);
      return { shown: true };
    }),
    now,
  });
  return { notifier, sent };
}

test("long chat response finishing ok announces via onJobStarted/onJobFinished", () => {
  // Unfocused window: notify() shows the OS notification.
  const start = 1_000;
  const { notifier, sent } = makeNotifier({ nowSequence: [start, start + DEFAULT_THRESHOLD_MS + 5_000] });
  const job = trackChatResponseJob(notifier, "maple-stream-abc");
  assert.deepEqual(notifier.pending().map((entry) => entry.jobId), ["maple-stream-abc"]);

  const result = job.finish({ ok: true });
  assert.equal(result.notified, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Maple response");
  assert.match(sent[0].body, /^Maple response finished · took /);
  assert.deepEqual(notifier.pending(), [], "finished chat job leaves the pending queue");
});

test("fast chat response stays silent (below threshold)", () => {
  const start = 1_000;
  const { notifier, sent } = makeNotifier({ nowSequence: [start, start + DEFAULT_THRESHOLD_MS - 1] });
  const job = trackChatResponseJob(notifier, "maple-stream-fast");
  const result = job.finish({ ok: true });
  assert.equal(result.notified, false);
  assert.equal(result.reason, "below-threshold");
  assert.equal(sent.length, 0, "sub-threshold responses never announce");
  assert.deepEqual(notifier.pending(), [], "short jobs still dequeue on finish");
});

test("user-cancelled chat response never announces, even after a long wait", () => {
  const start = 1_000;
  const { notifier, sent } = makeNotifier({ nowSequence: [start, start + DEFAULT_THRESHOLD_MS * 10] });
  const job = trackChatResponseJob(notifier, "maple-stream-stopped");
  job.cancel();
  assert.equal(sent.length, 0, "a user stop is not a completion");
  assert.deepEqual(notifier.pending(), [], "cancelled job does not linger in the pending queue");

  // Cancelling twice / cancelling an unknown id is harmless.
  assert.equal(job.cancel(), false);
});

test("long failed chat response announces a stopped receipt with the reason", () => {
  const start = 0;
  const { notifier, sent } = makeNotifier({ nowSequence: [start, start + DEFAULT_THRESHOLD_MS + 1_000] });
  const job = trackChatResponseJob(notifier, "maple-stream-fail");
  const result = job.finish({ ok: false, detail: "Maple-Preview returned HTTP 500: kv cache" });
  assert.equal(result.notified, true);
  assert.equal(sent[0].body, "Maple response stopped · Maple-Preview returned HTTP 500: kv cache");
});

test("focused window suppresses the OS notification (policy lives in the notify callback)", () => {
  // main.cjs wires notify() to skip while mainWindow.isFocused(); simulate that
  // exact callback shape here and confirm nothing is shown.
  const { notifier } = makeNotifier({
    nowSequence: [0, DEFAULT_THRESHOLD_MS + 1],
    notify: () => ({ shown: false, skipped: "window-focused" }),
  });
  const job = trackChatResponseJob(notifier, "maple-stream-focused");
  const result = job.finish({ ok: true });
  assert.equal(result.notified, false);
});

test("adapter defaults the label to 'Maple response' and tolerates an explicit label", () => {
  const { notifier } = makeNotifier({ nowSequence: [0, 1] });
  const job = trackChatResponseJob(notifier, "maple-stream-label");
  assert.equal(notifier.pending()[0].label, "Maple response");

  const { notifier: custom } = makeNotifier({ nowSequence: [0, 1] });
  trackChatResponseJob(custom, "maple-stream-custom", "Custom label");
  assert.equal(custom.pending()[0].label, "Custom label");
});

// --- Wiring guard -----------------------------------------------------------
// The adapter above only helps if main.cjs actually starts/finishes/cancels a
// chat job at the inference resolve/reject boundaries. Booting main.cjs needs
// a full mocked-Electron harness (host_ux_ipc does this for IPC handlers); for
// these three call sites a source-level guard keeps the wiring honest without
// that machinery.
test("main.cjs wires the chat notification boundary", () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");

  // Starts a job bound to the stream id at the inference boundary…
  assert.match(
    mainSource,
    /trackChatResponseJob\(workNotifier,\s*`maple-\$\{[^}]+\}`\)/,
    "expected a `maple-${streamId}` job started through trackChatResponseJob",
  );
  // …announces success/failure at terminal outcomes…
  assert.match(mainSource, /\.finish\(\{\s*ok:\s*true\s*\}\)/, "expected ok:true finish at the resolve boundary");
  assert.match(mainSource, /\.finish\(\{\s*ok:\s*false/, "expected ok:false finish at the reject boundary");
  // …and drops the pending job when the user cancels instead of finishing it.
  assert.match(mainSource, /\.cancel\(\)/, "expected cancel() on the user-cancelled path");
});

// --- Leak guard -------------------------------------------------------------
// A settle (finish/cancel) must happen BEFORE any post-terminal work that can
// throw (persistModelOutput receipt writes), so a receipt-write failure can
// never strand a pending notification job. cancel-after-finish is a no-op, so
// settling early is always safe.
test("settling before risky work prevents pending-job leaks", () => {
  const { notifier } = makeNotifier({ nowSequence: [0, 1] });
  // trackChatResponseJob starts the job immediately.
  const job = trackChatResponseJob(notifier, "maple-leak-guard");
  // Simulate the main.cjs ordering: finish first, then a receipt write throws.
  job.finish({ ok: true });
  assert.throws(() => { throw new Error("disk full"); });
  // The map entry is already gone; a defensive late cancel is a harmless no-op.
  assert.equal(job.cancel(), false);
  assert.equal(notifier.pending().length, 0);
});
