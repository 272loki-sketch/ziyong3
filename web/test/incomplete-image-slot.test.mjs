import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
const tail = '<image>【标题】\n<unknown-meta><div><div>synthetic metadata</div><script>window.__metadataExecuted=true</script></div></unknown-meta>\nimage###Scene Composition:1girl,1boy;\n多行中文说明;\nCharacter 1 Prompt:blue coat|centers:b3; Character 1 UC:blur; Character 2 Prompt:$synthetic-from front-sfw-upperBody$, brown coat';
const full = `<image>【完整】image###tree###</image>\n合成正文。\n${tail}`;

// Actual RichContent and its effects, served from an in-memory synthetic bundle.
// No application host, production data, model endpoints or saved media are used.
test('historical RichContent images: desktop/mobile, read-only lookups and no paid requests', { timeout: 60000 }, async () => {
 const bundle = await build({ stdin: { contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RichContent,ReadOnlyMessagesContext} from './src/components/Messages.tsx';
import {prepareDisplayText} from '../src/postprocess.ts';
const tail=${JSON.stringify(tail)}, full=${JSON.stringify(full)};
createRoot(document.getElementById('root')).render(<>
 <section id="normal"><RichContent text={prepareDisplayText(tail)}/></section>
  <section id="complete"><RichContent text="<image>【完整提示】image###cloud###</image>"/></section>
  <section id="browser-cache"><RichContent text="<image>【浏览器旧图】image###cached###</image>"/></section>
 <section id="mixed"><ReadOnlyMessagesContext.Provider value={true}><RichContent text={prepareDisplayText(full)}/></ReadOnlyMessagesContext.Provider></section>
</>);`, resolveDir: join(root, 'web'), loader: 'tsx' }, bundle: true, format: 'esm', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, logLevel: 'silent' });
 const css = await readFile(join(root, 'web/src/app.css'), 'utf8');
 const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><div id="root" class="msg-body"></div><script type="module" src="/fixture.js"></script></body></html>';
 const calls = [], errors = [], forbidden = [];
 const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
   calls.push(`${req.method} ${path}`);
    assert.equal(`${req.method} ${path}`, 'GET /api/historical-images');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ src: new URL(req.url, 'http://localhost').searchParams.get('prompt')?.includes('cloud') ? '/media/server.png' : null }));
   }
   if (path === '/media/server.png' || path === '/media/browser.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
   }
  const files = { '/': [html, 'text/html'], '/fixture.js': [bundle.outputFiles[0].text, 'text/javascript'], '/fixture.css': [css, 'text/css'] };
  if (files[path]) { res.writeHead(200, { 'content-type': files[path][1] }); return res.end(files[path][0]); }
  res.writeHead(404); res.end();
 });
 let browser;
 try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, '.liyuan-database-plugin/browser/headless_shell')) ? join(root, '.liyuan-database-plugin/browser/headless_shell') : undefined);
  const libs = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || join(root, '.liyuan-database-plugin/browser-libs/lib64');
  browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: libs }, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
   const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    const page = await context.newPage();
    await page.addInitScript(() => {
     localStorage.setItem('liyuan:nai:【浏览器旧图】image###cached###', '/media/browser.png');
     window.__cacheBefore = JSON.stringify({ ...localStorage });
    });
   page.on('pageerror', error => errors.push(error.message));
   await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { forbidden.push(route.request().url()); return route.abort(); }
    return route.continue();
   });
   await page.goto(base, { waitUntil: 'domcontentloaded' });
    const slot = page.locator('#normal .historical-image-slot details');
   await slot.waitFor();
   assert.equal(await slot.count(), 1);
   assert.equal(await slot.getAttribute('open'), null);
    assert.equal(await slot.locator('summary').textContent(), '历史图片提示 · 标题');
   assert.equal(await page.locator('#normal button, #normal img').count(), 0);
   assert.equal(await page.locator('#normal iframe').count(), 0);
   assert.equal(await page.evaluate(() => window.__metadataExecuted), undefined);
    await page.locator('#complete img').waitFor();
    assert.equal(await page.locator('#complete img').getAttribute('src'), '/media/server.png');
    assert.equal(await page.locator('#browser-cache img').getAttribute('src'), '/media/browser.png');
    assert.equal(await page.locator('button').count(), 0);
    assert.equal(await page.locator('#mixed .historical-image-slot').count(), 2);
    assert.equal(await page.locator('#mixed .historical-image-slot details').count(), 2);
   await slot.locator('summary').click();
   assert.equal(await slot.locator('pre').textContent(), tail);
   assert.equal(await page.locator('#normal').evaluate(el => [...el.querySelectorAll('p')].some(p => /Scene Composition|Character 1 Prompt/.test(p.textContent))), false);
   await slot.locator('summary').click();
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }) === window.__cacheBefore), true);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#complete img').waitFor();
    assert.equal(await page.locator('#browser-cache img').getAttribute('src'), '/media/browser.png');
   await context.close();
  }
    assert.equal(calls.length, 8, 'two server lookups per viewport and reload; browser cache and incomplete slots never query');
    assert.ok(calls.every(call => call === 'GET /api/historical-images'));
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
 } finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
 }
});
