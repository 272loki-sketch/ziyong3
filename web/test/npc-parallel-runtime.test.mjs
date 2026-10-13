import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NpcParallelRuntime } from '../../server/npc-parallel-runtime.ts';
import { tavernVendorAsset } from '../../server/tavern-plugin-vendor.ts';
import { chromium } from 'playwright';

const runtimeAssetsRoot = process.env.NPC_PARALLEL_UI_ASSETS_ROOT ? resolve(process.env.NPC_PARALLEL_UI_ASSETS_ROOT) : resolve('.');
const fixtureRoot = process.env.NPC_PARALLEL_FIXTURE_ROOT ? resolve(process.env.NPC_PARALLEL_FIXTURE_ROOT) : '';
const required = ['index.js', 'style.css', 'manifest.json'];
const fixtureReady = !!fixtureRoot && required.every(file => existsSync(join(fixtureRoot, file)));

function makeFixtureSource() {
  const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
  const commit = execFileSync('git', ['-C', fixtureRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const hash = createHash('sha256');
  for (const file of required) hash.update(file).update('\0').update(readFileSync(join(fixtureRoot, file)));
  const candidate = { root: fixtureRoot, version: String(manifest.version), commit, sha256: hash.digest('hex'), manifest };
  return {
    active: () => candidate,
    resolveAsset(rel, selected = candidate) {
      if (selected.commit !== candidate.commit || !required.includes(rel)) return null;
      const path = join(fixtureRoot, rel);
      return existsSync(path) ? path : null;
    },
  };
}
function makeInput(overrides = {}) {
  const previousText = 'PREVIOUS-SYNTHETIC-CONTINUATION-ONLY';
  const original = [
    { entryId: 'user-0', mes: '合成用户提出问题。', is_user: true, name: '合成用户', extra: {} },
    { entryId: 'assistant-0', mes: '合成上一轮主文。', is_user: false, name: '合成角色', extra: { npc_parallel: [{ name: '阿青', text: previousText, info: '合成信息' }] } },
    { entryId: 'user-1', mes: '合成用户继续对话。', is_user: true, name: '合成用户', extra: {} },
    { entryId: 'assistant-1', mes: '冻结的合成正文，尾部空格用于前缀保护。  ', is_user: false, name: '合成角色', extra: {} },
  ];
  return {
    sessionId: 'npc-parallel-synthetic-session',
    card: 'npc-parallel-synthetic-card',
    sourceEntryId: 'assistant-1',
    chat: original,
    npcs: [{ name: '阿青', notes: '仅合成测试人物', pov: '合成视角', weight: 1 }],
    worldbooks: { 'Synthetic-World': { entries: [{ uid: 1, comment: 'synthetic entry', content: '合成世界书条目', key: ['合成'], enabled: true }] } },
    settings: { enabled: true, autoTrigger: true, minGenTokens: 4096, pickBeforeGen: true, skipPresent: false, autoSyncDatabase: true, autoDetectPresence: true, batchGenerate: false, delayMs: 321, customApi: { enabled: false } },
    metadata: { npc_parallel: { npcs: [{ name: '阿青' }], ignoredNpcs: [] }, world_info: 'Synthetic-World' },
    constraintText: 'SYNTHETIC ECOLOGY CONSTRAINT: respect only this frozen synthetic branch context.',
    guard() {},
    async generate() { return '<npc正文>阿青在廊下收好一封合成信。</npc正文><npc信息>知道：合成事实</npc信息>'; },
    previousText,
    original,
    ...overrides,
  };
}

await test('原版 npc-parallel 隔离浏览器运行器（无模型费用、合成数据）', async t => {
  if (!fixtureReady) {
    t.skip('明确跳过：未设置 NPC_PARALLEL_FIXTURE_ROOT 或原版 index.js/style.css/manifest.json 不完整；这不代表已验证上游原字节兼容。');
    return;
  }
  const sources = makeFixtureSource();
  const runtime = new NpcParallelRuntime({ assetsCwd: runtimeAssetsRoot, sources });
  try {
    await t.test('原版脚本生成、上一段续接、constraint注入、完整原稿前缀不变且自定义SSE只走受管callback', async () => {
      const input = makeInput();
      const before = structuredClone(input.chat);
      let calls = 0;
      const result = await runtime.run({
        ...input,
        settings: {
          ...input.settings, timeoutMs: 5000,
          customApi: {
            enabled: true,
            stream: true,
            endpoints: [{ name: 'synthetic-only', url: 'https://invalid.example/v1', apiKey: 'synthetic-not-a-real-key', model: 'untrusted-model', enabled: true, temperature: 0.4, maxRetries: 0 }],
          },
        },
        async generate(request) {
          calls++;
          assert.equal(request.messages[0].role, 'system');
          assert.match(request.messages[0].content, /SYNTHETIC ECOLOGY CONSTRAINT/);
          assert.doesNotMatch(JSON.stringify(request), /invalid\.example|synthetic-not-a-real-key/);
          assert.match(request.messages.map(message => message.content).join('\n'), /PREVIOUS-SYNTHETIC-CONTINUATION-ONLY/);
          return '<npc正文>阿青在廊下收好一封合成信。</npc正文><npc信息>知道：合成事实</npc信息>';
        },
      });
      assert.equal(calls, 1, `only injected managed generate callback may run; result=${JSON.stringify({ errors: result.errors, entries: result.entries.length, calls: result.calls })}`);
      assert.equal(result.calls, 1);
      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0].name, '阿青');
      assert.match(result.entries[0].text, /合成信/);
      assert.deepEqual(input.chat, before, 'upstream .mes mutation must remain in the deep-cloned virtual chat');
      assert.equal(input.chat.at(-1).mes, before.at(-1).mes);
      assert.equal(Object.hasOwn(result, 'chat'), false);
      assert.equal(Object.hasOwn(result.entries[0], 'mes'), false);
      assert.equal(result.settings.customApi.endpoints[0].apiKey, 'synthetic-not-a-real-key', 'run projection must not overwrite persisted original settings');
      assert.equal(result.settings.minGenTokens, 4096, 'temporary run override must never replace saved setting');
      assert.equal(result.settings.pickBeforeGen, true);
      assert.equal(result.settings.autoSyncDatabase, true);
      assert.equal(result.settings.autoDetectPresence, true);
      assert.equal(result.settings.delayMs, 321);
      assert.equal(result.settings.enabled, true);
      assert.equal(result.settings.autoTrigger, true);
      assert.equal(result.settings.person, 'third', 'upstream default/migrated settings are retained from the actual settings snapshot');
      assert.ok(result.metadata.npc_parallel);
      assert.ok(result.metadata.world_info);
      assert.equal(runtime.busy(), false);
    });

    await t.test('explicitly disabled upstream automation is rejected before browser startup', async () => {
      const input = makeInput({ settings: { enabled: true, autoTrigger: false } });
      await assert.rejects(runtime.run(input), /显式关闭/);
      assert.equal(runtime.busy(), false);
    });

    await t.test('原版自定义JSON代理响应映射到同一受管callback', async () => {
      let calls = 0;
      const result = await runtime.run(makeInput({
        settings: { enabled: true, autoTrigger: true, skipPresent: false, batchGenerate: false, autoSyncDatabase: false, autoDetectPresence: false, timeoutMs: 5000, customApi: { enabled: true, stream: false, endpoints: [{ name: 'synthetic-json', url: 'https://invalid.example/v1', apiKey: 'synthetic-not-a-real-key', enabled: true, model: 'untrusted-model', maxRetries: 0 }] } },
        async generate(request) {
          calls++;
          assert.equal(request.messages[0].role, 'system');
          assert.match(request.messages[0].content, /SYNTHETIC ECOLOGY CONSTRAINT/);
          assert.doesNotMatch(JSON.stringify(request), /invalid\.example|synthetic-not-a-real-key/);
          return '<npc正文>合成JSON代理正文。</npc正文>';
        },
      }));
      assert.equal(calls, 1);
      assert.equal(result.entries.length, 1);
      assert.match(result.entries[0].text, /合成JSON代理正文/);
      assert.equal(result.settings.customApi.endpoints[0].apiKey, 'synthetic-not-a-real-key');
    });

    await t.test('原版在场判定命中时真实跳过生成', async () => {
      let calls = 0;
      const result = await runtime.run(makeInput({
        settings: { skipPresent: true, batchGenerate: false, autoSyncDatabase: false, autoDetectPresence: false, customApi: { enabled: false } },
        async generate() { calls++; return '阿青：在场'; },
      }));
      assert.equal(calls, 1, 'only the upstream presence request should reach the managed stub');
      assert.equal(result.calls, 1);
      assert.deepEqual(result.entries, []);
      assert.deepEqual(result.errors, []);
    });

    await t.test('模型失败不冒充成功', async () => {
      const result = await runtime.run(makeInput({ async generate() { throw new Error('synthetic provider failure'); } }));
      assert.deepEqual(result.entries, []);
      assert.ok(result.errors.length > 0);
      assert.equal(result.calls, 1);
    });

    await t.test('上游失败/请求次数不能绕过八次上限', async () => {
      const result = await runtime.run(makeInput({
        npcs: Array.from({ length: 10 }, (_, index) => ({ name: `合成NPC${index + 1}`, always: true })),
        settings: { batchGenerate: false, autoSyncDatabase: false, autoDetectPresence: false, customApi: { enabled: false } },
        async generate() { return '<npc正文>合成段落。</npc正文>'; },
      }));
      assert.ok(result.calls <= 8);
      assert.ok(result.errors.some(error => error.includes('8次上限')));
      assert.ok(result.entries.length <= 8);
    });

    await t.test('外部停止信号中止受管请求，并等待原版完成保存回执后拒绝候选', async () => {
      const controller = new AbortController();
      let markStarted;
      const started = new Promise(resolveStarted => { markStarted = resolveStarted; });
      const run = runtime.run(makeInput({
        signal: controller.signal,
        async generate(_request, signal) {
          markStarted();
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) { reject(signal.reason); return; }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }));
      await started;
      controller.abort(new DOMException('synthetic stop', 'AbortError'));
      await assert.rejects(run, /synthetic stop|aborted|cancel/i);
      assert.equal(runtime.busy(), false);
    });

    await t.test('外部超时信号不返回半成品', async () => {
      const controller = new AbortController();
      let markStarted;
      const started = new Promise(resolveStarted => { markStarted = resolveStarted; });
      const run = runtime.run(makeInput({
        signal: controller.signal,
        async generate(_request, signal) {
          markStarted();
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) { reject(signal.reason); return; }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }));
      await started;
      controller.abort(new DOMException('synthetic timeout', 'TimeoutError'));
      await assert.rejects(run, /synthetic timeout|TimeoutError|timeout/i);
      assert.equal(runtime.busy(), false);
    });

    await t.test('reset后可再次运行，close是终止操作', async () => {
      await runtime.reset();
      const noNpcs = makeInput({ npcs: [] });
      const noOp = await runtime.run(noNpcs);
      assert.equal(noOp.calls, 0);
      await runtime.close();
      await assert.rejects(runtime.run(noNpcs), /closed/);
    });

    await t.test('manifest改名入口/CSS与声明assets通过SourceLike白名单加载', async () => {
      const temp = await mkdtemp(join(tmpdir(), 'liyuan-npc-parallel-renamed-fixture-'));
      let renamedRuntime;
      try {
        await copyFile(join(fixtureRoot, 'index.js'), join(temp, 'upstream.js'));
        await copyFile(join(fixtureRoot, 'style.css'), join(temp, 'theme.css'));
        const assetText = JSON.stringify({ synthetic: true });
        await writeFile(join(temp, 'declared.json'), assetText);
        await writeFile(join(temp, 'entry.mjs'), [
          "import './upstream.js';",
          "const response = await fetch('/npc-parallel/scripts/extensions/third-party/npc-parallel/declared.json');",
          "if (!response.ok || !(await response.json()).synthetic) throw new Error('manifest declared asset failed');",
        ].join('\n'));
        const manifest = { display_name: 'synthetic fixture', js: 'entry.mjs', css: 'theme.css', version: 'synthetic-renamed', requires: [], assets: ['upstream.js', 'declared.json'] };
        await writeFile(join(temp, 'manifest.json'), JSON.stringify(manifest));
        const hash = createHash('sha256');
        for (const file of ['entry.mjs', 'theme.css', 'upstream.js', 'declared.json', 'manifest.json']) hash.update(file).update('\0').update(readFileSync(join(temp, file)));
        const candidate = { root: temp, version: manifest.version, commit: '3'.repeat(40), sha256: hash.digest('hex'), manifest };
        const allowedAssets = new Set([manifest.js, manifest.css, ...manifest.assets]);
        const renamedSource = {
          active: () => candidate,
          resolveAsset(rel, selected = candidate) {
            if (selected.commit !== candidate.commit || (rel !== 'manifest.json' && !allowedAssets.has(rel))) return null;
            const path = join(temp, rel);
            return existsSync(path) ? path : null;
          },
        };
        renamedRuntime = new NpcParallelRuntime({ assetsCwd: runtimeAssetsRoot, sources: renamedSource });
        const result = await renamedRuntime.run(makeInput());
        assert.equal(result.version, 'synthetic-renamed');
        assert.equal(result.entries.length, 1);
        assert.match(result.entries[0].text, /合成信/);
      } finally {
        await renamedRuntime?.close();
        await rm(temp, { recursive: true, force: true });
      }
    });
  } finally {
    await runtime.close();
  }
});


await test('原版设置管理页 source/revision 保存与只读/禁模型隔离', async t => {
  if (!fixtureReady) {
    t.skip('明确跳过：未设置 NPC_PARALLEL_FIXTURE_ROOT；管理页真实原字节验收没有执行。');
    return;
  }
  const root = resolve('.'), assetsRoot=process.env.NPC_PARALLEL_UI_ASSETS_ROOT ? resolve(process.env.NPC_PARALLEL_UI_ASSETS_ROOT) : root;
  const upstream = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
  const commit = execFileSync('git', ['-C', fixtureRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const assetHash = createHash('sha256');
  for (const rel of ['index.js', 'style.css', 'manifest.json']) assetHash.update(rel).update('\0').update(readFileSync(join(fixtureRoot, rel)));
  const manifest = { ...upstream };
  const bodyChat = [
    { entryId: 'synthetic-user', mes: '纯合成管理页测试输入', is_user: true, name: '合成用户', extra: {} },
    { entryId: 'synthetic-assistant', mes: '纯合成管理页测试正文', is_user: false, name: '合成角色', extra: { npc_parallel: [{ name: '阿青', text: '合成历史侧写' }] } },
  ];
  const initialNpc = [{ name: '阿青', notes: '保留这份合成名单', pov: '', always: false, weight: 1 }];
  const initialSettings = { enabled: false, autoTrigger: false, template: 'synthetic-original-template', customUnknown: { preserve: true }, enabled: true, autoTrigger: true, customApi: { enabled: false, endpoints: [] } };
  const initialMetadata = { npc_parallel: { npcs: [{ name: 'stale-copy' }], ignoredNpcs: ['synthetic-ignored'] }, world_info: 'Synthetic-World', customMetadata: { preserve: 7 } };
  const bootstrap = {
    scope: { sessionId: 'synthetic-session', card: 'synthetic-card-name', sourceEntryId: 'synthetic-assistant', visibleEntryIds: ['synthetic-user', 'synthetic-assistant'] },
    scopeKey: 'synthetic-scope-key', sourceEntryId: 'synthetic-assistant', upstreamCommit: commit, revision: 7,
    chat: bodyChat, npcs: initialNpc, worldbooks: { 'Synthetic-World': { entries: [] } },
    settings: initialSettings, metadata: initialMetadata, constraintText: 'synthetic manager constraint',
    userName: '合成用户名', characterName: '合成角色名', version: upstream.version, manifest,
    model: { provider: 'managed', id: 'synthetic-only' },
  };
  let server, browser;
  let modelCalls = 0;
  const savedBodies = [];
  let resolveChangedSave;
  const changedSave = new Promise(resolveSave => { resolveChangedSave = resolveSave; });
  server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const send = (status, type, body) => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(body); };
      if (request.method === 'GET' && pathname === '/npc-parallel-host.html') return send(200, 'text/html; charset=utf-8', readFileSync(join(assetsRoot, 'web/public/npc-parallel-host.html')));
      const hostStatic = {
        '/npc-parallel/host.js': 'web/public/npc-parallel/host.js',
        '/npc-parallel/host.css': 'web/public/npc-parallel/host.css',
        '/npc-parallel/script.js': 'web/public/npc-parallel/script.js',
        '/npc-parallel/scripts/extensions.js': 'web/public/npc-parallel/extensions.js',
      };
      if (request.method === 'GET' && hostStatic[pathname]) return send(200, pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', readFileSync(join(assetsRoot, hostStatic[pathname])));
      const vendors = {
        '/npc-parallel/vendor/jquery.js': 'jquery.js',
        '/npc-parallel/vendor/jquery-ui.js': 'jquery-ui.js',
        '/npc-parallel/vendor/jquery-touch-punch.js': 'jquery-touch-punch.js',
        '/npc-parallel/vendor/toastr.js': 'toastr.js',
      };
      if (request.method === 'GET' && vendors[pathname]) {
        const file = tavernVendorAsset(root, vendors[pathname]);
        if (!file) return send(503, 'text/plain; charset=utf-8', 'verified vendor missing');
        return send(200, 'text/javascript; charset=utf-8', readFileSync(file));
      }
      const pluginPrefix = '/npc-parallel/scripts/extensions/third-party/npc-parallel/';
      if (request.method === 'GET' && pathname.startsWith(pluginPrefix)) {
        const rel = decodeURIComponent(pathname.slice(pluginPrefix.length));
        if (!['index.js', 'style.css', 'manifest.json'].includes(rel)) return send(404, 'text/plain; charset=utf-8', 'not found');
        const contentType = rel.endsWith('.css') ? 'text/css; charset=utf-8' : rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8';
        return send(200, contentType, readFileSync(join(fixtureRoot, rel)));
      }
      if (request.method === 'GET' && pathname === '/api/npc-parallel/context') return send(200, 'application/json; charset=utf-8', JSON.stringify(bootstrap));
      if (request.method === 'POST' && pathname === '/api/npc-parallel/settings') {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); savedBodies.push(body);
        if (body.settings?.template === 'synthetic-edited-template') resolveChangedSave(body);
        const nextRevision = Number(body.revision) + 1;
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ scopeKey: body.scopeKey, sourceEntryId: body.sourceEntryId, revision: nextRevision }));
      }
      if (request.method === 'POST' && pathname.includes('generate')) { modelCalls++; return send(403, 'application/json; charset=utf-8', JSON.stringify({ error: 'disabled' })); }
      return send(404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not found' }));
    })().catch(() => { if (!response.headersSent) { response.writeHead(500); response.end(); } });
  });
  try {
    await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolveListen); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const binary = process.env.LIYUAN_NPC_PARALLEL_BROWSER_EXECUTABLE ?? process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE ?? join(root, '.liyuan-database-plugin/browser/headless_shell');
    const libs = process.env.LIYUAN_NPC_PARALLEL_BROWSER_LIBS ?? process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? join(root, '.liyuan-database-plugin/browser-libs/lib64');
    browser = await chromium.launch({ headless: true, ...(existsSync(binary) ? { executablePath: binary } : {}), env: { ...process.env, LD_LIBRARY_PATH: libs }, args: ['--no-sandbox'] });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    page.setDefaultTimeout(10_000);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort('blockedbyclient');
      return route.continue();
    });
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(error.message.slice(0, 160)));
    await page.goto(`${origin}/npc-parallel-host.html`, { waitUntil: 'domcontentloaded' });
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      if (await page.evaluate(() => window.LiyuanNpcParallel?.ready?.() === true)) break;
      const status = await page.locator('#status').textContent();
      if (String(status).includes('初始化失败')) throw new Error(String(status));
      await new Promise(resolvePoll => setTimeout(resolvePoll, 50));
    }
    assert.equal(await page.evaluate(() => window.LiyuanNpcParallel?.ready?.() === true), true, `manager iframe did not become ready ${consoleErrors.join('; ')}`);
    assert.equal(await page.evaluate(() => window.parent === window), true);
    const panel = page.locator('#npcp_floating');
    await panel.waitFor({state:'visible'});
    assert.equal(await page.locator('#npcp_fab').isVisible(),false,'嵌入页不再套悬浮窗口');
    const originalControlIds=await panel.locator('input[id],select[id],textarea[id]').evaluateAll(nodes=>nodes.map(n=>n.id));
    assert.ok(originalControlIds.length>=45,`原版设置控件不能删减：实际id控件${originalControlIds.length}`);
    assert.equal(await panel.locator('input,select,textarea').count(),60,'当前原v1.1.0合成设置的60个原控件全部保留');
    const expectedTabs=['general','api','npcs','pov','logs'];
    assert.deepEqual(await panel.getByRole('tab').evaluateAll(nodes=>nodes.map(n=>n.dataset.tab)),expectedTabs);
    for(const viewport of [{width:1280,height:900},{width:390,height:844},{width:320,height:640}]){
      await page.setViewportSize(viewport);
      await page.waitForFunction(()=>{const r=document.getElementById('npcp_floating').getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight+1;});
      const rect=await panel.boundingBox();
      assert.ok(rect&&rect.x>=-1&&rect.y>=-1&&rect.x+rect.width<=viewport.width+1&&rect.y+rect.height<=viewport.height+1,`设置画布不得裁切：${JSON.stringify({viewport,rect})}`);
      for(const id of expectedTabs){
        const tab=panel.locator(`.npcp-tab[data-tab="${id}"]`);await tab.click();
        assert.equal(await tab.getAttribute('aria-selected'),'true');
        const pane=panel.locator(`.npcp-pane[data-pane="${id}"]`);await pane.waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'不得横向溢出');
        assert.equal(await panel.locator('.npcp-tab-panes').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,`${id}原设置页不得被横向裁切`);
        assert.deepEqual(await panel.locator('input[id],select[id],textarea[id]').evaluateAll(nodes=>nodes.map(n=>n.id)),originalControlIds);
      }
      await panel.locator('.npcp-tab[data-tab="general"]').click();
      await panel.locator('.npcp-tab[data-tab="general"]').press('ArrowRight');
      assert.equal(await panel.locator('.npcp-tab[data-tab="api"]').getAttribute('aria-selected'),'true','键盘使用原版tab处理器');
      await panel.locator('.npcp-tab[data-tab="general"]').click();
      await page.locator('#npcp_theme').selectOption(viewport.width===1280?'day':'night');
      assert.equal(await page.locator('html').getAttribute('data-theme'),viewport.width===1280?'light':'dark');
      if(process.env.NPC_PARALLEL_UI_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.NPC_PARALLEL_UI_SCREENSHOT_DIR,`after-${viewport.width}.png`)});
    }
    await panel.locator('.npcp-tab[data-tab="general"]').click();
    const templateControl=page.locator('#npcp_template');
    await templateControl.scrollIntoViewIfNeeded();
    assert.equal(await templateControl.isVisible(),true,'长内容底部模板必须通过正常滚动到达');

    const changed = page.evaluate(() => {
      const input = document.querySelector('#npcp_template');
      if (!input) throw new Error('original template setting control missing');
      input.value = 'synthetic-edited-template';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await changed;
    const saved = await Promise.race([changedSave, new Promise((_, reject) => setTimeout(() => reject(new Error('settings save request not observed')), 10_000))]);
    assert.equal(saved.scopeKey, bootstrap.scopeKey);
    assert.equal(saved.sourceEntryId, bootstrap.sourceEntryId);
    assert.equal(saved.upstreamCommit, bootstrap.upstreamCommit);
    assert.ok(saved.revision >= 7);
    assert.deepEqual(savedBodies.map((body,index)=>body.revision), savedBodies.map((_,index)=>7+index), '每次保存必须接续服务端CAS revision');
    assert.equal(saved.settings.template, 'synthetic-edited-template');
    assert.deepEqual(saved.settings.customUnknown, { preserve: true });
    assert.deepEqual(saved.metadata.npc_parallel.npcs, initialNpc, 'separate current roster must be preserved instead of stale/empty metadata');
    assert.equal(saved.metadata.world_info, 'Synthetic-World');
    assert.deepEqual(saved.metadata.customMetadata, { preserve: 7 });
    assert.equal(Object.hasOwn(saved, 'chat'), false);
    assert.equal(Object.hasOwn(saved, 'extra'), false);
    const blocked = await page.evaluate(() => {
      const trigger = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const model = trigger('#npcp_test');
      const historic = document.createElement('button');
      historic.className = 'npcp-pov-del'; document.body.append(historic);
      const history = trigger('.npcp-pov-del'); historic.remove();
      return { model, history, banner: document.getElementById('npcp-host-message')?.textContent ?? '' };
    });
    assert.equal(blocked.model, true, 'manual endpoint/model-list test is blocked, never faked');
    assert.equal(blocked.history, true, 'historical sidecar mutation is blocked');
    assert.match(blocked.banner, /已禁用|不允许/);
    assert.equal(modelCalls, 0);
    assert.ok(savedBodies.every(body => !Object.hasOwn(body, 'chat') && !Object.hasOwn(body, 'extra')));
  } catch (error) {
    if (t.signal.aborted) throw error;
    throw error;
  } finally {
    await browser?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  }
});
