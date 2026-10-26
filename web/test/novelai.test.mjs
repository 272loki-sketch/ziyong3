import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const scope = 'a'.repeat(64), image = `/media/nai-${'c'.repeat(64)}.png`;
const initialConfig = { enabled: false, baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full', sampler: 'k_dpmpp_2m', scheduler: 'karras', steps: 28, scale: 10, cfgRescale: 0.18, width: 1024, height: 1024, positivePrefix: '', positiveSuffix: '', negativePrompt: '' };

test('NovelAI desktop/mobile: explicit settings, manual generation, readonly/incomplete guards, reload cache and no browser Key storage', { timeout: 90_000 }, async () => {
 const bundle = await build({ stdin: { contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{RichContent,ReadOnlyMessagesContext}from'./src/components/Messages.tsx';
import{TavernEntryContext}from'./src/components/TavernMessageFrame.tsx';
import{NovelAiSection}from'./src/components/NovelAiSection.tsx';
function Fixture(){const[show,setShow]=useState(true);return <>
<TavernEntryContext.Provider value={{entryId:'story-a',entryScope:${JSON.stringify(scope)}}}>
<section id="active">{show&&<RichContent text="<image>image###tree###</image>"/>}</section>
<section id="readonly"><ReadOnlyMessagesContext.Provider value={true}><RichContent text="<image>image###readonly tree###</image>"/></ReadOnlyMessagesContext.Provider></section>
<section id="incomplete"><RichContent text="<image>image###Scene Composition: truncated tree"/></section>
</TavernEntryContext.Provider>
<section id="unbound"><RichContent text="<image>image###unbound tree###</image>"/></section>
<section id="legacy"><RichContent text="<image>【旧图】image###legacy###</image>"/></section>
<button id="hide" onClick={()=>setShow(false)}>hide</button><button id="show" onClick={()=>setShow(true)}>show</button>
<NovelAiSection toast={()=>{}}/>
</>};createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: join(root, 'web'), loader: 'tsx' }, bundle: true, format: 'esm', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, logLevel: 'silent' });
 const css = await readFile(join(root, 'web/src/app.css'), 'utf8');
 let config, revision, keyConfigured, cached, paid = 0, mode = 'normal', waiting;
 const errors = [], calls = [], secrets = [];
 const reset = () => { config = { ...initialConfig }; revision = 'r1'; keyConfigured = false; cached = false; paid = 0; mode = 'normal'; waiting = undefined; };
 reset();
 const status = () => ({ config, revision, apiKeyConfigured: keyConfigured, legacySettings: false, binding: { scopeKey: scope } });
 const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><div id="root" class="panel-body"></div><script type="module" src="/fixture.js"></script></body></html>';
 const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) calls.push(`${req.method} ${url.pathname}`);
  if (url.pathname === '/api/historical-images') return json({ src: null });
  if (url.pathname === '/api/novelai/cached') return json({ src: cached && url.searchParams.get('prompt') === 'image###tree###' ? image : null });
  if (url.pathname === '/api/novelai' && req.method === 'GET') return json(status());
  if (url.pathname === '/api/novelai' && req.method === 'PUT') {
   const chunks = []; for await (const part of req) chunks.push(part);
   const input = JSON.parse(Buffer.concat(chunks));
   assert.equal(input.revision, revision); assert.equal(input.binding.scopeKey, scope);
   secrets.push(input.apiKey); config = Object.fromEntries(Object.keys(initialConfig).map(key => [key, input[key]])); keyConfigured ||= !!input.apiKey; revision = 'r2'; return json(status());
  }
  if (url.pathname === '/api/novelai/generate' && req.method === 'POST') {
   paid++;
   const chunks = []; for await (const part of req) chunks.push(part);
   const input = JSON.parse(Buffer.concat(chunks));
   assert.equal(input.entryId, 'story-a'); assert.equal(input.entryScope, scope); assert.equal(input.revision, revision);
   assert.equal(input.apiKey, undefined); assert.equal(config.enabled, true);
   if (mode === 'pending') { waiting = () => { if (!res.destroyed) json({ src: image, bytes: PNG.length }); }; return; }
   cached = true; return json({ src: image, bytes: PNG.length });
  }
  if (url.pathname.startsWith('/media/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  const scopedHtml = url.searchParams.has('slot') ? html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="liyuan-workspace" content="11111111-1111-4111-8111-111111111111"><meta name="liyuan-workspace-lease" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">') : html;
  const file = { '/': [scopedHtml, 'text/html'], '/fixture.js': [bundle.outputFiles[0].text, 'text/javascript'], '/fixture.css': [css, 'text/css'] }[url.pathname];
  if (file) { res.writeHead(200, { 'content-type': file[1] }); return res.end(file[0]); }
  res.writeHead(404); res.end();
 });
 let browser;
 try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, '.liyuan-database-plugin/browser/headless_shell')) ? join(root, '.liyuan-database-plugin/browser/headless_shell') : undefined);
  browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || join(root, '.liyuan-database-plugin/browser-libs/lib64') }, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
   reset();
   const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
   const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
   await page.addInitScript(() => { localStorage.setItem('liyuan:nai:【旧图】image###legacy###', '/media/legacy.png'); window.__before = JSON.stringify({ ...localStorage }); });
   await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
   await page.goto(base, { waitUntil: 'networkidle' });
   assert.equal(paid, 0);
   assert.equal(await page.locator('#legacy img').getAttribute('src'), '/media/legacy.png');
   assert.equal(await page.locator('#readonly button,#incomplete button,#unbound button').count(), 0);
   await page.locator('#active .nai-generate-btn').click();
   await page.locator('#active [role="alert"]').waitFor(); assert.equal(paid, 0);
   const settings = page.locator('.nai-settings');
   await settings.locator('input[type="password"]').fill('synthetic-browser-key');
   await settings.locator('button.toggle').click();
   await settings.getByRole('button', { name: '保存生图设置' }).click();
   await page.waitForFunction(() => document.querySelector('.nai-settings input[type="password"]')?.placeholder.startsWith('已配置'));
   assert.equal(await settings.locator('input[type="password"]').inputValue(), '');
   await page.locator('#active .nai-generate-btn').click(); await page.locator('#active img').waitFor();
   assert.equal(paid, 1); assert.equal(await page.locator('#active img').getAttribute('src'), image);
   await page.reload({ waitUntil: 'networkidle' }); await page.locator('#active img').waitFor(); assert.equal(paid, 1);
   assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }) === window.__before), true);
   assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage }).includes('synthetic-browser-key')), false);
   // Unmounting an active request discards its result and never retries on remount.
   cached = false; mode = 'pending';
   await page.locator('#hide').click(); await page.locator('#show').click();
   await page.locator('#active .nai-generate-btn').click();
   await page.waitForFunction(() => document.querySelector('#active .nai-generate-btn')?.textContent.includes('生图中'));
   for (let i = 0; !waiting && i < 50; i++) await new Promise(r => setTimeout(r, 10));
   assert.equal(paid, 2);
   await page.locator('#hide').click(); waiting?.(); await page.locator('#show').click();
   await page.waitForTimeout(150);
   assert.equal(await page.locator('#active img').count(), 0); assert.equal(paid, 2);
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
   cached = true; mode = 'normal';
   await page.goto(`${base}/?slot=1`, { waitUntil: 'networkidle' });
   await page.locator('#active img').waitFor();
   assert.match(await page.locator('#active img').getAttribute('src'), /liyuanWorkspace=11111111-1111-4111-8111-111111111111/);
   assert.match(await page.locator('#active img').getAttribute('src'), /liyuanLease=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
   assert.equal(await page.locator('#legacy img').count(), 0, 'parallel workspace must not read primary legacy browser image URLs');
   assert.equal(paid, 2);
   await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(secrets, ['synthetic-browser-key', 'synthetic-browser-key']);
  assert.ok(calls.filter(call => call === 'POST /api/novelai/generate').length === 4);
 } finally { waiting?.(); await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
