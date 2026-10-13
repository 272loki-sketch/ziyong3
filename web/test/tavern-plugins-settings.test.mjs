// Offline synthetic regressions for host UI; original byte-level integration remains separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
test('设置宿主：中文含动态属性、输入节点不替换、折叠不抢控件事件、重复增强不双触发', { timeout: 40_000 }, async () => {
 let server, browser;
 const errors = [], requests = [];
 try {
  server = createServer((req, res) => { void (async () => {
   const path = new URL(req.url, 'http://localhost').pathname;
   const base = '/tavern-compat/scripts/extensions/third-party/ST-Prompt-Template/';
   if (path === base + 'manifest.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ i18n: { 'zh-cn': 'locales/zh-cn.json' } })); }
   if (path === base + 'locales/zh-cn.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ 'PT label': '合成中文', 'PT title': '合成中文说明', 'With control': '控件标题', 'Dynamic ${0}': '动态 ${0}' })); }
   if (['i18n.js', 'settings-ui.js', 'settings-host.css'].some(name => path === '/tavern-compat/' + name)) { res.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' }); return res.end(await readFile(join(root, 'web/public', path), 'utf8')); }
   if (path !== '/') { requests.push(path); res.writeHead(404); return res.end(); }
   res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
   res.end(`<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/tavern-compat/settings-host.css"><style>.TH-collapsible--content{display:none}.TH-collapsible.expanded>.TH-collapsible--content{display:flex}</style></head><body data-view="manager"><div id="extensions_settings">
<div id="prompt_template_settings"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header">合成折叠栏<button id="header-action">不折叠的按钮</button><span class="inline-drawer-icon"></span></div><div class="inline-drawer-content"><span data-i18n="PT label;[title]PT title">English</span><label id="with-control" data-i18n="With control">English label<select id="preserved"><option value="keep">KEEP_VALUE</option></select></label><textarea id="authored">&lt;%= user_authored %&gt;</textarea><div id="nested" class="TH-collapsible"><div>原生Vue行为合成替身</div><div class="TH-collapsible--content">详情</div></div></div></div></div></div>
<div id="chat"><span data-i18n="PT label">UNTRANSLATED_STORY</span></div>
<script type="module">import {loadPluginLocales,t} from '/tavern-compat/i18n.js';import {installSettingsUI} from '/tavern-compat/settings-ui.js';window.__events=[];window.$=drawer=>({trigger:event=>window.__events.push(event)});document.querySelector('#nested>div').onclick=()=>{window.__nativeClicks=(window.__nativeClicks||0)+1;document.querySelector('#nested').classList.toggle('expanded')};await loadPluginLocales([{id:'template',enabled:true}]);window.__select=document.getElementById('preserved');window.__ui=installSettingsUI({view:'manager',plugin:'template'});window.__t=t;window.__ready=true;</script></body></html>`);
  })().catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, '.liyuan-database-plugin/browser/headless_shell')) ? join(root, '.liyuan-database-plugin/browser/headless_shell') : undefined);
  const libs = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || (existsSync(join(root, '.liyuan-database-plugin/browser-libs/lib64')) ? join(root, '.liyuan-database-plugin/browser-libs/lib64') : '');
  browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: libs }, args: ['--no-sandbox'] });
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__ready);
  assert.equal(await page.locator('#prompt_template_settings [data-i18n^="PT label"]').innerText(), '合成中文');
  assert.equal(await page.locator('#prompt_template_settings [data-i18n^="PT label"]').getAttribute('title'), '合成中文说明');
  assert.equal(await page.evaluate(() => document.getElementById('preserved') === window.__select), true);
  assert.equal(await page.locator('#preserved').inputValue(), 'keep'); assert.equal(await page.locator('#authored').inputValue(), '<%= user_authored %>');
  assert.equal(await page.locator('#chat span').innerText(), 'UNTRANSLATED_STORY');
  assert.equal(await page.evaluate(() => window.__t(['Dynamic ', ''], 42)), '动态 42');
  const header = page.locator('.inline-drawer-header'); await page.locator('#header-action').click();
  assert.equal(await header.getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => { window.__ui.refresh(); window.__ui.refresh(); });
  await header.click({ position: { x: 12, y: 12 } }); assert.equal(await header.getAttribute('aria-expanded'), 'false');
  await header.focus(); await page.keyboard.press('Space'); assert.equal(await header.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await page.evaluate(() => window.__events), ['inline-drawer-toggle', 'inline-drawer-toggle']);
  await page.evaluate(() => { const node = document.createElement('span'); node.id = 'dynamic-label'; node.dataset.i18n = 'PT label;[title]PT title'; node.textContent = 'English'; document.querySelector('.inline-drawer-content').append(node); });
  await page.waitForFunction(() => document.getElementById('dynamic-label')?.textContent === '合成中文');
  assert.equal(await page.locator('#dynamic-label').getAttribute('title'), '合成中文说明');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mainFontSize').trim()), '16px');
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
 } finally { await browser?.close(); if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
});
