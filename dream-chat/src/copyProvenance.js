// Pure provenance header for Option-click "copy with provenance" on chat
// messages. Kept free of React/DOM (same precedent as evidenceLedger.js) so
// it is testable with node:test. Never invents data: missing time, thread
// title, or rawOutputRef segments are omitted rather than placeholdered.
export function withProvenance(message, { threadTitle, providerLabel } = {}) {
  const content =
    (typeof message?.content === "string" && message.content.trim()) ||
    String(
      (message?.channels || []).find((channel) => channel.name === "content")?.text || "",
    ).trim();
  if (!content) return "";
  const parts = [providerLabel ? String(providerLabel) : "Unknown"];
  if (message?.time) parts.push(String(message.time));
  if (threadTitle) parts.push(String(threadTitle));
  if (message?.rawOutputRef) parts.push(String(message.rawOutputRef));
  return `[${parts.join(" · ")}]\n\n${content}`;
}
