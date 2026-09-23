import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guide ↔ binding parity. Both directions are checked at the source level:
// every chord the guide prints must have a backing handler, and every literal
// key binding in the global/dock/model-picker/transcript handlers must be
// either documented in the guide or covered by an annotated affordance (the
// per-app ⌘digit list, the "Escape dismisses overlays" intro).

const guide = readFileSync(new URL("./ShortcutGuide.jsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../main.jsx", import.meta.url), "utf8");
const chat = readFileSync(new URL("../windows/ChatWindow.jsx", import.meta.url), "utf8");
const frame = readFileSync(new URL("./WindowFrame.jsx", import.meta.url), "utf8");
const copyButton = readFileSync(new URL("./CopyMessageButton.jsx", import.meta.url), "utf8");

function region(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  assert.ok(start >= 0, `missing region start: ${startToken}`);
  const end = source.indexOf(endToken, start);
  assert.ok(end > start, `missing region end after ${startToken}: ${endToken}`);
  return source.slice(start, end);
}

// The shell's global key handler (⌘ chords, window tiling, Escape).
const globalKeys = region(main, "const onKeyDown = (event) => {", 'document.addEventListener("keydown", onKeyDown)');
// The model-picker chord lives in its own listener (⌘⇧M).
const modelKeys = region(main, "const onShortcut = (event) => {", 'window.addEventListener("keydown", onShortcut)');
// The dock's own arrow-key / menu-key navigation.
const dockKeys = region(main, 'aria-label="Hemlock surfaces" onKeyDown', "dockApps(WINDOW_META");
// Chat transcript filter chord (⌘F) lives in the window's own surface handler.
const chatKeys = region(chat, "ref={surfaceRef} onKeyDown", "setSearchOpen(true)");

// Every literal `key === "X"` / `shortcutKey === "x"` in a handler must be
// explained by the guide. The map value is the exact guide token (or a note
// that the affordance is documented by another element of the guide).
const LITERAL_COVERAGE = {
  F1: "F1",
  d: "⌘⌥D",
  w: "⌘W",
  o: "⌘⇧O",
  k: "⌘K",
  "`": "⌘`",
  ArrowLeft: "⌘⌥←",
  ArrowRight: "⌘⌥→",
  ArrowUp: "⌘⌥↑",
  ArrowDown: "⌘⌥↓",
  m: null, // ⌘⌥M minimize and ⌘⇧M model picker share the literal — asserted separately below
  f: "⌘F",
  Escape: "Escape dismisses overlays",
  ContextMenu: "window actions menu",
  F10: "Shift+F10",
  Home: "← →",
  End: "← →",
};

test("every literal key binding in the shell handlers is documented", () => {
  const literals = new Set();
  for (const source of [globalKeys, modelKeys, dockKeys, chatKeys]) {
    for (const match of source.matchAll(/(?:event\.key|shortcutKey)(?:\.toLowerCase\(\))? === "([^"]+)"/g)) literals.add(match[1]);
    for (const match of source.matchAll(/event\.key === "([^"]+)"/g)) literals.add(match[1]);
  }
  for (const key of literals) {
    assert.ok(Object.hasOwn(LITERAL_COVERAGE, key), `key binding "${key}" has no guide coverage entry — document it or extend LITERAL_COVERAGE`);
    const token = LITERAL_COVERAGE[key];
    if (token) assert.ok(guide.includes(token), `guide does not mention ${token} (binding "${key}")`);
  }
});

test("documented chords are backed by real handlers", () => {
  // ⌘digit app jumps render from APP_SHORTCUTS in the guide itself.
  assert.ok(guide.includes("APP_SHORTCUTS"), "guide lost its per-app ⌘digit list");
  assert.match(main, /\/\^\[0-9\]\$\/\.test\(event\.key\)[\s\S]*?shortcutApp\(event\.key\)/);
  // Palette quick-pick digits (documented as ⌘1–9).
  assert.ok(guide.includes("⌘1–9"));
  assert.match(main, /metaKey \|\| event\.ctrlKey\) && \/\^\[1-9\]\$\/\.test\(event\.key\)/);
  // The ambiguous "m" literal must carry both chords: ⌘⌥M (altKey branch) and
  // ⌘⇧M (the model-picker listener).
  assert.match(globalKeys, /shortcutKey === "m" \? "minimize"/);
  assert.match(modelKeys, /!event\.shiftKey \|\| event\.key\.toLowerCase\(\) !== "m"/);
  assert.ok(guide.includes("⌘⌥M") && guide.includes("⌘⇧M"));
  // Escape is documented by the intro copy, not a kbd row.
  assert.match(globalKeys, /event\.key === "Escape"/);
  // Transcript filter chord.
  assert.match(chatKeys, /event\.key\.toLowerCase\(\) === "f"/);
  assert.ok(guide.includes("⌘F"));
  // Shift+Enter newline vs Enter submit (composer).
  assert.match(chat, /event\.key === "Enter" && !event\.shiftKey/);
  assert.ok(guide.includes("Shift+Enter") && guide.includes("Enter"));
  // Option-click copy with provenance.
  assert.match(copyButton, /event\.altKey && provenanceText/);
  assert.ok(guide.includes("Option-click"));
  // Focused-edge resize arrows and the title-bar double-click.
  assert.match(frame, /resizeWithKeyboard/);
  assert.match(frame, /onDoubleClick=\{\(\) => onMaximize\(id\)\}/);
  assert.ok(guide.includes("Arrows · Shift"));
  assert.ok(guide.includes("Double-click"));
});

test("guide icon names all resolve", () => {
  const icons = readFileSync(new URL("./Icons.jsx", import.meta.url), "utf8");
  const defined = new Set([...icons.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]));
  const groupsRegion = region(guide, "const groups = [", "];");
  for (const match of groupsRegion.matchAll(/\["(\w+)", "/g)) {
    assert.ok(defined.has(match[1]), `guide references unknown icon "${match[1]}"`);
  }
});
