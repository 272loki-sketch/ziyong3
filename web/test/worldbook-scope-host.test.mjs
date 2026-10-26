// Product-owned native bridge, synthetic books only; no upstream plugin or real model requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '../..');
const row = (uid, entryKey, content, enabled = true) => ({ uid, entryKey, content, enabled, disable: !enabled, constant: true, position: 0, key: [], comment: content });
test('native host exposes separate global/character/chat scopes and preserves same-uid original rows', { timeout: 40_000 }, async () => {
 let browser;
 const context = { sessionId: 'synthetic', card: 'card.json', sourceEntryId: 'source', scopeKey: 'synthetic-scope', revision: 0, userName: 'User',
  character: { name: 'Char', avatar: 'card.png', data: { extensions: { world: 'Primary' }, character_book: { entries: [] } } },
  chat: [], state: { chatMetadata: {}, extensionSettings: {}, characterExtensions: {}, presetExtensions: {}, messages: {}, worldbooks: {} },
  readonlyBooks: { Primary: { entries: [row(7, 'old', 'SHOULD_NOT_LOAD', false), row(7, 'current', 'CURRENT_PRIMARY')] },
   Aux: { entries: [row(7, '0', 'AUX')] }, Global: { entries: [row(7, '0', 'GLOBAL')] }, Chat: { entries: [row(7, '0', 'CHAT')] } },
  worldbookSelections: { primary: 'Primary', additional: ['Aux'], global: ['Global'], chat: ['Chat'] },
  preset: { name: 'synthetic', prompts: [], extensions: {} }, model: { id: 'mock' } };
 const source = await readFile(join(root, 'web/public/tavern-compat/bridge-worldbooks.js'));
 const i18n = await readFile(join(root, 'web/public/tavern-compat/i18n.js'));
 const server = createServer((req, res) => { res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(req.url === '/bridge.js' ? source : req.url === '/i18n.js' ? i18n : '<!doctype html><html><body></body></html>'); });
 await new Promise(ok => server.listen(0, '127.0.0.1', ok));
 try {
  const binary = join(root, '.liyuan-database-plugin/browser/headless_shell'), libs = join(root, '.liyuan-database-plugin/browser-libs/lib64');
  browser = await chromium.launch({ headless: true, ...(existsSync(binary) ? { executablePath: binary } : {}), env: { ...process.env, ...(existsSync(libs) ? { LD_LIBRARY_PATH: libs } : {}) }, args: ['--no-sandbox'] });
  const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async context => {
   const { host, eventSource, event_types } = await import('/bridge.js');
   host.context = context; host.chat = []; host.characters = [context.character]; host.metadata = {}; host.extensions = {}; host.books = {}; host.presets = [context.preset]; host.prompts = {};
   await host.bind({...context,state:{...context.state,characterExtensions:{world:'stale-embedded-binding'}}});
   const module = host.modules['/scripts/world-info.js'];
   let groups; eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, data => { groups = data; });
   const prompt = await module.getWorldInfoPrompt([]);
   const primary = await module.loadWorldInfo('Primary');
   return { primary:host.characters[0].data.extensions.world,global: module.selected_world_info, charLore: module.world_info.charLore, chat: module.getChatWorldInfoNames(),
    keys: Object.keys(primary.entries), groups: Object.fromEntries(Object.entries(groups).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.map(e => e.content)])), prompt: prompt.worldInfoBefore };
  }, context);
  assert.equal(result.primary,'Primary'); assert.deepEqual(result.global, ['Global']); assert.deepEqual(result.charLore, [{ name: 'card', extraBooks: ['Aux'] }]); assert.deepEqual(result.chat, ['Chat']);
  assert.deepEqual(result.keys, ['old', 'current']); assert.deepEqual(result.groups.characterLore, ['SHOULD_NOT_LOAD', 'CURRENT_PRIMARY', 'AUX']);
  assert.deepEqual(result.groups.globalLore, ['GLOBAL']); assert.deepEqual(result.groups.chatLore, ['CHAT']);
  assert.ok(!result.prompt.includes('SHOULD_NOT_LOAD')); for (const text of ['CURRENT_PRIMARY', 'AUX', 'GLOBAL', 'CHAT']) assert.ok(result.prompt.includes(text));
  assert.deepEqual(errors, []);
 } finally { await browser?.close(); await new Promise(ok => server.close(ok)); }
});
