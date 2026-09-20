import { WINDOW_DEFINITIONS, clampBounds, normalizeCanvas, normalizeZOrder, setWindowState, toggleMaximize } from "./windowManager.js";

export function centerWindow(item, canvas, useDefaultSize = false) {
  if (!item || item.state === "closed") return item;
  const surface = normalizeCanvas(canvas);
  const restored = item.state === "maximized" ? toggleMaximize(item, surface) : item;
  const requested = useDefaultSize ? WINDOW_DEFINITIONS[item.windowId]?.preferred || restored.bounds : restored.bounds;
  const fitted = clampBounds(requested, surface, item.minimumSize);
  const bounds = { ...fitted, x: Math.floor((surface.width - fitted.width) / 2), y: Math.floor((surface.height - fitted.height) / 2) };
  return { ...restored, state: "normal", minimizedFrom: null, bounds, restoreBounds: bounds, snapTarget: null };
}

// Show desktop is reversible window visibility, never cancellation or closure.
export function minimizeWorkspace(windows, activeId, canvas) {
  const ids = Object.keys(windows).filter(id => ["normal", "maximized"].includes(windows[id].state));
  const next = { ...windows };
  for (const id of ids) next[id] = setWindowState(windows[id], "minimized", canvas);
  return { windows: next, snapshot: { ids, activeId } };
}

export function restoreWorkspace(windows, snapshot, canvas) {
  const next = { ...windows };
  for (const id of snapshot?.ids || []) {
    if (next[id]?.state === "minimized") next[id] = setWindowState(next[id], "normal", canvas);
  }
  const visible = Object.keys(next).filter(id => ["normal", "maximized"].includes(next[id].state));
  const activeId = visible.includes(snapshot?.activeId) ? snapshot.activeId : visible.sort((a, b) => next[b].zOrder - next[a].zOrder)[0] || null;
  return { windows: normalizeZOrder(next, activeId), activeId };
}

export function windowMenuItems(state) {
  const maximized = state === "maximized";
  const minimized = state === "minimized";
  return [
    { id: "focus", label: minimized ? "Restore window" : "Bring to front", icon: "windows" },
    { id: "half-left", label: "Tile left", icon: "tileLeft", shortcut: "⌘⌥←" },
    { id: "half-right", label: "Tile right", icon: "tileRight", shortcut: "⌘⌥→" },
    { id: maximized ? "restore" : "maximize", label: maximized ? "Restore size" : "Fill workspace", icon: maximized ? "restore" : "maximize", shortcut: maximized ? "⌘⌥↓" : "⌘⌥↑" },
    { id: "center", label: "Center window", icon: "centerWindow" },
    { id: "default-size", label: "Reset size & position", icon: "resetSize" },
    { id: "minimize", label: "Minimize", icon: "minimize", shortcut: "⌘⌥M", disabled: minimized },
    { id: "close", label: "Close window", icon: "close", shortcut: "⌘⌥W", destructive: true },
  ];
}
