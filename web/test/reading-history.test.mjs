// Real App and real message components; loopback-only synthetic REST/WS, no host data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
const messages = Array.from({ length: 1000 }, (_, i) => ({ channel: i % 2 ? 'narrative' : 'user', text: `Synthetic floor ${i + 1}.\n\nOnly generated fixture text.`, entryId: `floor-${i + 1}`, entryScope: 'synthetic' }));
messages.splice(998, 0, { channel: 'html', text: 'Synthetic script', scripts: true, html: '<div style="height:120px">Synthetic script frame</div><script>window.syntheticRuns=(window.syntheticRuns||0)+1;</script>' });
const hello = sessionId => ({ type: 'hello', sessionId, appVersion: '1.8.16', charName: 'Synthetic', userName: 'Fixture', streaming: false, messages, state: null, stats: null, panels: [], cardfront: { enabled: false, hasSkin: false, rules: [] } });
const cards = ['one', 'two', 'three'].map(name => ({ name, path: `${name}.json`, tags: [], isPng: false, mtimeMs: 1, fav: false }));

test('App: 1000 floors, bounded initial DOM, prepend anchor, stable scripts, REST/hello orders and beginning fallback', { timeout: 90000 }, async () => {
	const work = await mkdtemp(join(tmpdir(), 'liyuan-reading-app-'));
	let browser, server;
	try {
		await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App.tsx';import './src/app.css';createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`, resolveDir: join(root, 'web'), loader: 'tsx' }, define: { __LIYUAN_BUILD_VERSION__: '"1.8.16"' }, bundle: true, jsx: 'automatic', format: 'esm', outfile: join(work, 'fixture.js'), logLevel: 'silent' });
		server = createServer(async (req, res) => {
			if (req.url === '/fixture.js' || req.url === '/fixture.css') {
				res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
				return res.end(await readFile(join(work, req.url.slice(1))));
			}
			res.setHeader('content-type', 'text/html');
			res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
		});
		await new Promise(done => server.listen(0, '127.0.0.1', done));
		const base = `http://127.0.0.1:${server.address().port}`;
		browser = await chromium.launch({ headless: true, ...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE ? { executablePath: process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? '' }, args: ['--no-sandbox'] });
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
			page.setDefaultTimeout(12000);
			const errors = [], writes = [];
			page.on('pageerror', e => { errors.push(e.message); console.error('Synthetic App error:', e.stack); });
			let socket, sessionId = 'one', releaseSwitch;
			await page.addInitScript(() => { if (window !== window.top) return; localStorage.setItem('liyuan.lastVisit', String(Date.now())); localStorage.setItem('liyuan.panels', '{"left":null,"right":null}'); });
			await page.route('**/*', async route => {
				const req = route.request(), url = new URL(req.url());
				if (url.origin !== base) return route.abort();
				if (!url.pathname.startsWith('/api/')) return route.continue();
				if (req.method() !== 'GET') writes.push(url.pathname);
				let data = {};
				if (url.pathname === '/api/card/switch') {
					const next = req.postDataJSON().card.replace('.json', '');
					if (next === 'two') { // WS wins; REST can finish after the user loads earlier.
						sessionId = next; socket.send(JSON.stringify(hello(sessionId)));
						await new Promise(done => { releaseSwitch = done; });
					} else sessionId = next; // REST wins; hello deliberately delivered by the test later.
					data = { name: next, path: `${next}.json`, embeddedLoreCount: 0 };
				} else if (url.pathname === '/api/cards') data = { current: `${sessionId}.json`, cards };
				else if (url.pathname === '/api/card') data = { path: `${sessionId}.json`, name: sessionId, displayName: null, greetingIndex: 0, description: '', personality: '', scenario: '', creatorNotes: '', tags: [], greetings: [] };
				else if (url.pathname === '/api/personas') data = { personas: [] };
				else if (url.pathname === '/api/cardfront') data = { enabled: false, hasSkin: false, rules: [] };
				else if (url.pathname === '/api/real-tests') data = { records: [] };
				else return route.fulfill({ status: 503, json: { error: 'Synthetic endpoint not provided' } });
				return route.fulfill({ json: data });
			});
			await page.routeWebSocket('**/ws', ws => {
				socket = ws;
				ws.onMessage(raw => {
					const frame = JSON.parse(String(raw));
					if (frame.type === 'sessions') ws.send(JSON.stringify({ type: 'sessions', list: [{ path: `${sessionId}.jsonl`, current: true, firstMessage: 'Synthetic', name: 'Synthetic', messageCount: 1000, modified: 1 }] }));
				});
				ws.send(JSON.stringify(hello(sessionId)));
			});
			await page.goto(base);
			const count = n => page.waitForFunction(n => document.querySelectorAll('[data-reading-block]').length === n, n);
			const bottom = () => page.waitForFunction(() => { const el = document.querySelector('.list'); return el.scrollHeight - el.scrollTop - el.clientHeight < 3; });
			await count(50); await bottom();
			assert.match(await page.locator('[data-reading-block="1000"]').innerText(), /Synthetic floor 1000/);
			assert.match(await page.locator('[data-reading-block="1000"] .floor').innerText(), /1000/);
			const script = page.frameLocator('[data-reading-block="998"] iframe');
			await script.getByText('Synthetic script frame').waitFor();
			assert.equal(await script.locator('body').evaluate(() => window.syntheticRuns), 1);
			await page.evaluate(() => { window.savedFrame = document.querySelector('[data-reading-block="998"] iframe'); window.savedWindow = savedFrame.contentWindow; });
			// Ordinary backscroll, without loading earlier: native anchoring must protect visible text.
			await page.locator('[data-reading-block="975"]').evaluate(node => {
				const list = document.querySelector('.list');
				list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top - 70;
			});
			await page.getByRole('button', { name: '回到最新', exact: true }).waitFor();
			await page.waitForTimeout(100);
			assert.equal(await page.locator('.list').evaluate(el => getComputedStyle(el).overflowAnchor), 'auto');
			await page.evaluate(() => {
				window.readingText = document.querySelector('[data-reading-block="975"] .msg p');
				window.readingOffset = readingText.getBoundingClientRect().top;
				const above = document.querySelector('[data-reading-block="951"]');
				const image = document.createElement('img');
				image.alt = 'Synthetic late image'; image.style.cssText = 'display:block;width:40px;height:0';
				above.append(image); window.lateImage = image;
			});
			await page.waitForTimeout(100);
			await page.evaluate(() => { lateImage.style.height = '360px'; });
			await page.waitForTimeout(150);
			assert.ok(await page.evaluate(() => Math.abs(readingText.getBoundingClientRect().top - readingOffset) < 3), 'ordinary backscroll preserves text after above-viewport image growth');
			await count(50);
			await page.getByRole('button', { name: '回到最新', exact: true }).click(); await bottom();
			// Scroll to the earlier button, save an actual visible original node, then prepend.
			await page.locator('.list').evaluate(el => { el.scrollTop = 0; });
			await page.waitForTimeout(80);
			await page.getByRole('button', { name: /加载更早记录/ }).evaluate(button => {
				button.addEventListener('click', () => { window.anchorNode = document.querySelector('[data-reading-block]'); window.anchorTop = anchorNode.getBoundingClientRect().top; }, { capture: true, once: true });
			});
			await page.getByRole('button', { name: /加载更早记录/ }).click();
			await count(100);
			assert.ok(await page.evaluate(() => Math.abs(anchorNode.getBoundingClientRect().top - anchorTop) < 3), 'prepend preserves visible original block offset');
			// Late earlier content resizes after mounting, without pulling the old viewport away.
			await page.locator('[data-reading-block]').first().evaluate(el => { el.style.height = '900px'; });
			await page.waitForTimeout(150);
			assert.ok(await page.evaluate(() => Math.abs(anchorNode.getBoundingClientRect().top - anchorTop) < 3), 'late prepended layout preserves anchor');
			assert.equal(await page.locator('.list').evaluate(el => getComputedStyle(el).overflowAnchor), 'none', 'prepend has exclusive anchoring ownership');
			await page.locator('.list').evaluate(el => el.dispatchEvent(new Event('wheel')));
			assert.equal(await page.locator('.list').evaluate(el => getComputedStyle(el).overflowAnchor), 'auto', 'interaction returns anchoring to the browser');
			assert.equal(await page.evaluate(() => savedFrame === document.querySelector('[data-reading-block="998"] iframe') && savedWindow === savedFrame.contentWindow), true);
			assert.equal(await script.locator('body').evaluate(() => window.syntheticRuns), 1);
			const readingTop = await page.locator('.list').evaluate(el => el.scrollTop);
			socket.send(JSON.stringify({ ...hello(sessionId), streaming: true, settling: true }));
			await page.locator('.settlement-note').waitFor();
			socket.send(JSON.stringify(hello(sessionId))); await page.waitForTimeout(100);
			await count(100);
			assert.ok(Math.abs(await page.locator('.list').evaluate(el => el.scrollTop) - readingTop) < 3);
			await page.getByRole('button', { name: '回到最新', exact: true }).click(); await bottom(); await count(100);
			assert.equal(await page.evaluate(() => savedWindow === savedFrame.contentWindow), true);
			assert.equal(await script.locator('body').evaluate(() => window.syntheticRuns), 1);
			socket.send(JSON.stringify({ type: 'message', message: { channel: 'user', text: 'Synthetic appended floor', entryId: 'appended', entryScope: 'synthetic' } }));
			await count(101); await bottom();
			assert.equal(await page.evaluate(() => savedFrame === document.querySelector('[data-reading-block="998"] iframe')), true, 'new turns do not slide/recycle the mounted tail');
			socket.send(JSON.stringify(hello(sessionId))); await count(100); await bottom();
			// Same-session return from home retains the expanded range, but positions at latest.
			await page.locator('[aria-label="打开欢迎页"]').evaluate(el => el.click());
			await page.getByRole('button', { name: '继续当前对话', exact: true }).click();
			await count(100); await bottom();
			// Exercise the actual CardPanel REST callback and actual App hello handler in both orders.
			await page.getByRole('button', { name: '角色卡', exact: true }).click();
			await page.getByRole('button', { name: '返回卡库', exact: true }).click();
			await page.getByTitle('切换到「two」并打开详情').click();
			await count(50); await bottom();
			// Mobile drawer covers the list; DOM click here isolates the REST/WS race, not hit testing.
			await page.locator('.list').evaluate(el => { el.scrollTop = 0; });
			await page.waitForTimeout(80);
			await page.getByRole('button', { name: /加载更早记录/ }).evaluate(el => el.click()); await count(100);
			releaseSwitch(); await page.getByRole('button', { name: '返回卡库', exact: true }).waitFor();
			await bottom(); await count(100); // Late REST must not shrink/recycle the new session range.
			await page.getByRole('button', { name: '返回卡库', exact: true }).click();
			await page.getByTitle('切换到「three」并打开详情').click();
			await page.getByRole('button', { name: '返回卡库', exact: true }).waitFor();
			await count(100);
			socket.send(JSON.stringify(hello(sessionId))); await count(50); await bottom();
			// Every batch remains reachable, including removal of the final earlier button.
			await page.locator('.list').evaluate(el => { el.scrollTop = 0; });
			await page.waitForTimeout(80);
			for (let mounted = 50; mounted < 1001;) {
				await page.getByRole('button', { name: /加载更早记录/ }).evaluate(button => {
					window.batchAnchor = document.querySelector('[data-reading-block]');
					window.batchTop = batchAnchor.getBoundingClientRect().top;
					button.click();
				});
				mounted = Math.min(1001, mounted + 50); await count(mounted);
				assert.ok(await page.evaluate(() => Math.abs(batchAnchor.getBoundingClientRect().top - batchTop) < 3));
			}
			assert.equal(await page.getByRole('button', { name: /加载更早记录/ }).count(), 0);
			// Beginning is deliberately full history; jump latest never removes any mounted block.
			await page.evaluate(() => localStorage.setItem('liyuan.reading-position', 'start'));
			sessionId = 'beginning'; socket.send(JSON.stringify(hello(sessionId))); await count(1001);
			await page.waitForFunction(() => document.querySelector('.list').scrollTop === 0);
			await page.getByRole('button', { name: '回到最新', exact: true }).evaluate(el => el.click()); await bottom(); await count(1001);
			assert.deepEqual(writes, ['/api/card/switch', '/api/card/switch']);
			assert.deepEqual(errors, []);
			await page.close();
		}
	} finally {
		await browser?.close();
		if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
		await rm(work, { recursive: true, force: true });
	}
});
