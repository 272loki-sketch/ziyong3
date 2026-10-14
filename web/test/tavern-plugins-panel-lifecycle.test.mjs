// Runs the real React component against deferred synthetic responses, with no external requests.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);
const status = version => ({ checking: false, plugins: ["helper", "template"].map(id => ({
	id, name: id, installed: true, enabled: false, autoUpdate: false, version,
})) });

test("Tavern panel: polling settles loading and navigation invalidates deferred opens", { timeout: 60_000 }, async t => {
	const bundle = await build({
		stdin: { resolveDir: join(root, "web"), loader: "tsx", contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TavernPluginsPanel} from './src/components/TavernPluginsPanel.tsx';
function Harness() {
 const [mounted,setMounted]=useState(true),[tick,setTick]=useState(0),[plugin,setPlugin]=useState('helper');
 return <><button id="unmount" onClick={()=>setMounted(false)}>unmount</button>
 <button id="context" onClick={()=>setTick(x=>x+1)}>context</button>
 <button id="plugin" onClick={()=>setPlugin(x=>x==='helper'?'template':'helper')}>plugin</button>
 {mounted && <TavernPluginsPanel managerMode contextTick={tick} pluginId={plugin}
 toast={(...args)=>window.__toasts.push(args)} onOpenOriginal={p=>window.__opens.push(p)}/>}</>;
}
window.__toasts=[];window.__opens=[];
createRoot(document.getElementById('root')).render(<Harness/>);` },
		bundle: true, format: "esm", jsx: "automatic", write: false, loader: { ".css": "empty" }, logLevel: "silent",
	});
	const server = createServer((req, res) => {
		if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); }
		else if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>'); }
		else { res.writeHead(404); res.end(); }
	});
	let browser;
	t.signal.addEventListener("abort", () => { void browser?.close(); server.closeAllConnections(); }, { once: true });
	try {
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${server.address().port}`;
		const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, ".liyuan-database-plugin/browser/headless_shell")) ? join(root, ".liyuan-database-plugin/browser/headless_shell") : undefined);
		const libs = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || (existsSync(join(root, ".liyuan-database-plugin/browser-libs/lib64")) ? join(root, ".liyuan-database-plugin/browser-libs/lib64") : "");
		browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: libs }, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
		const page = await browser.newPage();
		page.setDefaultTimeout(5_000);
		const errors = [], forbidden = [], reads = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.addInitScript(() => {
			const intervals = new Map(); let id = 0;
			window.setInterval = (fn, delay) => { if (delay !== 10_000) throw Error("Unexpected interval"); intervals.set(++id, fn); return id; };
			window.clearInterval = id => intervals.delete(id);
			window.__poll = () => { for (const fn of intervals.values()) fn(); };
		});
		await page.route("**/*", route => {
			const url = new URL(route.request().url());
			if (url.origin !== base) { forbidden.push(url.href); return route.abort(); }
			if (url.pathname === "/api/tavern-plugins/status") { reads.push(route); return; }
			if (!["/", "/fixture.js", "/favicon.ico"].includes(url.pathname)) { forbidden.push(url.pathname); return route.abort(); }
			return route.continue();
		});
		const waitReads = async count => { await page.waitForFunction(() => !!window.__poll); for (let i = 0; reads.length < count && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(reads.length, count); };
		const respond = (index, version, fail = false) => reads[index].fulfill({ status: fail ? 503 : 200, json: fail ? { error: version } : status(version) });
		const idle = () => page.waitForFunction(() => document.querySelector('.tavern-plugins-panel')?.getAttribute('aria-busy') === 'false');
		const opened = page.getByRole("button", { name: "打开helper原设置", exact: true });

		for (const fail of [false, true]) {
			reads.length = 0;
			await page.goto(base); await waitReads(1);
			await page.evaluate(() => window.__poll()); await waitReads(2);
			await respond(1, fail ? "synthetic failure" : "CURRENT", fail); await idle();
			if (fail) await page.getByRole("button", { name: "重新读取插件状态", exact: true }).waitFor();
			else assert.equal(await opened.isEnabled(), true);
			await respond(0, "STALE");
			await page.waitForTimeout(50);
			assert.equal(await page.getByText("已校验 STALE", { exact: true }).count(), 0);
			assert.equal(await page.locator('.tavern-plugins-panel').getAttribute('aria-busy'), 'false');
			if (fail) { await page.getByRole("button", { name: "重新读取插件状态", exact: true }).click(); await waitReads(3); await respond(2, "RETRY"); await idle(); assert.equal(await opened.isEnabled(), true); }
		}

		for (const navigation of ["unmount", "context", "plugin"]) {
			for (const fail of [false, true]) {
				reads.length = 0;
				await page.goto(base); await waitReads(1); await respond(0, "INITIAL"); await idle();
				await opened.click(); await waitReads(2);
				await page.locator(`#${navigation}`).click();
				if (navigation === "unmount") await page.locator('.tavern-plugins-panel').waitFor({ state: 'detached' });
				else {
					await waitReads(3); await respond(2, "NEW"); await idle();
					await page.getByRole("button", { name: `打开${navigation === "plugin" ? "template" : "helper"}原设置`, exact: true }).click(); await waitReads(4);
				}
				await respond(1, "OLD", fail); await page.waitForTimeout(50);
				assert.deepEqual(await page.evaluate(() => window.__opens), [], navigation + " must invalidate old callback");
				assert.deepEqual(await page.evaluate(() => window.__toasts), [], navigation + " must suppress stale errors");
				if (navigation !== "unmount") {
					assert.equal(await page.locator('.tavern-plugins-panel').getAttribute('aria-busy'), 'true', "old finally cannot release the new operation");
					await page.evaluate(() => window.__poll()); assert.equal(reads.length, 4, "new operation retains its polling lock");
					await respond(3, "VERIFIED"); await idle();
					assert.deepEqual((await page.evaluate(() => window.__opens)).map(p => [p.id, p.version]), [[navigation === "plugin" ? "template" : "helper", "VERIFIED"]]);
				}
			}
		}
		assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
	} finally {
		await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
	}
});
