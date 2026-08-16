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
  assert.match(styles, /\.chat-surface > \.chat-plan-card\s*\{[^}]*order:\s*6;[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.plan-collapse-toggle\.is-collapsed svg/);
});

test("Chat keeps the task hero compact so the transcript gets the viewport", () => {
  assert.match(styles, /\.chat-surface > \.chat-task-header\s*\{[^}]*max-height:\s*min\(17vh, 175px\);/s);
  assert.match(styles, /\.chat-task-header \.objective-collapse summary\s*\{[^}]*-webkit-line-clamp:\s*2;/s);
  assert.match(styles, /\.chat-task-header \.objective-collapse summary\s*\{[^}]*max-width:\s*min\(900px, 80vw\);/s);
});

test("Chat keeps live model output visible and does not call stale evidence passed while approval is pending", () => {
  assert.match(mainSource, /className="chat-live-stream"/);
  assert.match(mainSource, /LIVE MODEL STREAM/);
  assert.match(mainSource, /const evidenceStatus = planNeedsApproval \|\| planStateMissing \? "waiting"/);
  assert.match(mainSource, /const latestObservation = \(agentProjection\?\.observations \|\| \[\]\)\.filter\(\(observation\) => observation\.taskId === task\.id\)/);
  assert.match(mainSource, /const container = node\?\.closest\("\.chat-scroll"\)/);
  assert.match(mainSource, /chatPinnedRef\.current/);
});

test("Displayed workspace paths redact the macOS home-directory identity", () => {
  assert.match(mainSource, /function redactUserPaths\(value\)/);
  assert.match(mainSource, /replace\(\/.*Users/);
  assert.match(mainSource, /redactUserPaths\(value\)/);
  assert.match(mainSource, /the path stays local and is not shown in Hemlock UI/);
});
