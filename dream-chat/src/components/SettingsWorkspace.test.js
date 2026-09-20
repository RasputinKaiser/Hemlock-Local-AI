import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { importJsx } from "../testSupport/jsxLoader.js";
import { pathToFileURL } from "node:url";

// Use the installed Vite JSX compiler, with no browser, host, or new dependency.
const { SettingsWorkspace, SettingsWorkspaceView } = await importJsx(new URL("./SettingsWorkspace.jsx", import.meta.url));

function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}
function text(tree) {
  if (!React.isValidElement(tree)) return String(tree ?? "");
  return React.Children.toArray(tree.props.children).map(text).join("");
}
function fixture(overrides = {}, activeSection = "models") {
  const calls = [];
  const actions = ["setApiBase", "setReadinessCheck", "setServerProcessReady", "setInferenceReady", "checkReadiness", "refreshProviderStatuses", "providerAuthAction", "onSkipCloseWarningChange", "reopenPrimer", "setSourceEnabled", "updateProviderCapacity", "setDreamTrainingProfile"];
  const model = {
    apiBase: "http://127.0.0.1:8080", serverState: "idle", inferenceReady: null, readinessCheck: "idle",
    isDesktop: true, skipCloseWarning: false, dreamTrainingProfile: "balanced",
    modelLanes: { maple: { label: "Maple-Preview", shortLabel: "Maple" }, codex: { label: "Codex", shortLabel: "Codex" }, claude: { label: "Claude", shortLabel: "Claude" } },
    providerStatuses: [], providerCaps: {}, sourcePolicies: [],
    displayText: (value, fallback = "—") => value == null || value === "" ? fallback : String(value),
    ...Object.fromEntries(actions.map((name) => [name, (...args) => calls.push([name, ...args])])),
    ...overrides,
  };
  const tree = SettingsWorkspaceView({ model, activeSection, idPrefix: "settings-test", onSectionChange: (id) => calls.push(["section", id]) });
  return { tree, model, calls, all: nodes(tree) };
}
function panel(f, section) { return f.all.find((node) => node.props.id === `settings-test-${section}`); }
function button(tree, label) { return nodes(tree).find((node) => node.type === "button" && text(node).trim() === label); }
function inputFor(tree, label) {
  return nodes(nodes(tree).find((node) => node.type === "label" && text(node).includes(label))).find((node) => ["input", "select"].includes(node.type));
}

test("default wrapper renders Models and four named sections with accessible navigation", () => {
  const f = fixture();
  assert.match(renderToStaticMarkup(React.createElement(SettingsWorkspace, { model: f.model })), /aria-current="page"/);
  const nav = f.all.find((node) => node.type === "nav");
  assert.equal(nav.props["aria-label"], "Settings sections");
  const buttons = nodes(nav).filter((node) => node.type === "button");
  assert.deepEqual(buttons.map(text), ["Models & accounts", "Workspace", "Context & memory", "Advanced/runtime"]);
  for (const [index, section] of ["models", "workspace", "context", "advanced"].entries()) {
    const region = panel(f, section);
    assert.equal(region.props.hidden, index !== 0);
    assert.equal(region.props["aria-labelledby"], `settings-test-${section}-heading`);
    assert.equal(buttons[index].props["aria-controls"], region.props.id);
    assert.equal(buttons[index].props["aria-current"], index === 0 ? "page" : undefined);
    buttons[index].props.onClick();
  }
  assert.deepEqual(f.calls, [["section", "models"], ["section", "workspace"], ["section", "context"], ["section", "advanced"]]);
});

test("each selected section is the only visible region; unrelated setup is not interleaved", () => {
  for (const section of ["models", "workspace", "context", "advanced"]) {
    const f = fixture({}, section);
    assert.deepEqual(f.all.filter((node) => node.type === "section" && node.props.hidden === false).map((node) => node.props.id), [`settings-test-${section}`]);
  }
  const f = fixture();
  assert.ok(inputFor(panel(f, "models"), "Maple-Preview server URL"));
  assert.ok(button(panel(f, "models"), "Check local readiness"));
  assert.match(text(panel(f, "models")), /Subscription providers/);
  assert.doesNotMatch(text(panel(f, "models")), /Concurrency caps|Regular Dream profile|Runtime storage|Ask before closing/);
  assert.ok(inputFor(panel(f, "workspace"), "Ask before closing a window"));
  assert.ok(button(panel(f, "workspace"), "Reopen getting-started tips"));
  assert.match(text(panel(f, "context")), /Context sources/);
  assert.match(text(panel(f, "advanced")), /Concurrency caps.*Regular Dream profile.*Runtime storage/);
});

test("server edits invalidate all existing readiness state without issuing a request", () => {
  const f = fixture();
  inputFor(f.tree, "Maple-Preview server URL").props.onChange({ target: { value: "http://localhost:9000" } });
  assert.deepEqual(f.calls, [["setApiBase", "http://localhost:9000"], ["setReadinessCheck", "idle"], ["setServerProcessReady", null], ["setInferenceReady", null]]);
});

test("readiness states remain explicit and the running check keeps its disabled guard", () => {
  for (const [value, label] of [[null, "not checked"], [false, "not verified"], [true, "verified"]]) {
    const f = fixture({ inferenceReady: value });
    assert.match(text(panel(f, "models")), new RegExp(`inference: ${label}`));
    button(f.tree, "Check local readiness").props.onClick();
    assert.deepEqual(f.calls, [["checkReadiness"]]);
  }
  assert.equal(button(fixture({ readinessCheck: "checking" }).tree, "Checking local inference…").props.disabled, true);
  // Browser readiness was not disabled in the original renderer: retain that contract.
  assert.equal(button(fixture({ isDesktop: false }).tree, "Check local readiness").props.disabled, false);
});

test("account status, refresh, login and logout preserve provider ids and disabled guards", () => {
  const f = fixture({ providerStatuses: [{ provider: "codex", installed: true, authenticated: true, accountLabel: "Fixture account" }, { provider: "claude", installed: false, authenticated: false }] });
  assert.match(text(panel(f, "models")), /Fixture account/);
  assert.equal(button(f.tree, "Log in").props.disabled, true);
  button(f.tree, "Refresh").props.onClick();
  button(f.tree, "Re-authenticate").props.onClick();
  button(f.tree, "Log out").props.onClick();
  assert.deepEqual(f.calls, [["refreshProviderStatuses"], ["providerAuthAction", "codex", "login"], ["providerAuthAction", "codex", "logout"]]);
  const browser = fixture({ isDesktop: false });
  assert.equal(button(browser.tree, "Refresh").props.disabled, true);
  for (const control of browser.all.filter((node) => node.type === "button" && text(node) === "Log in")) assert.equal(control.props.disabled, true);
  const claude = fixture({ providerStatuses: [{ provider: "claude", installed: true, authenticated: true }] });
  button(claude.tree, "Re-authenticate").props.onClick();
  assert.deepEqual(claude.calls, [["providerAuthAction", "claude", "login"]]);
});

test("workspace preference preserves inverse checked semantics and delegates persistence", () => {
  const f = fixture({ skipCloseWarning: true });
  const checkbox = inputFor(f.tree, "Ask before closing a window");
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  button(f.tree, "Reopen getting-started tips").props.onClick();
  assert.deepEqual(f.calls, [["onSkipCloseWarningChange", false], ["reopenPrimer"]]);
  assert.match(text(panel(f, "workspace")), /does not cancel running work/);
  assert.match(text(panel(f, "workspace")), /Destructive actions still ask/);
});

test("context policies preserve objects, opt-in state, metadata and local-project restriction", () => {
  const policies = [{ sourceId: "local-project", displayName: "Local project", retention: "session", permissionState: "granted" }, { sourceId: "calendar", displayName: "Calendar", enabled: false, retention: "day", permissionState: "denied" }];
  const f = fixture({ sourcePolicies: policies });
  assert.equal(inputFor(f.tree, "Local project").props.checked, true);
  assert.equal(inputFor(f.tree, "Local project").props.disabled, true);
  assert.equal(inputFor(f.tree, "Calendar").props.checked, false);
  inputFor(f.tree, "Calendar").props.onChange({ target: { checked: true } });
  assert.deepEqual(f.calls, [["setSourceEnabled", policies[1], true]]);
  assert.match(text(panel(f, "context")), /calendar · day · denied/);
  assert.equal(inputFor(fixture({ isDesktop: false, sourcePolicies: policies }).tree, "Calendar").props.disabled, true);
  assert.match(text(panel(fixture(), "context")), /Source policies will appear after the desktop runtime resumes/);
});

test("capacity edits retain the original blur validation, reset, Enter, and desktop guard", () => {
  const f = fixture({ providerCaps: { maple: 2 } });
  const input = inputFor(panel(f, "advanced"), "Maple");
  assert.equal(input.props.defaultValue, 2);
  assert.equal(input.props.min, "1");
  assert.equal(input.props.max, "8");
  input.props.onBlur({ target: { value: "4" } });
  assert.deepEqual(f.calls, [["updateProviderCapacity", "maple", "4"]]);
  for (const value of ["", "0", "9", "Infinity", "nonsense", "2"]) {
    const event = { target: { value } };
    input.props.onBlur(event);
    assert.equal(event.target.value, "2");
  }
  assert.equal(f.calls.length, 1);
  let blurred = false;
  input.props.onKeyDown({ key: "Enter", currentTarget: { blur() { blurred = true; } } });
  assert.equal(blurred, true);
  for (const control of fixture({ isDesktop: false }).all.filter((node) => node.type === "input" && node.props.type === "number")) assert.equal(control.props.disabled, true);
});

test("training profile changes only the preference; storage stays read-only and honestly empty", () => {
  const f = fixture({ inventory: { root: "/fixture/application-data", modelBytes: 2 * 1024 ** 3, totalRuntimeBytes: 4 * 1024 ** 2, freeBytes: 0 } });
  const select = inputFor(f.tree, "Regular Dream profile");
  assert.equal(select.props.value, "balanced");
  assert.deepEqual(nodes(select).filter((node) => node.type === "option").map((node) => node.props.value), ["smoke", "balanced", "quality"]);
  select.props.onChange({ target: { value: "quality" } });
  assert.deepEqual(f.calls, [["setDreamTrainingProfile", "quality"]]);
  assert.match(text(panel(f, "advanced")), /2.0 GiB.*4.0 MiB.*0 KiB/);
  assert.match(text(panel(f, "advanced")), /\/fixture\/application-data/);
  const empty = fixture({ storageRoot: "/fixture/fallback" });
  assert.match(text(panel(empty, "advanced")), /\/fixture\/fallback/);
  assert.equal(nodes(panel(empty, "advanced")).filter((node) => node.type === "dd" && text(node) === "—").length, 3);
  assert.equal(nodes(panel(empty, "advanced")).filter((node) => node.type === "button").length, 0);
});

test("scoped CSS uses theme tokens and window-width container layout with visible focus", async () => {
  const css = await readFile(new URL("./settings-workspace.css", import.meta.url), "utf8");
  assert.match(css, /@container settings-workspace/);
  assert.match(css, /\[hidden\]/);
  assert.match(css, /focus-visible/);
  for (const token of ["surface", "paper", "surface-soft", "surface-border", "ink", "muted-ink"]) assert.ok(css.includes(`var(--${token})`), token);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i);
});

// Optional isolated browser test. No App import, credentials, inference or host.
// HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node --test src/components/SettingsWorkspace.test.js
const playwrightPath = process.env.HEMLOCK_PLAYWRIGHT;
test("browser: keyboard section switching, compact controls, themes and scroll ownership", { skip: !playwrightPath }, async () => {
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const virtualId = "\0settings-workspace-fixture";
  const sample = fixture({
    sourcePolicies: [{ sourceId: "fixture-source", displayName: "Fixture source with a long descriptive name", retention: "session", permissionState: "not granted", enabled: false }],
    inventory: { root: `/fixture/${"long-directory/".repeat(20)}` },
  }).model;
  const actionNames = Object.keys(sample).filter((key) => typeof sample[key] === "function" && key !== "displayText");
  const server = await createServer({ root: new URL("../../", import.meta.url).pathname, configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "settings-workspace-fixture",
    resolveId(id) { if (id === virtualId) return id; },
    load(id) {
      if (id !== virtualId) return;
      return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {SettingsWorkspace} from '/src/components/SettingsWorkspace.jsx'; import '/src/styles.css';
        window.calls=[]; const model=${JSON.stringify(sample)};
        for(const name of ${JSON.stringify(actionNames)}) model[name]=(...args)=>window.calls.push([name,...args]);
        model.displayText=(value,fallback='—')=>value==null||value===''?fallback:String(value);
        createRoot(document.getElementById('fixture')).render(React.createElement(SettingsWorkspace,{model}));`;
    },
    configureServer(vite) {
      vite.middlewares.use('/__settings-test.html', async (req, res) => {
        const html = await vite.transformIndexHtml('/__settings-test.html', '<html><body><div class="hemlock-os"><div id="fixture" class="window-body" style="width:470px;height:374px"></div></div><script type="module" src="/@id/__x00__settings-workspace-fixture"></script></body></html>');
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
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__settings-test.html`);
    await page.getByRole('button', { name: 'Models & accounts', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await nav.getByRole('button', { name: 'Models & accounts', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    assert.equal(await nav.getByRole('button', { name: 'Workspace', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await page.getByRole('region', { name: 'Workspace', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('textbox', { name: 'Maple-Preview server URL' }).count(), 0);
    await page.getByRole('checkbox', { name: 'Ask before closing a window' }).focus();
    await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => window.calls), [['onSkipCloseWarningChange', true]]);
    await page.getByRole('button', { name: 'Reopen getting-started tips' }).click();
    assert.equal(await page.evaluate(() => window.calls.at(-1)[0]), 'reopenPrimer');
    const observations = [];
    for (const width of [470, 320, 720]) {
      await page.locator('#fixture').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
      for (const section of ['Models & accounts', 'Workspace', 'Context & memory', 'Advanced/runtime']) {
        await nav.getByRole('button', { name: section, exact: true }).click();
        const measurement = await page.locator('.settings-workspace-content').evaluate(el => {
          const visible = [...el.querySelectorAll('section')].filter(node => !node.hidden);
          const controls = [...visible[0].querySelectorAll('input:not([type="checkbox"]),select,button')];
          return { width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, visibleSections: visible.length, minimumControlHeight: controls.length ? Math.min(...controls.map(node => node.getBoundingClientRect().height)) : null };
        });
        assert.ok(measurement.scrollWidth <= measurement.width + 1, JSON.stringify(measurement));
        assert.equal(measurement.visibleSections, 1);
        assert.equal(measurement.scrollTop, 0);
        assert.ok(measurement.minimumControlHeight == null || measurement.minimumControlHeight >= 36);
        observations.push({ width, section, ...measurement });
      }
    }
    await page.locator('#fixture').evaluate(el => { el.style.width = '320px'; });
    await nav.getByRole('button', { name: 'Models & accounts', exact: true }).click();
    await nav.getByRole('button', { name: 'Advanced/runtime', exact: true }).focus();
    // Tab into and back out of the task; fixed navigation must not cover focus.
    for (const key of [...Array(5).fill('Tab'), ...Array(5).fill('Shift+Tab')]) {
      await page.keyboard.press(key);
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { label: el.textContent || el.getAttribute('type'), visible: hit === el || el.contains(hit) };
      });
      assert.ok(focused.visible, JSON.stringify(focused));
    }
    const contrasts = [];
    for (const theme of ['paper', 'understory']) {
      await page.locator('.hemlock-os').evaluate((el, theme) => el.classList.toggle('understory', theme === 'understory'), theme);
      contrasts.push(await page.locator('.settings-workspace').evaluate(el => {
        const lum = value => value.match(/[\d.]+/g).slice(0,3).map(Number).map(c => c/255).map(c => c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((sum,c,i) => sum+c*[.2126,.7152,.0722][i],0);
        const ratio = (a,b) => (Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
        const bg = getComputedStyle(el).backgroundColor;
        return { surface: bg, body: ratio(getComputedStyle(el.querySelector('p')).color,bg), status: ratio(getComputedStyle(el.querySelector('.settings-workspace-status')).color,bg), primary: ratio(getComputedStyle(el.querySelector('.settings-workspace-primary')).color,getComputedStyle(el.querySelector('.settings-workspace-primary')).backgroundColor) };
      }));
      if (process.env.HEMLOCK_SETTINGS_SCREENSHOTS) await page.screenshot({ path: `${process.env.HEMLOCK_SETTINGS_SCREENSHOTS}-${theme}.png` });
    }
    assert.notEqual(contrasts[0].surface, contrasts[1].surface);
    assert.ok(contrasts.every(({ body, status, primary }) => Math.min(body,status,primary) >= 4.5), JSON.stringify(contrasts));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ settingsGeometry: observations, settingsContrast: contrasts, pageErrors: errors }));
  } finally { await browser?.close(); await server.close(); }
});
