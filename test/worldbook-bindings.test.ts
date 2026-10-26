import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { configPath, handleApiRequest, loadMergedLore, type RestHost } from '../server/rest.ts';
import { createDatabasePluginReadonlyLorebooks } from '../server/database-plugin-lorebooks.ts';
import { mergeEntries, normalizeEntries } from '../src/lorebook.ts';
import { loadStageMaterials } from '../src/stage/materials.ts';
import { boundedLore } from '../src/stage/prompt-budget.ts';
import { buildEcologyCardPrompt, buildEcologyRuntimePrompt, defaultLiteraryEcologyState, emptyEcologyCardPool, emptyEcologyGlobalPool } from '../src/stage/literary-ecology.ts';
import { DEFAULT_CONFIG, type RpConfig } from '../src/types.ts';
import { defaultState } from '../src/state.ts';
import { nativeWorldbookContext, resolveWorldbooks, setScopedLorebooks, worldbookSelections } from '../src/worldbook-bindings.ts';

function fixture(run: (cwd: string, config: RpConfig, host: RestHost, session: (id: string) => void) => unknown): unknown {
 const cwd = mkdtempSync(join(tmpdir(), 'liyuan-binding-synthetic-'));
 mkdirSync(join(cwd, 'assets/lorebooks'), { recursive: true });
 const embedded = [{ id: 1, content: '关闭模块不应被旧内嵌副本复活', enabled: true, comment: '可选人物', keys: ['可选人物'] }];
 writeFileSync(join(cwd, 'card.json'), JSON.stringify({ data: { name: '合成卡', description: '仅用于离线测试', extensions: { world: '合成主书' }, character_book: { name: '合成主书', entries: embedded } } }));
 writeFileSync(join(cwd, 'other.json'), JSON.stringify({ name: '另一合成卡', character_book: { name: '另一卡内书', entries: [] } }));
 writeFileSync(join(cwd, 'assets/lorebooks/合成主书.json'), JSON.stringify({ keepBook: { unknown: true }, entries: {
  old: { uid: 7, comment: '旧篇章', content: '独立同正文', enabled: false, constant: true, keys: ['旧篇章'] },
  current: { uid: 7, comment: '新篇章', content: '独立同正文', enabled: true, constant: true, keys: ['新篇章'], extensions: { unknown: 'keep' } },
  optional: { uid: 9, comment: '关闭可选人物', content: '关闭模块不应被旧内嵌副本复活', enabled: false, constant: true, keys: ['可选人物'] },
  blank: { uid: 10, comment: '空行也有身份', content: '', enabled: false },
 } }));
 const config: RpConfig = { ...DEFAULT_CONFIG, card: 'card.json', lorebooks: [] };
 writeFileSync(configPath(cwd), JSON.stringify(config));
 let id = 'session-A';
 const host = { cwd, worldbookSessionId: () => id, isStreaming: () => false, softRefreshConfig: async () => undefined, switchToCard: async () => 'created', notify: () => undefined } as unknown as RestHost;
 try {
  const result = run(cwd, config, host, next => { id = next; });
  if (result && typeof (result as Promise<unknown>).then === 'function') return (result as Promise<unknown>).finally(() => rmSync(cwd, { recursive: true, force: true }));
  rmSync(cwd, { recursive: true, force: true }); return result;
 } catch (error) { rmSync(cwd, { recursive: true, force: true }); throw error; }
}
async function request(host: RestHost, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
 const req: any = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]); req.method = method; req.url = url;
 let status = 0, text = '';
 await handleApiRequest(req, { writeHead(code: number) { status = code; }, end(chunk = '') { text += chunk; } } as never, host);
 return { status, body: JSON.parse(text) };
}
function update(book: any): any { return { ...book, entries: book.entries.map((entry: any) => ({ uid: entry.uid, enabled: entry.enabled, entryKey: entry.entryKey, fingerprint: entry.fingerprint })) }; }
function seedFile(cwd: string, file: string, name: string): void { writeFileSync(join(cwd, file), JSON.stringify({ name, entries: [{ uid: 1, content: name, enabled: true, constant: true }] })); }

test('explicit named standalone wins even unmounted; management, native, database, NPC and actual material rows agree', async () => fixture(async (cwd, config, host) => {
 const cardBefore = readFileSync(join(cwd, config.card)), file = 'assets/lorebooks/合成主书.json', before = readFileSync(join(cwd, file));
 const resolved = resolveWorldbooks(cwd, config), material = loadStageMaterials(cwd, { nativeTavernPlugins: true, sessionId: 'session-A' });
 assert.equal(resolved.primaryResolution, 'bound'); assert.equal(resolved.primary?.source, 'file'); assert.equal(resolved.embedded?.active, false);
 assert.equal(resolved.primary?.path, file); assert.equal(resolved.primary?.entries.length, 4);
 assert.deepEqual(material.entries.map(e => e.entryKey), ['old', 'current', 'optional', 'blank']);
 assert.deepEqual(material.entries.map(e => e.enabled), [false, true, false, false]);
 assert.match(material.markerMaterials.worldInfoBefore!, /新篇章/); assert.ok(!material.markerMaterials.worldInfoBefore?.includes('旧篇章'));
 assert.deepEqual(loadMergedLore(cwd, config).map(e => e.entryKey), ['old', 'current', 'optional', 'blank']);
 const native = nativeWorldbookContext(resolved);
 assert.equal(native.readonlyBooks['合成主书'].entries.length, 4); assert.equal(native.readonlyBooks['合成主书'].entries[1].unknown, 'keep');
 const database = createDatabasePluginReadonlyLorebooks(cwd, material);
 assert.equal(database.characterBookNames.length, 1); assert.equal(database.readonlyBooks[database.characterBookNames[0]].entries.length, 4);
 const names = await request(host, 'GET', '/api/tavern/worldbooks'); assert.deepEqual(names.body, { primary: '合成主书', additional: [], global: [], chat: [] });
 const read = await request(host, 'GET', '/api/tavern/worldbook?name=合成主书');
 assert.equal(read.status, 200); assert.equal(read.body.path, file); assert.equal(read.body.entries.length, 4);
 const listing = (await request(host, 'GET', '/api/lorebooks')).body;
 assert.equal(listing.primary.path, file); assert.equal(listing.embeddedCard.active, false);
 assert.ok(!JSON.stringify(boundedLore(material.entries)).includes('关闭模块'));
 assert.ok(readFileSync(join(cwd, file)).equals(before)); assert.ok(readFileSync(join(cwd, config.card)).equals(cardBefore));
 // Source-bound enable write changes this book only, not the embedded export or another row of same uid/content.
 const put = update(read.body); put.entries.find((e: any) => e.entryKey === 'current').enabled = false;
 assert.equal((await request(host, 'PUT', '/api/tavern/worldbook', put)).status, 200);
 assert.ok(readFileSync(join(cwd, config.card)).equals(cardBefore));
 const raw = JSON.parse(readFileSync(join(cwd, file), 'utf8'));
 assert.equal(raw.entries.old.enabled, false); assert.equal(raw.entries.current.enabled, false); assert.equal(raw.entries.optional.enabled, false);
 assert.deepEqual(raw.keepBook, { unknown: true });
 assert.equal((await request(host, 'PUT', '/api/tavern/worldbook', put)).status, 400, 'stale revisions remain rejected');
}));

test('absent declaration/absent file falls back without copying; ambiguous bindings fail rather than choosing arbitrary book', () => fixture((cwd, config) => {
 const raw = JSON.parse(readFileSync(join(cwd, config.card), 'utf8'));
 raw.data.extensions.world = 'missing'; writeFileSync(join(cwd, config.card), JSON.stringify(raw));
 const missing = resolveWorldbooks(cwd, config); assert.equal(missing.primaryResolution, 'embedded'); assert.equal(missing.declaredPrimary, 'missing');
 delete raw.data.extensions.world; writeFileSync(join(cwd, config.card), JSON.stringify(raw)); assert.equal(resolveWorldbooks(cwd, config).primary?.source, 'card');
 seedFile(cwd, 'assets/lorebooks/one.json', 'Ambiguous'); seedFile(cwd, 'assets/lorebooks/two.json', 'Ambiguous');
 raw.data.extensions.world = 'Ambiguous'; writeFileSync(join(cwd, config.card), JSON.stringify(raw)); assert.throws(() => resolveWorldbooks(cwd, config), /不唯一/);
 raw.data.extensions.world = 'assets/lorebooks/two.json'; writeFileSync(join(cwd, config.card), JSON.stringify(raw)); assert.equal(resolveWorldbooks(cwd, config).primary?.path, 'assets/lorebooks/two.json');
 seedFile(cwd, 'secret.json', 'Unlisted'); raw.data.extensions.world = join(cwd, 'secret.json'); writeFileSync(join(cwd, config.card), JSON.stringify(raw));
 assert.equal(resolveWorldbooks(cwd, config).primary?.source, 'card', 'card reference is not arbitrary file read authorization');
}));

test('deduplication uses book and raw row identity, never content, enabled flag, shared uid or emptiness', () => {
 const entries = normalizeEntries([{ uid: 1, content: 'same', enabled: false }, { uid: 1, content: 'same', enabled: true }, { uid: 3, content: '' }]);
 assert.equal(mergeEntries(entries, entries).length, 3);
 assert.equal(mergeEntries(entries, entries.map(e => ({ ...e }))).length, 6, 'unbound clones are independent; no content-based guesses');
 const bound = entries.map(e => ({ ...e, bookId: 'book-A' }));
 assert.equal(mergeEntries(bound, bound.map(e => ({ ...e }))).length, 3);
 assert.equal(mergeEntries(bound, bound.map(e => ({ ...e, bookId: 'book-B' }))).length, 6);
 assert.equal(mergeEntries(bound).filter(e => e.enabled).length, 2);
});

test('global, character auxiliary and chat selection stay separate across card/session switches; duplicate physical bindings load once', async () => fixture(async (cwd, config, host, setSession) => {
 const global = 'assets/lorebooks/global.json', aux = 'assets/lorebooks/aux.json', chat = 'assets/lorebooks/chat.json';
 for (const file of [global, aux, chat]) seedFile(cwd, file, file);
 config.lorebooks = [global]; writeFileSync(configPath(cwd), JSON.stringify(config));
 const identity = (await request(host, 'GET', '/api/lorebooks')).body.embeddedCard.cardIdentity;
 assert.equal((await request(host, 'POST', '/api/lorebooks/select', { path: aux, scope: 'character_aux', cardIdentity: identity })).status, 200);
 assert.equal((await request(host, 'POST', '/api/lorebooks/select', { path: chat, scope: 'chat', cardIdentity: identity, sessionId: 'session-A' })).status, 200);
 const names = (await request(host, 'GET', '/api/tavern/worldbooks')).body;
 assert.deepEqual(names.additional, [aux]); assert.deepEqual(names.global, [global]); assert.deepEqual(names.chat, [chat]);
 const chatBook = (await request(host, 'GET', `/api/tavern/worldbook?name=${encodeURIComponent(chat)}`)).body;
 setSession('session-B'); assert.deepEqual((await request(host, 'GET', '/api/tavern/worldbooks')).body.chat, []);
 assert.equal((await request(host, 'PUT', '/api/tavern/worldbook', update(chatBook))).status, 400);
 const selected = JSON.parse(readFileSync(configPath(cwd), 'utf8'));
 assert.equal((await request(host, 'POST', '/api/card/switch', { card: 'other.json' })).status, 200);
 const switched = JSON.parse(readFileSync(configPath(cwd), 'utf8'));
 const b = worldbookSelections(resolveWorldbooks(cwd, switched, { sessionId: 'session-A' }));
 assert.deepEqual(b.additional, []); assert.deepEqual(b.chat, []); assert.deepEqual(b.global, [global]);
 selected.lorebooks.push('assets/lorebooks/合成主书.json');
 const duplicate = resolveWorldbooks(cwd, selected, { sessionId: 'session-A' });
 assert.equal(duplicate.books.filter(book => book.path.endsWith('合成主书.json')).length, 1);
 assert.deepEqual(duplicate.primary?.scopes, ['character', 'global']); assert.equal(duplicate.primary?.scope, 'global');
 assert.equal(duplicate.books.flatMap(book => book.entries).filter(e => e.comment === '新篇章').length, 1);
 // stale bound primary snapshot must also fail on source/scope change.
}));

test('disabled lore is excluded BEFORE all ecology budgets, including adaptation/runtime and constant optional modules', () => fixture((cwd) => {
 const material = loadStageMaterials(cwd), enabled = material.entries.find(e => e.enabled)!;
 const disabled = { ...enabled, enabled: false, comment: '可选关闭', content: 'SHOULD_NOT_APPEAR' };
 assert.deepEqual(boundedLore([disabled, enabled], 1), [{ title: enabled.comment, content: enabled.content }]);
 const input = { ecology: defaultLiteraryEcologyState(), global: emptyEcologyGlobalPool(), cardPool: emptyEcologyCardPool(), lore: [disabled, enabled], state: defaultState(), history: [], userText: '合成输入', narrativeText: '合成正文' };
 assert.ok(!buildEcologyRuntimePrompt('合成职责', { ...input, phase: 'aftermath' }).userText.includes('SHOULD_NOT_APPEAR'));
 assert.ok(!buildEcologyCardPrompt('合成职责', { ...input, card: material.card }).userText.includes('SHOULD_NOT_APPEAR'));
}));

test('native-style renderer rules follow bound primary even without a redundant manual mount', async () => fixture(async (cwd, config) => {
 const path=join(cwd,'assets/lorebooks/合成主书.json'),book=JSON.parse(readFileSync(path,'utf8'));
 book.extensions={regex_scripts:[{id:'fixture-bound-skin',scriptName:'bound-primary-skin',findRegex:'/SYNTHETIC/g',replaceString:'RENDERED',placement:[2],markdownOnly:true,disabled:false}]};
 writeFileSync(path,JSON.stringify(book));
 const {loadCardFrontSnapshot}=await import('../server/rest.ts');
 assert.ok(loadCardFrontSnapshot(cwd).rules.some(rule=>rule.name==='bound-primary-skin'));
 assert.ok(!JSON.parse(readFileSync(configPath(cwd),'utf8')).lorebooks.length);
}));

test('new independent workspace copies the resolved unmounted primary and only selected-card auxiliaries, never old chat bindings', async () => fixture(async (cwd, config) => {
 const {PlaySlots}=await import('../server/play-slots.ts');
 seedFile(cwd,'assets/lorebooks/aux.json','Aux'); seedFile(cwd,'assets/lorebooks/unrelated.json','Unrelated');
 const scoped=setScopedLorebooks(config,'character_aux',['assets/lorebooks/aux.json']);
 scoped.lorebookBindings!.character!['other.json']=['assets/lorebooks/unrelated.json'];
 scoped.lorebookBindings!.chat={'old-session':{'card.json':['assets/lorebooks/unrelated.json']}};
 const slots=new PlaySlots(cwd,{cardFile:card=>({file:join(cwd,card),name:'Synthetic copy'}),snapshot:()=>({config:scoped as unknown as Record<string,unknown>,agent:{version:1,providers:{}}}),authorized:()=>true});
 slots.start=async()=>undefined; // Test workspace creation, not another real process/model.
 try {
  const created=await slots.create('card.json'),work=join(slots.root,created.id,'work');
  const material=loadStageMaterials(work),child=material.config;
  assert.equal(material.worldbooks?.primaryResolution,'bound'); assert.equal(material.worldbooks?.primary?.entries.length,4);
  assert.equal(child.lorebookBindings?.chat,undefined); assert.equal(child.lorebookBindings?.character?.['other.json'],undefined);
  assert.deepEqual(child.lorebookBindings?.character?.['card.json'],['assets/lorebooks/aux.json']);
  assert.ok(!material.entries.some(entry=>entry.content==='Unrelated'));
  assert.equal(material.entries.find(entry=>entry.entryKey==='optional')?.enabled,false);
  assert.deepEqual(readFileSync(join(work,'card.json')),readFileSync(join(cwd,'card.json')),'copy must not patch original card bytes to rewrite the declaration');
 } finally {slots.close();}
}));
