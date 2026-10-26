import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TavernPluginRuntime } from '../server/tavern-plugin-runtime.ts';

// Synthetic browser doubles only (same pattern as tavern-runtime-browser-reuse.test.ts); no real Chromium.
const TIMEOUT = 'timeout' as const;
const within = <T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work.catch(error => { throw error; }), new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), ms); })]).finally(() => clearTimeout(timer));
};
const settle = <T>(work: Promise<T>) => work.then(() => 'resolved', (error: Error) => `rejected:${error.message}`);
const packet = () => ({ systemPrompt: '', messages: [], worldbookEntries: [{ uid: 1, comment: 'synthetic', content: 'synthetic', enabled: true }], card: 'card.json' });

function harness() {
  const state = { launches: 0, closes: 0, hangEvaluate: false, hangLaunch: false, evaluations: 0, pending: [] as Array<() => void> };
  const makeBrowser = (id: number) => {
    let connected = true;
    return {
      id,
      isConnected: () => connected,
      close: async () => { connected = false; state.closes++; },
      newContext: async () => ({
        route: async () => {},
        close: async () => {},
        newPage: async function () {
          const context = this;
          return { on() {}, isClosed: () => !connected, context: () => context, goto: async () => {}, waitForFunction: async () => {},
            evaluate: async (_fn: unknown, p: any) => {
              state.evaluations++;
              // A wedged native listener: closing the browser does not settle this promise.
              if (state.hangEvaluate) await new Promise<void>(resolve => { state.pending.push(resolve); });
              return { ...p, retainedWorldbookIndices: [0], browser: id };
            } };
        },
      }),
    };
  };
  const launch = async () => {
    const id = ++state.launches;
    if (state.hangLaunch) await new Promise<void>(resolve => { state.pending.push(resolve); });
    return makeBrowser(id);
  };
  let signal: AbortSignal | undefined, turnNonce = 'turn';
  const http: any = {
    assetsCwd: '',
    binding: () => ({ scopeKey: 'scope', sourceEntryId: 'user-1', card: 'card.json' }),
    assertBinding() {},
    sources: { config() {}, status: () => ({ plugins: [{ id: 'helper', enabled: true, installed: true, commit: 'synthetic' }] }) },
    get turnSignal() { return signal; }, set turnSignal(value) { if (value !== signal) turnNonce += '-next'; signal = value; },
    get turnNonce() { return turnNonce; },
  };
  return { state, launch, http };
}

test('aborting a hung worldbook evaluate settles before(), discards the browser, and the next turn relaunches', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'liyuan-tavern-abort-'));
  const original = chromium.launch;
  const h = harness(); h.http.assetsCwd = root;
  chromium.launch = h.launch as any;
  const runtime = new TavernPluginRuntime(h.http, () => 'http://synthetic.invalid');
  try {
    const warm = await runtime.before(packet(), new AbortController().signal) as any;
    assert.equal(warm.browser, 1);
    h.state.hangEvaluate = true;
    const turn = new AbortController();
    const hung = settle(runtime.before(packet(), turn.signal));
    while (h.state.evaluations < 2) await new Promise(resolve => setTimeout(resolve, 5));
    turn.abort(new Error('synthetic deadline'));
    const outcome = await within(hung, 2000);
    assert.notEqual(outcome, TIMEOUT, 'an aborted before() must settle even if page.evaluate never answers');
    assert.match(String(outcome), /^rejected:插件任务已取消/);
    assert.equal(h.state.closes, 1, 'the wedged browser must be closed');
    assert.equal(runtime.busy(), false);
    h.state.hangEvaluate = false;
    const next = await within(runtime.before(packet(), new AbortController().signal), 2000) as any;
    assert.notEqual(next, TIMEOUT, 'the serialized queue must not stay wedged behind the abandoned evaluate');
    assert.equal(next.browser, 2, 'the next turn must use a freshly launched browser, not the wedged page');
    assert.equal(h.state.launches, 2);
  } finally {
    for (const release of h.state.pending) release();
    await runtime.close(); chromium.launch = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('aborting during a slow browser launch never installs the late browser for the next turn', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'liyuan-tavern-abort-'));
  const original = chromium.launch;
  const h = harness(); h.http.assetsCwd = root;
  chromium.launch = h.launch as any;
  const runtime = new TavernPluginRuntime(h.http, () => 'http://synthetic.invalid');
  try {
    h.state.hangLaunch = true;
    const turn = new AbortController();
    const hung = settle(runtime.before(packet(), turn.signal));
    while (h.state.launches < 1) await new Promise(resolve => setTimeout(resolve, 5));
    turn.abort(new Error('synthetic deadline'));
    const outcome = await within(hung, 2000);
    assert.notEqual(outcome, TIMEOUT, 'an aborted before() must settle even if launch never answers');
    h.state.hangLaunch = false;
    for (const release of h.state.pending.splice(0)) release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.state.closes, 1, 'the browser that finished launching after abort must be closed, not kept');
    const next = await within(runtime.before(packet(), new AbortController().signal), 2000) as any;
    assert.notEqual(next, TIMEOUT);
    assert.equal(next.browser, 2, 'the next turn must launch its own browser');
    assert.equal(h.state.evaluations, 1, 'the abandoned turn must never evaluate the filter');
  } finally {
    for (const release of h.state.pending) release();
    await runtime.close(); chromium.launch = original;
    await rm(root, { recursive: true, force: true });
  }
});
