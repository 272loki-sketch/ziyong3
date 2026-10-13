// Synthetic browser coverage for App-level plugin navigation and original settings.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("显眼酒馆插件入口：状态/原设置、桌面390px布局、context重绑且关闭不改会话", { timeout: 60_000 }, async t => {
	const app = await readFile(join(root, "web/src/App.tsx"), "utf8");
	const settings = await readFile(join(root, "web/src/components/SettingsPanel.tsx"), "utf8");
	assert.match(app, /className="tavern-plugin-entry"[^>]*aria-label="插件中心：酒馆助手、提示词模板、MVU、众生侧写与 Veridis Rewrite"/);
	assert.match(app, /<TavernPluginsManager onClose=/);
	assert.match(app, /contextTick=\{agentTick\}/);
	assert.doesNotMatch(settings, /TavernPluginsPanel/, "设置不再重复酒馆插件管理入口");

	const cwd = await mkdtemp(join(tmpdir(), "liyuan-tavern-navigation-"));
	let browser, server;
	t.signal.addEventListener("abort",()=>{void browser?.close();server?.closeAllConnections?.();},{once:true});
	const forbidden = [], apiWrites = [], managerLoads = [];
	const plugins = [
		{ id: "helper", name: "酒馆助手", enabled: false, autoUpdate: true, installed: true, version: "4.11.3", commit: "a".repeat(40), sha256: "b".repeat(64) },
		{ id: "template", name: "提示词模板", enabled: false, autoUpdate: true, installed: true, version: "1.17.9", commit: "c".repeat(40), sha256: "d".repeat(64), previousVersion: "1.17.8" },
	];
	let statusFails = 1, failManager = false, statusReads = 0;
	try {
		const entrySource = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TavernPluginsManager} from './src/components/TavernPluginsManager.tsx';
function Harness(){const [open,setOpen]=useState(false),[tick,setTick]=useState(0);useEffect(()=>{window.__advanceContext=()=>setTick(x=>x+1)},[]);return <><nav className="database-navigation" aria-label="管理入口"><button className="database-entry">数据库</button><button id="open-plugins" className="tavern-plugin-entry" aria-label="酒馆插件：酒馆助手与提示词模板" onClick={()=>setOpen(true)}>酒馆插件</button></nav><main id="session-marker" data-session="synthetic-session-never-recreated">当前合成会话不应被管理弹窗重建</main>{open&&<TavernPluginsManager onClose={()=>setOpen(false)} toast={(level,text)=>window.__toasts.push({level,text})} contextTick={tick}/>}</>}
window.__sessionCreations=1;window.__toasts=[];window.__changes=[];window.addEventListener('liyuan:tavern-plugins-changed',e=>window.__changes.push(e.detail));createRoot(document.getElementById('root')).render(<Harness/>);`;
		await build({ stdin: { contents: entrySource, resolveDir: join(root, "web"), loader: "tsx" }, bundle: true, format: "esm", jsx: "automatic", outfile: join(cwd, "fixture.js"), loader: { ".css": "empty" }, logLevel: "silent" });
		const css = (await readFile(join(root, "web/src/app.css"), "utf8")) + "\n" + (await readFile(join(root, "web/src/components/TavernPluginsPanel.css"), "utf8")) + "\n" + (await readFile(join(root,"web/src/components/MvuPanel.css"),"utf8")) + "\n" + (await readFile(join(root,"web/src/npc-parallel.css"),"utf8"));
		await writeFile(join(cwd, "fixture.css"), css);
		await writeFile(join(cwd, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>.database-navigation{display:flex;position:relative}.panel-error{padding:12px;color:#922;background:#fee;border-radius:8px}.tavern-plugin-card{overflow-wrap:anywhere}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
		server = createServer(async (req, res) => {
			const url = new URL(req.url, "http://localhost");
			const json = (code, value) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
            if(["/api/npc-parallel/status","/api/veridis-rewrite/status"].includes(url.pathname))return json(200,{installed:false,enabled:false,autoUpdate:false,busy:false,ecologyEnabled:false,scopeKey:"fixture",sourceEntryId:"fixture",revision:0,settings:{}});
			if (url.pathname.startsWith("/api/tavern-plugins/") && req.method !== "GET") apiWrites.push(`${req.method} ${url.pathname}`);
			if(url.pathname==="/api/tavern-plugins/mvu/view")return json(200,{enabled:false,installed:false,version:"synthetic",commit:"fixed",dependencies:0,helper:{enabled:true,installed:true},binding:{scopeKey:"synthetic",sourceEntryId:"round"},streaming:false,pluginBusy:false,canRecover:false,recoveryReason:"合成未安装MVU",variables:{rootCount:0,hasData:false}});
   if (url.pathname === "/api/tavern-plugins/status") { statusReads++; if (statusFails-- > 0) return json(503, { error: "synthetic status failure" }); return json(200, { plugins, checking: false }); }
			if (url.pathname === "/api/tavern-plugins/config" && req.method === "PUT") { let raw=""; for await (const part of req) raw+=part; const patch=JSON.parse(raw), plugin=plugins.find(x=>x.id===patch.id); Object.assign(plugin, patch); return json(200,{ok:true}); }
			if (url.pathname.startsWith("/api/tavern-plugins/") && req.method === "POST") { let raw=""; for await (const part of req) raw+=part; const {id}=JSON.parse(raw), plugin=plugins.find(x=>x.id===id), action=url.pathname.split("/").at(-1); if(action==="check") Object.assign(plugin,{updateAvailable:true,candidateVersion:"4.12.0"}); if(action==="update"){plugin.previousVersion=plugin.version;plugin.version=plugin.candidateVersion;plugin.updateAvailable=false;} if(action==="rollback"){const current=plugin.version;plugin.version=plugin.previousVersion;plugin.previousVersion=current;} return json(200,{ok:true}); }
			if (url.pathname === "/__test/fail-manager") { failManager = url.searchParams.get("value") === "1"; return json(200, { ok: true }); }
			if (url.pathname === "/tavern-plugin-host.html") {
				const plugin = url.searchParams.get("plugin"); managerLoads.push(plugin); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				const finalStatus = failManager ? "原插件加载失败：synthetic fixture error" : "原插件已就绪（合成梨园宿主）";
				res.end(`<!doctype html><html><body><div id="status" role="status">正在加载原始插件…</div><main><h2>合成 ${plugin} 原设置</h2><button>合成上游设置控件</button></main><script>window.LiyuanTavernPlugins={host:{flush:async()=>{window.flushCalls=(window.flushCalls||0)+1;if(window.holdFlush)await new Promise(r=>window.releaseFlush=r);if(window.failFlush)throw Error('synthetic save failed');}}};setTimeout(()=>document.getElementById('status').textContent=${JSON.stringify(finalStatus)},280)</script></body></html>`); return;
			}
			const files = { "/": ["index.html", "text/html; charset=utf-8"], "/fixture.js": ["fixture.js", "text/javascript; charset=utf-8"], "/fixture.css": ["fixture.css", "text/css; charset=utf-8"] };
			if (files[url.pathname]) { const [file, type] = files[url.pathname]; res.writeHead(200, { "content-type": type }); return res.end(await readFile(join(cwd, file))); }
			if (!url.pathname.endsWith("favicon.ico")) forbidden.push(`${req.method} ${url.pathname}`); res.writeHead(404); res.end();
		});
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const base = `http://127.0.0.1:${server.address().port}`;
		const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, ".liyuan-database-plugin/browser/headless_shell")) ? join(root, ".liyuan-database-plugin/browser/headless_shell") : undefined);
		const libs = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || (existsSync(join(root, ".liyuan-database-plugin/browser-libs/lib64")) ? join(root, ".liyuan-database-plugin/browser-libs/lib64") : "");
		console.log("NAVIGATION_STAGE browser-launch");
		browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: libs }, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
		console.log("NAVIGATION_STAGE browser-page");
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(12_000); page.setDefaultNavigationTimeout(12_000); page.on("pageerror", e => forbidden.push(`pageerror:${e.message}`));
		await page.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { forbidden.push(route.request().url()); return route.abort(); } return route.continue(); });
		console.log("NAVIGATION_STAGE app-navigation");
		await page.goto(base, { waitUntil: "domcontentloaded" });
		console.log("NAVIGATION_STAGE app-interactions");
		const entry = page.getByRole("button", { name: "酒馆插件：酒馆助手与提示词模板" }); assert.equal(await entry.isVisible(), true); assert.equal(await page.getByRole("button", { name: "数据库", exact: true }).isVisible(), true);
		await page.evaluate(() => { window.__sessionNode = document.querySelector("#session-marker"); }); await entry.click();
		let dialog = page.getByRole("dialog", { name: "酒馆插件管理" }); await dialog.waitFor();
		assert.equal(await dialog.locator('.plugin-overview-card').count(), 5);
		assert.equal(statusReads, 0, "overview is static metadata, not an execution or installation registry");
		await dialog.getByRole('button', {name:'管理酒馆助手',exact:true}).click();
		await page.getByRole("alert").filter({ hasText: "synthetic status failure" }).waitFor();
		await dialog.getByRole("button", { name: "重新读取插件状态", exact: true }).click();
		let helper = dialog.getByRole("article", { name: "酒馆助手来源与更新" }); let template = dialog.getByRole("article", { name: "提示词模板来源与更新" });
		await helper.getByText("已校验 4.11.3", { exact: true }).waitFor();
		assert.equal(await template.count(), 0, "details mount only the selected integration");
		assert.equal(await helper.getByTitle("启用 酒馆助手", { exact: true }).getAttribute("aria-pressed"), "false");
		assert.equal(await helper.getByTitle("酒馆助手自动更新", { exact: true }).getAttribute("aria-pressed"), "true");
		await helper.getByTitle("启用 酒馆助手", { exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="酒馆助手来源与更新"] .toggle')?.getAttribute("aria-pressed") === "true");
		await helper.getByTitle("酒馆助手自动更新", { exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('[aria-label="酒馆助手来源与更新"] .toggle')[1]?.getAttribute("aria-pressed") === "false");
		await helper.getByRole("button", { name: "检查更新", exact: true }).click(); await helper.getByText(/候选 4.12.0/).waitFor();
		await helper.getByRole("button", { name: "更新并激活", exact: true }).click(); await helper.getByText("已校验 4.12.0", { exact: true }).waitFor();
		await helper.getByRole("button", { name: "回退上一版", exact: true }).click(); await helper.getByText("已校验 4.11.3", { exact: true }).waitFor();
		await page.screenshot({ path: "/tmp/liyuan-tavern-plugin-ui-desktop.png", fullPage: true });
		await helper.getByRole("button", { name: "打开酒馆助手原设置", exact: true }).click(); await page.getByText("酒馆助手 · 原上游设置", { exact: true }).waitFor();
		let frame = page.frameLocator(".tavern-plugin-frame-wrap iframe"); await frame.getByText("合成 helper 原设置", { exact: true }).waitFor(); await page.locator(".tavern-plugin-frame-wrap iframe").waitFor({ state: "visible" });
		await page.evaluate(() => { window.__oldFrame = document.querySelector(".tavern-plugin-frame-wrap iframe"); window.__advanceContext(); });
		await page.waitForFunction(() => document.querySelector(".tavern-plugin-frame-wrap iframe") !== window.__oldFrame && document.querySelector(".tavern-plugin-frame-wrap iframe")?.getAttribute("data-context-tick") === "1");
		frame = page.frameLocator(".tavern-plugin-frame-wrap iframe"); await frame.getByText("合成 helper 原设置", { exact: true }).waitFor(); await page.locator(".tavern-plugin-frame-wrap iframe").waitFor({ state: "visible" }); assert.deepEqual(managerLoads, ["helper", "helper"]);
		await frame.getByRole("button", { name: "合成上游设置控件", exact: true }).focus();
		await frame.locator('body').evaluate(()=>{window.failFlush=true;});
		await page.getByRole('button',{name:'关闭酒馆插件管理',exact:true}).click();
		try { await page.getByRole('alert').filter({hasText:'synthetic save failed'}).waitFor(); } catch(error) { console.log('LEAVE_DIAGNOSTIC',await page.locator('[role="alert"], [role="status"]').allTextContents(),await page.locator('iframe').count());throw error; }
		assert.equal(await page.locator('.tavern-plugin-frame-wrap iframe').count(),1);
		await page.getByRole("button", { name: "返回酒馆插件", exact: true }).click();
		assert.equal(await frame.locator('body').evaluate(()=>window.flushCalls),1,'failure must not retry saves or replace the original close destination');
		page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'放弃未确认的更改并离开'}).click();await dialog.waitFor({state:'detached'});
		await entry.click();await dialog.waitFor();await dialog.getByRole('button',{name:'管理酒馆助手',exact:true}).click();await helper.waitFor();
		await page.keyboard.press("Escape"); await dialog.locator('.plugin-overview-card').first().waitFor();
		await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
		assert.equal(await page.locator("#session-marker").evaluate(node => node === window.__sessionNode), true); assert.equal(await page.evaluate(() => window.__sessionCreations), 1); assert.equal(await page.evaluate(() => document.activeElement?.id), "open-plugins");

		await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await entry.isVisible(), true); await entry.click(); dialog = page.getByRole("dialog", { name: "酒馆插件管理" }); await dialog.waitFor();
		await dialog.getByRole('button',{name:'管理提示词模板',exact:true}).click();
		template = dialog.getByRole("article", { name: "提示词模板来源与更新" }); await template.getByText("已校验 1.17.9", { exact: true }).waitFor();
		const box = await dialog.boundingBox(); assert.ok(box && box.x >= 6 && box.width <= 378 && box.height <= 832); assert.equal(await page.locator("body").evaluate(el => el.scrollWidth <= window.innerWidth), true);
		await page.screenshot({ path: "/tmp/liyuan-tavern-plugin-ui-mobile-390px.png", fullPage: true }); await page.request.get(`${base}/__test/fail-manager?value=1`);
		await template.getByRole("button", { name: "打开提示词模板原设置", exact: true }).click(); await page.locator(".tavern-plugin-frame-state").filter({ hasText: "synthetic fixture error" }).waitFor(); assert.equal(await page.locator(".tavern-plugin-frame-wrap iframe").isVisible(), false);
		await page.request.get(`${base}/__test/fail-manager?value=0`); await page.getByRole("button", { name: "重新载入并重试", exact: true }).click(); frame = page.frameLocator(".tavern-plugin-frame-wrap iframe"); await frame.getByText("合成 template 原设置", { exact: true }).waitFor(); await page.locator(".tavern-plugin-frame-wrap iframe").waitFor({ state: "visible" });
		await page.screenshot({ path: "/tmp/liyuan-tavern-plugin-original-390px.png", fullPage: true }); const frameBox = await page.locator(".tavern-plugin-frame-wrap iframe").boundingBox(); assert.ok(frameBox && frameBox.x >= 0 && frameBox.x + frameBox.width <= 390);
		await page.getByRole("button", { name: "返回酒馆插件", exact: true }).click(); await template.waitFor();
		await page.getByRole("button", { name: "关闭酒馆插件管理", exact: true }).click(); await dialog.waitFor({ state: "detached" });
		await entry.click(); dialog = page.getByRole("dialog", { name: "酒馆插件管理" }); await dialog.waitFor();
		await page.setViewportSize({width:320,height:740});
		assert.equal(await dialog.locator('.plugin-overview-card').count(),5);
		assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
		let veridisFail=true, veridisWrites=0;
		const veridisStatus={installed:true,enabled:true,autoUpdate:false,busy:false,scopeKey:'synthetic',sourceEntryId:'round',revision:0,version:'fixture',settings:{rules:[]}};
		await page.route('**/api/veridis-rewrite/status',route=>route.fulfill({status:veridisFail?503:200,json:veridisFail?{error:'synthetic Veridis unavailable'}:veridisStatus}));
		await page.route('**/api/veridis-rewrite/config',route=>{veridisWrites++;assert.equal(route.request().postDataJSON().enabled,false);return route.fulfill({json:{...veridisStatus,enabled:false}});});
		await page.route('**/api/veridis-rewrite/settings',route=>route.fulfill({json:veridisStatus}));
		await dialog.getByRole('button',{name:'管理Veridis Rewrite',exact:true}).click();
		await dialog.getByText('状态未知；尚不能确认安装、启用或模型配置。').waitFor();
		assert.equal(await dialog.getByText('原版尚未安装',{exact:true}).count(),0);
		veridisFail=false;await dialog.getByRole('button',{name:'重新读取',exact:true}).click();
		await dialog.getByRole('button',{name:'关闭净化',exact:true}).click();
		await page.waitForFunction(()=>document.querySelector('.veridis-panel')?.textContent.includes('保存开关请求已返回'));
		assert.equal(veridisWrites,1,'missing model must not prevent disabling');
		assert.equal(await dialog.getByRole('button',{name:'启用净化',exact:true}).isDisabled(),true);
		await dialog.getByRole('button',{name:'宿主规则设置',exact:true}).click();
		await dialog.getByRole('textbox',{name:'Veridis Rewrite 宿主规则 JSON'}).fill('{');
		await dialog.getByRole('button',{name:'保存规则设置',exact:true}).click();
		await dialog.getByText('规则 JSON 必须是有效对象，请修正后重试。').waitFor();
		await dialog.getByRole('textbox',{name:'Veridis Rewrite 宿主规则 JSON'}).fill('{"rules":[]}');
		await dialog.getByRole('button',{name:'保存规则设置',exact:true}).click();
		await dialog.getByText(/保存规则请求已返回/).waitFor();
		await page.route('**/veridis-rewrite-host.html*',route=>route.fulfill({contentType:'text/html',body:`<html><body><button id="inner">inner</button><script>window.LiyuanVeridisRewrite={ready:()=>true,flush:async()=>{window.calls=(window.calls||0)+1;},failed:true};</script></body></html>`}));
		await dialog.getByRole('button',{name:'打开原版工作台／上传规则'}).click();
		const veridisFrame=page.frameLocator('iframe[title="Veridis Rewrite 原版规则工作台"]');
		await veridisFrame.locator('#inner').waitFor();
		for(const exit of ['back','reload','escape','message','backdrop']) {
			if(exit==='back')await page.getByRole('button',{name:'返回插件详情',exact:true}).click();
			if(exit==='reload')await page.getByRole('button',{name:'重新载入工作台',exact:true}).click();
			if(exit==='escape'){await veridisFrame.locator('#inner').focus();await page.keyboard.press('Escape');}
			if(exit==='message')await veridisFrame.locator('body').evaluate(()=>parent.postMessage({type:'liyuan:veridis-rewrite-close'},location.origin));
			if(exit==='backdrop')await page.locator('.tavern-app-manager-backdrop').click({position:{x:2,y:2}});
			await page.getByRole('alert').filter({hasText:'原设置保存失败'}).waitFor();
			assert.equal(await page.locator('iframe[title="Veridis Rewrite 原版规则工作台"]').count(),1,exit+' failure retains frame');
		}
		await veridisFrame.locator('body').evaluate(()=>{window.LiyuanVeridisRewrite.failed=false;});
		page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'放弃未确认的更改并离开'}).click();
		await dialog.getByRole('button',{name:'打开原版工作台／上传规则'}).waitFor();
		let releaseOld;
		const oldRead=new Promise(resolve=>{releaseOld=resolve;});
		let reads=0;
		await page.route('**/api/veridis-rewrite/status',async route=>{if(++reads===1){await oldRead;await route.fulfill({json:{...veridisStatus,version:'STALE'}}).catch(()=>{});}else await route.fulfill({json:{...veridisStatus,sourceEntryId:'new-round',version:'CURRENT'}});});
		await page.evaluate(()=>window.__advanceContext());
		await page.waitForTimeout(100);
		await page.evaluate(()=>window.__advanceContext());
		await dialog.getByText('已校验 CURRENT',{exact:true}).waitFor();releaseOld();
		await page.waitForTimeout(150);
		assert.equal(await dialog.getByText('已校验 STALE',{exact:true}).count(),0,'late status cannot overwrite a new context');
		await page.locator(".tavern-app-manager-backdrop").click({ position: { x: 2, y: 2 } }); await dialog.waitFor({ state: "detached" });
		assert.ok(statusReads >= 8); assert.equal(apiWrites.length, 5); assert.equal((await page.evaluate(() => window.__changes)).length, apiWrites.length);
		assert.equal(await page.locator("#session-marker").evaluate(node => node === window.__sessionNode), true); assert.equal(await page.evaluate(() => window.__sessionCreations), 1); assert.deepEqual(forbidden, []);
	} finally {
		server?.closeAllConnections?.();server?.closeIdleConnections?.();await browser?.close(); if (server) { server.closeIdleConnections?.(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } await rm(cwd, { recursive: true, force: true });
	}
});
