import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const css = postcss.parse(styles);

// Inspect declarations, not an obsolete matching substring anywhere in the
// file. Scope responsive rules explicitly so dead overrides cannot pass.
function declarations(selector, condition = null) {
  const result = {};
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const parentCondition = rule.parent.type === "atrule" ? `${rule.parent.name} ${rule.parent.params}` : null;
    if (parentCondition !== condition) return;
    rule.walkDecls((decl) => { result[decl.prop] = decl.value; });
  });
  return result;
}

const chatRows = [...declarations(".chat-surface")["grid-template-rows"].matchAll(/\[([a-z]+)\]/g)].map((match) => match[1]);

test("Chat keeps the window frame fixed and the message history scrollable", () => {
  assert.equal(declarations(".window-body").container, "window / inline-size");
  assert.equal(declarations(".window-body").display, "flex");
  const surface = declarations(".chat-surface");
  assert.equal(surface.display, "grid");
  assert.equal(surface["min-height"], "0");
  assert.equal(surface.height, "100%");
  assert.equal(surface.overflow, "auto", "oversized text and optional panels remain reachable by scrolling");
  assert.match(surface["grid-template-rows"], /\[transcript\] minmax\(180px, 1fr\)/);
  const scroll = declarations(".chat-surface > .chat-scroll");
  assert.equal(scroll["min-height"], "0");
  assert.equal(scroll["overflow-x"], "hidden");
  assert.equal(scroll["overflow-y"], "auto");
  assert.equal(scroll["grid-row"], "transcript");
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
  assert.equal(declarations(".chat-surface > .chat-plan-card")["grid-row"], "plan");
  assert.equal(declarations(".chat-surface > .chat-plan-card")["grid-column"], "1");
  assert.ok(chatRows.indexOf("plan") > chatRows.indexOf("transcript"));
  assert.ok(chatRows.indexOf("composer") > chatRows.indexOf("plan"));
  assert.match(styles, /\.plan-collapse-toggle\.is-collapsed svg/);
});

test("Chat inspector is secondary, explicitly hideable, and owns its scroll", () => {
  assert.match(mainSource, /const hostActivity = <section className="chat-host-rail"/);
  assert.match(mainSource, /<details className="chat-host-details" open={hostActivityOpen}/);
  assert.match(mainSource, /className="chat-work-rail"/);
  assert.match(mainSource, /hidden=\{!inspectorOpen\}/);
  assert.equal(declarations(".chat-surface.is-inspector-hidden > .chat-work-rail").display, "none");
  assert.equal(declarations("[hidden]").display, "none");
  const hiddenRule = css.nodes.find((node) => node.selector === "[hidden]");
  assert.ok(hiddenRule.nodes.find((node) => node.prop === "display").important);
  const rail = declarations(".chat-surface > .chat-work-rail");
  assert.equal(rail["overflow-y"], "auto");
  assert.equal(rail["grid-row"], "transcript", "compact evidence never overlays composer or thread controls");
  assert.equal(rail["max-height"], "none");
  assert.equal(rail.position, "absolute", "compact inspector is a dismissible drawer, not stolen transcript space");
  assert.ok(chatRows.indexOf("inspector") > chatRows.indexOf("composer"));
});

test("Chat gives every optional direct child a distinct named row", () => {
  const selectors = [".thread-bar", ".chat-error", ".suggestion-stack", ".chat-activity-strip", ".chat-compare", ".chat-scroll", ".chat-question-card", ".chat-plan-card", ".chat-composer-area", ".chat-status-bar"];
  const assigned = selectors.map((selector) => declarations(`.chat-surface > ${selector}`)["grid-row"]);
  assert.equal(new Set(assigned).size, selectors.length, "optional panels must not overlap another grid slot");
  for (const row of assigned) assert.ok(chatRows.includes(row), `missing explicit row: ${row}`);
  assert.equal(declarations(".chat-surface > .chat-task-header").display, "none", "thread title already supplies the context");
  assert.equal(declarations(".work-message.assistant .maple-output-card").border, "0");
});

test("Chat composer stays below the transcript, outside the host inspector", () => {
  const composer = declarations(".chat-surface > .chat-composer-area");
  assert.equal(composer["grid-column"], "1");
  assert.equal(composer["grid-row"], "composer");
  const inspectorSource = mainSource.match(/<aside\b[^>]*className="chat-work-rail"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
  assert.ok(inspectorSource);
  assert.doesNotMatch(inspectorSource, /chat-compose|interaction-mode-bar|composer-model-line/);
  assert.match(mainSource, /className="chat-composer-area"/);
  assert.match(mainSource, /className="chat-inspector-toggle" aria-expanded=\{inspectorOpen\}/);
  assert.doesNotMatch(styles, /\.chat-work-rail > \.(?:chat-compose|interaction-mode-bar)/);
});

test("Chat adapts to its window width, not the desktop viewport", () => {
  assert.equal(declarations(".chat-surface")["grid-template-columns"], "minmax(0, 1fr)");
  const wide = "container window (min-width: 900px)";
  assert.equal(declarations(".chat-surface:not(.is-inspector-hidden)", wide)["grid-template-columns"], "minmax(0, 1fr) 296px");
  assert.equal(declarations(".chat-surface > .chat-work-rail", wide)["grid-column"], "2");
  assert.equal(declarations(".chat-surface > .chat-work-rail", wide)["grid-row"], "activity / status");
  css.walkAtRules("media", (rule) => {
    if (!/width/.test(rule.params)) return;
    rule.walkDecls("grid-template-columns", (decl) => assert.notEqual(decl.parent.selector, ".chat-surface"));
  });
});

test("Chat retains forest chrome and exposes throughput telemetry", () => {
  assert.equal(declarations(".os-window.window-chat.is-active .window-bar").background, "#0b3228");
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
  // Plan and transcript share the reading column, never the inspector slot.
  assert.equal(declarations(".chat-surface > .chat-plan-card")["grid-column"], "1");
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

test("Shell preserves floating desktop windows and truly hides minimized ones", () => {
  assert.equal(declarations(".os-window").position, "absolute");
  assert.notEqual(declarations(".os-window.window-center .window-bar").display, "none", "Command Center keeps a reachable draggable titlebar");
  for (const property of ["left", "top", "width", "height", "inset"]) {
    assert.equal(declarations(".os-window.window-center")[property], undefined, `Command Center must not lock ${property} over managed bounds`);
  }
  assert.equal(declarations(".os-window.is-minimized").display, "none");
  assert.equal(declarations(".os-window.window-chat.is-maximized").position, undefined, "maximizing chat must not cover the shell and dock");
  css.walkAtRules("media", (rule) => {
    rule.walkRules((child) => {
      if (!child.selectors.includes(".os-window")) return;
      if (!child.nodes.some((node) => node.prop === "position" && node.value === "relative")) return;
      assert.match(rule.params, /max-width: 759px/, "native windows remain floating at Electron's 760px minimum");
    });
  });
  assert.equal(declarations(".system-brand").background, "transparent");
  assert.equal(declarations(".understory-dock")["overflow-x"], "auto");
  assert.equal(declarations(".understory-dock .dock-item")["flex-shrink"], "0");
});

test("Keyboard, touch, and reduced motion have explicit usable states", () => {
  assert.match(styles, /summary:focus-visible/);
  assert.match(styles, /outline: 2px solid var\(--focus-ink, var\(--gold-bright\)\) !important/);
  assert.equal(declarations(".message-actions", "media (hover: none)").opacity, "1");
  assert.equal(declarations(".thread-row-actions", "media (hover: none)").opacity, "1");
  assert.equal(declarations("*", "media (prefers-reduced-motion: reduce)").animation, "none");
  assert.equal(declarations("*", "media (prefers-reduced-motion: reduce)").transition, "none");
  assert.equal(declarations(".dock-item:hover", "media (prefers-reduced-motion: reduce)").transform, "none");
  assert.equal(declarations(".chat-scroll > .chat-live-stream .chat-live-stream-body")["max-height"], "none");
  assert.equal(declarations(".chat-scroll > .chat-live-stream .chat-live-channel pre").overflow, "visible");
});

function luminance(hex) {
  const rgb = hex.slice(1).match(/.{2}/g).map((part) => Number.parseInt(part, 16) / 255);
  const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

test("Paper, understory, and chrome metadata tokens clear WCAG contrast", () => {
  const root = declarations(":root");
  for (const [name, palette] of [["paper", root], ["understory", { ...root, ...declarations(".understory") }]]) {
    for (const text of ["--ink", "--muted-ink", "--ink-muted"]) {
      for (const surface of ["--paper", "--paper-warm", "--surface", "--surface-soft"]) {
        const contrast = (luminance(palette[surface]) + 0.05) / (luminance(palette[text]) + 0.05);
        assert.ok(contrast >= 4.5, `${name}: ${text} on ${surface}: ${contrast.toFixed(2)}:1`);
      }
    }
  }
  for (const background of ["#0b3025", "#0a2a21", "#18211e"]) {
    const contrast = (luminance("#aebfa4") + 0.05) / (luminance(background) + 0.05);
    assert.ok(contrast >= 4.5, `moss on ${background}: ${contrast.toFixed(2)}:1`);
  }
});
