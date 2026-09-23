import test from "node:test";
import assert from "node:assert/strict";
import {
  PALETTE_RECENT_KEY,
  PALETTE_RECENT_LIMIT,
  buildPaletteGroups,
  fuzzyMatch,
  fuzzyScore,
  rankSectionItems,
  readRecentCommands,
  recordRecentCommand,
} from "./commandPalette.js";

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    data,
  };
}

const item = (id, label, hint = "", extra = {}) => ({ id, label, hint, ...extra });
const section = (id, items) => ({ id, label: id.toUpperCase(), items });

test("fuzzyScore requires every non-space query character in order", () => {
  assert.equal(fuzzyScore("xyz", "New thread"), null);
  assert.equal(fuzzyScore("tn", "New thread"), null, "characters out of order do not match");
  assert.ok(fuzzyScore("nt", "New thread") !== null);
  assert.equal(fuzzyScore("", "anything"), 0);
  assert.equal(fuzzyScore("   ", "anything"), 0, "whitespace-only queries match everything");
});

test("fuzzyScore rewards contiguous runs and word starts over scattered hits", () => {
  const contiguous = fuzzyScore("art", "Artifact Studio");
  const scattered = fuzzyScore("art", "a great tree");
  assert.ok(scattered !== null, "scattered subsequence still matches");
  assert.ok(contiguous > scattered, "contiguous beats scattered");
  const wordStart = fuzzyScore("map", "Map the project");
  const midWord = fuzzyScore("map", "Remap receipts");
  assert.ok(wordStart > midWord, "word-start hit beats mid-word hit");
  assert.ok(fuzzyScore("Map", "map the project") !== null, "matching is case-insensitive");
});

test("rankSectionItems orders by score and keeps a stable order on ties", () => {
  const items = [item("a", "Chat"), item("b", "Open map"), item("c", "Map the project")];
  const ranked = rankSectionItems(items, "map");
  assert.deepEqual(ranked.map((entry) => entry.id), ["c", "b"], "unmatched items drop out, best score first");
  const ties = rankSectionItems([item("x", "Open chat"), item("y", "Open map")], "");
  assert.deepEqual(ties.map((entry) => entry.id), ["x", "y"], "empty query preserves the authored order");
});

test("rankSectionItems lets backend-verified matches bypass local scoring", () => {
  const items = [item("a", "Alpha"), item("deep", "Thread content match", "matches · snippet", { bypassFilter: true })];
  const ranked = rankSectionItems(items, "zzz-no-local-hit");
  assert.deepEqual(ranked.map((entry) => entry.id), ["deep"]);
  const mixed = rankSectionItems([item("a", "Alpha run"), item("deep", "Content row", "", { bypassFilter: true })], "alp");
  assert.deepEqual(mixed.map((entry) => entry.id), ["a", "deep"], "scored rows lead, bypassed rows trail");
});

test("buildPaletteGroups leads with resolved recents and lifts them out of home sections", () => {
  const sections = [
    section("surfaces", [item("surface-chat", "Chat"), item("surface-map", "Project Map")]),
    section("actions", [item("action-verify", "Run UI verification"), item("action-map", "Map the project")]),
  ];
  const groups = buildPaletteGroups(sections, { recentIds: ["action-map", "surface-chat", "gone-id"] });
  assert.equal(groups[0].id, "recent");
  assert.deepEqual(groups[0].items.map((entry) => entry.id), ["action-map", "surface-chat"], "recents keep most-recent-first order and skip dead ids");
  assert.deepEqual(groups.find((group) => group.id === "actions").items.map((entry) => entry.id), ["action-verify"], "recent items are not duplicated in their section");
  assert.deepEqual(groups.find((group) => group.id === "surfaces").items.map((entry) => entry.id), ["surface-map"]);
});

test("buildPaletteGroups hides recents under a query and fuzzy-ranks each section", () => {
  const sections = [section("actions", [item("action-verify", "Run UI verification"), item("action-map", "Map the project")])];
  const groups = buildPaletteGroups(sections, { query: "verif", recentIds: ["action-map"] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "actions");
  assert.deepEqual(groups[0].items.map((entry) => entry.id), ["action-verify"]);
});

test("recent commands persist, dedupe, and cap at the section limit", () => {
  const storage = memoryStorage();
  assert.deepEqual(readRecentCommands(storage), []);
  recordRecentCommand("a", storage);
  recordRecentCommand("b", storage);
  recordRecentCommand("a", storage);
  assert.deepEqual(readRecentCommands(storage), ["a", "b"], "re-picks float to the front without duplicating");
  for (const id of ["c", "d", "e", "f"]) recordRecentCommand(id, storage);
  const stored = readRecentCommands(storage);
  assert.equal(stored.length, PALETTE_RECENT_LIMIT);
  assert.equal(stored[0], "f");
  assert.equal(JSON.parse(storage.data[PALETTE_RECENT_KEY]).length, PALETTE_RECENT_LIMIT, "storage never grows past the cap");
});

test("recent storage degrades honestly when unavailable or corrupt", () => {
  assert.deepEqual(readRecentCommands(memoryStorage({ [PALETTE_RECENT_KEY]: "{not json" })), []);
  assert.deepEqual(readRecentCommands(memoryStorage({ [PALETTE_RECENT_KEY]: JSON.stringify({ nope: 1 }) })), []);
  assert.deepEqual(readRecentCommands(null), []);
  assert.deepEqual(recordRecentCommand("a", null), ["a"], "the pick list still updates for this session");
});
