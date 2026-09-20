// Run against a local Vite/preview server; no model or host requests are submitted.
// npm install --prefix /tmp/hemlock-gui-qa playwright
// HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/gui-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.HEMLOCK_PLAYWRIGHT ? pathToFileURL(process.env.HEMLOCK_PLAYWRIGHT).href : 'playwright');
const output = path.resolve(process.env.HEMLOCK_GUI_OUTPUT || '/tmp/hemlock-gui-evidence');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.HEMLOCK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
const results = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, condition, details) => { results.push({ name, passed: Boolean(condition), ...(details ? { details } : {}) }); assert.ok(condition, `${name}: ${JSON.stringify(details || '')}`); };
const dock = label => page.locator(`.understory-dock .dock-item[aria-label^="${label},"]`);
async function openApp(label) {
  if (await dock(label).count()) return dock(label).click();
  await page.getByRole('button', { name: 'Open all apps', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find an app or window', exact: true }).fill(label);
  await page.locator('.overview-app').first().click();
}
const bounds = selector => page.locator(selector).evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }; });
const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
try {
  await page.goto(process.env.HEMLOCK_GUI_URL || 'http://127.0.0.1:5178');
  await page.locator('.system-bar').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await shot('command-center');
  await dock('Chat / Code').click();
  await page.locator('.chat-compose textarea').waitFor();
  check('Chat opens without a hook-order crash', errors.length === 0, errors);
  check('Composer sits outside the evidence inspector', await page.locator('.chat-surface > .chat-composer-area .chat-compose').count() === 1);
  check('Explore starts with inspector hidden', await page.locator('#hemlock-chat-inspector').isHidden());
  await page.locator('.chat-compose textarea').fill('IME check — do not send');
  await page.locator('.chat-compose textarea').evaluate(e => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  check('IME Enter preserves draft without sending', await page.locator('.chat-compose textarea').inputValue() === 'IME check — do not send' && await page.locator('.work-message.user').count() === 0);
  await page.locator('.chat-compose textarea').fill('');
  check('Empty send is disabled', await page.locator('.chat-compose button[type="submit"]').isDisabled());
  await page.getByRole('button', { name: 'Maximize Chat / Code', exact: true }).click();
  await shot('chat-wide');
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  check('Build does not obstruct the composer with automatic evidence', await page.locator('#hemlock-chat-inspector').isHidden());
  await page.locator('.chat-inspector-toggle').click();
  check('Explicit activity control exposes host evidence', await page.locator('#hemlock-chat-inspector').isVisible());
  const transcript = await bounds('.chat-scroll');
  const composer = await bounds('.chat-composer-area');
  check('Composer is below the transcript', composer.y >= transcript.bottom - 1, { transcript, composer });
  await shot('chat-build-wide');
  await page.getByRole('button', { name: 'Minimize Chat / Code', exact: true }).click();
  check('Minimized Chat leaves the workspace', await page.locator('.window-chat').count() === 0);
  await dock('Chat / Code').click();
  check('Dock restores maximized state', await page.locator('.window-chat.is-maximized').count() === 1);
  await page.getByRole('button', { name: 'Restore Chat / Code', exact: true }).click();
  const initialWidth = (await bounds('.window-chat')).width;
  await page.getByRole('button', { name: 'Resize Chat / Code from right', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  check('Keyboard resize changes the window width', (await bounds('.window-chat')).width > initialWidth);
  const bar = await bounds('.window-chat .window-bar');
  const beforeDrag = await bounds('.window-chat');
  await page.mouse.move(bar.x + 200, bar.y + 20);
  await page.mouse.down();
  await page.mouse.move(4, bar.y + 50, { steps: 8 });
  check('Edge drag previews placement before resizing', await page.locator('.window-snap-preview').count() === 1 && (await bounds('.window-chat')).width === beforeDrag.width);
  await page.mouse.up();
  check('Release tiles the window and clears preview', (await bounds('.window-chat')).x <= 1 && await page.locator('.window-snap-preview').count() === 0);
  await page.getByRole('button', { name: 'Close Chat / Code', exact: true }).click();
  check('Closing a window asks for confirmation', await page.locator('.confirm-dialog').isVisible());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('Cancel keeps Chat open', await page.locator('.chat-surface').count() === 1);
  await page.getByRole('button', { name: 'Close Chat / Code', exact: true }).click();
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  check('Confirmed close leaves the app healthy', await page.locator('.chat-surface').count() === 0 && errors.length === 0, errors);
  await page.locator('.system-palette').click();
  check('Palette focuses its search field', await page.locator('.palette-top input').evaluate(e => document.activeElement === e));
  for (let index = 0; index < 12; index++) await page.keyboard.press('ArrowDown');
  check('Keyboard-selected command stays in view', await page.locator('.palette-list').evaluate(list => { const active = list.querySelector('[aria-selected="true"]'); const a = active.getBoundingClientRect(); const b = list.getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1; }));
  await page.keyboard.press('Escape');
  check('Palette Escape restores focus', await page.locator('.command-palette').count() === 0 && await page.locator('.system-palette').evaluate(e => document.activeElement === e));
  await page.getByRole('button', { name: 'Open window overview', exact: true }).click();
  check('Overview lists every app', await page.locator('.overview-app').count() === 10);
  await shot('window-overview');
  await page.getByRole('textbox', { name: 'Find an app or window', exact: true }).fill('settings');
  check('Overview filters apps', await page.locator('.overview-app').count() === 1);
  await page.keyboard.press('Enter');
  check('Overview launches the selected app', await page.locator('.window-settings.is-active').count() === 1 && await page.locator('.workspace-overview').count() === 0);
  await dock('Command Center').focus();
  await page.keyboard.press('ArrowRight');
  check('Dock supports arrow-key navigation', await dock('Chat / Code').evaluate(e => document.activeElement === e));
  await dock('Chat / Code').click();
  await page.getByRole('button', { name: 'Maximize Chat / Code', exact: true }).click();
  for (const [width, height] of [[1440, 900], [1024, 768], [760, 620], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const frame = await bounds('.window-chat');
    const compose = await bounds('.chat-compose');
    const scroll = await bounds('.chat-scroll');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(`No horizontal page overflow at ${width}`, !overflow);
    check(`Composer is contained at ${width}`, compose.x >= frame.x - 1 && compose.right <= frame.right + 1 && compose.bottom <= frame.bottom + 1, { frame, compose });
    check(`Transcript has reading space at ${width}`, scroll.height >= 100, scroll);
    await shot(`chat-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.system-understory').click();
  check('Understory theme toggles', await page.locator('html.understory').count() === 1);
  await shot('chat-understory');
  await page.reload();
  check('Understory survives reload', await page.locator('html.understory').count() === 1);
  for (const label of ['Artifact Studio', 'Memory Garden', 'Settings', 'Activity', 'Receipts', 'Project Map', 'SIPS Control', 'Dream Lab']) {
    await openApp(label);
    check(`${label} opens`, await page.locator(`.os-window[aria-label="${label}"]`).isVisible());
  }
  await dock('Settings').click();
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  check('Close warning offers opt-out', await page.getByRole('button', { name: 'Never show this again', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Never show this again', exact: true }).click();
  await dock('Settings').click();
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  check('Opt-out skips subsequent close warnings', await page.locator('.window-settings').count() === 0 && await page.locator('.confirm-dialog').count() === 0);
  await page.reload();
  await dock('Settings').click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  check('Close-warning preference persists', !(await page.getByRole('checkbox', { name: 'Ask before closing a window', exact: true }).isChecked()));
  await page.getByRole('checkbox', { name: 'Ask before closing a window', exact: true }).check();
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  check('Settings can restore window-close warnings', await page.locator('.confirm-dialog').isVisible());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('No renderer errors across all surfaces', errors.length === 0, errors);
} catch (error) {
  await shot('failure');
  results.push({ name: 'runner', passed: false, details: error.stack });
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length }, null, 2));
  console.log(JSON.stringify({ results, errors, output }, null, 2));
  await browser.close();
}
