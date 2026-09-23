import { workToastFor } from "./workToasts.js";

export const NOTIFICATION_HISTORY_LIMIT = 30;

// Notification history: the toast stack expires after 12s, but the terminal
// events that produced it stay on the spine. This derives the same records the
// toasts showed — same rule table, same routing — as a durable, inspectable
// history. Pure projection of ctx.events: dismissed and expired toasts all
// remain here, stamped with the event's own createdAt rather than display time.
export function notificationHistory(events, { limit = NOTIFICATION_HISTORY_LIMIT } = {}) {
  const list = Array.isArray(events) ? events : [];
  const items = [];
  for (let index = list.length - 1; index >= 0 && items.length < limit; index -= 1) {
    const event = list[index];
    const at = Date.parse(event?.createdAt || "") || 0;
    const toast = workToastFor(event, at);
    if (!toast) continue;
    items.push({
      id: toast.id,
      eventId: toast.eventId,
      title: toast.title,
      body: toast.body,
      tone: toast.tone,
      icon: toast.icon,
      windowId: toast.windowId,
      at,
      createdAt: event.createdAt || null,
      status: event.status || "recorded",
    });
  }
  return items;
}
