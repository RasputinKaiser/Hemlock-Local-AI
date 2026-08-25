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
