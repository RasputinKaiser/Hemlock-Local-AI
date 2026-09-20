// Audit-specific regressions. Uses isolated browser state and no inference.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.HEMLOCK_PLAYWRIGHT ? pathToFileURL(process.env.HEMLOCK_PLAYWRIGHT).href : 'playwright');
const output = path.resolve(process.env.HEMLOCK_GUI_OUTPUT || '/tmp/hemlock-audit-fixed');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.HEMLOCK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
function check(name, passed, evidence) { checks.push({ name, passed: !!passed, evidence }); assert.ok(passed, `${name}: ${JSON.stringify(evidence)}`); }
async function open(label) {
  const item = page.locator(`.dock-item[aria-label^="${label},"]`);
  if (await item.count()) await item.click();
  else {
    await page.getByRole('button', { name: 'Open all apps', exact: true }).click();
    await page.getByRole('textbox', { name: 'Find an app or window', exact: true }).fill(label);
    await page.locator('.overview-app').first().click();
  }
}
async function geometry() { return page.locator('.chat-surface').evaluate(e => Object.fromEntries(['.chat-scroll', '.chat-composer-area', '.chat-compose', '.chat-work-rail'].map(s => { const r=e.querySelector(s).getBoundingClientRect(); return [s,{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}]; }))); }
async function unobstructed(selector) { return page.locator(selector).evaluate(e => { const r=e.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return e===hit || e.contains(hit); }); }
try {
  await page.goto(process.env.HEMLOCK_GUI_URL || 'http://127.0.0.1:5178');
  await page.locator('.system-bar').waitFor();
  check('Idle home offers a direct start instead of empty monitors', await page.locator('.workspace-home').count() === 1);
  check('Idle dock has four frequent apps and All apps', await page.locator('.understory-dock > button').count() === 5);
  await page.screenshot({path:path.join(output,'home.png')});
  await open('Chat / Code');
  await page.getByRole('button',{name:'Build',exact:true}).click();
  check('Build does not automatically open evidence', await page.locator('#hemlock-chat-inspector').isHidden());
  check('Build leaves Send and input unobstructed', await unobstructed('.chat-compose button[type=submit]') && await unobstructed('.chat-compose textarea'));
  await page.getByRole('button',{name:'Resize Chat / Code from right',exact:true}).focus();
  for(let i=0;i<12;i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('button',{name:'Resize Chat / Code from bottom',exact:true}).focus();
  for(let i=0;i<12;i++) await page.keyboard.press('Shift+ArrowUp');
  let g=await geometry();
  check('Minimum Chat retains at least 180px reading space',g['.chat-scroll'].height>=180,g);
  check('Minimum empty composer stays under 150px',g['.chat-composer-area'].height<=150,g);
  await page.locator('.chat-inspector-toggle').click();
  check('Inspector moves focus to its close control',await page.getByRole('button',{name:'Close activity and evidence'}).evaluate(e=>e===document.activeElement));
  check('Compact inspector cannot intercept input or Send',await unobstructed('.chat-compose textarea') && await unobstructed('.chat-compose button[type=submit]'));
  await page.keyboard.press('Escape');
  check('Escape closes inspector and restores opener focus',await page.locator('#hemlock-chat-inspector').isHidden() && await page.locator('.chat-inspector-toggle').evaluate(e=>e===document.activeElement));
  await page.locator('.chat-inspector-toggle').click();
  await page.getByRole('button',{name:'Close activity and evidence'}).click();
  check('Pointer close also restores inspector opener',await page.locator('.chat-inspector-toggle').evaluate(e=>e===document.activeElement));
  await page.locator('.chat-inspector-toggle').click();
  await page.locator('.chat-compose textarea').click();
  check('Clicking composer dismisses compact evidence without stealing input focus',await page.locator('#hemlock-chat-inspector').isHidden() && await page.locator('.chat-compose textarea').evaluate(e=>e===document.activeElement));
  await page.screenshot({path:path.join(output,'chat-minimum.png')});
  for(const theme of ['paper','understory']) {
    if(theme==='understory') await page.locator('.system-understory').click();
    const ratio=await page.locator('.thread-switcher .status-lamp').evaluate(e=>{
      const rgb=s=>(s.match(/[\d.]+/g)||[]).map(Number);
      const fg=rgb(getComputedStyle(e).color),bg=rgb(getComputedStyle(e.closest('.thread-bar')).backgroundColor);
      const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });
    check(`Thread state passes AA in ${theme}`,ratio>=4.5,{ratio});
  }
  await page.setViewportSize({width:760,height:620});
  await page.getByRole('button',{name:'Maximize Chat / Code',exact:true}).click();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  g=await geometry();check('Compact native-size viewport keeps meaningful reading space',g['.chat-scroll'].height>=180,g);
  await page.locator('.chat-surface').evaluate(root=>{ const sizes=[root,...root.querySelectorAll('*')].map(e=>[e,parseFloat(getComputedStyle(e).fontSize)]); for(const [e,size] of sizes)e.style.fontSize=`${size*2}px`; });
  g=await geometry();check('200% text does not collapse the transcript',g['.chat-scroll'].height>=180,g);
  await page.locator('.chat-compose textarea').scrollIntoViewIfNeeded();
  check('Scaled composer remains reachable by scrolling',await unobstructed('.chat-compose textarea'));
  await page.screenshot({path:path.join(output,'chat-text200.png')});
  await page.reload();
  await page.setViewportSize({width:1440,height:900});
  await open('Settings');
  check('Settings groups tasks into four sections',await page.locator('.settings-workspace-nav button').count()===4);
  await page.screenshot({path:path.join(output,'settings.png')});
  await open('Dream Lab');
  check('Dream does not present invented loss curves',await page.locator('.dream-surface .dream-chart polyline').count()===0 && await page.locator('.dream-observation-empty').count()===1);
  check('No renderer errors',errors.length===0,errors);
} catch(error) { checks.push({name:'runner',passed:false,error:error.stack}); process.exitCode=1; await page.screenshot({path:path.join(output,'failure.png')}); }
finally { await fs.writeFile(path.join(output,'audit-regressions.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));await browser.close(); }
