// Pure transcript search/filter for the Chat window: query normalization,
// per-row searchable text, kind filters, and match-segment splitting for
// highlight rendering. No React/DOM — testable with node:test like
// agentTimeline.js. Filtering only ever hides rows; nothing is reordered.

export const SEARCH_KINDS = ["all", "you", "model", "host"];

export function normalizeQuery(query) {
  return String(query || "").trim();
}

// Row-kind buckets used by the filter chips. System rows (host footnotes,
// stop notes) count as host chrome, not model output.
export function messageKind(message) {
  if (message?.role === "user") return "you";
  if (message?.role === "assistant") return "model";
  return "host";
}

// Everything a message row can plausibly show, joined for substring matching.
export function messageSearchText(message) {
  const parts = [message?.role, message?.provider, message?.content, message?.text, message?.displayMode];
  for (const channel of message?.channels || []) {
    parts.push(channel?.name, channel?.text, channel?.source);
  }
  return parts.filter((part) => typeof part === "string" && part).join("\n");
}

// Host events match on type, status, the rendered note, command ids, scalar
// payload values, and evidence refs — never on nested object blobs.
export function eventSearchText(event, note = "") {
  const payload = event?.payload || {};
  const action = payload.action || {};
  const parts = [
    event?.type, event?.status, note,
    payload.command, payload.commandId, payload.stage, payload.title, payload.error, payload.reason,
    action.commandId, action.kind, action.shortRationale,
  ];
  for (const [key, value] of Object.entries(payload)) {
    if (value == null || typeof value === "object") continue;
    parts.push(key, String(value));
  }
  for (const ref of event?.evidenceRefs || []) parts.push(ref);
  return parts.filter((part) => typeof part === "string" && part).join("\n");
}

export function matchesQuery(text, query) {
  const needle = normalizeQuery(query).toLowerCase();
  if (!needle) return true;
  return String(text || "").toLowerCase().includes(needle);
}

// Returns the sets the renderer intersects with its normal render order.
// `active` is false when neither a query nor a kind filter is set, so the
// caller can skip membership checks entirely on the common path. Event keys
// fall back to the event object itself when the host omitted an id.
export function filterTranscript({ messages = [], events = [], query = "", kind = "all", eventText = () => "" } = {}) {
  const needle = normalizeQuery(query);
  const wantedKind = SEARCH_KINDS.includes(kind) ? kind : "all";
  const active = Boolean(needle) || wantedKind !== "all";
  const messageIndexes = new Set();
  const eventIds = new Set();
  if (!active) {
    return { active: false, messageIndexes, eventIds, messageCount: messages.length, eventCount: events.length, total: messages.length + events.length };
  }
  messages.forEach((message, index) => {
    if ((wantedKind === "all" || messageKind(message) === wantedKind) && matchesQuery(messageSearchText(message), needle)) {
      messageIndexes.add(index);
    }
  });
  for (const event of events) {
    const kindOk = wantedKind === "all" || wantedKind === "host";
    if (kindOk && matchesQuery(eventSearchText(event, eventText(event)), needle)) {
      eventIds.add(event?.id ?? event);
    }
  }
  return {
    active: true,
    messageIndexes,
    eventIds,
    messageCount: messageIndexes.size,
    eventCount: eventIds.size,
    total: messageIndexes.size + eventIds.size,
  };
}

// Split text into match/non-match segments for <mark> rendering. Case-
// insensitive; overlapping matches are impossible because the cursor always
// advances past the previous hit.
export function highlightSegments(text, query) {
  const haystack = String(text ?? "");
  const needle = normalizeQuery(query).toLowerCase();
  if (!needle || !haystack) return [{ text: haystack, match: false }];
  const lower = haystack.toLowerCase();
  const segments = [];
  let cursor = 0;
  for (;;) {
    const found = lower.indexOf(needle, cursor);
    if (found === -1) break;
    if (found > cursor) segments.push({ text: haystack.slice(cursor, found), match: false });
    segments.push({ text: haystack.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }
  if (cursor < haystack.length) segments.push({ text: haystack.slice(cursor), match: false });
  return segments;
}
