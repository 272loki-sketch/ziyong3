/** Real, unchanged upstream UI on synthetic state only; no production cache or model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { TavernPluginHttp } from '../server/tavern-plugin-http.ts';
import { syntheticTavernPluginContext } from '../server/tavern-plugin-runtime.ts';
import { ensureTavernPluginVendors } from '../server/tavern-plugin-vendor.ts';
import { TAVERN_CDN_ASSETS } from '../server/tavern-plugin-cdn.ts';

const fixtures = process.env.LIYUAN_TAVERN_PLUGIN_FIXTURES;
const screenshots = process.env.LIYUAN_TAVERN_UI_SCREENSHOTS;
test('原插件设置：中文语言包、原生折叠与键盘、选项持久化、昼夜主题及390px无溢出', { skip: !fixtures, timeout: 120_000 }, async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'liyuan-tavern-settings-'));
 let browser: any, server: any, api: TavernPluginHttp | undefined;
 try {
  await symlink(join(process.cwd(), 'web'), join(cwd, 'web'), 'dir');
  await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');
  await ensureTavernPluginVendors(cwd, { fixtureRoot: fixtures });
  const context = syntheticTavernPluginContext(); let modelCalls = 0;
  api = new TavernPluginHttp(cwd, { context: () => context, isStreaming: () => false, generate: async () => { modelCalls++; throw new Error('settings must never generate'); } });
  for (const id of ['helper', 'template'] as const) { await api.sources.install(id, { fixtureRepo: join(fixtures!, id) }); api.sources.configure(id, { enabled: true }); }
  server = createServer((req, res) => { void (async () => {
   if (req.url?.split('?')[0] === '/tavern-plugin-host.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(join(cwd, 'web/public/tavern-plugin-host.html'))); return; }
   if (!await api!.handle(req, res)) { res.writeHead(404); res.end(); }
  })().catch(error => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const executable = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE;
  browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? '' }, args: ['--no-sandbox'] });
  // An English browser must still follow the Chinese app, not silently show English labels.
  const page = await browser.newPage({ locale: 'en-US', serviceWorkers: 'block', viewport: { width: 1180, height: 900 } });
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.route('**/*', (route: any) => {
   const url = new URL(route.request().url()), mapped = TAVERN_CDN_ASSETS[url.href];
   if (mapped) { const file = mapped.includes('/vendor/') ? join(cwd, '.liyuan-tavern-plugins/vendor', mapped.split('/').at(-1)!) : api!.sources.resolveAsset('helper', 'src/iframe/node_modules/log.js'); return file ? route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(file), headers: { 'access-control-allow-origin': '*' } }) : route.abort(); }
   return url.origin === base ? route.continue() : route.abort();
  });
  const open = async (plugin: string) => { await page.goto(`${base}/tavern-plugin-host.html?view=manager&plugin=${plugin}&network=isolated`); try { await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('原插件已就绪'), {}, { timeout: 30_000 }); } catch(error) { console.error('settings initialization', await page.locator('#status').textContent(), errors); throw error; } };
  const snapshot = async (name: string) => { if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true }); } };
  await open('helper'); await snapshot('helper-desktop');
  const helperDrawer = page.locator('#tavern_helper > .inline-drawer > .inline-drawer-toggle');
  assert.equal(await helperDrawer.getAttribute('aria-expanded'), 'true');
  await helperDrawer.click(); assert.equal(await helperDrawer.getAttribute('aria-expanded'), 'false'); assert.equal(await page.locator('#tavern_helper > .inline-drawer > .inline-drawer-content').isVisible(), false);
  await helperDrawer.focus(); await page.keyboard.press('Enter'); assert.equal(await helperDrawer.getAttribute('aria-expanded'), 'true');
  const sections = page.locator('#tavern_helper fieldset.TH-fieldset:visible');
  const sectionCount = await sections.count(); assert.ok(sectionCount >= 2);
  for (let index = 0; index < sectionCount; index++) {
   const section = sections.nth(index), legend = section.locator(':scope > legend');
   assert.equal(await legend.getAttribute('aria-expanded'), 'true');
   await legend.click(); assert.equal(await legend.getAttribute('aria-expanded'), 'false');
   assert.equal(await section.locator(':scope > div').first().isVisible(), false);
   await legend.focus(); await page.keyboard.press('Enter');
   assert.equal(await legend.getAttribute('aria-expanded'), 'true'); assert.equal(await section.locator(':scope > div').first().isVisible(), true);
  }
  let foldsChecked = 0;
  for (const tab of ['开发', '工具', '优化', '脚本']) {
   await page.getByRole('tab', { name: tab, exact: true }).click();
   const folds = page.locator('#tavern_helper .TH-collapsible:visible');
   for (let index = 0; index < await folds.count(); index++) {
    const fold = folds.nth(index), toggle = fold.locator(':scope > .liyuan-helper-fold-toggle');
    if (await toggle.getAttribute('aria-expanded') === 'true') { await toggle.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(400); }
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.locator('.TH-Item--title').click(); await page.waitForTimeout(400);
    assert.equal(await fold.locator(':scope > .TH-collapsible--content').isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(400);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); assert.equal(await fold.locator(':scope > .TH-collapsible--content').isVisible(), false);
    foldsChecked++;
   }
  }
  assert.ok(foldsChecked >= 1, 'exercise the real Vue fold as well as fieldset groups and the outer drawer');
  console.log('native helper folds checked:', foldsChecked);
  await page.getByRole('tab', { name: '渲染', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await snapshot('helper-mobile');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'helper must not overflow at 390px');
  assert.equal(await page.locator('#prompt_template_settings').isVisible(), false);
  await open('template');
  assert.equal(await page.locator('#prompt_template_settings [data-i18n="Prompt template settings"]').innerText(), '提示词模板');
  assert.equal(await page.locator('#prompt_template_settings [data-i18n="PT Enable"]').innerText(), '是否启用扩展');
  assert.equal(await page.locator('#pt_enabled').locator('..').getAttribute('title'), '全局开关');
  assert.equal(await page.locator('#pt_cache_enabled option[value="0"]').innerText(), '禁用');
  assert.equal(await page.locator('#tavern_helper').isVisible(), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'template must not overflow at 390px');
  await snapshot('template-mobile');
  const checked = await page.locator('#pt_debug_enabled').isChecked();
  await page.locator('#pt_debug_enabled').setChecked(!checked); await page.evaluate(() => (window as any).LiyuanTavern.flush());
  await open('template'); assert.equal(await page.locator('#pt_debug_enabled').isChecked(), !checked, 'translated form must still persist the real upstream setting');
  await page.evaluate(() => localStorage.setItem('liyuan.theme', 'dark')); await open('template');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); await snapshot('template-mobile-dark');
  await page.setViewportSize({ width: 1180, height: 900 }); await snapshot('template-desktop');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mainFontSize').trim()), '16px');
  assert.equal(modelCalls, 0); assert.deepEqual(errors, []);
 } finally { api?.sources.close(); await browser?.close(); if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve)); } await rm(cwd, { recursive: true, force: true }); }
});
