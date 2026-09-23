// Durable notice stack for ArtifactStudio — a single overwritten status line
// loses action feedback to preview console traffic, so we keep the last few.

export const MAX_NOTICES = 3;

let sequence = 0;

export function pushNotice(list, entry, max = MAX_NOTICES) {
  const text = String(entry?.text ?? entry ?? "").trim();
  if (!text) return Array.isArray(list) ? list : [];
  const current = Array.isArray(list) ? list : [];
  // Consecutive duplicates (repeated console noise) update in place.
  if (current[0]?.text === text) {
    return [{ ...current[0], at: entry?.at || Date.now(), count: (current[0].count || 1) + 1 }, ...current.slice(1)];
  }
  sequence += 1;
  const notice = {
    id: entry?.id || `notice-${Date.now()}-${sequence}`,
    text,
    tone: entry?.tone || "info",
    at: entry?.at || Date.now(),
    count: 1,
  };
  return [notice, ...current].slice(0, Math.max(1, max));
}

export function dismissNotice(list, id) {
  return (Array.isArray(list) ? list : []).filter((notice) => notice.id !== id);
}
