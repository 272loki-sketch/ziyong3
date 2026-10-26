import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TavernPluginHttp } from '../server/tavern-plugin-http.ts';
import { syntheticTavernPluginContext } from '../server/tavern-plugin-runtime.ts';

test('settings host assets use exact allowlist, byte equality, correct MIME and no-store', async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'liyuan-settings-assets-'));
 const api = new TavernPluginHttp(cwd, { context: syntheticTavernPluginContext, isStreaming: () => false }, process.cwd());
 const server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
 try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const name of ['i18n.js', 'settings-ui.js', 'settings-host.css', 'frontend-api.js']) {
   const response = await fetch(`${base}/tavern-compat/${name}`);
   assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
   assert.match(response.headers.get('content-type')!, name.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
   assert.equal(await response.text(), await readFile(join(process.cwd(), 'web/public/tavern-compat', name), 'utf8'));
  }
  for (const [served, original] of [['host.js','host-frontends.js'],['host-base.js','host-worldbooks.js']]) {
   const response=await fetch(`${base}/tavern-compat/${served}`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   assert.equal(await response.text(),await readFile(join(process.cwd(),'web/public/tavern-compat',original),'utf8'));
  }
  for (const path of ['liyuan.config.json', 'unlisted.js', 'settings-host.css/other', 'web/public/tavern-compat/i18n.js']) assert.equal((await fetch(`${base}/tavern-compat/${path}`)).status, 404);
 } finally { api.sources.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); }
});
