// Synthetic deferred API only: verifies that an old-source completion cannot repaint a new scope.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const status = sourceEntryId => ({
	installed: true, enabled: false, autoUpdate: false, busy: false, ecologyEnabled: true,
	scopeKey: `scope-${sourceEntryId}`, sourceEntryId, revision: 1,
	model: { provider: "fixture", id: "synthetic-model" },
	receipt: { status: "empty", sourceEntryId, accepted: 0, rejected: 0, total: 0 },
});

test("NPC old operation cannot overwrite status after source switch", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-npc-source-switch-"));
	let browser, server, sourceEntryId = "source-A";
	const startedA = gate(), releaseA = gate(), startedB = gate(), releaseB = gate();
	try {
		const bundle = await build({
			stdin: { resolveDir: join(root, "web"), loader: "tsx", contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{NpcParallelPanel}from'./src/components/NpcParallelPanel.tsx';
function Fixture(){const[tick,setTick]=useState(0);window.__switch=async()=>{await fetch('/fixture/switch',{method:'POST'});setTick(x=>x+1)};return <NpcParallelPanel contextTick={tick} toast={(level,text)=>window.__toasts.push({level,text})}/>}
window.__toasts=[];createRoot(document.getElementById('root')).render(<Fixture/>);` },
			bundle: true, format: "esm", jsx: "automatic", write: false, loader: { ".css": "empty" }, logLevel: "silent",
		});
		server = createServer(async (req, res) => {
			const url = new URL(req.url, "http://127.0.0.1");
			const json = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
			if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script>'); }
			if (url.pathname === "/fixture.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(bundle.outputFiles[0].text); }
			if (url.pathname === "/fixture/switch") { sourceEntryId = "source-B"; return json(200, { ok: true }); }
			if (url.pathname === "/api/npc-parallel/status" && req.method === "GET") return json(200, status(sourceEntryId));
			if (url.pathname === "/api/npc-parallel/check" && req.method === "POST") {
				let raw = ""; for await (const chunk of req) raw += chunk;
				const body = JSON.parse(raw);
				if (body.sourceEntryId === "source-A") {
					startedA.resolve(); await releaseA.promise;
					return json(200, { ...status("source-A"), updateAvailable: true, candidateVersion: "stale-candidate" });
				}
				if (body.sourceEntryId === "source-B") {
					startedB.resolve(); await releaseB.promise;
					return json(200, { ...status("source-B"), updateAvailable: true, candidateVersion: "current-candidate" });
				}
				return json(409, { error: "wrong source for synthetic action" });
			}
			res.writeHead(404); res.end();
		});
		await new Promise(done => server.listen(0, "127.0.0.1", done));
		browser = await chromium.launch({
			headless: true,
			...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE ? { executablePath: process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE } : {}),
			env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? "" },
			args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage(); page.setDefaultTimeout(5_000);
		const errors = []; page.on("pageerror", error => errors.push(error.message));
		await page.goto(`http://127.0.0.1:${server.address().port}`);
		await page.getByText("来源正文条目：source-A", { exact: true }).waitFor();
		await page.getByRole("button", { name: "检查更新", exact: true }).click();
		await startedA.promise;
		await page.evaluate(() => window.__switch());
		await page.getByText("来源正文条目：source-B", { exact: true }).waitFor();
		const check = page.locator(".npc-parallel-actions button").first();
		assert.equal(await check.isEnabled(), true, "a previous scope's pending operation must not lock the new scope");
		await check.click();
		await startedB.promise;
		releaseA.resolve();
		await page.waitForTimeout(100);
		assert.equal(await page.getByText("来源正文条目：source-A", { exact: true }).count(), 0, "old completion must not replace new-source receipt");
		assert.equal(await page.getByText("候选版本 stale-candidate", { exact: false }).count(), 0, "old completion must not publish its candidate in the new scope");
		assert.equal(await check.isDisabled(), true, "old completion must not unlock a newer source's in-flight operation");
		assert.equal(await page.evaluate(() => window.__toasts.some(item => item.text.includes("候选"))), false, "old completion must not publish success feedback");
		releaseB.resolve();
		await page.getByText("候选版本 current-candidate", { exact: false }).waitFor();
		assert.equal(await page.getByText("来源正文条目：source-B", { exact: true }).count(), 1);
		assert.deepEqual(errors, []);
	} finally {
		releaseA.resolve(); releaseB.resolve();
		await browser?.close(); server?.closeAllConnections();
		if (server) await new Promise(done => server.close(done));
		await rm(cwd, { recursive: true, force: true });
	}
});
