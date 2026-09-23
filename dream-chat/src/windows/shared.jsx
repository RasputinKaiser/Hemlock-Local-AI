import React, { useRef, useState } from "react";

// Shared leaf module: helpers and chrome used by both the app shell and the
// extracted window renderers. Nothing here may import from main.jsx or the
// window modules — dependencies only flow inward.

// Browser preview has no Electron host to negotiate a per-request ceiling.
// Keep the same high default used by the local Maple runtime; this is transport
// capacity, not a prompt-level reasoning limit.
export const DEFAULT_MAPLE_MAX_TOKENS = 16384;
export const TERMINAL_STREAM_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "interrupted_by_steering", "restarting"]);
// Mirrors electron/agent_queue.cjs ACTIVE_STATUSES — steer: only lands while one of these holds.
export const ACTIVE_TASK_STATUSES = new Set(["accepted", "planning", "running", "waiting_for_approval", "waiting_for_user", "verifying", "paused"]);

export const MODEL_LANES = {
  maple: { provider: "maple", label: "Local", shortLabel: "MAPLE", kind: "local", defaultModel: "default_model", defaultModelLabel: "Local MLX model", defaultReasoning: "on", reasoningLevels: ["on", "off"], modelOptions: [{ value: "default_model", label: "Maple-Preview" }, { value: "lfm25-8b", label: "LFM2.5-8B-A1B (LiquidAI)" }] },
  codex: { provider: "codex", label: "Codex", shortLabel: "CODEX", kind: "subscription", defaultModel: "", defaultModelLabel: "Codex default", defaultReasoning: "high", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], modelOptions: [{ value: "", label: "Default Codex model" }, { value: "gpt-5.6-luna", label: "gpt-5.6-luna" }] },
  claude: { provider: "claude", label: "Claude", shortLabel: "CLAUDE", kind: "subscription", defaultModel: "sonnet", defaultModelLabel: "Claude Sonnet", defaultReasoning: "high", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], modelOptions: [{ value: "sonnet", label: "Claude Sonnet" }, { value: "opus", label: "Claude Opus" }, { value: "haiku", label: "Claude Haiku" }] },
};

export function formatTime(value = new Date()) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatElapsed(seconds) {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatTokensPerSecond(usage, elapsedMs) {
  const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens);
  const durationSeconds = Number(elapsedMs) / 1000;
  if (!Number.isFinite(completionTokens) || completionTokens <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return "tok/s —";
  const rate = Math.round((completionTokens / durationSeconds) * 10) / 10;
  // T8-F3: "~" marks char-estimated counts (server sent no usage chunk).
  return `tok/s ${usage?.completionTokensApproximate ? "~" : ""}${rate}`;
}

export function redactUserPaths(value) {
  return String(value).replace(/\/Users\/[^/\s"'`<>]+/g, "~");
}

export function displayText(value, fallback = "—") {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return redactUserPaths(value);
  if (Array.isArray(value)) return value.map((item) => displayText(item, "")).filter(Boolean).join(" · ") || fallback;
  try { return redactUserPaths(JSON.stringify(value)); } catch { return fallback; }
}

export function compactPreview(value, maxLength = 150) {
  const text = displayText(value, "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export function formatRelativeTime(iso) {
  if (!iso) return "";
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) return "";
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function messageChannels(message) {
  if (Array.isArray(message?.channels) && message.channels.length) return message.channels;
  if (typeof message?.content === "string" && message.content) return [{ name: "content", text: message.content, visible: true, source: message?.provider || "maple" }];
  return [];
}

export function StatusLamp({ state = "idle", label }) {
  const safeState = displayText(state, "idle");
  return <span className={`status-lamp ${safeState}`}><i />{displayText(label, safeState)}</span>;
}

// Glossary hint: keeps the native title= tooltip for mouse hover while adding a
// styled popover on keyboard focus and tap. Focus shows it, blur hides it, tap
// toggles (second tap closes), Escape closes without blocking global Escape
// ordering (modals > primer > others). Elements that carry their own onClick
// keep it — the popover then follows focus instead of click toggling.
export function GlossaryHint({ term, definition, as = "span", className = "", children, onClick, ...rest }) {
  const [open, setOpen] = useState(false);
  const openedByFocus = useRef(false);
  const Trigger = as;
  const handleClick = (event) => {
    if (onClick) { onClick(event); return; }
    // A click right after keyboard focus would toggle-close the popover that
    // focus just opened — treat that click as confirmation instead.
    if (openedByFocus.current) { openedByFocus.current = false; return; }
    setOpen((value) => !value);
  };
  return <Trigger {...rest} tabIndex={0} className={`${className} glossary-hint${open ? " is-open" : ""}`} title={`${term}: ${definition}`} onFocus={() => { openedByFocus.current = true; setOpen(true); }} onBlur={() => { openedByFocus.current = false; setOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} onMouseDown={() => { if (!onClick) openedByFocus.current = false; }} onClick={handleClick}>{children}{open ? <span className="glossary-popover" role="tooltip"><strong>{term}</strong>{definition}</span> : null}</Trigger>;
}

const PRIMER_LINES = [
  { term: "Model-verbatim", copy: "Model output is shown exactly as the model wrote it — Hemlock never paraphrases a reply." },
  { term: "Receipts", copy: "Every consequential action leaves evidence you can open later in Receipts." },
  { term: "Bounded", copy: "Agent steps are limited to an approved plan before anything runs." },
  { term: "Where things appear", copy: "Replies stream into Chat; artifacts open in Artifact Studio." },
];

// First-run primer: teaches the four load-bearing ideas (verbatim, receipts,
// bounded, where output lands) in one inline, non-modal card. Shown once;
// dismissal persists under PRIMER_KEY.
export function PrimerCard({ onDismiss }) {
  return <section className="primer-card" aria-label="How Hemlock works">
    <div className="primer-heading">
      <div>
        <span className="primer-kicker">HOW HEMLOCK WORKS</span>
        <h3>The four things worth knowing</h3>
      </div>
      <button type="button" className="primer-dismiss" onClick={onDismiss} aria-label="Dismiss the onboarding primer">Got it</button>
    </div>
    <dl className="primer-lines">{PRIMER_LINES.map((line) => <div key={line.term}><dt>{line.term}</dt><dd>{line.copy}</dd></div>)}</dl>
  </section>;
}

// Persisted opt-out for the close-window confirm dialog.
export const CLOSE_WARNING_KEY = "hemlock-close-warning-v1";
