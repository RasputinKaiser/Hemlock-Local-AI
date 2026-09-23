// Pure grouping for the Chat evidence ledger: collapses repetitive receipt
// rows into one compact row per event-type prefix (e.g. "command.run" and
// "command.failed" -> "command"). Kept free of React/DOM so it is testable
// with node:test like windowManager.js.
function timestampOf(event) {
  const ms = new Date(event?.createdAt || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function groupEvidence(receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  const groups = new Map();
  for (const event of list) {
    if (!event) continue;
    const prefix = String(event.type || "event").split(".")[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(event);
  }
  return [...groups.entries()]
    .map(([prefix, items]) => {
      const ordered = items.slice().sort((a, b) => timestampOf(b) - timestampOf(a));
      return { prefix, count: ordered.length, latest: ordered[0], items: ordered };
    })
    .sort((a, b) => timestampOf(b.latest) - timestampOf(a.latest));
}

// Which window can show the underlying evidence for an event or receipt?
// Receipts deep-links out only when the match is unambiguous — an unmatched
// ref returns null and the row stays in Receipts, which is itself evidence.
export const RECEIPT_TARGET_LABELS = {
  grove: "Grove",
  dream: "Dream Lab",
  sips: "SIPS Control",
  activity: "Activity",
  memory: "Memory Garden",
  artifact: "Artifact Studio",
};

export function receiptTargetWindow(input) {
  const { type = "", refs = [] } = input || {};
  const haystack = `${type} ${(Array.isArray(refs) ? refs : [refs]).join(" ")}`.toLowerCase();
  if (!haystack.trim()) return null;
  if (/experiment|world\.|world_|grove|physics/.test(haystack)) return "grove";
  if (/dream|adapter|training|graft|checkpoint/.test(haystack)) return "dream";
  if (/sips|selfloop|self-loop/.test(haystack)) return "sips";
  if (/shell|exec|console|command/.test(haystack)) return "activity";
  if (/memory|lesson|recall/.test(haystack)) return "memory";
  if (/artifact|preview|change[-_]?set/.test(haystack)) return "artifact";
  return null;
}
