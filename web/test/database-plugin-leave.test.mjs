// Real React wrapper and database host; the upstream UI/API are loopback-only synthetic fixtures.
// No installed upstream bytes, private settings, stories, credentials or models are loaded.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
const hostRoot = process.env.LIYUAN_DATABASE_MANAGER_DIST || join(root, 'web/public');
const gate = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
const pause = ms => new Promise(done => setTimeout(done, ms));

// LiyuanDatabasePluginHost.flush returns true, rather than a void result.
test('database adapter waits for flush and retains a rejected save', async () => {
 const bundle = await build({ entryPoints: [join(root, 'web/src/plugins/usePluginLeave.tsx')], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', write: false, logLevel: 'silent' });
 const { flushPluginFrame } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
 const saved = gate(); let finished = false, calls = 0;
 const frame = { contentWindow: { LiyuanDatabasePluginHost: { flush: async () => { calls++; await saved.promise; return true; } } }, getAttribute: () => 'false' };
 const leaving = flushPluginFrame(frame).then(() => { finished = true; }, error => { throw new Error(error.message); });
 void leaving.catch(() => {});
 await pause(0); assert.equal(calls, 1); assert.equal(finished, false);
 saved.release(); await leaving; assert.equal(finished, true);
 frame.contentWindow.LiyuanDatabasePluginHost.flush = async () => { throw Error('synthetic database CAS conflict'); };
 await assert.rejects(flushPluginFrame(frame), /synthetic database CAS conflict/);
});

test('database manager save-before-leave and source guards in desktop/mobile browsers', { timeout: 120_000 }, async t => {
 const work = await mkdtemp(join(tmpdir(), 'liyuan-database-leave-'));
 let browser, server;
 const state = { source: 'source-A', metadata: {}, outcome: 'success', hold: null, writes: [], commits: [], loads: [], revision: 0, bindingFails: false };
 const errors = [], forbidden = [];
 const binding = () => ({ scopeKey: 'synthetic-scope', sourceEntryId: state.source, sha256: 'synthetic-host-source', streaming: false });
 const context = () => ({ ...binding(), revision: state.revision, scope: { sessionId: 'synthetic-session' }, chat: [], chatMetadata: state.metadata, extensionSettings: {}, worldbooks: { Fixture: { entries: [] } }, primaryBook: 'Fixture', character: { name: 'Synthetic' }, userName: 'Fixture' });
 const syntheticUpstream = `
window.syntheticFlushCalls=0;
// Match the pinned upstream CHAT_CHANGED hydration task that the real host joins.
const context=window.SillyTavern.getContext();
context.eventSource.on(context.eventTypes.CHAT_CHANGED,()=>{setTimeout(()=>{},1200);});
const originalFlush=window.LiyuanDatabasePluginHost.flush;
window.LiyuanDatabasePluginHost.flush=function(){window.syntheticFlushCalls++;return originalFlush.call(this);};
window.AutoCardUpdaterAPI={triggerUpdate:async()=>({success:true}),refreshDataAndWorldbook:async()=>{},exportTableAsJson:()=>({})};
window.AutoCardUpdaterV2API={open:async()=>{
 const input=document.createElement('input');input.id='synthetic-edit';input.setAttribute('aria-label','Synthetic database setting');
 input.addEventListener('blur',()=>{const ctx=window.SillyTavern.getContext();ctx.chatMetadata.syntheticValue=input.value;void ctx.saveChat().catch(()=>{});});
 document.body.append(input);return true;
},openVisualizer:async()=>true,refreshVisualizer:async()=>{}};`;
 try {
  await build({ stdin: { resolveDir: join(root, 'web'), loader: 'tsx', contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{DatabasePluginManager}from'./src/components/DatabasePluginManager.tsx';import './src/app.css';import './src/npc-parallel.css';
function Fixture(){const[open,setOpen]=useState(true),[busy,setBusy]=useState(false),[tick,setTick]=useState(0);window.__busy=setBusy;window.__advance=()=>setTick(x=>x+1);return <><main id="story">Synthetic story<button onClick={()=>setOpen(true)}>reopen</button></main>{open&&<DatabasePluginManager busy={busy} contextTick={tick} onClose={()=>{window.__closes++;setOpen(false);}}/>}</>}
window.__closes=0;createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle: true, format: 'esm', jsx: 'automatic', outfile: join(work, 'fixture.js'), logLevel: 'silent' });
  const hostScript = await readFile(join(hostRoot, 'database-plugin-host.js'));
  const hostHtml = await readFile(join(hostRoot, 'database-plugin-host.html'), 'utf8');
  server = createServer(async (req, res) => {
   try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, value) => { if (!res.destroyed) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); } };
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>'); }
    if (['/fixture.js', '/fixture.css'].includes(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' }); return res.end(await readFile(join(work, url.pathname.slice(1)))); }
    if (url.pathname === '/database-plugin-host.html') { state.loads.push(url.searchParams.get('sourceEntryId')); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(hostHtml); }
    if (url.pathname === '/database-plugin-host.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(hostScript); }
    if (url.pathname === '/api/database-plugin/status') return json(200, { sourceReady: true, config: { enabled: true } });
    if (url.pathname === '/api/database-plugin/binding') return state.bindingFails ? json(503, { error: 'synthetic binding unavailable' }) : json(200, binding());
    if (url.pathname === '/api/database-plugin/context') return json(200, context());
    if (url.pathname === '/api/database-plugin/vendor/jquery.min.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('/* Synthetic empty dependency: the host itself never calls jQuery. */'); }
    if (url.pathname === '/api/database-plugin/source/index.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(syntheticUpstream); }
    if (url.pathname === '/api/database-plugin/state' && req.method === 'POST') {
     let raw = ''; for await (const part of req) raw += part;
     const body = JSON.parse(raw), outcome = state.outcome, hold = state.hold;
     const record = { body, finished: false }; state.writes.push(record);
     if (hold) await hold.promise;
     record.finished = true;
     if (body.scopeKey !== 'synthetic-scope' || body.sourceEntryId !== state.source) return json(409, { error: 'synthetic source changed; save rejected' });
     if (outcome === 'failure') return json(409, { error: 'synthetic database CAS conflict' });
     state.metadata = structuredClone(body.state.chatMetadata); state.commits.push(body); state.revision++;
     return json(200, { globalRevision: state.revision });
    }
    if (url.pathname !== '/favicon.ico') forbidden.push(`${req.method} ${url.pathname}`);
    res.writeHead(404); res.end();
   } catch (error) { errors.push(error.message); if (!res.headersSent) res.writeHead(500); if (!res.destroyed) res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE ? { executablePath: process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? '' }, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  t.signal.addEventListener('abort', () => { state.hold?.release(); void browser?.close(); server.closeAllConnections(); }, { once: true });
  const waitWrite = async () => { for (let i = 0; !state.writes.length && i < 100; i++) await pause(10); assert.equal(state.writes.length, 1); };
  for (const width of [1280, 390]) {
    for (const scenario of ['close', 'escape', 'reload', 'failure', 'timeout-late', 'timeout-discard', 'source-poll', 'source-context', 'readonly-failure', 'sync-contract', 'binding-outage', 'busy-idle-draft']) await t.test(`${width}px ${scenario}`, async () => {
     state.source = 'source-A'; state.metadata = { retained: { value: 'old' }, removed: { value: 'stale' } }; state.revision = 0; state.bindingFails = false;
    state.outcome = ['failure', 'readonly-failure'].includes(scenario) ? 'failure' : 'success';
    state.hold = scenario === 'sync-contract' ? null : gate(); state.writes = []; state.commits = []; state.loads = [];
    const held = state.hold;
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' }); page.setDefaultTimeout(5_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (forbidden.push('external request'), route.abort()));
    await page.addInitScript(() => {
     if (window.top !== window) return;
     const nativeTimeout = window.setTimeout.bind(window), nativeInterval = window.setInterval.bind(window), nativeClear = window.clearInterval.bind(window);
     const polls = new Map(); let id = 0;
     window.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 15_000 && window.__leaveTimeoutMs ? window.__leaveTimeoutMs : ms, ...args);
     window.setInterval = (fn, ms, ...args) => { if (ms !== 2500) return nativeInterval(fn, ms, ...args); polls.set(--id, fn); return id; };
     window.clearInterval = id => polls.delete(id) || nativeClear(id);
     window.__pollBinding = () => { for (const fn of polls.values()) fn(); };
    });
    try {
     await page.goto(origin);
     const manager = page.getByRole('dialog', { name: '数据库管理台', exact: true });
     const iframe = page.locator('iframe[title="原数据库插件管理台"]');
     await page.waitForFunction(() => { const frame = document.querySelector('iframe'); return frame?.contentWindow?.LiyuanDatabasePluginHost?.ready() && !document.querySelector('.database-manager__state'); });
     await page.evaluate(() => { window.initialDatabaseFrame = document.querySelector('iframe'); });
      const frame = await (await iframe.elementHandle()).contentFrame();
      assert.equal(await frame.evaluate(() => window.syntheticFlushCalls), 1, 'host joins hydration and flushes before readiness');
      await frame.evaluate(() => { window.syntheticFlushCalls = 0; });
      const box = await manager.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
      if (scenario === 'binding-outage' || scenario === 'busy-idle-draft') {
       await frame.locator('#synthetic-edit').fill('draft survives status checks');
       if (scenario === 'binding-outage') {
        state.bindingFails = true;
        await page.evaluate(() => window.__pollBinding());
        await page.getByRole('alert').filter({ hasText: 'synthetic binding unavailable' }).waitFor();
        assert.equal(await iframe.evaluate(element => element.inert), true);
        assert.equal(await page.evaluate(() => document.querySelector('iframe') === window.initialDatabaseFrame), true);
        assert.equal(await frame.locator('#synthetic-edit').inputValue(), 'draft survives status checks');
        state.bindingFails = false;
        await page.getByRole('button', { name: '重新核对分支', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'synthetic binding unavailable' }).waitFor({ state: 'detached' });
       } else {
        await page.evaluate(() => window.__busy(true));
        await page.waitForFunction(() => document.querySelector('iframe')?.inert === true);
        await page.evaluate(() => window.__busy(false));
       }
       await page.waitForFunction(() => document.querySelector('iframe')?.inert === false);
       assert.equal(await page.evaluate(() => document.querySelector('iframe') === window.initialDatabaseFrame), true, 'same binding must retain the editing realm');
       assert.equal(await frame.locator('#synthetic-edit').inputValue(), 'draft survives status checks');
       assert.equal(state.loads.length, 1, 'status-only changes must not reload upstream');
       return;
      }
     if (scenario === 'sync-contract') {
      await frame.evaluate(() => { window.savedMetadata = window.SillyTavern.getContext().chatMetadata; });
      state.metadata = { retained: { value: 'current' } };
      await frame.evaluate(() => window.LiyuanDatabasePluginHost.sync());
      assert.deepEqual(await frame.evaluate(() => ({ sameReference: window.savedMetadata === window.SillyTavern.getContext().chatMetadata, retained: window.savedMetadata.retained, hasRemoved: Object.hasOwn(window.savedMetadata, 'removed') })), { sameReference: true, retained: { value: 'current' }, hasRemoved: false });
      await frame.evaluate(() => window.SillyTavern.getContext().saveChat());
      assert.equal(Object.hasOwn(state.commits.at(-1).state.chatMetadata, 'removed'), false);
      state.source = 'source-B';
      const message = await frame.evaluate(async () => { try { await window.LiyuanDatabasePluginHost.sync(); return ''; } catch (error) { return error.message; } });
      assert.match(message, /分支需重新载入/);
      assert.deepEqual(await frame.evaluate(() => window.LiyuanDatabasePluginHost.binding()), { scopeKey: 'synthetic-scope', sourceEntryId: 'source-A' });
      return;
     }
     if (scenario.startsWith('timeout')) await page.evaluate(() => { window.__leaveTimeoutMs = 120; });
     await frame.locator('#synthetic-edit').evaluate(element => { element.focus(); element.value = 'synthetic edited value'; });
     if (scenario === 'escape') await manager.dispatchEvent('keydown', { key: 'Escape', bubbles: true });
     else await manager.getByRole('button', { name: scenario === 'reload' ? '刷新' : '返回对话', exact: true }).click();
     await waitWrite();
     await page.getByRole('status').filter({ hasText: '正在等待原数据库设置保存确认' }).waitFor();
     assert.equal(await iframe.evaluate(element => element.inert), true);
     assert.equal(await frame.evaluate(() => window.syntheticFlushCalls), 1);
     assert.equal(await page.evaluate(() => window.__closes), 0);
     if (scenario === 'source-poll' || scenario === 'source-context') {
      state.source = 'source-B';
      await page.evaluate(scenario => scenario === 'source-poll' ? window.__pollBinding() : window.__advance(), scenario);
      await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.LiyuanDatabasePluginHost?.binding()?.sourceEntryId === 'source-B' && document.querySelector('iframe')?.contentWindow?.LiyuanDatabasePluginHost?.ready());
      held.release(); await pause(80);
      assert.equal(await page.evaluate(() => window.__closes), 0, 'old source save must not close the new source');
      assert.equal(state.commits.length, 0, 'old source save must not publish into a new source');
      assert.equal(await page.getByRole('alert').count(), 0, 'old save failure must not become the new frame error');
      state.hold = null;
      await manager.getByRole('button', { name: '返回对话', exact: true }).click();
      await manager.waitFor({ state: 'detached' });
      return;
     }
     if (scenario === 'readonly-failure') await page.evaluate(() => window.__busy(true));
     if (scenario === 'failure' || scenario === 'readonly-failure') held.release();
     if (scenario.startsWith('timeout') || scenario === 'failure' || scenario === 'readonly-failure') {
      const error = page.locator('.npc-parallel-feedback[role="alert"]').filter({ hasText: scenario.startsWith('timeout') ? '等待保存确认超时' : 'synthetic database CAS conflict' });
      await error.waitFor();
      assert.match(await error.innerText(), /不.*取消|不会.*取消/);
      assert.equal(await iframe.evaluate(element => element.inert), scenario === 'readonly-failure');
      await manager.getByRole('button', { name: '返回对话', exact: true }).click();
      assert.equal(await frame.evaluate(() => window.syntheticFlushCalls), 1, 'failed close must not silently retry a save');
      if (scenario === 'timeout-late') {
       held.release(); for (let i = 0; !state.commits.length && i < 100; i++) await pause(10);
       assert.equal(state.commits.length, 1); assert.equal(await page.evaluate(() => window.__closes), 0, 'late save may commit, but cannot navigate after timeout');
       return;
      }
      const discard = page.getByRole('button', { name: '放弃未确认的更改并离开', exact: true });
      page.once('dialog', dialog => dialog.dismiss()); await discard.click();
      assert.equal(await page.evaluate(() => window.__closes), 0);
      page.once('dialog', dialog => dialog.accept()); await discard.click();
      await manager.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.__closes), 1);
      if (scenario === 'timeout-discard') {
       held.release(); for (let i = 0; !state.writes[0].finished && i < 100; i++) await pause(10);
       assert.equal(state.commits.length, 1, 'discarding the UI does not cancel the server-side save commitment');
      }
      return;
     }
     held.release();
     if (scenario === 'reload') {
      await page.waitForFunction(() => document.querySelector('iframe') !== window.initialDatabaseFrame);
      await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.LiyuanDatabasePluginHost?.ready() && !document.querySelector('.database-manager__state'));
      assert.equal(state.loads.length, 2); assert.equal(await page.evaluate(() => window.__closes), 0);
     } else {
      await manager.waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => window.__closes), 1);
      assert.equal(await page.locator('#story').evaluate(element => element.inert), false);
     }
     assert.equal(state.commits.length, 1); assert.equal(state.commits[0].state.chatMetadata.syntheticValue, 'synthetic edited value');
    } finally { held?.release(); await page.close(); }
   });
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
 } finally {
  state.hold?.release(); await browser?.close(); server?.closeAllConnections();
  if (server) await new Promise(done => server.close(done));
  await rm(work, { recursive: true, force: true });
 }
});
