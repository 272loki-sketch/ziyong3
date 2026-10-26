import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { planningHistory, planningLore, validatePlotGrounding, plotMaterialKey } from '../src/plot-options/relevance.ts';
import { plotCards, retrievePlotCards } from '../src/plot-options/library.ts';
import { PlotOptionsEngine, plotContextKey, type PlotContext } from '../src/plot-options/engine.ts';
import { normalizeEntries } from '../src/lorebook.ts';
import { syntheticPlotGrounding } from './fixtures/plot-grounding.ts';
const patterns = ['合成共同整理', '合成共同修理'].map(title => ({ docId: 'synthetic', title, locator: title, setting: '合成工坊', surfaceActivity: '协作整理材料并核对数量', initiative: '双方明确同意处理任务', sweetBeat: '发现彼此做事习惯', friction: '对分类与分工有不同意见', misunderstanding: '', microChange: '共同完成小任务后重新认识对方', escalationLimit: '不预定关系', naturalStop: '核对结束', failureWarning: '没有明确需求时不参与' }));
const history = [{ id: 'old', role: 'assistant', text: '旧场景已经离开，相关活动结束。' }, { id: 'user', role: 'user', text: '我请教保管员如何处理这份材料。' }, { id: 'latest', role: 'assistant', text: '现在在合成工坊内，保管员正在核对箱里的材料数量。' }];
const cards = plotCards(patterns);
const proof = () => syntheticPlotGrounding({ candidates: cards, recentHistory: history });

test('latest committed narrative is complete rather than its last 3000 chars; disabled lore stays outside input', () => {
 const text = '最新正文开头的明确条件。' + '甲'.repeat(5000) + '最新正文末尾的实际停点。';
 const recent = planningHistory([...history, { id: 'long', role: 'assistant', text }]);
 assert.equal(recent.at(-1)?.text, text); assert.ok(recent.at(-1)?.text.startsWith('最新正文开头'));
 const entries = normalizeEntries([{ content: '保管员在工坊负责核对材料。', keys: ['保管员'], enabled: true }, { content: 'CLOSED_MODULE_MUST_NOT_APPEAR', keys: ['保管员'], constant: true, enabled: false }, { content: '合成世界的常驻规则', enabled: true, constant: true }]);
 const lore = planningLore(entries, history); assert.equal(lore.length, 2); assert.ok(!JSON.stringify(lore).includes('CLOSED_MODULE'));
 const key = plotMaterialKey({ modelKey: 'synthetic', skill: 'synthetic', worldLore: entries }, history);
 assert.notEqual(key, plotMaterialKey({ modelKey: 'another', skill: 'synthetic', worldLore: entries }, history));
});

test('acceptance requires latest original evidence AND source activity/friction/change, not a valid cardId with renamed scene', () => {
 const valid = proof(); assert.ok(validatePlotGrounding(valid, history, cards[0]));
 assert.equal(validatePlotGrounding({ cardId: cards[0].id, title: '同一幕换标题', draft: '走到桌旁坐下。' }, history, cards[0]), undefined);
 assert.equal(validatePlotGrounding({ ...valid, grounding: [{ entryId: 'old', quote: history[0].text }] }, history, cards[0]), undefined);
 assert.equal(validatePlotGrounding({ ...valid, grounding: [{ entryId: 'latest', quote: '原文里没有发生的邀请' }] }, history, cards[0]), undefined);
 assert.equal(validatePlotGrounding({ ...valid, mechanism: { ...valid.mechanism, friction: { quote: '源卡根本没有的内容', adaptation: '声称有摩擦但没有来源' } } }, history, cards[0]), undefined);
 assert.equal(validatePlotGrounding({ ...valid, mechanism: { activity: valid.mechanism.activity, change: valid.mechanism.change } }, history, cards[0]), undefined);
 assert.equal(validatePlotGrounding({ ...valid, mechanism: Object.fromEntries(Object.entries(valid.mechanism).map(([key, value]) => [key, { ...value, adaptation: '同一段静态观察。' }])) }, history, cards[0]), undefined);
});

async function engineFixture(run: (payload: any) => any, testRun: (x: any) => Promise<void>) {
 const cwd = mkdtempSync(join(tmpdir(), 'liyuan-plot-relevance-')); let calls = 0;
 const context: PlotContext = { sessionId: 'synthetic', cardIdentity: 'synthetic-card', sourceId: 'latest', branch: history.map(h => ({ id: h.id, type: 'message', message: { role: h.role, content: h.text, ...(h.role === 'assistant' ? { details: { rpNarrative: h.text }, stopReason: 'stop' } : {}) } })), card: { name: '合成场景卡', description: '' }, persona: '', state: { location: '陈旧站台缓存' }, outline: {}, outlineHash: 'synthetic', modelKey: 'synthetic-model', skill: 'synthetic-skill', worldLore: normalizeEntries([{ content: '合成世界仅允许已确认的任务', constant: true, enabled: true }]) };
 const engine = new PlotOptionsEngine({ cwd, context: () => context, busy: () => false, library: () => patterns, appendControl: () => { throw Error('No story writes'); }, run: async (_sp, ut) => { calls++; return JSON.stringify(run(JSON.parse(ut))); } });
 const settled = async () => { for (let i = 0; i < 200; i++) { if (!engine.view().running) return; await new Promise(r => setTimeout(r, 5)); } throw Error('synthetic task timeout'); };
 try { await testRun({ engine, context, settled, calls: () => calls }); } finally { engine.close(); rmSync(cwd, { recursive: true, force: true }); }
}

test('real input labels stale state as reference, includes effective lore and latest-turn identity; no extra judge calls', async () => {
 let captured: any;
 await engineFixture(payload => { captured = payload; return { options: [{ cardId: payload.candidates[0].id, experience: '合成互动体验', draft: '我询问是否需要核对材料。', ...syntheticPlotGrounding(payload) }] }; }, async ({ engine, settled, calls }) => {
  engine.settings({ enabled: true }, engine.view().contextKey); await settled();
  assert.equal(captured.state, undefined); assert.match(captured.sceneStateReferenceOnly, /陈旧站台缓存/);
  assert.equal(captured.latestTurn.narrativeEntryId, 'latest'); assert.equal(captured.recentHistory.at(-1).text, history.at(-1)?.text); assert.equal(captured.worldLore.length, 1);
  assert.equal(engine.view().options.length, 1); assert.equal(engine.view().options[0].development.length, 3); assert.equal(calls(), 1);
 });
});

test('renamed duplicate plans are not treated as distinct experiences; ungrounded proposals never become options', async () => {
 await engineFixture(payload => ({ options: payload.candidates.slice(0, 2).map((card: any, index: number) => ({ cardId: card.id, title: `另一标题${index}`, experience: '表面不同的体验', draft: index ? '我询问材料怎么核对。' : '我请教材料如何核对。', ...syntheticPlotGrounding({ ...payload, candidates: [card] }) })) }), async ({ engine, settled, calls }) => {
  engine.settings({ enabled: true }, engine.view().contextKey); await settled(); assert.equal(engine.view().options.length, 1); assert.equal(calls(), 1);
 });
 await engineFixture(payload => ({ options: [{ cardId: payload.candidates[0].id, title: '只复述眼前一幕', experience: '没有活动的新名字', draft: '我站在原地观察。' }] }), async ({ engine, settled, calls }) => {
  engine.settings({ enabled: true }, engine.view().contextKey); await settled(); assert.equal(engine.view().options.length, 0); assert.match(engine.view().error ?? '', /未采用/); engine.tick(); await settled(); assert.equal(calls(), 1, 'validation failure is not a hidden paid retry');
 });
});

test('old recommendations remain in audit storage but are withdrawn without automatically charging for regeneration', async () => {
 await engineFixture(() => { throw Error('No automatic regeneration allowed'); }, async ({ engine, context, calls }) => {
  engine.store.settings({ enabled: true }); const key = plotContextKey(context);
  const old = { contextKey: key, sourceId: 'latest', outlineHash: context.outlineHash, sourceHash: 'old', libraryHash: 'old', rounds: 2, selectionEntryId: null, options: [{ id: 'old-option', cardId: cards[0].id, cardHash: cards[0].hash, title: '旧推荐', experience: '旧体验', draft: '旧草稿', prerequisites: [], setup: [], development: [], boundaries: [], entryCondition: '' }], createdAt: '2026-01-01T00:00:00Z' };
  engine.store.save(old); assert.equal(engine.view().options.length, 0); assert.match(engine.view().error ?? '', /手动重新筹备/); engine.tick(); assert.equal(calls(), 0); assert.deepEqual(engine.store.batches(key)[0], old); assert.throws(() => engine.resolve({ contextKey: key, optionId: 'old-option' }), /过期/);
 });
});

test('latest scene relevance is weighted over common long background terms across the entire library', () => {
 const rows = Array.from({ length: 70 }, (_, i) => ({ ...patterns[0], title: `常见背景${i}`, locator: String(i), setting: '日常学校站台与教室', surfaceActivity: '随便讨论日常学校生活' }));
 rows.push({ ...patterns[0], title: '合成失物编号协作', locator: 'needle', setting: '器材保管室', surfaceActivity: '核对失物编号并寻找登记遗漏' });
 const found = retrievePlotCards(plotCards(rows), '日常学校站台教室 '.repeat(100), 5, [], '现在进入器材保管室，核对失物编号。'); assert.equal(found[0].title, '合成失物编号协作');
});

test('material version changes withdraw stale proposals without rewriting an already selected user direction', async () => {
 await engineFixture(payload => ({ options: [{ cardId: payload.candidates[0].id, experience: '合成体验', draft: '我询问是否需要核对材料。', ...syntheticPlotGrounding(payload) }] }), async ({ engine, context, settled, calls }) => {
  engine.settings({ enabled: true }, engine.view().contextKey); await settled();
  const before = engine.view(), choice = { contextKey: before.contextKey, optionId: before.options[0].id };
  const selected = engine.resolve(choice); context.branch.push({ id: 'selected', message: { role: 'user', content: '用户亲自确认的方向', details: { rpPlotSelection: selected } } });
  context.worldLore[0].enabled = false;
  assert.equal(engine.view().options.length, 0); assert.throws(() => engine.resolve(choice), /过期/);
  assert.equal(engine.view().active?.option.id, selected.option.id, 'accepted user intent is not a stale suggestion to delete');
  engine.tick(); assert.equal(calls(), 1);
 });
});
