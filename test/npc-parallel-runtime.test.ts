import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter, getEventListeners } from 'node:events';
import { Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
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

test('runtime drains actual HTTP generations before releasing its identity lock', { timeout: 5000 }, async t => {
  for (const mode of ['normal', 'cancel', 'timeout', 'reset', 'close'] as const) {
    await t.test(mode, async t => {
      let server!: Server;
      let timeout!: () => void;
      const realTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number, ...args: unknown[]) => {
        if (ms === 15 * 60 * 1000) {
          timeout = callback;
          return realTimeout(() => {}, ms);
        }
        return realTimeout(callback, ms, ...args);
      });
      // No sockets, browser process, upstream assets or production data are used.
      t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
        server = this;
        (args.at(-1) as () => void)();
        return this;
      });
      t.mock.method(Server.prototype, 'address', () => ({ address: '127.0.0.1', family: 'IPv4', port: 12345 }));
      let token = '';
      const page = {
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {},
        async goto() {
          const response = new EventEmitter() as any;
          response.writeHead = () => {};
          response.end = (body: Buffer) => { token = JSON.parse(body.toString()).jobToken; };
          server.emit('request', { url: '/api/npc-parallel/context', method: 'GET', headers: {} }, response);
          await delay(0);
        },
        async evaluate(fn: () => unknown) {
          const code = String(fn);
          if (code.includes('emitReceived')) {
            for (let index = 0; index < 2; index++) {
              const request = new PassThrough() as any;
              Object.assign(request, { url: '/__npc-parallel-job/generate', method: 'POST', headers: {
                origin: 'http://127.0.0.1:12345', 'content-type': 'application/json', 'x-liyuan-npc-parallel-job': token,
              } });
              const response = new EventEmitter() as any;
              response.writeHead = () => {};
              response.end = () => { response.writableEnded = true; };
              server.emit('request', request, response);
              request.end(JSON.stringify({ messages: [{ role: 'user', content: 'synthetic request' }], maxTokens: 4096 }));
            }
            await ready;
            return;
          }
          if (code.includes('completion?.ready')) return mode === 'normal';
          if (code.includes('snapshot()')) return {
            sourceExtra: {}, sourceMes: 'synthetic body', completion: { saves: 1, edited: 1 }, status: '在场跳过 1',
          };
          return true;
        },
      };
      let disposed = false;
      const context = { async route() {}, async newPage() { return page; }, async close() { disposed = true; } };
      t.mock.method(chromium, 'launch', async () => ({ async newContext() { return context; }, async close() {} }));
      const controller = new AbortController();
      const finishes: Array<(value: string) => void> = [];
      const failures: Array<(error: Error) => void> = [];
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const runtime = new NpcParallelRuntime({ assetsCwd: process.cwd(), sources: source });
      let settled = false;
      let modelSignal!: AbortSignal;
      const running = runtime.run(base({ npcs: [{ name: 'synthetic npc' }], signal: controller.signal,
        generate(_request, signal) {
          modelSignal = signal!;
          // Deliberately ignore abort until the test explicitly settles both callbacks.
          return new Promise<string>((resolve, reject) => {
            finishes.push(resolve); failures.push(reject);
            if (finishes.length === 2) started();
          });
        },
      }));
      const outcome = running.then(value => { settled = true; return value; }, error => { settled = true; return error; });
      await Promise.race([ready, outcome.then(result => { throw new Error(`runtime exited before generation: ${result}`); })]);
      let management: Promise<void> | undefined;
      let managementDone = false;
      if (mode === 'cancel') controller.abort(new DOMException('synthetic cancellation', 'AbortError'));
      if (mode === 'timeout') timeout();
      if (mode === 'reset') management = runtime.reset();
      if (mode === 'close') management = runtime.close();
      if (management) void management.then(() => { managementDone = true; });
      await delay(10);
      assert.equal(settled, false);
      assert.equal(runtime.busy(), true);
      assert.equal(managementDone, false);
      assert.equal(modelSignal.aborted, mode !== 'normal');
      if (mode !== 'normal') assert.equal(disposed, true);
      await assert.rejects(runtime.run(base()), /busy/);
      finishes[0]('late synthetic content');
      await delay(10);
      assert.equal(settled, false);
      assert.equal(runtime.busy(), true);
      failures[1](new Error('late synthetic rejection'));
      const result = await outcome;
      if (mode === 'normal') assert.equal(result.calls, 2);
      else assert.equal(result.name, mode === 'timeout' ? 'TimeoutError' : 'AbortError');
      await management;
      assert.equal(runtime.busy(), false);
      if (mode === 'close') await assert.rejects(runtime.run(base()), /closed/);
      else assert.equal((await runtime.run(base())).calls, 0);
      await runtime.close();
    });
  }
});
