import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
test('multi-card pane: independent sockets/outboxes, three slots, hidden pane continues, raw text, mobile and failed pause (synthetic)', { timeout: 90_000 }, async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'liyuan-play-slots-ui-'));
 let server, browser, wss; const slots = [], frames = [], errors = [];
 const sessions = new Map(), histories = new Map(), connections = new Map();
 try {
  await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{PlaySlotsPanel}from'./src/components/PlaySlotsPanel.tsx';createRoot(document.getElementById('root')).render(<React.StrictMode><PlaySlotsPanel onClose={()=>window.__closed=true}/></React.StrictMode>);`, resolveDir: join(root, 'web'), loader: 'tsx' }, bundle: true, format: 'esm', jsx: 'automatic', outfile: join(cwd, 'fixture.js'), logLevel: 'silent' });
  await writeFile(join(cwd, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  server = createServer((req, res) => { void (async () => {
   const path = new URL(req.url, 'http://localhost').pathname;
   const json = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
   if (path === '/api/cards' || path === '/api/play-slots/cards') return json(200, { current: 'A.json', cards: ['甲', '乙', '丙'].map((name, i) => ({ path: `${i}.json`, name: `合成卡${name}` })) });
   if (path === '/api/play-slots' && req.method === 'GET') return json(200, { slots });
   if (path === '/api/play-slots' && req.method === 'POST') {
    let raw = ''; for await (const bytes of req) raw += bytes;
    const card = JSON.parse(raw).card, name = `合成卡${['甲','乙','丙'][Number(card.split('.')[0])]}`;
    const slot = { id: randomUUID(), name, state: 'running', busy: false, settling: false }; slots.push(slot); sessions.set(slot.id, randomUUID()); histories.set(slot.id, []);
    return json(201, { slot });
   }
   if (path.endsWith('/pause')) return json(409, { error: '合成暂停失败：卡位仍在后台整理，存档保留' });
   const files = { '/': join(cwd, 'index.html'), '/fixture.js': join(cwd, 'fixture.js'), '/app.css': join(root, 'web/src/app.css') };
   if (!files[path]) { res.writeHead(404); return res.end(); }
   res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(await readFile(files[path]));
  })().catch(() => { res.writeHead(500); res.end(); }); });
  wss = new WebSocketServer({ server });
  const hello = (ws, id) => ws.send(JSON.stringify({ type: 'hello', sessionId: sessions.get(id), deliveryProtocol: 1, messages: histories.get(id), streaming: false, settling: false, generationMode: 'director' }));
  wss.on('connection', (ws, req) => {
   const id = new URL(req.url,'http://localhost').pathname.split('/')[3]; connections.set(id, ws); hello(ws, id);
   ws.on('message', raw => {
    const packet = JSON.parse(raw); frames.push({ id, packet });
    if (packet.type !== 'prompt') return;
    assert.equal(packet.sessionId, sessions.get(id));
    histories.get(id).push({ channel: 'user', text: packet.text, messageId: packet.messageId });
    ws.send(JSON.stringify({ type: 'prompt_ack', messageId: packet.messageId, sessionId: sessions.get(id), status: 'accepted' }));
    ws.send(JSON.stringify({ type: 'agent', state: 'start' }));
   });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('combobox', { name: '并行角色卡' }).selectOption('0.json');
  await page.getByRole('button', { name: '新开独立卡位', exact: true }).click();
  const first = () => page.getByRole('region', { name: '合成卡甲独立游玩' }); await first().getByRole('status').filter({ hasText: '可以输入' }).waitFor();
  await first().getByRole('combobox', { name: '合成卡甲生成模式' }).selectOption('direct');
  await page.getByRole('textbox', { name: '合成卡甲输入' }).fill('甲席独立输入'); await first().getByRole('button', { name: '发送', exact: true }).click();
  await first().getByRole('status').filter({ hasText: '生成中' }).waitFor();
  await page.getByRole('combobox', { name: '并行角色卡' }).selectOption('1.json'); await page.getByRole('button', { name: '新开独立卡位', exact: true }).click();
  const second = () => page.getByRole('region', { name: '合成卡乙独立游玩' }); await second().getByRole('status').filter({ hasText: '可以输入' }).waitFor();
  await page.getByRole('textbox', { name: '合成卡乙输入' }).fill('乙席独立输入'); await second().getByRole('button', { name: '发送', exact: true }).click();
  await second().getByRole('status').filter({ hasText: '生成中' }).waitFor();
  assert.equal(frames.filter(row => row.packet.type === 'prompt').length, 2); assert.notEqual(frames[0].id, frames[1].id);
  const original = '<script>window.__unsafe=true</script>\n<options>原格式未改写</options>\n甲席的完整原稿';
  histories.get(slots[0].id).push({ channel: 'backstage', text: '合成专家报告，不是故事事实' });
  histories.get(slots[0].id).push({ channel: 'narrative', text: '短事实投影不能替换', authorDelivery: original });
  hello(connections.get(slots[0].id), slots[0].id);
  await page.getByRole('navigation', { name: '独立游玩卡位' }).getByRole('button', { name: /合成卡甲/ }).click();
  assert.equal(await first().getByRole('combobox', { name: '合成卡甲生成模式' }).inputValue(), 'direct', 'a hello/default mode must not override the user-selected next submission mode');
  assert.equal(frames[0].packet.generationMode, 'direct');
  assert.equal(await first().getByText('幕后信息 · 非正文', { exact: true }).count(), 1);
  assert.equal(await first().locator('pre').last().textContent(), original); assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  assert.equal((await first().textContent()).includes('乙席独立输入'), false);
  await page.getByRole('combobox', { name: '并行角色卡' }).selectOption('2.json'); await page.getByRole('button', { name: '新开独立卡位', exact: true }).click();
  await page.getByRole('region', { name: '合成卡丙独立游玩' }).getByRole('status').filter({ hasText: '可以输入' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '新开独立卡位', exact: true }).isDisabled(), true);
  await page.getByRole('navigation', { name: '独立游玩卡位' }).getByRole('button', { name: '暂停', exact: true }).first().click();
  await page.getByRole('alert').filter({ hasText: '合成暂停失败' }).waitFor(); assert.equal(slots.length, 3);
  await page.waitForTimeout(3100); assert.equal(await page.getByRole('alert').filter({ hasText: '合成暂停失败' }).count(), 1, 'successful status polling must not erase a failed management action');
  // Full-window recovery items share the same slot store, but cannot silently
  // turn an assistant request or a plot-bound prompt into ordinary prose.
  const recoveryId = randomUUID(), assistantRecoveryId = randomUUID(), recoveryText = '合成带剧情方向的恢复草稿';
  await page.evaluate(({slotId,sessionId,recoveryId,assistantRecoveryId,recoveryText}) => {
   sessionStorage.setItem(`liyuan.play-slot.${slotId}.liyuan.prompt-outbox.v1`, JSON.stringify([
    {frame:{type:'prompt',text:recoveryText,sessionId,messageId:recoveryId,generationMode:'director',plotChoice:{contextKey:'a'.repeat(64),optionId:'synthetic_option'}},state:'rejected',reason:'synthetic recovery',createdAt:Date.now()},
    {frame:{type:'assistant_prompt',text:'合成助手恢复，不是正文',sessionId:'assistant:synthetic',messageId:assistantRecoveryId},state:'rejected',reason:'synthetic uncertain assistant',createdAt:Date.now()},
   ]));
  }, {slotId:slots[0].id,sessionId:sessions.get(slots[0].id),recoveryId,assistantRecoveryId,recoveryText});
  await page.reload();await first().getByRole('status').filter({hasText:'可以输入'}).waitFor();
  const assistantItem=first().locator('.play-slot-outbox').filter({hasText:'合成助手恢复，不是正文'});
  assert.equal(await assistantItem.getByRole('button',{name:'恢复到输入框',exact:true}).count(),0);
  await first().getByRole('button',{name:'恢复到输入框',exact:true}).click();
  assert.equal(await first().getByRole('textbox',{name:'合成卡甲输入'}).inputValue(),recoveryText);
  assert.equal(await first().getByRole('combobox',{name:'合成卡甲生成模式'}).inputValue(),'director');
  assert.equal(await first().getByRole('button',{name:'发送',exact:true}).isDisabled(),true);
  const recovered=await page.evaluate(slotId=>JSON.parse(sessionStorage.getItem(`liyuan.play-slot.${slotId}.plot-draft`)),slots[0].id);
  assert.deepEqual(recovered.choice,{contextKey:'a'.repeat(64),optionId:'synthetic_option'});
  assert.equal(frames.some(row=>[recoveryId,assistantRecoveryId].includes(row.packet.messageId)),false);
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.getByRole('button', { name: '关闭多卡并行' }).click(); assert.equal(await page.evaluate(() => window.__closed), true);
  assert.deepEqual(errors, []);
 } finally {
  await browser?.close(); for (const ws of wss?.clients ?? []) ws.terminate(); await new Promise(resolve => wss ? wss.close(resolve) : resolve()); if (server) await new Promise(resolve => server.close(resolve)); await rm(cwd, { recursive: true, force: true });
 }
});
