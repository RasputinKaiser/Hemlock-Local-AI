export const PINNED_APPS = ["center", "chat", "artifact", "settings"];
// Grove sits past the ten digit slots — reachable from the palette, dock, and
// overview, but with no ⌘digit chord so the existing chords never move.
export const APP_SHORTCUTS = ["center", "chat", "artifact", "memory", "activity", "receipts", "map", "sips", "dream", "settings", "grove"];
export const APP_GROUPS = [
  { label: "Work", ids: ["center", "chat", "artifact"] },
  { label: "World", ids: ["grove"] },
  { label: "Knowledge", ids: ["memory", "map"] },
  { label: "System", ids: ["settings", "activity", "receipts"] },
  { label: "Training", ids: ["sips", "dream"] },
];

export function dockApps(metadata, windows) {
  return Object.entries(metadata).filter(([id]) => PINNED_APPS.includes(id) || (windows[id] && windows[id].state !== "closed"));
}

export function shortcutApp(key) {
  if (!/^[0-9]$/.test(key)) return null;
  return APP_SHORTCUTS[key === "0" ? 9 : Number(key) - 1];
}
