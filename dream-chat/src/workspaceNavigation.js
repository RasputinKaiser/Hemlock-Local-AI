export const PINNED_APPS = ["center", "chat", "artifact", "settings"];
// Grove and Threads sit past the ten digit slots — reachable from the palette,
// dock, and overview, but with no ⌘digit chord so the existing chords never move.
export const APP_SHORTCUTS = ["center", "chat", "artifact", "memory", "activity", "receipts", "map", "sips", "dream", "settings", "grove", "threads"];
export const APP_GROUPS = [
  { label: "Work", ids: ["center", "chat", "threads", "artifact"] },
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

// Front-to-back cycle order: frontmost (highest zOrder) first. Minimized
// windows are excluded — they live in the dock, not the cycle.
export function windowCycleOrder(windows) {
  return Object.entries(windows || {})
    .filter(([, item]) => item && !["closed", "minimized"].includes(item.state))
    .sort(([, a], [, b]) => (b.zOrder || 0) - (a.zOrder || 0))
    .map(([id]) => id);
}

// ⌘` walks front-to-back: from the focused window to the next one behind it,
// wrapping at the back. With no focused window it lands on the frontmost.
export function nextWindowInCycle(windows, activeId) {
  const order = windowCycleOrder(windows);
  if (order.length < 2) return null;
  return order[(order.indexOf(activeId) + 1) % order.length];
}

// On close or minimize, focus hands off to the next frontmost open window —
// the one the user was working in before the dismissed window was raised.
export function focusHandoffId(windows, dismissedId) {
  return windowCycleOrder(windows).find((id) => id !== dismissedId) || null;
}

// Dock status chips are derived from real runtime state — never decorative.
// Approval is the highest-priority affordance (a parked task blocks the queue),
// so it gets a distinct amber chip rather than the generic unread dot.
export function dockActivityBadges(id, { taskStatus = "", isDreaming = false, unseenEvents = [] } = {}) {
  const badges = [];
  if (id === "chat") {
    if (taskStatus === "waiting_for_approval") badges.push({ id: "approval", icon: "warning", tone: "amber", label: "Approval needed" });
    else if (taskStatus === "running") badges.push({ id: "working", icon: "chat", tone: "moss", label: "Task running" });
  }
  if (id === "dream" && isDreaming) badges.push({ id: "dreaming", icon: "dream", tone: "violet", label: "Dream running" });
  if (id === "artifact" && unseenEvents.some((event) => String(event?.type || "").startsWith("artifact.") && Number(event?.payload?.artifact?.revision || 0) > 0)) {
    badges.push({ id: "revision", icon: "artifact", tone: "violet", label: "New artifact revision" });
  }
  return badges;
}
