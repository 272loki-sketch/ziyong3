// Synthetic host/API only. Never loads a private story or external model.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("众生侧写原生设置：状态失败重试/开关依赖/保存设置/放弃修改/忙时锁定/390px（合成）", { timeout: 120_000 }, async t => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-npc-sidewrite-panel-"));
	let browser, server;
	const writes = [];
	const state = {
		implementation: "builtin-1", enabled: false, executionEnabled: false, ecologyEnabled: true, busy: false,
		model: { provider: "new", id: "gemini-3.8-flash" }, scopeKey: "scope", sourceEntryId: "entry-1", revision: 3,
		settings: { enabled: true, maxPerRound: 3, cooldownRounds: 3, minWords: 200, maxWords: 600, person: "third", style: "", ignored: [], weights: {} },
		receipt: { status: "accepted", sourceEntryId: "entry-1", accepted: 2, rejected: 0, total: 2 }, requestBudget: { used: 4 },
	};
	let statusFailures = 1, failSettings = false, holdWrite = false, releaseWrite;
	t.signal.addEventListener('abort', () => { releaseWrite?.(); void browser?.close(); server?.closeAllConnections(); }, { once: true });
	try {
		await build({
			stdin: { contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {NpcParallelPanel} from './src/components/NpcParallelPanel.tsx'; function Harness(){const[tick,setTick]=useState(0);window.advance=()=>setTick(t=>t+1);return <NpcParallelPanel contextTick={tick} onDirtyChange={dirty=>window.__dirty=dirty} toast={(level,text)=>window.__toasts.push({level,text})}/>;} createRoot(document.getElementById('root')).render(<Harness/>);`, resolveDir: join(root, "web"), loader: "tsx" },
			bundle: true, format: "esm", jsx: "automatic", outfile: join(cwd, "fixture.js"), logLevel: "silent",
		});
		await writeFile(join(cwd, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script>window.__toasts=[];</script><script type="module" src="/fixture.js"></script></body></html>`);
		server = createServer(async (req, res) => {
			const url = new URL(req.url, "http://127.0.0.1");
			const json = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
			if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(await readFile(join(cwd, "index.html"))); }
			if (url.pathname === "/fixture.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(await readFile(join(cwd, "fixture.js"))); }
			if (url.pathname === "/fixture.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end(await readFile(join(cwd, "fixture.css"))); }
			if (url.pathname === "/api/npc-parallel/status") { if (statusFailures-- > 0) return json(503, { error: "合成状态服务暂不可用" }); return json(200, state); }
			if (url.pathname === "/api/npc-parallel/roster") return json(200, { names: ["甲合成", "乙合成"], ignored: state.settings.ignored, weights: {} });
			if (req.method === "PUT") {
				let text = ""; for await (const chunk of req) text += chunk;
				const body = JSON.parse(text); writes.push({ path: url.pathname, body });
				if (holdWrite) { const old = structuredClone(state); await new Promise(resolve => { releaseWrite = resolve; }); return json(200, { ...old, enabled: body.enabled ?? old.enabled, revision: old.revision + 1 }); }
				if (body.revision !== state.revision || body.scopeKey !== state.scopeKey) return json(409, { error: "合成过期" });
				if (url.pathname === "/api/npc-parallel/config") { state.enabled = body.enabled; state.executionEnabled = body.enabled; state.revision++; return json(200, state); }
				if (url.pathname === "/api/npc-parallel/settings") { if (failSettings) return json(400, { error: "合成设置写入失败" }); state.settings = body.settings; state.revision++; return json(200, state); }
			}
			res.writeHead(404); res.end("not found");
		});
		await new Promise(r => server.listen(0, "127.0.0.1", r));
		const executablePath = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE;
		browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? "" }, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
		const pageErrors = [];
		const page = await browser.newPage({ viewport: { width: 980, height: 900 } });
		page.setDefaultTimeout(6_000);
		page.setDefaultNavigationTimeout(15_000);
		page.on("pageerror", e => pageErrors.push(e.message));
		await page.goto(`http://127.0.0.1:${server.address().port}`);
		const card = page.locator(".npc-parallel-card");
		await page.getByRole("alert").filter({ hasText: "合成状态服务暂不可用" }).waitFor();
		assert.equal(await card.getByRole("switch").count(), 0, "状态失败时不显示可写控件");
		await page.getByRole("button", { name: "重试读取状态" }).click();
		await card.getByText("模块已关闭", { exact: true }).waitFor();
		await card.getByText(/最近一拍：已采纳/).waitFor();
		await card.getByText("new/gemini-3.8-flash").waitFor();
		for (const name of ["甲合成", "乙合成"]) await card.getByRole("checkbox", { name }).waitFor();

		await card.getByRole("switch", { name: "众生侧写启用开关" }).click();
		await card.getByText("每拍后台自动运行", { exact: true }).waitFor();
		assert.deepEqual(writes.at(-1), { path: "/api/npc-parallel/config", body: { enabled: true, scopeKey: "scope", sourceEntryId: "entry-1", revision: 3 } });

		const save = card.getByRole("button", { name: "保存设置" });
		assert.equal(await save.isDisabled(), true, "未修改时不可保存");
		await card.getByLabel("每拍人数上限").fill("5");
		await card.getByRole("checkbox", { name: "乙合成" }).uncheck();
		await card.getByLabel("写作要求").fill("合成写作要求");
		failSettings = true;
		await save.click();
		await card.getByRole("alert").filter({ hasText: "合成设置写入失败" }).waitFor();
		assert.equal(await card.getByLabel("每拍人数上限").inputValue(), "5", "失败时保留编辑");
		failSettings = false;
		assert.equal(await save.isDisabled(), true, 'unknown write result requires a fresh status before another write');
		await card.getByRole('button', { name: '重试读取状态' }).click();
		await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
		await save.click();
		await card.getByText("侧写设置已保存。").waitFor();
		const saved = writes.at(-1).body.settings;
		assert.equal(saved.maxPerRound, 5); assert.deepEqual(saved.ignored, ["乙合成"]); assert.equal(saved.style, "合成写作要求");

		await card.getByLabel("冷却轮数").fill("9");
		await card.getByRole("button", { name: "放弃修改" }).click();
		assert.equal(await card.getByLabel("冷却轮数").inputValue(), "3");

		await card.getByLabel('写作要求').fill('draft survives global toggle');
		await card.getByRole('switch', { name: '众生侧写启用开关' }).click();
		await card.getByText('模块已关闭', { exact: true }).waitFor();
		assert.equal(await card.getByLabel('写作要求').inputValue(), 'draft survives global toggle');
		assert.equal(await page.evaluate(() => window.__dirty), true);
		state.sourceEntryId = 'entry-2';
		await page.evaluate(() => window.advance());
		await card.getByRole('alert').filter({ hasText: '故事来源已变化' }).waitFor();
		assert.equal(await card.getByLabel('写作要求').inputValue(), 'draft survives global toggle');
		assert.equal(await save.isDisabled(), true, 'old draft cannot be saved into another source');
		await card.getByRole('button', { name: '放弃修改' }).click();
		await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
		assert.equal(await card.getByLabel('写作要求').inputValue(), '合成写作要求');

		holdWrite = true;
		await card.getByRole('switch', { name: '众生侧写启用开关' }).click();
		await card.getByText('正在保存开关…', { exact: true }).waitFor();
		for (let i = 0; !releaseWrite && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(typeof releaseWrite, 'function');
		state.sourceEntryId = 'entry-3'; state.settings.style = 'current source settings';
		await page.evaluate(() => window.advance());
		await page.waitForFunction(() => document.querySelector('textarea')?.value === 'current source settings');
		const toastCount = await page.evaluate(() => window.__toasts.length);
		releaseWrite(); holdWrite = false;
		await page.waitForTimeout(100);
		assert.equal(await card.getByLabel('写作要求').inputValue(), 'current source settings');
		assert.equal(await page.evaluate(() => window.__toasts.length), toastCount, 'late old-source success must not toast or overwrite current state');
		assert.equal(await card.getByRole('switch', { name: '众生侧写启用开关' }).getAttribute('aria-checked'), 'false');

		state.busy = true;
		await page.reload();
		await card.getByText("正在生成或后台整理；设置暂不可修改。").waitFor();
		assert.equal(await card.getByLabel("每拍人数上限").isDisabled(), true);
		assert.equal(await card.getByRole("switch", { name: "众生侧写启用开关" }).isDisabled(), true);

		await page.setViewportSize({ width: 390, height: 844 });
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		assert.ok(overflow <= 1, `390px 不应横向溢出（${overflow}px）`);
		assert.deepEqual(pageErrors, []);
	} finally {
		releaseWrite?.();
		await browser?.close();
		if (server) { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
		await rm(cwd, { recursive: true, force: true });
	}
});
