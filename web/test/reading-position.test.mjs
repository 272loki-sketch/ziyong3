import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);

test('reading navigation wiring stays separate from hello refresh and full message indices', async () => {
	const app = await readFile(join(root, 'web/src/App.tsx'), 'utf8');
	assert.match(app, /if \(sessionIdRef.current !== frame.sessionId\) \{\s*sessionIdRef.current = frame.sessionId;\s*setReadingSessionId\(frame.sessionId\)/);
	assert.match(app, /onEnterChat=\{dismissWelcome\}/);
	assert.match(app, /setReadingNavigation\(value => value \+ 1\)/);
	assert.match(app, /blocks.slice\(historyStart\).map\(\(b, visibleIndex\)/);
	assert.match(app, /historyStart \+ visibleIndex === blocks.length - 1/);
	assert.match(app, /aria-label="插件中心：酒馆助手、提示词模板、MVU、众生侧写与 Veridis Rewrite"/);
});

test('synthetic reading navigation, local preference, resize follow and cancellation in desktop/mobile browsers', { timeout: 60000 }, async () => {
	const work = await mkdtemp(join(tmpdir(), 'liyuan-reading-'));
	let browser, server;
	try {
		const entry = `import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';
import{useReadingNavigation}from'./src/use-reading-position.ts';
import{getReadingPosition,setReadingPosition,useReadingPosition}from'./src/reading-preference.ts';
function App(){const listRef=useRef(null),atBottomRef=useRef(true);const[bottom,setAtBottom]=useState(true),[welcome,home]=useState(true),[sessionId,session]=useState('one'),[navigation,nav]=useState(0),[tick,refresh]=useState(0);
const pref=useReadingPosition();const{onScroll,jumpToBottom}=useReadingNavigation({listRef,atBottomRef,setAtBottom,welcome,sessionId,navigation});
window.fixture={home,session,open:()=>{home(false);nav(x=>x+1)},refresh:()=>refresh(x=>x+1),jumpToBottom,setReadingPosition,getReadingPosition};
return <><output>{pref}:{String(bottom)}:{tick}</output><div id="list" ref={listRef} onScroll={onScroll} style={{height:400,overflow:'auto'}}><div>{welcome?<div style={{height:900}}>Home</div>:<><div style={{height:1800}}>Synthetic history</div><iframe title="Synthetic late frame" srcDoc="<p>Synthetic frame</p>" style={{height:100}}/><div>Latest</div></>}</div></div></>};createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`;
		await build({ stdin: { contents: entry, resolveDir: join(root, 'web'), loader: 'tsx' }, bundle: true, jsx: 'automatic', format: 'esm', outfile: join(work, 'fixture.js'), logLevel: 'silent' });
		server = createServer(async (req, res) => {
			res.setHeader('content-type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
			res.end(req.url === '/fixture.js' ? await readFile(join(work, 'fixture.js')) : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script>');
		});
		await new Promise(done => server.listen(0, '127.0.0.1', done));
		browser = await chromium.launch({ headless: true, ...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE ? { executablePath: process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? '' }, args: ['--no-sandbox'] });
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 844 } });
			const errors = []; page.on('pageerror', e => errors.push(e.message));
			await page.goto(`http://127.0.0.1:${server.address().port}`);
			await page.waitForFunction(() => !!window.fixture);
			const bottom = () => page.waitForFunction(() => { const el = document.querySelector('#list'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2; });
			const top = () => page.waitForFunction(() => document.querySelector('#list').scrollTop === 0);
			assert.equal(await page.evaluate(() => fixture.getReadingPosition()), 'latest');
			await top(); await page.evaluate(() => fixture.open()); await bottom();
			await page.locator('iframe').evaluate(el => { el.style.height = '700px'; }); await bottom();
			await page.locator('#list').evaluate(el => { el.scrollTop = 500; });
			await page.waitForFunction(() => document.querySelector('output').textContent.includes('false'));
			await page.locator('iframe').evaluate(el => { el.style.height = '1100px'; });
			await page.evaluate(() => fixture.refresh()); await page.waitForTimeout(100);
			assert.equal(await page.locator('#list').evaluate(el => el.scrollTop), 500, 'same-session reconnect/settling and late iframe must preserve reading');
			await page.evaluate(() => fixture.home(true)); await top();
			await page.evaluate(() => fixture.open()); await bottom();
			await page.locator('#list').evaluate(el => { el.scrollTop = 500; });
			await page.waitForFunction(() => document.querySelector('output').textContent.includes('false'));
			await page.evaluate(() => fixture.open()); await bottom(); // same-card explicit entry
			await page.evaluate(() => fixture.setReadingPosition('start'));
			await bottom(); // preference does not navigate the current view
			await page.evaluate(() => fixture.session('two')); await top();
			await page.locator('iframe').evaluate(el => { el.style.height = '900px'; });
			await page.evaluate(() => fixture.refresh()); await page.waitForTimeout(100); await top();
			await page.evaluate(() => fixture.jumpToBottom()); await bottom();
			await page.evaluate(() => { fixture.home(true); requestAnimationFrame(() => fixture.open()); });
			await page.waitForTimeout(150); await top();
			await page.reload(); await page.waitForFunction(() => !!window.fixture);
			assert.equal(await page.evaluate(() => fixture.getReadingPosition()), 'start');
			await page.evaluate(() => fixture.open()); await top();
			await page.evaluate(() => { localStorage.setItem('liyuan.reading-position', 'invalid'); });
			assert.equal(await page.evaluate(() => fixture.getReadingPosition()), 'latest');
			assert.deepEqual(errors, []); await page.close();
		}
	} finally {
		await browser?.close();
		if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
		await rm(work, { recursive: true, force: true });
	}
});
