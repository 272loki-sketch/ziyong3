import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { NpcParallelRuntime, npcWaitForPage, type NpcParallelRunInput, type NpcParallelSourceLike } from '../server/npc-parallel-runtime.ts';

const candidate = {
  root: '/tmp/npc-parallel-synthetic',
  version: 'fixture-1',
  commit: '1'.repeat(40),
  sha256: 'a'.repeat(64),
  manifest: { js: 'index.js', css: 'style.css', version: 'fixture-1' },
};
const source: NpcParallelSourceLike = {
  active: () => candidate,
  resolveAsset: () => null,
};
const base = (overrides: Partial<NpcParallelRunInput> = {}): NpcParallelRunInput => ({
  sessionId: 'synthetic-session',
  card: 'synthetic-card',
  sourceEntryId: 'assistant-1',
  chat: [{ entryId: 'assistant-1', mes: 'synthetic body', is_user: false, name: 'synthetic actor', extra: {} }],
  npcs: [],
  worldbooks: {},
  settings: { untouched: 'synthetic-value' },
  metadata: { npc_parallel: { npcs: [] } },
  constraintText: 'synthetic authoritative constraint',
  guard() {},
  async generate() { throw new Error('empty roster must not invoke generate'); },
  ...overrides,
});

test('NpcParallelRuntime uses native Node 22-compatible constructor properties', () => {
  const runtime = new NpcParallelRuntime({ assetsCwd: process.cwd(), sources: source });
  assert.equal(runtime.busy(), false);
});

test('empty roster returns a no-op candidate without launching a browser/model call', async () => {
  const runtime = new NpcParallelRuntime({ assetsCwd: process.cwd(), sources: source });
  const result = await runtime.run(base());
  assert.deepEqual(result.entries, []);
  assert.equal(result.calls, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.settings, { untouched: 'synthetic-value' });
  assert.deepEqual(result.metadata, { npc_parallel: { npcs: [] } });
  assert.equal(result.version, 'fixture-1');
  assert.equal(result.commit, candidate.commit);
});

test('a missing SourceLike.active candidate fails explicitly', async () => {
  const runtime = new NpcParallelRuntime({ assetsCwd: process.cwd(), sources: { ...source, active: () => null } });
  await assert.rejects(runtime.run(base()), /来源尚未安装\/启用/);
});

test('latest source binding is validated before browser startup', async () => {
  const runtime = new NpcParallelRuntime({ assetsCwd: process.cwd(), sources: source });
  const input = base({ chat: [
    { entryId: 'assistant-old', mes: 'old', is_user: false },
    { entryId: 'assistant-1', mes: 'current', is_user: false },
    { entryId: 'assistant-later', mes: 'not bound', is_user: false },
  ] });
  await assert.rejects(runtime.run(input), /只允许对当前分支最新的 AI 正文执行/);
  assert.equal(runtime.busy(), false);
});

test('managed failure explains truncation but does not expose provider content or credentials',async()=>{
 const {npcManagedFailureReason}=await import('../server/npc-parallel-runtime.ts');
 assert.match(npcManagedFailureReason(Error('new/flash [unknown] 辅助模型输出触及上限，截断结果不采用')),/输出达到上限/);
 const failure=npcManagedFailureReason(Error('401 unauthorized private-key-is-very-sensitive https://private.endpoint'));
 assert.match(failure,/凭据/);assert.doesNotMatch(failure,/private|https/);
});

test('receipt polling cancels a pending check promptly and ignores its late completion', { timeout: 2000 }, async () => {
  for (const lateReject of [false, true]) {
    const controller = new AbortController();
    const reason = new DOMException('synthetic task cancelled', 'AbortError');
    let finish!: (ready: boolean) => void;
    let fail!: (error: Error) => void;
    const checkResult = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
    let checks = 0;
    let commits = 0;
    const waiting = npcWaitForPage(() => { checks++; return checkResult; }, 15 * 60 * 1000, 'receipt missing', controller.signal)
      .then(() => { commits++; });
    const rejected = assert.rejects(waiting, error => error === reason);
    await delay(10);
    const start = performance.now();
    controller.abort(reason);
    await rejected;
    assert.ok(performance.now() - start < 500, 'cancellation must not wait for check or the task deadline');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    if (lateReject) fail(new Error('late synthetic check failure'));
    else finish(true);
    await delay(100);
    assert.equal(checks, 1);
    assert.equal(commits, 0);
  }
});

test('receipt polling cancels between checks without restarting the poll', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const reason = new DOMException('synthetic runtime reset', 'AbortError');
  let checks = 0;
  const waiting = npcWaitForPage(async () => { checks++; return false; }, 15 * 60 * 1000, 'receipt missing', controller.signal);
  const rejected = assert.rejects(waiting, error => error === reason);
  await delay(10);
  controller.abort(reason);
  await rejected;
  await delay(100);
  assert.equal(checks, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('receipt polling propagates check errors and skips checks for an already cancelled task', async () => {
  const controller = new AbortController();
  const failure = new Error('synthetic check failure');
  await assert.rejects(npcWaitForPage(async () => { throw failure; }, 1000, 'receipt missing', controller.signal), error => error === failure);
  await assert.rejects(npcWaitForPage(() => { throw failure; }, 1000, 'receipt missing', controller.signal), error => error === failure);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(failure);
  await assert.rejects(npcWaitForPage(async () => { assert.fail('cancelled task must not check'); }, 1000, 'receipt missing', controller.signal), error => error === failure);
});

test('receipt polling returns on readiness and preserves its timeout error', async () => {
  const controller = new AbortController();
  await npcWaitForPage(async () => true, 1000, 'receipt missing', controller.signal);
  await assert.rejects(npcWaitForPage(async () => false, 1, 'synthetic receipt missing', controller.signal), /synthetic receipt missing/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
