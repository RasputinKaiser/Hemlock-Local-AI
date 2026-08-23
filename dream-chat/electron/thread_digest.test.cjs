const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DIGEST_MAX_LINES,
  buildDigest,
  applyDigestCompaction,
  insertDigestBlock,
} = require("./thread_digest.cjs");
const { compactInferenceMessages, normalizeInferenceMessage } = require("./maple_runtime.cjs");

function droppedContents(thread, compacted) {
  const normalized = thread.map(normalizeInferenceMessage).filter(Boolean);
  // Compaction reorders (latest user + trailing messages move to the end), so
  // match kept messages as a multiset of role+content pairs, not by position.
  const keptCounts = new Map();
  for (const message of compacted) {
    const key = `${message.role}\u0000${message.content}`;
    keptCounts.set(key, (keptCounts.get(key) || 0) + 1);
  }
  const dropped = [];
  for (const message of normalized) {
    const key = `${message.role}\u0000${message.content}`;
    const remaining = keptCounts.get(key) || 0;
    if (remaining > 0) keptCounts.set(key, remaining - 1);
    else dropped.push(message.content);
  }
  return new Set(dropped);
}

function msg(role, content) {
  return { role, content };
}

// A thread guaranteed to overflow the default message limit (16).
function longThread(turns = 30) {
  const messages = [msg("system", "You are Hemlock.")];
  for (let i = 0; i < turns; i += 1) {
    messages.push(msg("user", `Question number ${i}. Extra detail follows here.`));
    messages.push(msg("assistant", `Answer number ${i}. More elaboration text.`));
  }
  return messages;
}

test("buildDigest: empty / garbage input yields empty digest", () => {
  assert.deepEqual(buildDigest([]), { summaryLines: [], chars: 0 });
  assert.deepEqual(buildDigest(undefined), { summaryLines: [], chars: 0 });
  assert.deepEqual(buildDigest("not an array"), { summaryLines: [], chars: 0 });
  assert.deepEqual(buildDigest([null, {}, { role: "banana", content: "x" }, { role: "user", content: "   " }]), { summaryLines: [], chars: 0 });
});

test("buildDigest: one line per dropped message with role + first sentence", () => {
  const digest = buildDigest([
    msg("user", "What is the deploy order? Then we wait."),
    msg("assistant", "Build first. Then verify."),
  ]);
  assert.deepEqual(digest.summaryLines, [
    "user: What is the deploy order?",
    "assistant: Build first.",
  ]);
  assert.equal(digest.chars, digest.summaryLines.reduce((sum, line) => sum + line.length, 0));
});

test("buildDigest: lines are capped at 12, newest-wins among dropped", () => {
  const dropped = [];
  for (let i = 0; i < 20; i += 1) dropped.push(msg("user", `Point ${i} here.`));
  const digest = buildDigest(dropped);
  assert.equal(digest.summaryLines.length, DIGEST_MAX_LINES);
  // Oldest-first within the cap, and the oldest 8 were trimmed away.
  assert.match(digest.summaryLines[0], /^user: Point 8 here\.$/);
  assert.match(digest.summaryLines[11], /^user: Point 19 here\.$/);
});

test("buildDigest: sentences longer than 100 chars are truncated to 100", () => {
  const long = "a".repeat(250);
  const digest = buildDigest([msg("assistant", long)]);
  assert.deepEqual(digest.summaryLines, [`assistant: ${"a".repeat(100)}`]);
});

test("applyDigestCompaction: no drop -> null digest and identical messages", () => {
  const shortThread = [msg("system", "sys"), msg("user", "hi"), msg("assistant", "hello")];
  const result = applyDigestCompaction(shortThread);
  assert.equal(result.digest, null);
  assert.deepEqual(result.messages, compactInferenceMessages(shortThread));
});

test("applyDigestCompaction: drop -> digest lines match dropped messages' first sentences", () => {
  const thread = longThread(30);
  const result = applyDigestCompaction(thread);
  assert.ok(result.digest, "expected a digest for an overflowing thread");

  const expectedDroppedCount = thread.length - result.messages.length;
  // Dropped turns that survive the 12-line cap are summarized; the digest
  // covers a prefix window of what was lost.
  assert.ok(result.digest.summaryLines.length >= 1);
  assert.ok(result.digest.summaryLines.length <= Math.min(DIGEST_MAX_LINES, expectedDroppedCount));
  assert.equal(result.digest.droppedCount, expectedDroppedCount);

  const droppedSet = droppedContents(thread, result.messages);
  const lastDigestLine = result.digest.summaryLines[result.digest.summaryLines.length - 1];
  // Compare against the full first sentence (with its period), matching how
  // the module builds lines via firstSentence().
  const matchedContent = [...droppedSet].find((content) => {
    const match = String(content).match(/^[\s\S]*?[.!?](?=\s|$)/);
    const sentence = (match ? match[0] : String(content)).trim();
    return lastDigestLine.endsWith(sentence);
  });
  assert.ok(matchedContent, "last digest line should correspond to a dropped message's first sentence");
});

test("applyDigestCompaction: messages output is equivalent to plain compaction (same inputs)", () => {
  for (const thread of [longThread(9), longThread(30), [msg("user", "only user")], []]) {
    for (const opts of [{}, { maxMessages: 4, maxChars: 500 }]) {
      const result = applyDigestCompaction(thread, opts);
      assert.deepEqual(result.messages, compactInferenceMessages(thread, opts));
    }
  }
});

test("digest block fits inside the same maxChars budget", () => {
  const thread = longThread(30);
  const opts = { maxMessages: 6, maxChars: 900 };
  const result = applyDigestCompaction(thread, opts);
  if (!result.digest) return;
  const withBlock = insertDigestBlock(result.messages, result.digest);
  const total = withBlock.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= opts.maxChars, `total ${total} exceeded budget ${opts.maxChars}`);
  assert.ok(withBlock.some((message) => message.content.startsWith("[Earlier context digested ·")));
});

test("insertDigestBlock: slots after leading system message, before the tail", () => {
  const thread = longThread(30);
  const result = applyDigestCompaction(thread);
  assert.ok(result.digest);
  const withBlock = insertDigestBlock(result.messages, result.digest);
  assert.equal(withBlock[0].role, "system");
  assert.match(withBlock[1].content, /^\[Earlier context digested · \d+ points\]\n/);
  assert.deepEqual(
    withBlock.slice(2),
    result.messages.slice(result.messages[0]?.role === "system" ? 1 : 0),
  );
});

test("insertDigestBlock: no-op without digest or empty input", () => {
  const messages = [msg("user", "hi")];
  assert.deepEqual(insertDigestBlock(messages, null), messages);
  assert.deepEqual(insertDigestBlock([], null), []);
});
