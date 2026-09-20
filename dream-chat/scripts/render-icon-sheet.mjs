// Render the actual icon registry at small and standard UI sizes for inspection.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importJsx } from '../src/testSupport/jsxLoader.js';
const { Icon, ICON_NAMES } = await importJsx(new URL('../src/components/Icons.jsx', import.meta.url));
const output=path.resolve(process.env.HEMLOCK_GUI_OUTPUT || '/tmp/hemlock-controls-evidence');
await fs.mkdir(output,{recursive:true});
const cells=ICON_NAMES.filter(name=>name!=='unknown').map(name=>`<article><div>${[16,20,28].map(size=>renderToStaticMarkup(React.createElement(Icon,{name,size}))).join('')}</div><span>${name}</span></article>`).join('');
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Hemlock iconography</title><style>*{box-sizing:border-box}body{margin:0;padding:36px;background:#f5f0e3;color:#1b3029;font-family:system-ui,sans-serif}header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid #c6d2bf;padding-bottom:18px;margin-bottom:24px}h1{font:500 32px Georgia,serif;margin:0}p{margin:0;color:#566a5c;font-size:13px}main{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:14px}article{padding:18px 12px;border:1px solid #c6d2bf;border-radius:8px;background:#fffdf6}article>div{display:flex;align-items:center;gap:14px;min-height:32px;color:#31543b}article>span{display:block;font-size:11px;color:#566a5c;margin-top:12px}footer{margin-top:24px;color:#566a5c;font-size:12px}</style><header><h1>Hemlock · Iconography</h1><p>Actual application glyphs · 16 / 20 / 28 px</p></header><main>${cells}</main><footer>Distinct app silhouettes. Consistent 24px grid. Meaningful state and action symbols.</footer></html>`;
await fs.writeFile(path.join(output,'icon-sheet.html'),html);
if(process.env.HEMLOCK_PLAYWRIGHT){const {chromium}=await import(pathToFileURL(process.env.HEMLOCK_PLAYWRIGHT).href);const browser=await chromium.launch({executablePath:process.env.HEMLOCK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{const page=await browser.newPage({viewport:{width:1280,height:1000}});await page.setContent(html);await page.screenshot({path:path.join(output,'icon-sheet.png'),fullPage:true});}finally{await browser.close();}}
console.log(JSON.stringify({registrySize:ICON_NAMES.length,displayed:ICON_NAMES.filter(name=>name!=='unknown').length,output}));
