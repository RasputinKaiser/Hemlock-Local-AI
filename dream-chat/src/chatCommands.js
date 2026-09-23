// Composer grammar for the Chat window: the steer:/campaign:/queue: prefix
// hints and the /command table. Pure and dependency-free so node:test can pin
// exactly what the host will do with each prefix — the hint copy must never
// promise behavior parseInteractionMode (main.jsx) does not deliver.

// Mirrors parseInteractionMode in main.jsx: steer/steering → mode "steer",
// campaign/auto/autonomous → "campaign", everything else → "queue". queue: is
// NOT a host prefix — the host receives the line verbatim — so its hint says
// so instead of pretending it is stripped.
export const PREFIX_HINTS = [
  {
    re: /^steer(?:ing)?\s*[:\-]\s*/i,
    mode: "steer",
    prefix: "steer:",
    hint: "folds this note into the active task at the next bounded decision — a running inference is not rewritten",
  },
  {
    re: /^(?:campaign|auto|autonomous)\s*[:\-]\s*/i,
    mode: "campaign",
    prefix: "campaign:",
    hint: "submits an autonomous bounded intent — plans auto-approve inside campaign budgets",
  },
  {
    re: /^queue\s*[:\-]\s*/i,
    mode: "queue",
    prefix: "queue:",
    hint: "is sent verbatim — queueing is already the default; a plain message waits behind active work",
  },
];

export function prefixMode(text) {
  const value = String(text || "");
  if (!value.trim()) return null;
  for (const entry of PREFIX_HINTS) {
    const match = value.match(entry.re);
    if (match) {
      return { mode: entry.mode, prefix: entry.prefix, hint: entry.hint, body: value.slice(match[0].length).trim() };
    }
  }
  return null;
}

// Slash commands the composer can honor through ctx alone. "window" commands
// open a surface; "stop"/"retry" reuse the existing handlers; "fresh-context"
// and "help" resolve to a notice because ctx does not expose the visible
// transcript reset (main.jsx owns setMessages) or the shortcut guide.
export const SLASH_COMMANDS = [
  { name: "clear", kind: "fresh-context", summary: "Archive this thread's context so the model starts fresh" },
  { name: "stop", kind: "stop", summary: "Stop the in-flight generation" },
  { name: "retry", kind: "retry", summary: "Resend your last prompt" },
  { name: "help", kind: "help", summary: "Point at the shortcut guide and command palette" },
  { name: "settings", kind: "window", windowId: "settings", summary: "Open Settings" },
  { name: "receipts", kind: "window", windowId: "receipts", summary: "Open Receipts" },
  { name: "activity", kind: "window", windowId: "activity", summary: "Open Activity" },
  { name: "memory", kind: "window", windowId: "memory", summary: "Open Memory Garden" },
];

// A slash command must be the whole first token — "/clear now" is the clear
// command with args "now"; "note: /clear" mid-text is plain text, not a command.
export function parseSlashCommand(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("/")) return null;
  const match = value.match(/^\/([a-z][a-z0-9-]*)\b\s*([\s\S]*)$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: match[2].trim() };
}

export function resolveSlashCommand(name) {
  return SLASH_COMMANDS.find((command) => command.name === String(name || "").toLowerCase()) || null;
}

export function slashCommandList() {
  return SLASH_COMMANDS.map((command) => `/${command.name}`).join("  ");
}
