import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc, createServer } from "vite";

async function loadJsx(name, imports = {}) {
  const url = new URL(name, import.meta.url);
  const source = (await readFile(url, "utf8")).replace('import "./workspace-home.css";', "");
  const result = await transformWithOxc(source, url.pathname, { jsx: { runtime: "classic" } });
  let code = result.code.replaceAll('"react"', JSON.stringify(import.meta.resolve("react")));
  for (const [specifier, replacement] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const icons = await loadJsx("./Icons.jsx");
const { WorkspaceHome, workspaceReadiness, recentWorkspaceThreads } = await import(await loadJsx("./WorkspaceHome.jsx", { "./Icons.jsx": icons }));
const props = { provider: "maple", providerLabel: "Local", modelLabel: "Maple-Preview", isDesktop: true, onOpenChat() {}, onConfigureModels() {} };
const render = (overrides = {}) => renderToStaticMarkup(React.createElement(WorkspaceHome, { ...props, ...overrides }));
function nodes(tree) {
  return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)] : [];
}

test("idle home leads with Chat, not a synthetic task, metrics, or onboarding", () => {
  const html = render();
  assert.match(html, /What would you like to work on/);
  assert.match(html, /Open Chat/);
  assert.match(html, /Configure models/);
  assert.ok(html.indexOf("Open Chat") < html.indexOf("Selected model"));
  assert.doesNotMatch(html, /Continue task|measuring|Recent threads|Workspace details|\b0%/i);
  assert.match(html, /<details><summary>How Hemlock works/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /Model output stays verbatim/);
  assert.match(html, /Host actions and their evidence are labeled separately/);
});

test("process health never passes inference; null and failure are explicit", () => {
  assert.match(render({ serverProcessReady: true }), /Inference not checked/);
  assert.match(render({ serverProcessReady: true }), /does not verify model inference/);
  assert.match(render(), /server status is unknown/);
  assert.match(render({ serverProcessReady: false, inferenceReady: true }), /Local server unavailable/);
  assert.match(render({ inferenceReady: false }), /Inference check failed/);
  assert.match(render({ inferenceReady: true }), /Last inference check passed/);
  assert.match(render({ readinessCheck: "checking", inferenceReady: true }), /Readiness check in progress/);
  assert.match(render({ isDesktop: false, inferenceReady: true }), /Browser preview/);
  assert.doesNotMatch(render({ isDesktop: false, inferenceReady: true }), /Last inference check passed/);
});

test("subscription authentication is not inference readiness", () => {
  for (const provider of ["codex", "claude"]) {
    assert.equal(workspaceReadiness({ provider, providerStatus: { authenticated: true }, inferenceReady: true }).label, "Provider sign-in reported");
    assert.equal(workspaceReadiness({ provider, providerStatus: { authenticated: false } }).label, "Provider sign-in required");
    assert.equal(workspaceReadiness({ provider, providerStatus: { installed: false, authenticated: true } }).label, "Provider CLI not found");
    assert.equal(workspaceReadiness({ provider }).label, "Provider status not checked");
  }
});

test("recent threads are real, nonarchived, deduplicated, and sorted without mutation", () => {
  const threads = Object.freeze([
    { id: "older", title: "Older", updatedAt: "2026-01-01" },
    { id: "archived", status: "archived", updatedAt: "2026-09-19" },
    { id: "timestamp-archive", archivedAt: "2026-09-18" },
    { id: "closed", status: "closed" },
    { id: "newer", title: "Newer", updatedAt: "2026-09-18" },
    { id: "older", updatedAt: "2025-01-01" },
    { id: "invalid-date", updatedAt: "not a timestamp", lastOpenedAt: "2026-09-01" },
    null,
  ]);
  assert.deepEqual(recentWorkspaceThreads(threads).map(t => t.id), ["newer", "invalid-date", "older"]);
  assert.equal(threads[0].id, "older");
  assert.deepEqual(recentWorkspaceThreads(null), []);
  assert.doesNotMatch(render({ threads }), /timestamp-archive|closed|archived/);
});

test("navigation callbacks receive exact thread IDs and current state is accessible", () => {
  const calls = [];
  const tree = WorkspaceHome({ ...props,
    onOpenChat: () => calls.push("chat"), onConfigureModels: () => calls.push("settings"),
    onSwitchThread: id => calls.push(id), activeThreadId: "thread-α",
    threads: [{ id: "thread-α", title: "A thread" }],
  });
  const buttons = nodes(tree).filter(n => n.type === "button");
  buttons.forEach(button => button.props.onClick());
  assert.deepEqual(calls, ["chat", "settings", "thread-α"]);
  assert.equal(buttons.at(-1).props["aria-current"], "true");
  assert.match(render({ threads: [{ id: "one" }], threadSwitching: true, onSwitchThread() {} }), /class="workspace-home-thread"[^>]*disabled/);
});

test("only supplied valid counts appear, collapsed, and unknown is never zero", () => {
  const html = render({ counts: { threads: 0, projects: 2, receipts: null, artifacts: -1, observations: NaN } });
  assert.match(html, /<details><summary>Workspace details/);
  assert.match(html, /Open threads<\/dt><dd>0/);
  assert.match(html, /Projects<\/dt><dd>2/);
  assert.doesNotMatch(html, /Receipts<\/dt>|Artifacts<\/dt>|Context observations<\/dt>/);
  assert.doesNotMatch(render({ counts: { projects: "2" }, showHowItWorks: false }), /<footer/);
});

test("recent list is bounded and untrusted titles remain text", () => {
  const threads = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: i === 0 ? "<img src=x onerror=bad()>" : `Thread ${i}` }));
  const html = render({ threads, onBrowseThreads() {} });
  assert.equal((html.match(/class="workspace-home-thread"/g) || []).length, 3);
  assert.match(html, /Browse all threads/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|Thread 4/);
});

// Opt-in isolated real Chromium verification; serves a virtual fixture only,
// never imports App, exposes the Electron host, or sends model requests.
// HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node --test src/components/WorkspaceHome.test.js
const playwrightPath = process.env.HEMLOCK_PLAYWRIGHT;
test("browser: compact containment, keyboard actions, disclosure, and theme contrast", { skip: !playwrightPath }, async () => {
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const root = new URL("../../", import.meta.url).pathname;
  const virtualId = "\0workspace-home-fixture";
  const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "workspace-home-fixture",
    resolveId(id) { if (id === virtualId) return id; },
    load(id) {
      if (id !== virtualId) return;
      return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {WorkspaceHome} from '/src/components/WorkspaceHome.jsx'; import '/src/styles.css';
        window.calls=[]; window.renderHome=(extra={})=>root.render(React.createElement(WorkspaceHome, {
          provider:'maple',providerLabel:'Local',modelLabel:'Maple-Preview',isDesktop:true,
          onOpenChat:()=>window.calls.push('chat'),onConfigureModels:()=>window.calls.push('settings'),
          onSwitchThread:id=>window.calls.push(id),...extra}));
        const root=createRoot(document.getElementById('fixture'));window.renderHome();`;
    },
    configureServer(vite) {
      vite.middlewares.use('/__workspace-home-test.html', async (req, res) => {
        const html = await vite.transformIndexHtml('/__workspace-home-test.html', `<html><body><div class="hemlock-os"><div id="fixture" class="window-body" style="width:680px;height:600px"></div></div><script type="module" src="/@id/__x00__workspace-home-fixture"></script></body></html>`);
        res.setHeader('Content-Type', 'text/html'); res.end(html);
      });
    },
  }] });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.HEMLOCK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__workspace-home-test.html`);
    await page.getByRole('button', { name: 'Open Chat', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const observations = [];
    for (const width of [680, 440, 320, 280]) {
      await page.locator('#fixture').evaluate((el, width) => { el.style.width = `${width}px`; el.style.height = '420px'; }, width);
      const geometry = await page.locator('.workspace-home').evaluate(el => {
        const home = el.getBoundingClientRect(), primary = el.querySelector('button').getBoundingClientRect();
        return { width: el.clientWidth, scrollWidth: el.scrollWidth, primaryVisible: primary.top >= home.top && primary.bottom <= home.bottom };
      });
      assert.ok(geometry.scrollWidth <= geometry.width + 1, JSON.stringify(geometry));
      assert.ok(geometry.primaryVisible);
      observations.push({ width, ...geometry });
      if (process.env.HEMLOCK_HOME_SCREENSHOTS && [680, 320].includes(width)) await page.screenshot({ path: `${process.env.HEMLOCK_HOME_SCREENSHOTS}-${width}.png` });
    }
    await page.getByRole('button', { name: 'Open Chat', exact: true }).focus();
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.calls), ['chat', 'settings']);
    await page.getByText('How Hemlock works', { exact: true }).click();
    assert.equal(await page.locator('details[open]').count(), 1);
    await page.evaluate(() => window.renderHome({ serverProcessReady:true, counts:{projects:2}, activeThreadId:'fixture-thread', threads:[{id:'fixture-thread',title:'Fixture: very long title '.repeat(10),provider:'codex',workspaceRoot:'/example/fixture/'.repeat(30)}]}));
    await page.getByRole('button', { name: /Fixture: very long title/ }).waitFor();
    await page.getByRole('button', { name: /Fixture: very long title/ }).click();
    assert.deepEqual(await page.evaluate(() => window.calls), ['chat', 'settings', 'fixture-thread']);
    assert.ok(await page.locator('.workspace-home').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    const contrasts = [];
    for (const theme of ['paper', 'understory']) {
      await page.locator('.hemlock-os').evaluate((el, theme) => el.classList.toggle('understory', theme === 'understory'), theme);
      contrasts.push(await page.locator('.workspace-home').evaluate(el => {
        const rgb = value => value.match(/[\d.]+/g).slice(0,3).map(Number);
        const lum = value => rgb(value).map(c => c/255).map(c => c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((s,c,i) => s+c*[.2126,.7152,.0722][i],0);
        const bg = lum(getComputedStyle(el).backgroundColor);
        const ink = lum(getComputedStyle(el.querySelector('.workspace-home-intro p')).color);
        return (Math.max(bg,ink)+.05)/(Math.min(bg,ink)+.05);
      }));
    }
    assert.ok(contrasts.every(ratio => ratio >= 4.5), JSON.stringify(contrasts));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ geometry: observations, mutedTextContrast: contrasts, pageErrors: errors }));
  } finally { await browser?.close(); await server.close(); }
});
