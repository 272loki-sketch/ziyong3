// Production-free browser regression: real React workbench, REST routes, and OutlineEngine;
// all stories, providers, proposals, and persisted discussion records below are synthetic.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";
import { OutlineEngine } from "../../src/outline/engine.ts";
import { handleApiRequest } from "../../server/rest.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
test("创作对谈：真实SSE回复、续聊/重开/删除、失败重试/停止、分支和390px", { timeout: 60_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-director-chat-browser-"));
	const treeFile = join(cwd, "synthetic-tree.json");
	let browser, server, engine, calls = [], failOnce = true, stops = 0;
	const entries = [{ id: "synthetic-story", type: "message", message: { role: "user", content: "Synthetic established story" } }];
	const session = { getBranch: () => entries, getLeafId: () => entries.at(-1).id, getSessionId: () => "synthetic-director",
		appendCustomEntry(customType, data) { const id = `e${entries.length}`; entries.push({ id, type: "custom", customType, data }); return id; },
		flush() { writeFileSync(treeFile, JSON.stringify(entries)); },
	};
	session.appendCustomEntry("rp-outline-chat", { version: 1, requestId: "synthetic-old", baseLeafId: "synthetic-story", focus: "open", user: "Synthetic previous question", answer: "Synthetic previous director reply", options: [], warnings: [], createdAt: "2026-10-09T00:00:00.000Z" }); session.flush();
	const createEngine = () => new OutlineEngine({ cwd, getSessionManager: () => session,
		loadMaterials: () => ({ config: { card: "synthetic-card" }, card: { name: "Fixture" }, skillFiles: [{ workflow: "outline-chat", body: "Synthetic JSON discussion contract" }] }),
		getContext: () => ({ cardKey: "synthetic-card", history: [{ role: "user", text: "Synthetic established story" }] }),
		runSideModel: async (_step, _system, text, options) => {
			const packet = JSON.parse(text); calls.push(packet);
			if (packet.request.message === "Fail then retry" && failOnce) { failOnce = false; throw new Error("Synthetic provider failure"); }
			if (packet.request.message === "Wait until stopped") {
				return new Promise((_, reject) => options.signal.addEventListener("abort", () => { stops++; reject(new Error("Synthetic cancelled provider")); }, { once: true }));
			}
			options.onDelta?.({ kind: "text", delta: '{"answer":"Streaming synthetic ' });
			await new Promise(resolve => setTimeout(resolve, 150));
			options.onDelta?.({ kind: "text", delta: 'reply\\nSecond line", "options":[]}' });
			return JSON.stringify({ answer: "Streaming synthetic reply\nSecond line", options: [null, "Synthetic follow-up"], warnings: [], proposal: packet.request.message === "Create synthetic proposal" ? {
				version: 1, id: "synthetic-proposal", mode: "manual", kind: "chat", baseRevision: packet.request.baseRevision, baseHash: packet.request.baseHash, baseLeafId: packet.context.baseLeafId, rationale: "Synthetic candidate only", researchInspirationIds: [], patch: { premise: "Synthetic unconfirmed direction" },
			} : null });
		},
	});
	engine = createEngine();
	try {
		const source = `import React,{useState} from "react";import{createRoot}from"react-dom/client";import{StoryPlanningWorkbench}from${JSON.stringify(join(root, "web/src/planning/StoryPlanningWorkbench.tsx"))};function Harness(){const[open,setOpen]=useState(true),[tick,setTick]=useState(0);window.__contextTick=()=>setTick(t=>t+1);return <><button onClick={()=>setOpen(true)}>打开创作对谈</button>{open&&<StoryPlanningWorkbench onClose={()=>setOpen(false)} toast={()=>{}} contextTick={tick}/>}</>};createRoot(document.getElementById("root")).render(<Harness/>);`;
		await build({ stdin: { contents: source, resolveDir: join(root, "web"), loader: "tsx" }, bundle: true, format: "esm", jsx: "automatic", outfile: join(cwd, "fixture.js"), loader: { ".css": "empty" }, logLevel: "silent" });
		await writeFile(join(cwd, "fixture.css"), await readFile(join(root, "web/src/app.css"), "utf8"));
		await writeFile(join(cwd, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
		server = createServer(async (req, res) => {
			const url = new URL(req.url, "http://localhost");
			if (url.pathname === "/api/outline/research") { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"Synthetic optional research failure"}'); return; }
			if (url.pathname === "/fixture/restart") { entries.splice(0, entries.length, ...JSON.parse(readFileSync(treeFile, "utf8"))); engine = createEngine(); res.end("ok"); return; }
			if (url.pathname === "/fixture/advance") { entries.push({ id: `story-${entries.length}`, type: "message", message: { role: "assistant", content: "Synthetic next story branch" } }); session.flush(); res.end("ok"); return; }
			if (url.pathname.startsWith("/api/")) { await handleApiRequest(req, res, { cwd, isStreaming: () => false, outline: { getView: () => engine.getView(),createDiscussion:(title,key)=>engine.createDiscussion(title,key),selectDiscussion:(id,key)=>engine.selectDiscussion(id,key),renameDiscussion:(id,title,key)=>engine.renameDiscussion(id,title,key),discussionPage:(id,before,key)=>engine.discussionPage(id,before,key), history: () => engine.history(), chat: (...args) => engine.chat(...args), clearChats: (...args) => engine.clearChats(...args), deleteChat: (...args) => engine.deleteChat(...args) } }); return; }
			const file = join(cwd, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
			if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
			res.writeHead(200, { "content-type": file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }); res.end(await readFile(file));
		});
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${server.address().port}`, forbidden = [];
		const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE;
		browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS || "" }, args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "--disable-dev-shm-usage"] });
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10_000);
		page.on("pageerror", error => forbidden.push(error.message));
		await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : (forbidden.push("External request"), route.abort()));
		page.on("dialog", dialog => dialog.accept());
		await page.goto(base, { waitUntil: "domcontentloaded" });
		console.log("synthetic workbench mounted");
		const room = page.getByRole("dialog", { name: "故事规划导演室" }), input = page.getByRole("textbox", { name: "创作对谈消息" });
		await room.getByText("Synthetic previous director reply", { exact: true }).waitFor();
		assert.equal(await page.getByText("Synthetic optional research failure", { exact: true }).count(), 0, "Optional panel failure cannot hide discussion");
		await input.fill("First synthetic continuation"); await input.press("Enter"); await input.press("Enter");
		await page.getByText("Streaming synthetic reply\nSecond line", { exact: true }).waitFor();
		await page.getByRole("button", { name: "问导演", exact: true }).waitFor();
		await page.waitForFunction(() => !document.querySelector('.planning-live,.planning-typing'));
		assert.equal(calls.length, 1, "Repeated Enter must not duplicate provider requests");
		assert.deepEqual(calls[0].context.discussionHistory.map(row => row.text), ["Synthetic previous question", "Synthetic previous director reply"]);
		console.log("synthetic first reply checked");
		await input.fill("Create synthetic proposal"); await page.getByRole("button", { name: "问导演", exact: true }).click({ noWaitAfter: true });
		await page.waitForFunction(() => document.querySelectorAll('.planning-chat.assistant:not(.planning-live)').length === 3);
		assert.equal(await room.locator('.planning-room').isVisible(), true, "A proposal must not navigate away from the reply");
		assert.equal(engine.getView().pending.length, 1); console.log("synthetic proposal checked");
		await page.getByRole("button", { name: "关闭导演室", exact: true }).click({ noWaitAfter: true });
		await page.request.get(base + "/fixture/restart"); await page.getByRole("button", { name: "打开创作对谈", exact: true }).click({ noWaitAfter: true });
		await room.getByText("Synthetic previous director reply", { exact: true }).waitFor();
		assert.equal(await page.getByRole("button", { name: "删除这轮讨论", exact: true }).count(), 3);
		await page.getByRole("button", { name: "删除这轮讨论", exact: true }).first().click({ noWaitAfter: true });
		await room.getByText("Synthetic previous director reply", { exact: true }).waitFor({ state: "detached" });
		assert.equal(engine.getView().pending.length, 1, "Deleting discussions must not delete proposals");
		await input.fill("Continue without deleted round"); await page.getByRole("button", { name: "问导演", exact: true }).click({ noWaitAfter: true });
		await page.waitForFunction(() => !document.querySelector('.planning-live,.planning-typing'));
		assert.equal(JSON.stringify(calls.at(-1).context.discussionHistory).includes("Synthetic previous question"), false);
		console.log("synthetic reopen/delete checked");
		await input.fill("Fail then retry"); await page.getByRole("button", { name: "问导演", exact: true }).click({ noWaitAfter: true });
		await page.getByRole("alert").getByText("Synthetic provider failure", { exact: true }).waitFor();
		assert.equal(await input.inputValue(), "Fail then retry");
		await page.getByRole("button", { name: "重试发送", exact: true }).click({ noWaitAfter: true });
		await page.waitForFunction(() => !document.querySelector('.planning-live,.planning-typing'));
		assert.equal(await page.getByRole("alert").count(), 0);
		console.log("synthetic retry/cancel checkpoint");
		await input.fill("Wait until stopped"); await page.getByRole("button", { name: "问导演", exact: true }).click({ noWaitAfter: true });
		await page.waitForTimeout(100); await page.getByRole("button", { name: "停止对谈", exact: true }).click({ noWaitAfter: true });
		await page.getByRole("alert").getByText("讨论已停止，输入已保留", { exact: true }).waitFor();
		await page.waitForTimeout(100); assert.ok(stops >= 1); assert.equal(await input.inputValue(), "Wait until stopped");
		console.log("synthetic retry/cancel checkpoint");
		await input.fill("Wait until stopped"); await page.getByRole("button", { name: "问导演", exact: true }).click({ noWaitAfter: true });
		await page.getByRole("button", { name: "停止对谈", exact: true }).waitFor();
		await page.request.get(base + "/fixture/advance"); await page.evaluate(() => window.__contextTick());
		await page.getByRole("alert").getByText(/故事分支已切换/).waitFor();
		assert.equal(await input.inputValue(), "");
		await page.getByRole('button',{name:'新建对谈',exact:true}).click();await page.getByLabel('导演对谈标题').fill('人物线独立导演');await page.getByRole('button',{name:'保存对谈',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="切换导演对谈"]')?.selectedOptions[0]?.textContent.includes('人物线独立导演'));const thread=await page.getByLabel('切换导演对谈').inputValue();assert.notEqual(thread,'default');await page.getByLabel('创作对谈消息').fill('New independent subject');await page.getByRole('button',{name:'问导演',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.planning-live,.planning-typing'));await page.getByText('Streaming synthetic reply\nSecond line',{exact:true}).waitFor();assert.deepEqual(calls.at(-1).context.discussionHistory,[]);await page.getByLabel('切换导演对谈').selectOption('default');await page.getByRole('button',{name:'对谈改名',exact:true}).click();await page.getByLabel('导演对谈标题').fill('保留灵感');await page.getByRole('button',{name:'保存对谈',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="切换导演对谈"]')?.selectedOptions[0]?.textContent.includes('保留灵感'));
  await page.setViewportSize({ width: 390, height: 844 });
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		assert.ok(await input.isVisible());
		if (process.env.LIYUAN_DIRECTOR_CHAT_SCREENSHOTS) await page.screenshot({ path: process.env.LIYUAN_DIRECTOR_CHAT_SCREENSHOTS, fullPage: true });
		await page.getByRole("button", { name: "清空讨论", exact: true }).click({ noWaitAfter: true });
		await page.waitForFunction(() => document.querySelectorAll('.planning-chat').length === 0);
		assert.equal(engine.getView().chats.length, 0); assert.equal(entries.filter(row => row.customType === "rp-outline-proposal").length, 1, "Clearing discussions must not erase proposal entries");
		assert.deepEqual(forbidden, []);
	} finally {
		engine?.cancel(); if (browser) await browser.close();
		if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
		await rm(cwd, { recursive: true, force: true });
	}
});
