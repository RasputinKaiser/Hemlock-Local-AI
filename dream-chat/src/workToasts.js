// In-app work notifications. The host's work_notifications.cjs announces
// long-running job completion through OS notifications only — and skips them
// entirely while the window is focused — so the renderer's own surface is this
// quiet toast stack. Every toast derives from a terminal event on the agent
// spine; nothing is asserted from a timer or optimistic UI. Dedupe is by the
// source event id, each toast expires on its own, and clicking one opens the
// window that holds the underlying evidence.

export const WORK_TOAST_TTL_MS = 12000;
export const WORK_TOAST_LIMIT = 3;

// Only terminal, user-meaningful job outcomes earn a toast — in-flight
// progress already has the dock badges and the Activity spine.
const TOAST_RULES = {
  "task.completed": { windowId: "center", icon: "check", title: "Task completed", tone: "ok" },
  "task.blocked": { windowId: "receipts", icon: "warning", title: "Task blocked", tone: "warn" },
  "sips.cycle.completed": { windowId: "sips", icon: "sips", title: "SIPS cycle finished", tone: "ok" },
  "sips.cycle.failed": { windowId: "sips", icon: "sips", title: "SIPS cycle failed", tone: "warn" },
  "dream.completed": { windowId: "dream", icon: "dream", title: "Dream run finished", tone: "ok" },
  "dream.failed": { windowId: "dream", icon: "dream", title: "Dream run failed", tone: "warn" },
  "dream.blocked": { windowId: "dream", icon: "dream", title: "Dream run blocked", tone: "warn" },
  "dream.fused": { windowId: "dream", icon: "dream", title: "Graft fused into new weights", tone: "ok" },
  "comparison.completed": { windowId: "chat", icon: "pulse", title: "Lane comparison finished", tone: "ok" },
  "comparison.failed": { windowId: "chat", icon: "pulse", title: "Lane comparison failed", tone: "warn" },
  "memory.consolidated": { windowId: "memory", icon: "memory", title: "Memory consolidated", tone: "ok" },
  "world.suggest": { windowId: "grove", icon: "grove", title: "Experiment suggestions ready", tone: "ok" },
  "maple.crashloop.detected": { windowId: "activity", icon: "warning", title: "Maple crash loop detected", tone: "warn" },
};

function toastBody(payload, status) {
  const text = [
    payload?.summary,
    payload?.top?.reason ? `${payload.top.experiment || "experiment"} — ${payload.top.reason}` : null,
    Number.isFinite(payload?.merged) ? `${payload.merged} absorbed · ${(payload.clusters || []).length} cluster(s)` : null,
    payload?.error,
    payload?.reason,
    payload?.stage,
    payload?.objective,
    payload?.command,
  ].find((value) => typeof value === "string" && value.trim());
  const body = (text || String(status || "recorded")).replace(/\s+/g, " ").trim();
  return body.length > 140 ? `${body.slice(0, 139).trimEnd()}…` : body;
}

// event → toast | null. Unknown or non-terminal event types stay silent.
export function workToastFor(event, now = Date.now()) {
  const rule = TOAST_RULES[String(event?.type || "")];
  if (!rule || !event?.id) return null;
  return {
    id: `toast-${event.id}`,
    eventId: event.id,
    title: rule.title,
    body: toastBody(event.payload, event.status),
    tone: rule.tone,
    icon: rule.icon,
    windowId: rule.windowId,
    at: now,
    expiresAt: now + WORK_TOAST_TTL_MS,
  };
}

export function pushWorkToast(list, toast, limit = WORK_TOAST_LIMIT) {
  if (!toast) return Array.isArray(list) ? list : [];
  const current = Array.isArray(list) ? list : [];
  // Same event id updates in place — a replayed event never double-pings.
  if (current.some((item) => item.id === toast.id)) {
    return current.map((item) => (item.id === toast.id ? toast : item));
  }
  return [toast, ...current].slice(0, Math.max(1, limit));
}

export function pruneWorkToasts(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((toast) => !Number.isFinite(toast.expiresAt) || toast.expiresAt > now);
}
