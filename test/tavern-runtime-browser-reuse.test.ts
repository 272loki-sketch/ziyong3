import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TavernPluginRuntime } from '../server/tavern-plugin-runtime.ts';

test('two turns reuse the browser, isolate source/nonce realms, and never cache failed readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'liyuan-tavern-reuse-'));
  const launch = chromium.launch;
  let launches = 0, closes = 0, contextCloses = 0, readyFailure = false;
  const routes: Array<(route: any) => Promise<void>> = [];
  let sourceEntryId = 'user-1', turnNonce = 'turn-1';
  let signal: AbortSignal | undefined;
  const browser: any = {
    isConnected: () => true,
    close: async () => { closes++; },
    newContext: async () => ({
      route: async (_pattern: string, handler: any) => { routes.push(handler); },
      close: async () => { contextCloses++; },
      newPage: async function () {
        const context = this;
        return { on() {}, isClosed: () => false, context: () => context, goto: async () => {},
          waitForFunction: async () => { if (readyFailure) throw Error('synthetic readiness failure'); },
          evaluate: async () => '' };
      },
    }),
  };
  chromium.launch = async () => { launches++; return browser; };
  const http: any = {
    assetsCwd: root,
    binding: () => ({ scopeKey: 'scope', sourceEntryId }),
    assertBinding(scope: string, source: string) { assert.equal(scope, 'scope'); assert.equal(source, sourceEntryId); },
    sources: { config() {}, status: () => ({ plugins: [{ id: 'helper', enabled: true, installed: true, commit: 'synthetic' }] }) },
    get turnSignal() { return signal; }, set turnSignal(value) { if (value !== signal) turnNonce += '-next'; signal = value; },
    get turnNonce() { return turnNonce; },
  };
  const runtime = new TavernPluginRuntime(http, () => 'http://synthetic.invalid');
  try {
    const first = new AbortController().signal;
    await runtime.before({ systemPrompt: '', messages: [] }, first);
    sourceEntryId = 'assistant-1'; await runtime.after(sourceEntryId, first);
    const second = new AbortController().signal;
    await runtime.before({ systemPrompt: '', messages: [] }, second);
    sourceEntryId = 'user-2'; await runtime.before({ systemPrompt: '', messages: [] }, second);
    sourceEntryId = 'assistant-2'; await runtime.after(sourceEntryId, second);
    assert.equal(launches, 1);
    assert.equal(closes, 0);
    assert.equal(contextCloses, 4);
    const headers: any[] = [];
    for (const route of routes) await route({ request: () => ({ url: () => 'http://synthetic.invalid/api/tavern-plugins/state', headers: () => ({}) }), continue: async (options: any) => { headers.push(options.headers); } });
    assert.deepEqual(headers.map(h => h['x-liyuan-tavern-source']), ['user-1', 'assistant-1', 'assistant-1', 'user-2', 'assistant-2']);
    assert.notEqual(headers[1]['x-liyuan-tavern-turn'], headers[2]['x-liyuan-tavern-turn']);
    sourceEntryId = 'user-3'; readyFailure = true;
    await assert.rejects(runtime.before({ systemPrompt: '', messages: [] }, second), /原酒馆插件加载未完成/);
    const count = routes.length; readyFailure = false;
    await runtime.before({ systemPrompt: '', messages: [] }, second);
    assert.equal(routes.length, count + 1, 'an unready realm must be discarded, not reused');
    assert.equal(launches, 1);
  } finally {
    await runtime.close(); chromium.launch = launch;
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(closes, 1);
});
