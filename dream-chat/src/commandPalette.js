// Command palette plumbing: pure scoring, grouping, and recent tracking.
// No DOM and no React — the shell wires these into the palette markup.

export const PALETTE_RECENT_KEY = "hemlock.palette.recent";
export const PALETTE_RECENT_LIMIT = 4;

function resolveStorage(storage) {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

// Spotlight-style subsequence score: every non-space query character must
// appear in order inside the haystack. Contiguous runs and word-start hits
// earn bonuses; an earlier first hit and a tighter length gap rank higher.
// Returns null when the query is not a subsequence of the text.
export function fuzzyScore(query, text) {
  const needle = String(query || "").toLowerCase().replace(/\s+/g, "");
  const haystack = String(text || "").toLowerCase();
  if (!needle) return 0;
  if (needle.length > haystack.length) return null;
  let score = 0;
  let cursor = 0;
  let run = 0;
  let firstHit = -1;
  for (const char of needle) {
    const at = haystack.indexOf(char, cursor);
    if (at < 0) return null;
    if (firstHit >= 0 && at === cursor) { run += 1; score += 6 + run; } else run = 0;
    if (at === 0 || /[\s\-_/.·:]/.test(haystack[at - 1])) score += 4;
    score += 1;
    if (firstHit < 0) firstHit = at;
    cursor = at + 1;
  }
  score += Math.max(0, 16 - firstHit);
  score += Math.max(0, 8 - (haystack.length - needle.length) / 24);
  return score;
}

export function fuzzyMatch(query, text) {
  return fuzzyScore(query, text) !== null;
}

// Filter and rank one section's items against a query. Items flagged
// `bypassFilter` (backend-verified content matches) skip local scoring and
// trail the scored rows — the backend already decided they match, and a
// truncated snippet could otherwise drop a real hit.
export function rankSectionItems(items, query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [...items];
  const scored = [];
  const bypassed = [];
  items.forEach((item, index) => {
    if (item?.bypassFilter) { bypassed.push(item); return; }
    const score = fuzzyScore(trimmed, `${item.label} ${item.hint || ""}`);
    if (score !== null) scored.push({ item, index, score });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return [...scored.map((entry) => entry.item), ...bypassed];
}

// Assemble the rendered groups. With an empty query a RECENT section leads
// (resolved against the live catalog so actions never go stale) and its items
// are lifted out of their home sections instead of duplicated. With a query,
// recents hide and every section is fuzzy-ranked.
export function buildPaletteGroups(sections, { query = "", recentIds = [] } = {}) {
  const trimmed = String(query || "").trim();
  const groups = [];
  const recentShown = new Set();
  if (!trimmed && recentIds.length) {
    const catalog = new Map((sections || []).flatMap((section) => (section.items || []).map((item) => [item.id, item])));
    const recentItems = recentIds.map((id) => catalog.get(id)).filter(Boolean).slice(0, PALETTE_RECENT_LIMIT);
    if (recentItems.length) {
      recentItems.forEach((item) => recentShown.add(item.id));
      groups.push({ id: "recent", label: "RECENT", items: recentItems });
    }
  }
  for (const section of sections || []) {
    const items = rankSectionItems((section.items || []).filter((item) => !recentShown.has(item.id)), trimmed);
    if (items.length) groups.push({ ...section, items });
  }
  return groups;
}

export function readRecentCommands(storage) {
  const store = resolveStorage(storage);
  try {
    const value = JSON.parse(store?.getItem(PALETTE_RECENT_KEY) || "null");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id).slice(0, PALETTE_RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

// Records a pick and returns the fresh list so the caller can keep it in
// React state. Most recent first, deduped, capped at the section limit.
export function recordRecentCommand(id, storage) {
  const store = resolveStorage(storage);
  const next = [id, ...readRecentCommands(store).filter((item) => item !== id)].slice(0, PALETTE_RECENT_LIMIT);
  try { store?.setItem(PALETTE_RECENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}
