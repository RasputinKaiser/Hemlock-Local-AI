// Production-bundle smoke test in real Electron, using temporary app data.
// HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/gui-electron-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { _electron } = await import(process.env.HEMLOCK_PLAYWRIGHT ? pathToFileURL(process.env.HEMLOCK_PLAYWRIGHT).href : 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'hemlock-electron-gui-'));
await fs.mkdir(path.join(data, 'workspace-runtime'), { recursive: true });
const evidence = path.resolve(process.env.HEMLOCK_GUI_OUTPUT || '/tmp/hemlock-gui-evidence');
await fs.mkdir(evidence, { recursive: true });
const errors = [];
const checks = [];
const check = (name, passed) => { checks.push({ name, passed: !!passed }); assert.ok(passed, name); };
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(root, 'electron/main.cjs'), `--user-data-dir=${path.join(data, 'chromium')}`],
  env: { ...process.env, HEMLOCK_DATA_DIR: data, HEMLOCK_PROD_UI: '1', MAPLE_AUTOSTART_SERVER: '0' },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.system-bar').waitFor();
  check('Production bundle uses the real Electron bridge', await page.evaluate(() => window.mapleDesktop?.isDesktop === true));
  await page.locator('.workspace-home').waitFor();
  check('Real Electron idle startup uses task-first home', await page.locator('.workspace-home').isVisible());
  await page.screenshot({ path: path.join(evidence, 'electron-home.png') });
  await page.locator('.dock-item[aria-label^="Chat / Code,"]').click();
  await page.getByRole('button', { name: 'Maximize Chat / Code', exact: true }).click();
  await page.keyboard.press('Meta+Shift+o');
  check('Native overview shortcut opens navigation', await page.locator('.workspace-overview').isVisible());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  check('Native palette shortcut works', await page.locator('.command-palette').isVisible());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Alt+ArrowLeft');
  check('Native shortcut tiles Chat left', await page.locator('.window-chat').evaluate(e => !e.classList.contains('is-maximized') && e.getBoundingClientRect().x < 1));
  await page.keyboard.press('Meta+Alt+ArrowUp');
  await page.screenshot({ path: path.join(evidence, 'electron-desktop.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 620));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('Small native desktop keeps floating windows', await page.locator('.window-chat').evaluate(e => getComputedStyle(e).position === 'absolute'));
  check('Native composer stays inside window bounds', await page.locator('.window-chat').evaluate(e => { const a=e.getBoundingClientRect(); const b=e.querySelector('.chat-compose').getBoundingClientRect(); return b.bottom <= a.bottom && b.right <= a.right; }));
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  check('Native Build leaves evidence closed and Send reachable', await page.locator('#hemlock-chat-inspector').isHidden() && await page.locator('.chat-compose button[type=submit]').evaluate(e => { const r=e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }));
  await page.locator('.chat-inspector-toggle').click();
  check('Native compact evidence preserves composer hit targets', await page.locator('.chat-compose textarea').evaluate(e => { const r=e.getBoundingClientRect(); return e===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); }));
  await page.keyboard.press('Escape');
  check('Native inspector Escape restores its opener', await page.locator('.chat-inspector-toggle').evaluate(e => document.activeElement===e && e.getAttribute('aria-expanded')==='false'));
  await page.screenshot({ path: path.join(evidence, 'electron-compact.png') });
  await page.keyboard.press('Meta+0');
  check('Stable Cmd+0 opens Settings', await page.locator('.window-settings.is-active .settings-workspace').isVisible());
  await page.keyboard.press('Meta+2');
  check('Stable Cmd+2 returns to Chat independent of z-order', await page.locator('.window-chat.is-active').count()===1);
  await page.keyboard.press('F1');
  check('F1 opens the real Electron shortcut guide', await page.getByRole('dialog',{name:'Workspace shortcuts'}).isVisible());
  await page.keyboard.press('Meta+Shift+m');
  check('Model picker shortcuts cannot open underneath modal help', await page.locator('.model-picker-popover').count()===0);
  await page.keyboard.press('Escape');
  const visibleWindows=await page.locator('.os-window').count();
  await page.keyboard.press('Meta+Alt+d');
  check('Native Show desktop shortcut hides every visible window', await page.locator('.os-window').count()===0);
  await page.keyboard.press('Meta+Alt+d');
  check('Native desktop restore retains window count and maximized Chat', await page.locator('.os-window').count()===visibleWindows && await page.locator('.window-chat.is-maximized').count()===1);
  await page.keyboard.press('Meta+Alt+w');
  check('Native close-active shortcut respects the confirmation boundary', await page.getByRole('alertdialog').isVisible());
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Window actions for Chat / Code',exact:true}).click();
  check('Native window menu receives keyboard focus', await page.locator('.window-actions-menu').evaluate(e=>e.contains(document.activeElement)));
  await page.screenshot({ path: path.join(evidence,'electron-window-actions.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  await page.getByRole('option', { name: /Understory Grove/ }).click();
  check('Understory Grove opens in real Electron', await page.locator('.window-grove').isVisible());
  check('Grove mounts a live WebGL canvas', await page.locator('.grove-canvas').evaluate(e => { const probe = document.createElement('canvas'); return !!(probe.getContext('webgl2') || probe.getContext('webgl')) && e.clientWidth > 100; }));
  check('Grove bindings rail lists the real model roster', await page.locator('.grove-roster li').count() >= 3);
  const experiment = await page.evaluate(() => window.mapleDesktop.agent.runCommand('experiment.run', { experiment: 'pendulum', input: { length: 1, gravity: 9.81 }, hypothesis: 'smoke probe' }));
  check('World experiment runs deterministically through the agent command', experiment?.schema === 'hemlock.world.experiment.result.v1' && experiment?.experiment?.measured?.period > 1.9 && experiment?.experiment?.measured?.period < 2.1);
  check('World experiment returns a receipt path', typeof experiment?.receiptPath === 'string' && experiment.receiptPath.includes('experiments'));
  check('Experiment receipt carries a replayable measured trail', Array.isArray(experiment?.experiment?.trail?.points) && experiment.experiment.trail.points.length >= 2 && experiment.experiment.trail.points.length <= 96 && experiment.experiment.trail.axes.includes('theta'));
  // Front the grove mid-replay: Maple should be at the bench while the real
  // trail animates, before the 9.5s replay+fade window closes.
  await page.locator('.dock-item[aria-label^="Understory Grove,"]').click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(evidence, 'electron-grove-replay.png') });
  check('Lab replay readout surfaces the newest real run', await page.locator('.grove-lab-readout strong').textContent().then(t => t === 'pendulum').catch(() => false));
  const note = await page.evaluate(() => window.mapleDesktop.agent.runCommand('experiment.note', { claim: 'The pendulum period matched theory within integration error.' }));
  check('Experiment finding joins the Dream dataset', note?.schema === 'hemlock.world.finding.result.v1' && note?.datasetRows >= 1);
  const dataset = await page.evaluate(() => window.mapleDesktop.agent.runCommand('experiment.dataset', { limit: 5 }));
  check('Experiment dataset rows are readable with provenance', dataset?.count >= 1 && dataset?.rows?.at(-1)?.metadata?.source === 'experiment');
  // Autonomy controls: a submitted intent parks at approval; pause/resume is a
  // real state transition; campaign mode auto-approves and runs to terminal.
  const intent = await page.evaluate(() => window.mapleDesktop.agent.submitIntent({ text: 'Inspect the current project', source: 'smoke' }));
  const parkedStatus = intent?.task?.status;
  check('Intent parks at plan approval before work starts', parkedStatus === 'waiting_for_approval');
  const paused = await page.evaluate((id) => window.mapleDesktop.agent.runCommand('task.pause', { taskId: id }), intent?.task?.id);
  check('task.pause parks the task', paused?.status === 'paused');
  const resumed = await page.evaluate((id) => window.mapleDesktop.agent.runCommand('task.resume', { taskId: id }), intent?.task?.id);
  check('task.resume restores the pre-approval park', resumed?.status === 'waiting_for_approval');
  const approved = await page.evaluate((id) => window.mapleDesktop.agent.runCommand('plan.approve', { taskId: id }), intent?.task?.id);
  check('Approved plan drives the loop to a terminal or honest-blocked state', ['completed', 'blocked', 'waiting_for_user'].includes(approved?.status));
  const campaign = await page.evaluate(() => window.mapleDesktop.agent.submitIntent({ text: 'run a pendulum experiment', mode: 'campaign', source: 'smoke' }));
  check('Campaign intent auto-approves and runs to a terminal state', ['completed', 'blocked', 'failed'].includes(campaign?.status));
  const snapshot = await page.evaluate(() => window.mapleDesktop.agent.getState());
  check('Campaign auto-approval is recorded as an event', (snapshot?.events || []).some((event) => event.type === 'plan.auto_approved'));
  check('Scored-choice path engages in real Electron', (snapshot?.events || []).some((event) => event.type === 'action.scored'));
  const caps = await page.evaluate(() => window.mapleDesktop.agent.runCommand('agent.capabilities', {}));
  check('agent.capabilities self-describes the registry with input contracts', caps?.schema === 'hemlock.agent.capabilities.v1' && (caps?.commands || []).some((c) => c.commandId === 'improve.propose' && typeof c.inputHint === 'string' && c.inputHint.length));
  const proposal = await page.evaluate(() => window.mapleDesktop.agent.runCommand('improve.propose', { summary: 'smoke: verify the proposal lane', rationale: 'end-to-end smoke of the self-improvement surface', files: ['AGENTS.md'], confidence: 0.5 }));
  check('improve.propose records a durable scoped receipt', proposal?.status === 'proposed' && typeof proposal?.receiptPath === 'string' && (proposal?.evidenceRefs || []).includes('receipt://proposed-improvement'));
  await page.screenshot({ path: path.join(evidence,'electron-grove.png') });
  check('Native rendered controls have no unknown fallback icons', await page.locator('[data-icon=unknown]').count()===0);
  check('No Electron renderer exceptions', errors.length === 0);
} catch (error) {
  checks.push({ name: 'runner', passed: false, details: error.stack });
  process.exitCode = 1;
} finally {
  await app.close();
  await fs.writeFile(path.join(evidence, 'electron-results.json'), JSON.stringify({ checks, errors, isolatedData: data }, null, 2));
  console.log(JSON.stringify({ checks, errors, isolatedData: data }, null, 2));
}
