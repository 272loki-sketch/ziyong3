import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { DatabasePluginRuntime } from '../server/database-plugin-runtime.ts';
import { TavernPluginRuntime } from '../server/tavern-plugin-runtime.ts';

test('private computation browsers disable GPU compositing before creating a page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'liyuan-browser-options-'));
  const launch = chromium.launch;
  const options: Parameters<typeof chromium.launch>[0][] = [];
  const boundary = new Error('synthetic launch boundary');
  chromium.launch = async function (value) { options.push(value); throw boundary; };
  try {
    const database = new DatabasePluginRuntime({
      root, currentContext: () => ({ sourceEntryId: 'synthetic-user' }),
      scopeKey: () => 'synthetic-scope', managedPresets: () => [],
      sources: { readCurrentPinnedJS() {} },
    } as any, () => 'http://synthetic.invalid');
    const tavern = new TavernPluginRuntime({
      assetsCwd: root, binding: () => ({ scopeKey: 'synthetic-scope', sourceEntryId: 'synthetic-user' }),
      sources: { status: () => ({ plugins: [] }) },
    } as any, () => 'http://synthetic.invalid');
    await assert.rejects(database.rpc('synthetic'), error => error === boundary);
    await assert.rejects(tavern.smoke(), error => error === boundary);
    assert.equal(options.length, 2);
    for (const value of options) {
      assert.equal(value?.headless, true);
      assert.ok(value?.args?.includes('--disable-gpu'));
      assert.equal(value?.args?.includes('--no-sandbox'), process.getuid?.() === 0);
      assert.equal(value?.ignoreDefaultArgs, undefined);
    }
  } finally {
    chromium.launch = launch;
    await rm(root, { recursive: true, force: true });
  }
});
