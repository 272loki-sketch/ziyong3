// Synthetic browser/state only; upstream assets and private runtime data are not loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);

test('MVU settings: native readiness precedes iframe load, rejects stale/foreign messages, and rewrites model discovery', { timeout: 60_000 }, async t => {
 let server, browser;
 const errors = [], requests = [], pendingResources = new Set();
 t.signal.addEventListener('abort',()=>{for(const res of pendingResources)res.destroy();server?.closeAllConnections?.();void browser?.close();},{once:true});
 const context = { scopeKey: 'synthetic-scope', sourceEntryId: 'synthetic-round', sessionId: 'synthetic-session', plugins: [{ id: 'helper', enabled: true, version: 'synthetic' }], mvu: { enabled: true, installed: true, model: { id: 'managed-synthetic-model' } } };
 try {
  const bundle = await build({
   stdin: { resolveDir: join(root, 'web'), loader: 'tsx', contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{OriginalTavernPluginManager}from'./src/components/TavernPluginsPanel.tsx';function Fixture(){const[tick,setTick]=useState(7);window.__nextContext=()=>setTick(x=>x+1);return <OriginalTavernPluginManager plugin={{id:'helper',name:'Synthetic helper',installed:true,enabled:true,version:'fixture',commit:'fixture-commit'}} mvu={{version:'synthetic-mvu',commit:'synthetic-mvu-commit'}} contextTick={tick} presentation="inline" onClose={()=>{}}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);` },
   bundle: true, format: 'esm', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const modules = {
   '/tavern-compat/bridge.js': `export const host={context:null,errors:[],chat:[],metadata:{},displayProjection:0,characters:[],async request(){return ${JSON.stringify(context)}},async bind(value){this.context=value},async flush(){},async save(){}};export const event_types={};export const eventSource={listeners:new Map(),makeFirst(){},on(){},async emit(){}};`,
   '/tavern-compat/i18n.js': 'export async function loadPluginLocales(){}',
   '/tavern-compat/native-resources.js': 'export function installNativeResources(){}',
   '/tavern-compat/settings-ui.js': 'export async function ensureManagerWorker(){return false;}export function installSettingsUI(){return {refresh(){},mvuReady(){return window.__settingsReady===true}}}',
   '/tavern-compat/vendor/yaml/index.js': 'export const synthetic=true;',
   '/tavern-compat/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js': `window.TavernHelper={getScriptTrees:({type})=>type==='global'?[{type:'script',enabled:true,content:'MagVarUpdate'}]:[],async waitGlobalInitialized(){}};window.Mvu={parseMessage(){}};window.__bootstrapReady=true;`,
   '/tavern-compat/scripts/extensions/third-party/JS-Slash-Runner/dist/index.css': '',
  };
  server = createServer((req, res) => { void (async () => {
   const url = new URL(req.url, 'http://localhost');
   const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
   if (url.pathname === '/') return send('text/html', '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
   if (url.pathname === '/fixture.js') return send('text/javascript', bundle.outputFiles[0].text);
   if (url.pathname === '/tavern-plugin-host.html') return send('text/html; charset=utf-8', '<!doctype html><div id="status">Loading synthetic settings</div><button id="native-setting">Synthetic native setting</button><img src="/pending-resource"><script type="module" src="/tavern-compat/host.js"></script>');
   // An unfinished real HTTP resource holds load pending, not host initialization.
   if (url.pathname === '/pending-resource') { pendingResources.add(res); res.on('close', () => pendingResources.delete(res)); res.writeHead(200, { 'content-type': 'image/png' }); res.flushHeaders(); return; }
   if (Object.hasOwn(modules, url.pathname)) return send(url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', modules[url.pathname]);
   if (['/tavern-compat/host.js', '/tavern-compat/mvu-adapter.js'].includes(url.pathname)) return send('text/javascript', await readFile(join(root, 'web/public', url.pathname), 'utf8'));
   if (url.pathname === '/api/tavern-plugins/mvu/models') {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: url.pathname, query: url.search, method: req.method, headers: req.headers, body: JSON.parse(body) });
    return send('application/json', JSON.stringify({ data: [{ id: 'synthetic-listed-model' }] }));
   }
   if (url.pathname !== '/favicon.ico') errors.push(`Unexpected request: ${req.method} ${url.pathname}`);
   res.writeHead(404); res.end();
  })().catch(error => { errors.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, '.liyuan-database-plugin/browser/headless_shell')) ? join(root, '.liyuan-database-plugin/browser/headless_shell') : undefined);
  const libs = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || join(root, '.liyuan-database-plugin/browser-libs/lib64');
  browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: libs }, args: ['--no-sandbox'] });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
   window.__loadCount = 0; window.addEventListener('load', () => window.__loadCount++);
   window.__readyMessages = [];
   window.addEventListener('message', event => { if (event.data?.type === 'liyuan-tavern-manager-ready' && event.isTrusted) window.__readyMessages.push(event.data); });
   window.__nativeRequests = [];
   const native = window.fetch.bind(window);
   window.fetch = (input, options) => { window.__nativeRequests.push({ url: String(input), credentials: options?.credentials ?? null }); return native(input, options); };
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : (errors.push('External resource blocked'), route.abort()));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const iframe = page.locator('.tavern-plugin-frame-wrap iframe');
  const currentFrame = async () => { const handle = await iframe.elementHandle(); return handle.contentFrame(); };
  let frame = await currentFrame();
  try { await frame.waitForFunction(() => window.__bootstrapReady); } catch (error) { console.error("MVU_BOOT_DIAGNOSTICS", JSON.stringify({ errors, status: await frame.locator("#status").textContent(), source: await iframe.getAttribute("src") })); throw error; }
  const assertLoading = async () => {
   assert.equal(await iframe.evaluate(node => node.inert), true);
   assert.equal(await iframe.getAttribute('aria-hidden'), 'true');
   assert.equal(await page.locator('.tavern-plugin-frame-state[role="alert"]').count(), 0);
  };
  await assertLoading();
  // Dispatch with explicit identities to test each guard independently of browser origin isolation.
  for (const invalid of ['origin', 'source', 'attempt', 'contextTick']) {
   for (const type of ['liyuan-tavern-manager-ready', 'liyuan-tavern-manager-error']) {
    await page.evaluate(({ invalid, type }) => {
     const frame = document.querySelector('iframe'), params = new URL(frame.src).searchParams;
     window.dispatchEvent(new MessageEvent('message', { origin: invalid === 'origin' ? 'https://foreign.invalid' : location.origin, source: invalid === 'source' ? window : frame.contentWindow, data: { type, attempt: invalid === 'attempt' ? '999' : params.get('attempt'), contextTick: invalid === 'contextTick' ? '999' : params.get('contextTick'), error: 'Invalid message must be ignored' } }));
    }, { invalid, type });
    await assertLoading();
   }
  }
  await page.evaluate(() => { window.__oldFrame = document.querySelector('iframe').contentWindow; });
  await page.getByRole('button', { name: '重新载入上游管理台' }).click();
  await page.waitForFunction(() => new URL(document.querySelector('iframe').src).searchParams.get('attempt') === '1');
  frame = await currentFrame(); await frame.waitForFunction(() => window.__bootstrapReady);
  await page.evaluate(() => window.__nextContext());
  await page.waitForFunction(() => document.querySelector('iframe').dataset.contextTick === '8');
  frame = await currentFrame(); await frame.waitForFunction(() => window.__bootstrapReady);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window.__oldFrame, data: { type: 'liyuan-tavern-manager-ready', attempt: '1', contextTick: '8' } })));
  await assertLoading();
  assert.ok(pendingResources.size > 0);
  assert.equal(await frame.evaluate(() => window.__loadCount), 0);
  await frame.evaluate(() => { window.__settingsReady = true; });
  await page.waitForFunction(() => document.querySelector('iframe').inert === false);
  assert.equal(await iframe.getAttribute('aria-hidden'), 'false');
  assert.equal(await page.locator('.tavern-plugin-frame-state').count(), 0);
  assert.equal(await frame.evaluate(() => window.LiyuanTavernPlugins.ready()), true);
  assert.deepEqual(await page.evaluate(() => window.__readyMessages), [{ type: 'liyuan-tavern-manager-ready', attempt: '1', contextTick: '8' }], 'actual host must report the current readiness binding');
  assert.equal(await frame.evaluate(() => window.__loadCount), 0, 'native settings readiness must unlock the parent without iframe load');
  assert.notEqual(await frame.evaluate(() => document.readyState), 'complete');
  await frame.locator('#native-setting').click();
  assert.equal(await frame.evaluate(() => document.activeElement.id), 'native-setting');

  const payload = { model: 'native-placeholder', reverse_proxy: 'https://synthetic-endpoint.invalid/v1', proxy_password: '', chat_completion_source: 'openai', custom_url: 'https://synthetic-custom.invalid/v1', custom_include_headers: '{}' };
  for (const asURL of [false, true]) {
   const response = await frame.evaluate(async ({ payload, asURL }) => {
    const path = '/api/backends/chat-completions/status?fixture=preserved';
    const response = await fetch(asURL ? new URL(path, location.href) : path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-synthetic-preserved': 'yes' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
   }, { payload, asURL });
   assert.deepEqual(response, { status: 200, body: { data: [{ id: 'synthetic-listed-model' }] } });
   const request = requests.at(-1);
   assert.equal(request.path, '/api/tavern-plugins/mvu/models');
   assert.equal(request.query, '?fixture=preserved');
   assert.equal(request.method, 'POST');
   assert.equal(request.headers['content-type'], 'application/json');
   assert.equal(request.headers['x-synthetic-preserved'], 'yes');
   assert.equal(request.headers['x-liyuan-tavern-scope'], context.scopeKey);
   assert.equal(request.headers['x-liyuan-tavern-source'], context.sourceEntryId);
   assert.deepEqual(request.body, { ...payload, model: context.mvu.model.id });
   assert.equal(request.headers.authorization, undefined);
   assert.equal(request.headers.cookie, undefined);
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(await frame.evaluate(() => window.__nativeRequests.map(request => request.credentials)), [null, null], 'host must not inject fetch credentials');
  assert.deepEqual(errors, []);
 } catch(error) { console.error('SYNTHETIC SETTINGS DIAGNOSTIC',error.message,JSON.stringify({errors,requests:requests.length,pending:pendingResources.size}));throw error; } finally {
  for (const res of pendingResources) res.destroy();
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
 }
});
