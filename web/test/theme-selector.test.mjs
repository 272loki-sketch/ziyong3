import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
test('three backgrounds persist, sync selectors and tabs, protect story text, and fit desktop/mobile (synthetic)', { timeout: 90_000 }, async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'liyuan-theme-selector-'));
 let browser, server;
 const errors = [], external = [], writes = [];
 try {
  await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{ThemeSelector}from'./src/components/ThemeSelector.tsx';import{initTheme}from'./src/theme.ts';initTheme();createRoot(document.getElementById('root')).render(<React.StrictMode><ThemeSelector toast={()=>{}}/><ThemeSelector toast={()=>{}}/></React.StrictMode>);window.__initTheme=initTheme;`, resolveDir: join(root, 'web'), loader: 'tsx' }, bundle: true, format: 'esm', jsx: 'automatic', outfile: join(cwd, 'fixture.js'), logLevel: 'silent' });
  const index = await readFile(join(root, 'web/index.html'), 'utf8');
  const boot = index.match(/<script>([\s\S]*?)<\/script>/)[1];
  const story = '合成正文：<options>不应该因配色变化而修改</options>\nUnicode · 原始文本保留';
  await writeFile(join(cwd, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f4f0"><script>${boot}</script><link rel="stylesheet" href="/app.css"></head><body><main style="width:min(100%,640px);padding:16px;margin:auto"><div id="root"></div><pre id="story" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><iframe title="合成插件设置" src="/settings.html"></iframe></main><script>document.getElementById('story').textContent=${JSON.stringify(story)}</script><script type="module" src="/fixture.js"></script></body></html>`);
  server = createServer(async (req, res) => {
   try {
    if (req.method !== 'GET') writes.push(req.url);
    const url = new URL(req.url, 'http://localhost');
    const files = { '/': join(cwd, 'index.html'), '/fixture.js': join(cwd, 'fixture.js'), '/app.css': join(root, 'web/src/app.css'), '/settings-host.css': join(root, 'web/public/tavern-compat/settings-host.css'), '/settings-ui.js': join(root, 'web/public/tavern-compat/settings-ui.js'), '/i18n.js': join(root, 'web/public/tavern-compat/i18n.js') };
    if (url.pathname === '/settings.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><head><link rel="stylesheet" href="/settings-host.css"></head><body data-view="manager"><div id="extensions_settings"></div><div id="extensions_settings2"></div><script type="module">import{installSettingsUI}from'/settings-ui.js';window.__ui=installSettingsUI({view:'manager',plugin:'helper'});</script></body></html>`); }
    if (!files[url.pathname]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(await readFile(files[url.pathname]));
   } catch { res.writeHead(500); res.end('synthetic fixture error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('fieldset').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  const unchanged = await page.locator('#story').textContent();
  const themes = [['默认背景', 'light', '#f7f4f0'], ['护眼模式', 'eye-care', '#e8eee2'], ['夜晚模式', 'dark', '#141110']];
  for (const [label, value, color] of themes) {
   await page.getByRole('radio', { name: label, exact: false }).first().check();
   assert.equal(await page.locator('html').getAttribute('data-theme'), value);
   assert.equal(await page.getByRole('radio', { name: label, exact: false }).count(), 2);
   for (const radio of await page.getByRole('radio', { name: label, exact: false }).all()) assert.equal(await radio.isChecked(), true);
   assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), color);
   assert.equal(await page.evaluate(() => localStorage.getItem('liyuan.theme') ?? 'light'), value);
   await page.waitForFunction(mode => document.querySelector('iframe').contentDocument.documentElement.dataset.theme === mode, value);
   assert.equal(await page.locator('#story').textContent(), unchanged);
   await page.reload(); await page.locator('fieldset').first().waitFor();
   assert.equal(await page.locator('html').getAttribute('data-theme'), value);
  }
  const other = await context.newPage(); await other.goto(base); await other.locator('fieldset').first().waitFor();
  await other.getByRole('radio', { name: '护眼模式', exact: false }).first().check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'eye-care');
  for (const width of [390, 320]) {
   await page.setViewportSize({ width, height: 844 });
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}px`);
  }
  await page.evaluate(() => localStorage.setItem('liyuan.theme', 'invalid-mode')); await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.evaluate(() => localStorage.setItem('liyuan.theme', 'dark')); await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  const blocked = await browser.newContext();
  await blocked.addInitScript(() => { Object.defineProperty(Storage.prototype, 'getItem', { value() { throw Error('synthetic storage denied'); } }); Object.defineProperty(Storage.prototype, 'setItem', { value() { throw Error('synthetic storage denied'); } }); });
  const deniedPage = await blocked.newPage(); await deniedPage.goto(base); await deniedPage.getByRole('radio', { name: '护眼模式', exact: false }).first().check();
  assert.equal(await deniedPage.locator('html').getAttribute('data-theme'), 'eye-care');
  assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
 } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(cwd, { recursive: true, force: true }); }
});
