// Isolated GUI controls test: no model requests, account actions or training.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.HEMLOCK_PLAYWRIGHT ? pathToFileURL(process.env.HEMLOCK_PLAYWRIGHT).href : 'playwright');
const output = path.resolve(process.env.HEMLOCK_GUI_OUTPUT || '/tmp/hemlock-controls-evidence');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.HEMLOCK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
function check(name,pass,evidence) { checks.push({name,passed:!!pass,evidence});assert.ok(pass,`${name}: ${JSON.stringify(evidence)}`); }
const dock=id=>page.locator(`.dock-item[data-window-id="${id}"]`);
async function menu() { await page.getByRole('button',{name:'Window actions for Chat / Code',exact:true}).click(); }
async function shot(name) { await page.screenshot({path:path.join(output,`${name}.png`),fullPage:true}); }
try {
  await page.goto(process.env.HEMLOCK_GUI_URL || 'http://127.0.0.1:5178');
  await page.locator('.workspace-home').waitFor();
  check('All apps and Windows use distinct semantic glyphs',await page.locator('.dock-command [data-icon=apps]').count()===1 && await page.locator('.workspace-overview-trigger [data-icon=windows]').count()===1);
  await dock('chat').click();
  await page.locator('.chat-compose textarea').fill('Unsent draft survives Show desktop');
  await page.getByRole('button',{name:'Maximize Chat / Code',exact:true}).click();
  check('Maximized control changes to a restore glyph',await page.locator('[aria-label="Restore Chat / Code"] [data-icon=restore]').count()===1);
  await menu();
  check('Window menu opens with keyboard focus inside',await page.locator('.window-actions-menu').evaluate(e=>e.contains(document.activeElement)));
  check('Window menu exposes all eight actions',await page.locator('.window-actions-menu [role=menuitem]').count()===8);
  await shot('window-actions');
  await page.keyboard.press('End');
  check('End reaches Close',await page.getByRole('menuitem',{name:/Close window/}).evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Home');
  await page.keyboard.press('c');
  check('Type-to-select reaches Center window',await page.getByRole('menuitem',{name:'Center window',exact:true}).evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Enter');
  check('Center action restores and centers the window',await page.locator('.window-chat').evaluate(e=>{const r=e.getBoundingClientRect(),c=e.parentElement.getBoundingClientRect();return !e.classList.contains('is-maximized')&&Math.abs((r.x-c.x)-(c.width-r.width)/2)<=1&&Math.abs((r.y-c.y)-(c.height-r.height)/2)<=1;}));
  await menu();await page.getByRole('menuitem',{name:'Reset size & position',exact:true}).click();
  check('Reset size uses the Chat preferred dimensions',await page.locator('.window-chat').evaluate(e=>e.getBoundingClientRect().width===880&&e.getBoundingClientRect().height===640));
  await menu();await page.getByRole('menuitem',{name:/Tile left/}).click();
  check('Menu tiling is functional',await page.locator('.window-chat').evaluate(e=>e.getBoundingClientRect().x<1&&e.getBoundingClientRect().width===720));
  await dock('chat').focus();await page.keyboard.press('Shift+F10');
  check('Keyboard opens the dock context menu',await page.locator('.window-actions-menu').isVisible());
  check('Dock context menu is entirely on screen',await page.locator('.window-actions-menu').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}));
  await page.keyboard.press('Escape');
  check('Menu Escape restores the dock opener',await dock('chat').evaluate(e=>e===document.activeElement));
  await page.getByRole('button',{name:'Maximize Chat / Code',exact:true}).click();
  await dock('artifact').click();await page.getByRole('button',{name:'Minimize Artifact Studio',exact:true}).click();
  await page.getByRole('button',{name:'Show desktop',exact:true}).click();
  check('Show desktop removes visible windows without closing them',await page.locator('.os-window').count()===0 && await page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('hemlock-os-windows-v2'))).filter(w=>w.state==='minimized').length===3));
  await shot('show-desktop');
  await page.getByRole('button',{name:'Restore workspace windows',exact:true}).click();
  check('Restore keeps originally minimized windows minimized',await page.locator('.window-artifact').count()===0 && await page.locator('.window-chat.is-maximized').count()===1);
  check('Show desktop preserves the unsent draft',await page.locator('.chat-compose textarea').inputValue()==='Unsent draft survives Show desktop');
  await page.getByRole('button',{name:'Show desktop',exact:true}).click();await page.reload();
  await page.getByRole('button',{name:'Restore workspace windows',exact:true}).click();
  check('Workspace restore is available after reload',await page.locator('.window-chat.is-maximized').count()===1 && await page.locator('.window-center').count()===1 && await page.locator('.window-artifact').count()===0);
  await page.getByRole('button',{name:'Open shortcut guide',exact:true}).click();
  check('Shortcut guide names the active window operations',await page.getByRole('dialog',{name:'Workspace shortcuts'}).isVisible());
  await shot('shortcut-guide');
  await page.keyboard.press('Shift+Tab');
  check('Shortcut guide traps keyboard focus',await page.locator('.shortcut-guide').evaluate(e=>e.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  check('Guide Escape restores its opener',await page.getByRole('button',{name:'Open shortcut guide',exact:true}).evaluate(e=>e===document.activeElement));
  await page.getByRole('button',{name:'Open shortcut guide',exact:true}).click();
  await page.locator('.shortcut-apps button').filter({hasText:'Settings'}).click();
  check('Shortcut guide app entries actually navigate',await page.locator('.window-settings.is-active .settings-workspace').isVisible());
  check('Settings navigation has four meaningful glyphs',await page.locator('.settings-workspace-nav [data-icon]').count()===4);
  await page.locator('.system-understory').click();
  check('Theme control advertises the reverse action',await page.locator('.system-understory [data-icon=sun]').count()===1);
  await page.getByRole('button',{name:'Open all apps',exact:true}).click();await shot('app-icons-understory');await page.keyboard.press('Escape');
  check('No fallback icons are used by the rendered workspace',await page.locator('[data-icon=unknown]').count()===0);
  await page.setViewportSize({width:760,height:620});await dock('chat').click();await menu();
  check('Action menu remains bounded at native minimum viewport',await page.locator('.window-actions-menu').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;}));
  await page.keyboard.press('Escape');
  check('No renderer exceptions',errors.length===0,errors);
} catch(error) {checks.push({name:'runner',passed:false,error:error.stack});process.exitCode=1;await shot('failure');}
finally {await fs.writeFile(path.join(output,'controls-results.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));await browser.close();}
