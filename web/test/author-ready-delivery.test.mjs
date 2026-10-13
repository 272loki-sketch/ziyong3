import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = process.env.LIYUAN_DELIVERY_DIST || join(root, 'web/dist');
const artifacts = process.env.LIYUAN_DELIVERY_ARTIFACTS;
const pause = ms => new Promise(done => setTimeout(done, ms));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label) {
 let timer;
 try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timed out: ' + label)), 15000); })]); }
 finally { clearTimeout(timer); }
}
const listen = server => new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => done(server.address().port)); });

// All model responses are served by a loopback-only synthetic API. No real keys,
// material, installed plugin files, or production sessions are read/written.
for (const width of [1440, 390]) test(`正文先交付、后台结算与下一拍排队：${width}px隔离浏览器`, { timeout: 90000 }, async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'liyuan-author-ready-ui-'));
 const firstScribe = gate(), scribeStarted = gate();
 const requests = [], frames = [], errors = [];
 let writerCalls = 0, scribeCalls = 0, browser, host;
 const body = '后台未结束时即可阅读的合成正文。\n\n【作者附属格式】合成状态：已交付。';
 const mock = createServer(async (req, res) => {
  try {
   let input = ''; for await (const chunk of req) input += chunk;
   const payload = JSON.parse(input); requests.push(payload.model);
   let content;
   if (payload.model === 'writer') content = ++writerCalls === 1 ? body : '等待必要状态更新后开始的第二拍合成正文。';
   else if (payload.model === 'scribe') {
    if (++scribeCalls === 1) { scribeStarted.resolve(); await firstScribe.promise; }
    content = JSON.stringify({ patch: { location: '合成书房' } });
   } else content = JSON.stringify({ scenePressure: '合成事务', characterInitiatives: [], candidateBeats: [] });
   const data = { id: 'synthetic-local', object: 'chat.completion', model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
   if (payload.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...data, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...data, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n');
   } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('{}'); }
 });
 const modelPort = await listen(mock);
 const listener = createServer(); const hostPort = await listen(listener); await new Promise(done => listener.close(done));
 const base = `http://127.0.0.1:${hostPort}`;
 try {
  await mkdir(join(cwd, 'web')); await symlink(dist, join(cwd, 'web/dist'), 'dir');
  for (const name of ['src', 'skills', 'node_modules']) await symlink(join(root, name), join(cwd, name), 'dir');
  await mkdir(join(cwd, '.liyuan')); await symlink(join(root, '.liyuan/extensions'), join(cwd, '.liyuan/extensions'), 'dir');
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'author-ready-ui-fixture', version, type: 'module' }));
  await writeFile(join(cwd, 'card.json'), JSON.stringify({ data: { name: '合成正文测试角色', description: '只用于隔离回归', first_mes: '合成开场。' } }));
  await writeFile(join(cwd, 'liyuan.config.json'), JSON.stringify({ card: 'card.json', userName: '合成用户', generationMode: 'direct', literaryWorldEnabled: false, literaryEcologyEnabled: false, compactEveryNTurns: 0,
   stepModels: { literaryDirector: { provider: 'fixture', id: 'director' }, writer: { provider: 'fixture', id: 'writer' }, scribe: { provider: 'fixture', id: 'scribe' } }, novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false } }));
  await writeFile(join(cwd, 'liyuan.agent.json'), JSON.stringify({ version: 1, defaultProvider: 'fixture', defaultModel: 'writer', providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${modelPort}/v1`, compat: { supportsTools: false }, models: ['writer', 'scribe', 'director'].map(id => ({ id, maxTokens: 8192, contextWindow: 128000 })) } } }));
  await mkdir(join(cwd, 'home')); await mkdir(join(cwd, 'agent'));
  let logs = '';
  host = spawn(process.execPath, [join(root, 'server/main.ts'), '--new'], { cwd,
   env: { ...process.env, HOME: join(cwd, 'home'), LIYUAN_CODING_AGENT_DIR: join(cwd, 'agent'), LIYUAN_ACCESS_PASSWORD: '', LIYUAN_ASSISTANT_ACCESS_PASSWORD: '', LIYUAN_WEB_DIST: dist, HOST: '127.0.0.1', PORT: String(hostPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.on('data', b => { logs += b; }); host.stderr.on('data', b => { logs += b; });
  let healthy = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) { healthy = true; break; } } catch {} if (host.exitCode !== null) break; await pause(150); }
  assert.ok(healthy, `isolated server failed: ${logs.slice(-1000)}`);
  await fetch(base + '/api/models');
  assert.equal((await fetch(base + '/api/models/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'fixture', id: 'writer' }) })).ok, true);
  browser = await chromium.launch({ headless: true, ...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE?{executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE}:{}), env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH??''}, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width, height: 980 }, locale: 'zh-CN' }); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => { try { frames.push(JSON.parse(String(payload))); } catch {} }));
  await page.goto(base); await page.waitForSelector('#send_textarea');
  await page.locator('#send_textarea').fill('合成第一条输入。'); await page.locator('#send_but').click();
  await bounded(scribeStarted.promise, 'first scribe reached');
  await page.getByText('后台未结束时即可阅读的合成正文。', { exact: false }).first().waitFor();
  await page.getByText('【作者附属格式】合成状态：已交付。', { exact: false }).first().waitFor();
   await page.locator('.settlement-note').waitFor();
   await page.locator('.settlement-note').filter({ hasText: '仍在等待 场记' }).waitFor();
   const noteBounds = await page.locator('.settlement-note').boundingBox();
   assert.ok(noteBounds.x >= 0 && noteBounds.x + noteBounds.width <= width + 1, 'settlement status must fit the mobile/desktop viewport');
  assert.equal(await page.getByRole('button', { name: '停止生成', exact: true }).count(), 0);
  assert.equal(await page.locator('#send_but').count(), 1); assert.equal(writerCalls, 1);
  const readySnapshot = frames.find(frame => frame.type === 'hello' && frame.settling === true);
  assert.ok(readySnapshot); assert.equal(readySnapshot.messages.filter(message => message.channel === 'narrative').at(-1).authorDelivery, body);
  const readyIndex = frames.findIndex(frame => frame.type === 'agent' && frame.state === 'settling');
  assert.ok(readyIndex > 0); assert.equal(frames.slice(readyIndex).some(frame => frame.type === 'agent' && frame.state === 'end'), false);
  // Refresh while the deliberately slow scribe is pending. Do not regress to a
  // fake generation shell or replay the committed reply into a second bubble.
   await page.reload(); await page.locator('.settlement-note').waitFor();
   await page.locator('.settlement-note').filter({ hasText: '仍在等待 场记' }).waitFor();
  assert.equal(await page.getByText('后台未结束时即可阅读的合成正文。', { exact: false }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '停止生成', exact: true }).count(), 0);
  assert.equal(await page.locator('#send_but').count(), 1);
  const reconnect = frames.filter(frame => frame.type === 'hello' && frame.settling === true).at(-1);
  assert.equal(reconnect.streaming, true, 'operation lock stays visible to all clients');
  await page.evaluate(() => { window.__stateRefreshes = []; window.addEventListener('liyuan:turn-state-refreshed', event => window.__stateRefreshes.push(event.detail)); });
  await page.locator('#send_textarea').fill('合成第二条输入。'); await page.locator('#send_but').click(); await pause(200);
  assert.equal(writerCalls, 1, 'second writer must not use stale state while scribe is pending');
  if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, `author-ready-${width}.png`), fullPage: true }); }
  firstScribe.resolve();
  await page.getByText('等待必要状态更新后开始的第二拍合成正文。', { exact: false }).first().waitFor();
  for (let i = 0; i < 80 && await page.locator('.settlement-note').count(); i++) await pause(100);
  assert.equal(await page.locator('.settlement-note').count(), 0);
  assert.equal(writerCalls, 2); assert.equal(scribeCalls, 2);
  const stateRefreshes = await page.evaluate(() => window.__stateRefreshes);
  const firstReply = readySnapshot.messages.filter(message => message.channel === 'narrative').at(-1);
  assert.ok(stateRefreshes.some(source => source.entryId === firstReply.entryId && source.entryScope === firstReply.entryScope), 'completed hello must notify only the saved reply source');
  assert.ok(stateRefreshes.length >= 2, 'both background completions produce a read-only refresh notification');
  assert.deepEqual(errors, []);
  if (artifacts) await writeFile(join(artifacts, `delivery-${width}.safe.json`), JSON.stringify({ width, writerCalls, scribeCalls, requests, readyBeforeScribeCompleted: true, reconnectKeptAuthorReady: true, errors }, null, 2));
 } finally {
  firstScribe.resolve(); await browser?.close();
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await Promise.race([new Promise(done => host.once('exit', done)), pause(3000)]); if (host.exitCode === null) host.kill('SIGKILL'); }
  mock.closeAllConnections(); await new Promise(done => mock.close(done)); await rm(cwd, { recursive: true, force: true });
 }
});
