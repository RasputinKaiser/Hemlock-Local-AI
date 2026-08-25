import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");

test("Chat keeps the window frame fixed and the message history scrollable", () => {
  assert.match(styles, /\.window-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(styles, /\.chat-surface\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;[^}]*overflow:\s*hidden\s*!important;/s);
  assert.match(styles, /\.chat-scroll\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.chat-compose\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.objective-collapse summary\s*\{[^}]*-webkit-line-clamp:\s*3;/s);
  assert.match(styles, /\.objective-collapse \.objective-full\s*\{[^}]*white-space:\s*pre-wrap;/s);
});

test("Chat exposes the durable plan and approval boundary", () => {
  assert.match(mainSource, /className=\{`chat-plan-card \$\{planNeedsApproval \|\| planStateMissing \? "is-awaiting" : "is-approved"\} \$\{planCollapsed \? "is-collapsed" : ""\}`\}/);
  assert.match(mainSource, /Approve plan/);
  assert.match(mainSource, /Refresh task state/);
  assert.match(mainSource, /planFromEvents/);
  assert.match(styles, /\.chat-plan-card\.is-awaiting/);
  assert.match(styles, /\.chat-plan-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
});

test("Chat keeps the transcript above a collapsible plan dock", () => {
  assert.match(mainSource, /plan-collapse-toggle/);
  assert.match(mainSource, /aria-controls="hemlock-plan-body"/);
  assert.match(mainSource, /hidden=\{planCollapsed\}/);
  assert.match(styles, /\.chat-surface > \.chat-scroll\s*\{[^}]*order:\s*5;/s);
  assert.match(styles, /\.chat-surface > \.chat-host-rail\s*\{[^}]*order:\s*6;[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.chat-surface > \.chat-plan-card\s*\{[^}]*order:\s*7;[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.plan-collapse-toggle\.is-collapsed svg/);
});

test("Chat keeps host activity out of the transcript and collapsed by default", () => {
  assert.match(mainSource, /const hostActivity = <section className="chat-host-rail"/);
  assert.match(mainSource, /<details className="chat-host-details" open={hostActivityOpen}/);
  assert.match(mainSource, /className="chat-work-rail"/);
  assert.match(styles, /\.chat-host-rail\s*\{[^}]*max-height:\s*min\(15vh, 150px\);/s);
  assert.match(styles, /\.chat-host-details\s*\{[^}]*background:\s*#f4f8ef;/s);
  assert.match(styles, /\.chat-host-details\[open\]\s*\{[^}]*max-height:\s*min\(15vh, 150px\);/s);
  assert.match(styles, /\.chat-host-details > \.live-task-surface\s*\{[^}]*overflow:\s*auto;[^}]*border-top:/s);
  assert.match(styles, /\.chat-host-rail \.live-evidence-card\s*\{[^}]*display:\s*none;/s);
});

test("Chat keeps the task hero compact so the transcript gets the viewport", () => {
  assert.match(styles, /\.chat-surface > \.chat-task-header\s*\{[^}]*max-height:\s*min\(8vh, 70px\);/s);
  assert.match(styles, /\.chat-task-header \.objective-collapse summary\s*\{[^}]*-webkit-line-clamp:\s*1;/s);
  assert.match(styles, /\.chat-task-header \.objective-collapse summary\s*\{[^}]*max-width:\s*min\(980px, 78vw\);/s);
  assert.match(mainSource, /className="chat-context-summary"/);
  assert.match(styles, /\.chat-context-summary > span:last-child\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.work-message\.assistant \.maple-output-card\s*\{[^}]*border:\s*0;[^}]*box-shadow:\s*none;/s);
});

test("Chat uses a transcript-first work rail and exposes throughput telemetry", () => {
  assert.match(styles, /\.chat-surface\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 2fr\) minmax\(320px, 1fr\);/s);
  assert.match(styles, /\.chat-surface > \.chat-activity-strip\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*3;/s);
  assert.match(styles, /\.chat-surface > \.chat-scroll\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*4;/s);
  assert.match(styles, /\.chat-surface > \.chat-host-rail\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*3 \/ span 2;/s);
  assert.match(styles, /\.chat-surface > \.chat-evidence-rail\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*5;/s);
  assert.match(styles, /\.chat-surface > \.chat-compose\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*8;/s);
  assert.match(styles, /\.chat-status-bar\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*9;/s);
  assert.match(styles, /\.chat-surface > \.chat-work-rail\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*3 \/ span 6;/s);
  assert.match(styles, /\.window-chat \.window-bar\s*\{[^}]*background:\s*#0b3228;/s);
  assert.match(mainSource, /chat-evidence-rail/);
  assert.match(mainSource, /className="chat-status-bar"/);
  assert.match(mainSource, /thread-context-label/);
  assert.match(mainSource, /formatTokensPerSecond/);
  assert.match(mainSource, /tok\/s/);
  assert.match(mainSource, /liveStream\?\.startedAt/);
});

test("Chat restores the active thread conversation and keeps host JSON secondary", () => {
  assert.match(mainSource, /agent\.runCommand\("thread\.switch", \{ threadId: activeThreadId \}\)/);
  assert.match(mainSource, /setMessages\(\(current\) => current\.length \? current : result\.conversation\.map/);
  assert.match(mainSource, /<details><summary>Exact validated action envelope/);
  assert.match(mainSource, /<details><summary>Raw provider output reference/);
});

test("Chat keeps live model output visible and does not call stale evidence passed while approval is pending", () => {
  assert.match(mainSource, /className="chat-live-stream"/);
  assert.match(mainSource, /LIVE MODEL STREAM/);
  assert.match(mainSource, /const evidenceStatus = planNeedsApproval \|\| planStateMissing \? "waiting"/);
  assert.match(mainSource, /const latestObservation = \(agentProjection\?\.observations \|\| \[\]\)\.filter\(\(observation\) => observation\.taskId === task\.id\)/);
  assert.match(mainSource, /const container = node\?\.closest\("\.chat-scroll"\)/);
  assert.match(mainSource, /chatPinnedRef\.current/);
});

test("Hotfix: live stream renders below the transcript and the plan card owns its own grid slot", () => {
  // Reading-order invariant: streamed output follows sent messages, never precedes them.
  const streamAt = mainSource.indexOf('{liveStreams.length > 0 && <section className="chat-live-stream"');
  const transcriptAt = mainSource.indexOf("{messages.map((message, messageIndex) =>");
  const jumpAt = mainSource.indexOf('className="chat-jump-latest"');
  assert.ok(streamAt > -1 && transcriptAt > -1 && jumpAt > -1);
  assert.ok(streamAt > transcriptAt && streamAt < jumpAt, "live stream must sit between messages.map and the jump-to-latest/thinking block");
  assert.match(mainSource, /aria-label="Live model stream" aria-live="polite"/);
  // Plan card occupies grid row 5 in column 1 (below the transcript) — it must
  // never share column 2 rows 3-8 with .chat-work-rail again.
  assert.match(styles, /\.chat-surface > \.chat-plan-card\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*5;/s);
  assert.doesNotMatch(styles, /\.chat-surface > \.chat-plan-card\s*\{[^}]*grid-column:\s*2;/s);
  // flushStreamedMessages only appends new streams at the end of the transcript.
  assert.match(mainSource, /return \[\.\.\.current, \{ id: crypto\.randomUUID\(\), role: "assistant"/);
});

test("Displayed workspace paths redact the macOS home-directory identity", () => {
  assert.match(mainSource, /function redactUserPaths\(value\)/);
  assert.match(mainSource, /replace\(\/.*Users/);
  assert.match(mainSource, /redactUserPaths\(value\)/);
  assert.match(mainSource, /displayText\(message\.rawOutputRef\)/);
  // New-thread flow now uses the native directory picker; the privacy promise
  // moved into the picker dialog title in electron/main.cjs.
  assert.doesNotMatch(mainSource, /window\.prompt\(/);
});

test("T11-B transcript rows are memoized so stream flushes skip unchanged messages", () => {
  assert.match(mainSource, /const TranscriptMessageRow = memo\(function TranscriptMessageRow\(/);
  assert.match(mainSource, /<TranscriptMessageRow key=\{message\.id\}/);
  assert.match(mainSource, /reasoningOff=\{modelSelection\.reasoning === "off"\}/);
  // Stable retry identity keeps memo props shallow-equal across parent renders.
  assert.match(mainSource, /const stableRetryLast = useCallback\(\(target\) => stableRetryRef\.current\(target\), \[\]\)/);
});

test("T11-B streaming prose reads like a living document with an honest waiting state", () => {
  // Comfortable measure + pretty wrapping for streamed assistant prose.
  assert.match(styles, /\.maple-channel-content \.message-content\s*\{[^}]*max-width:\s*72ch;[^}]*text-wrap:\s*pretty;/s);
  // Growing-edge caret pulses (reduced-motion safe) and disappears on terminal frames.
  assert.match(styles, /@keyframes caretPulse/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{ \.stream-caret \{ animation: none;/s);
  // Empty streaming bubble shows a waiting note, never the terminal "no text" copy.
  assert.match(mainSource, /maple-channel-waiting/);
  assert.match(styles, /\.maple-channel-waiting p\s*\{/);
  // Reasoning channel stays visually distinct while live.
  assert.match(styles, /\.maple-channel-reasoning\[open\] summary::before/);
  assert.match(styles, /\.maple-channel-reasoning pre\s*\{[^}]*color:\s*#6b6350;/s);
});

test("T11-B verification status colors and budget counters hold the contrast floor", () => {
  // Skipped cards use explicit muted colors instead of an opacity dim that
  // composited below 4.5:1 over paper.
  assert.doesNotMatch(styles, /\.chat-verification-card\.is-skipped\s*\{[^}]*opacity/s);
  assert.match(styles, /\.chat-verification-card\.is-skipped \.card-kicker > span\s*\{\s*color:\s*#5f7161;\s*\}/);
  assert.match(styles, /\.chat-verification-card\.is-skipped strong\s*\{\s*color:\s*#556958;\s*\}/);
  // Live steps/commands counters and grant stepper values stay legible.
  assert.match(styles, /\.budget-usage\s*\{[^}]*font:\s*600 10px "DM Mono", monospace;/s);
  assert.match(styles, /\.budget-stepper strong\s*\{[^}]*color:\s*#5d4a1e;/s);
});
