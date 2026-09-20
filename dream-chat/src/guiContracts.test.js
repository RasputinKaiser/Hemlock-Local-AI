import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");

test("conditional window renderers do not declare React hooks", () => {
  const renderers = [...source.matchAll(/^  function (render\w+)\(/gm)];
  for (const match of renderers) {
    const end = source.indexOf("\n  }", match.index);
    const body = source.slice(match.index, end);
    assert.doesNotMatch(body, /\buse(?:State|Ref|Effect|Memo|Callback|LayoutEffect)\s*\(/, `${match[1]} is called conditionally and must not own hooks`);
  }
  assert.match(source, /const stableRetryLast = useCallback/);
});

test("composer follows the transcript outside the optional inspector", () => {
  const inspector = source.indexOf('<aside id="hemlock-chat-inspector"');
  const composer = source.indexOf('<div className="chat-composer-area">');
  assert.ok(inspector > source.indexOf('<div className="chat-scroll">'));
  assert.ok(composer > source.indexOf("</aside>", inspector));
  assert.match(source, /hidden=\{!inspectorOpen\}/);
  assert.match(source, /aria-expanded=\{inspectorOpen\} aria-controls="hemlock-chat-inspector"/);
  assert.match(source, /is-inspector-hidden/);
});

test("Enter does not submit while an input method is composing", () => {
  assert.match(source, /event\.key === "Enter" && !event\.shiftKey && !event\.nativeEvent\.isComposing && event\.keyCode !== 229/);
  assert.match(source, /aria-describedby="chat-compose-hint"/);
});

test("palette captures its opener before moving focus and handles Escape without Electron", () => {
  const start = source.indexOf('if (!paletteOpen) return undefined;');
  const end = source.indexOf('}, [paletteOpen]);', start);
  const effect = source.slice(start, end);
  assert.ok(effect.indexOf('const paletteOpener = document.activeElement') < effect.indexOf('paletteRef.current?.focus()'));
  assert.match(effect, /event\.key === "Escape"/);
  assert.match(effect, /paletteOpener\.focus\(\)/);
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
});

test("window close and minimize share focus handoff and confirmed close", () => {
  assert.match(source, /async function closeWindow\(id\)[\s\S]+?const confirmed = await confirmDialog/);
  assert.match(source, /if \(confirmed\) dismissWindow\(id, "closed"\)/);
  assert.match(source, /function minimizeWindow\(id\)\s*\{\s*dismissWindow\(id, "minimized"\)/);
  assert.match(source, /if \(activeWindowId === id\) setActiveWindowId\(nextId\)/);
  assert.match(source, /current\[id\]\?\.state !== "closed"\s*\? focusWindowState/);
});

test("brand is a native keyboard-operable button", () => {
  assert.ok(/<button type="button" className="system-brand"[^\n]+?aria-label="Open Command Center"/.test(source));
});

test("only window-close warnings can be persistently skipped", () => {
  assert.match(source, /const CLOSE_WARNING_KEY = "hemlock-close-warning-v1"/);
  assert.match(source, /readJson\(CLOSE_WARNING_KEY, \{\}\)\.skip === true/);
  assert.match(source, /if \(skipCloseWarning\) \{ dismissWindow\(id, "closed"\); return; \}/);
  assert.match(source, /confirmState\.allowSkipCloseWarning && <button/);
  assert.equal((source.match(/allowSkipCloseWarning: true/g) || []).length, 1);
  assert.match(source, /Never show this again/);
  const settingsSource = readFileSync(new URL("./components/SettingsWorkspace.jsx", import.meta.url), "utf8");
  assert.match(settingsSource, /Ask before closing a window/);
  assert.match(source, /onSkipCloseWarningChange: \(skip\) => \{ localStorage\.setItem\(CLOSE_WARNING_KEY/);
});

test("Build does not auto-open evidence, and compact evidence manages dismissal", () => {
  assert.match(source, /onClick=\{\(\) => setInteractionMode\("build"\)\}/);
  assert.doesNotMatch(source, /setInteractionMode\("build"\); setInspectorOpen\(true\)/);
  assert.match(source, /panel\.querySelector\("button"\)\?\.focus\(\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", dismiss\)/);
  assert.match(source, /inspectorOpenerRef\.current\?\.focus\?\.\(\)/);
});

test("Dream and preview labels do not imply fabricated observations", () => {
  assert.doesNotMatch(source, /aria-label="Dream loss preview"/);
  assert.match(source, /No training observations yet/);
  assert.match(source, /isDesktop \? "Electron runtime" : "Browser preview"/);
  assert.doesNotMatch(source, /"measuring…"/);
  assert.doesNotMatch(source, /role="badge"/);
});

test("idle home preserves active work and redacts displayed recent-thread paths", () => {
  const gate = source.slice(source.indexOf("const genuinelyIdle ="), source.indexOf("if (genuinelyIdle)"));
  for (const guard of ["!liveStream", "!isThinking", "!isDreaming", "!planNeedsApproval", "!actionNeedsApproval", "!error"]) assert.ok(gate.includes(guard), guard);
  assert.match(source, /workspaceRoot: displayText\(thread\.workspaceRoot, ""\)/);
  assert.match(source, /return <SettingsWorkspace model=/);
});

test("only the primary pointer starts window drag and resize", () => {
  for (const name of ["startDrag", "startResize"]) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n  }", start);
    assert.match(source.slice(start, end), /event\.button !== 0/);
  }
});
