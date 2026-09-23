// Rolling thread digest (T6-G2): make conversation truncation honest.
//
// compactInferenceMessages silently drops middle messages when a thread outgrows
// its prompt budget. This module derives a compact digest from exactly those
// dropped messages and reuses the SAME selection logic, so there is one source
// of truth for what the model sees. Digests are recomputed per send — cheap,
// stateless, persisted nowhere.

const {
  DEFAULT_CONVERSATION_MESSAGE_LIMIT,
  DEFAULT_CONVERSATION_CHAR_LIMIT,
  compactInferenceMessages,
  normalizeInferenceMessage,
} = require("./maple_runtime.cjs");

const DIGEST_MAX_LINES = 12;
const DIGEST_LINE_MAX_CHARS = 100;
const DIGEST_HEADER = (lines) => `[Earlier context digested · ${lines} points]`;

function firstSentence(content, maxChars = DIGEST_LINE_MAX_CHARS) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const match = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const sentence = (match ? match[0] : text).trim();
  return sentence.length > maxChars ? sentence.slice(0, maxChars) : sentence;
}

// buildDigest(droppedMessages) -> { summaryLines: string[], chars: int }
// One line per dropped message, capped at DIGEST_MAX_LINES. When more than 12
// messages were dropped the NEWEST 12 win (closest to the live conversation);
// lines are presented oldest-first.
function buildDigest(droppedMessages) {
  const dropped = (Array.isArray(droppedMessages) ? droppedMessages : [])
    .map(normalizeInferenceMessage)
    .filter(Boolean);
  // Walk newest-first so the livest context wins, skip exact duplicate lines
  // (repeated refusals, echoed prompts), and backfill from older drops so a
  // duplicated newest window does not shrink the digest below its cap.
  const lines = [];
  const seen = new Set();
  for (let index = dropped.length - 1; index >= 0 && lines.length < DIGEST_MAX_LINES; index -= 1) {
    const sentence = firstSentence(dropped[index].content);
    if (!sentence) continue;
    const line = `${dropped[index].role}: ${sentence}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.unshift(line);
  }
  return { summaryLines: lines, chars: lines.reduce((sum, line) => sum + line.length, 0) };
}

// applyDigestCompaction(messages, { maxMessages, maxChars })
//   -> { messages, digest|null }
//
// `messages` is byte-identical to plain compactInferenceMessages output for the
// same inputs (equivalence contract — the digest never changes selection).
// `digest` is non-null only when messages were actually dropped; its `block`
// field is a ready-to-inject system message body that fits inside the SAME
// maxChars budget (digest lines are trimmed from the oldest end if needed).
function applyDigestCompaction(messages, {
  maxMessages = DEFAULT_CONVERSATION_MESSAGE_LIMIT,
  maxChars = DEFAULT_CONVERSATION_CHAR_LIMIT,
} = {}) {
  const compacted = compactInferenceMessages(messages, { maxMessages, maxChars });
  const normalized = (Array.isArray(messages) ? messages : []).map(normalizeInferenceMessage).filter(Boolean);
  // Compaction normalizes into fresh objects AND reorders (the latest user
  // message moves to the end), so "kept" must be matched as a multiset of
  // role+content pairs, not by position. Anything whose count is not consumed
  // was dropped (fully, or partially via char-budget truncation — a truncated
  // kept copy never equals its source, so the source rightly lands here).
  const keyOf = (message) => `${message.role}\u0000${message.content}`;
  const keptCounts = new Map();
  for (const message of compacted) {
    const key = keyOf(message);
    keptCounts.set(key, (keptCounts.get(key) || 0) + 1);
  }
  const dropped = [];
  for (const message of normalized) {
    const key = keyOf(message);
    const remaining = keptCounts.get(key) || 0;
    if (remaining > 0) keptCounts.set(key, remaining - 1);
    else dropped.push(message);
  }
  if (!dropped.length) return { messages: compacted, digest: null };

  const { summaryLines } = buildDigest(dropped);
  if (!summaryLines.length) return { messages: compacted, digest: null };

  // Fit the digest block inside the same char budget the tail was chosen with.
  const used = compacted.reduce((sum, message) => sum + message.content.length, 0);
  const header = DIGEST_HEADER(summaryLines.length);
  const overhead = header.length + 1 + summaryLines.length; // newlines between lines
  let available = Math.max(0, maxChars - used - overhead);
  const fitLines = [];
  for (let index = summaryLines.length - 1; index >= 0; index -= 1) {
    const line = summaryLines[index];
    const cost = line.length + (fitLines.length ? 1 : 0);
    if (cost > available) break;
    available -= cost;
    fitLines.unshift(line);
  }
  if (!fitLines.length) return { messages: compacted, digest: null };

  const block = [header, ...fitLines].join("\n");
  return {
    messages: compacted,
    digest: {
      summaryLines: fitLines,
      droppedCount: dropped.length,
      chars: block.length,
      block,
    },
  };
}

// insertDigestBlock(messages, digest) -> messages
// Slots the synthetic digest system message after any leading system message,
// i.e. immediately BEFORE the retained tail. No-op when digest is null.
function insertDigestBlock(messages, digest) {
  if (!digest?.block || !Array.isArray(messages) || !messages.length) return messages;
  const lead = messages[0]?.role === "system" ? 1 : 0;
  const block = { role: "system", content: digest.block };
  return [...messages.slice(0, lead), block, ...messages.slice(lead)];
}

module.exports = {
  DIGEST_MAX_LINES,
  DIGEST_LINE_MAX_CHARS,
  buildDigest,
  applyDigestCompaction,
  insertDigestBlock,
  firstSentence,
};
