import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importJsx } from "../testSupport/jsxLoader.js";
import { createServer } from "vite";
import { pathToFileURL } from "node:url";
const { copyExactText, CopyMessageButton } = await importJsx(new URL("./CopyMessageButton.jsx", import.meta.url));

test("clipboard copies exact whitespace and line breaks, not a trimmed paraphrase", async () => {
  const calls = [];
  const text = "  Exact model text.\nSecond line.\n";
  await copyExactText(text, { writeText: async value => calls.push(value) });
  assert.deepEqual(calls, [text]);
});

test("empty text and unavailable clipboard fail explicitly", async () => {
  await assert.rejects(copyExactText(" \n", null), /no text/);
  await assert.rejects(copyExactText("text", null), /unavailable/);
  await assert.rejects(copyExactText("text", { writeText: async () => { throw new Error("Permission denied"); } }), /Permission denied/);
});

test("copy control has an accessible name, feedback channel and honest disabled state", () => {
  const empty = renderToStaticMarkup(React.createElement(CopyMessageButton, { text: "" }));
  assert.match(empty, /disabled/);
  const ready = renderToStaticMarkup(React.createElement(CopyMessageButton, { text: "Actual fixture" }));
  assert.match(ready, /Copy message \(Option-click to include provenance\)/);
  assert.match(ready, /data-icon="copy"/);
  assert.match(ready, /aria-live="polite"/);
  assert.doesNotMatch(ready, /disabled/);
});

test("browser: copy feedback, Option provenance and rejected clipboard recover correctly", { skip: !process.env.HEMLOCK_PLAYWRIGHT }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.HEMLOCK_PLAYWRIGHT).href);
  const id = "\0copy-control-fixture";
  const server = await createServer({ root: new URL("../../", import.meta.url).pathname, configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "copy-control-fixture",
    resolveId(value) { if (value === id) return id; },
    load(value) {
      if (value !== id) return;
      return `import React from 'react';import {createRoot} from 'react-dom/client';import {CopyMessageButton} from '/src/components/CopyMessageButton.jsx';
        window.copied=[];window.rejectCopy=false;
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(window.rejectCopy)throw new Error('Fixture permission denied');window.copied.push(text)}}});
        createRoot(document.getElementById('fixture')).render(React.createElement(CopyMessageButton,{text:'  Clipboard fixture\\n',provenanceText:'[Fixture provenance]\\n\\n  Clipboard fixture\\n'}));`;
    },
    configureServer(vite) { vite.middlewares.use('/__copy-test.html', async (_req,res) => { res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__copy-test.html','<html><body><div id="fixture"></div><script type="module" src="/@id/__x00__copy-control-fixture"></script></body></html>')); }); },
  }] });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.HEMLOCK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__copy-test.html`);
    const button=page.getByRole('button',{name:'Copy message (Option-click to include provenance)',exact:true});
    await button.click();
    await page.getByText('Copied to clipboard',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.copied), ['  Clipboard fixture\n']);
    await button.click({modifiers:['Alt']});
    await page.waitForFunction(()=>window.copied.length===2);
    assert.equal(await page.evaluate(()=>window.copied[1]), '[Fixture provenance]\n\n  Clipboard fixture\n');
    await page.evaluate(()=>{window.rejectCopy=true;});
    await button.click();
    await page.getByText('Copy failed. Select the message and copy manually.',{exact:true}).waitFor();
    assert.equal(await button.isDisabled(),false);
    await page.evaluate(()=>{window.rejectCopy=false;});
    await button.click();
    await page.getByText('Copied to clipboard',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.copied.length),3);
  } finally { await browser?.close();await server.close(); }
});
