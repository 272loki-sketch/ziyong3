// Synthetic management UI only: original upstream runtime smoke is a separate host integration test.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("原插件面板：安装/开关/检查/更新/回退、失败不假成功、原管理台iframe与手机布局（全合成）", { timeout: 120_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-tavern-panel-test-"));
	let browser, server;
	const writes = [], managerRequests = [], errors = [], forbidden = [];
	const plugins = [
		{ id: "helper", name: "酒馆助手", enabled: false, autoUpdate: true, installed: false },
		{ id: "template", name: "提示词模板", enabled: false, autoUpdate: true, installed: false },
	];
	let failConfig = false, failManager = false, checking = false, pendingUpdate = false;
	try {
		await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {TavernPluginsPanel} from './src/components/TavernPluginsPanel.tsx'; createRoot(document.getElementById('root')).render(<React.StrictMode><TavernPluginsPanel toast={(level,text)=>{window.__toasts.push({level,text});document.getElementById('toasts').textContent=level+': '+text;}}/></React.StrictMode>);`, resolveDir: join(root, "web"), loader: "tsx" }, bundle: true, format: "esm", jsx: "automatic", outfile: join(cwd, "fixture.js"), logLevel: "silent" });
		await writeFile(join(cwd, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>*{box-sizing:border-box}body{margin:0;font-family:sans-serif}.sp-section{max-width:680px;margin:auto;padding:12px}.toggle-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px}.toggle{width:42px;height:24px}.panel-row{display:flex;gap:8px}.drawer-btn{padding:7px}.field-hint{font-size:12px;overflow-wrap:anywhere}.panel-error{color:#b00}.icon-btn{min-width:32px;min-height:32px}.tavern-plugin-card{overflow-wrap:anywhere}</style></head><body><div id="root"></div><div id="toasts" role="status"></div><script>window.__toasts=[];window.__changes=[];window.addEventListener("liyuan:tavern-plugins-changed",event=>window.__changes.push(event.detail));</script><script type="module" src="/fixture.js"></script></body></html>`);
		server = createServer(async (req, res) => {
			const url = new URL(req.url, "http://localhost");
			const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
			if (url.pathname === "/api/tavern-plugins/status") return json(200, { plugins, checking });
			if (url.pathname.startsWith("/api/tavern-plugins/") && ["POST", "PUT"].includes(req.method)) {
				let raw = ""; for await (const bytes of req) raw += bytes;
				const body = JSON.parse(raw), plugin = plugins.find((entry) => entry.id === body.id); writes.push({ path: url.pathname, method: req.method, body });
				if (!plugin) return json(400, { error: "synthetic invalid id" });
				if (url.pathname.endsWith("/config")) { if (failConfig) return json(507, { error: "合成配置写入失败，服务器空间不足" }); for (const key of ["enabled", "autoUpdate"]) if (key in body) plugin[key] = body[key]; }
				else if (url.pathname.endsWith("/install")) Object.assign(plugin, { installed: true, version: "1.0.0", commit: "a".repeat(40), sha256: "b".repeat(64) });
				else if (url.pathname.endsWith("/check")) Object.assign(plugin, { updateAvailable: true, candidateVersion: "2.0.0", pendingActivation: false });
				else if (url.pathname.endsWith("/update") && pendingUpdate) Object.assign(plugin, { updateAvailable: true, candidateVersion: "2.0.0", pendingActivation: true });
				else if (url.pathname.endsWith("/update")) Object.assign(plugin, { previousVersion: plugin.version, version: "2.0.0", commit: "c".repeat(40), updateAvailable: false, pendingActivation: false });
				else if (url.pathname.endsWith("/rollback")) Object.assign(plugin, { previousVersion: plugin.version, version: "1.0.0", commit: "a".repeat(40) });
				else return json(404, { error: "synthetic unknown action" });
				return json(200, plugin);
			}
			if (url.pathname === "/tavern-plugin-host.html") { managerRequests.push(url.searchParams.get("plugin")); if (failManager) { res.writeHead(503, { "content-type": "text/html" }); return res.end('<div role="alert">合成宿主加载失败；原数据保留</div>'); } res.writeHead(200, { "content-type": "text/html" }); return res.end(`<h2>合成 ${url.searchParams.get("plugin")} 原设置fixture</h2><button>上游合成设置按钮</button>`); }
			const paths = { "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" };
			if (paths[url.pathname]) { res.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html" }); return res.end(await readFile(join(cwd, paths[url.pathname]))); }
			if (url.pathname !== "/favicon.ico") forbidden.push(url.pathname);
			res.writeHead(404); res.end();
		});
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const base = `http://127.0.0.1:${server.address().port}`;
		const publicBrowser = join(root, ".liyuan-database-plugin/browser/headless_shell"), publicLibs = join(root, ".liyuan-database-plugin/browser-libs/lib64");
		const executablePath = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(publicBrowser) ? publicBrowser : undefined);
		const libraryPath = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || (existsSync(publicLibs) ? publicLibs : "");
		// These two explicitly authorized paths contain public binary dependencies only. No state/settings/cache are inspected.
		browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), env: { ...process.env, LD_LIBRARY_PATH: libraryPath }, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(12_000);page.setDefaultNavigationTimeout(12_000);page.on("pageerror", error => errors.push(error.message));
		await page.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { forbidden.push(route.request().url()); return route.abort(); } return route.continue(); });
		await page.goto(base, { waitUntil: "domcontentloaded" });await page.getByRole("article",{name:"酒馆助手来源与更新"}).waitFor();
		const helper = page.getByRole("article", { name: "酒馆助手来源与更新" }), template = page.getByRole("article", { name: "提示词模板来源与更新" });
		assert.equal(await helper.getByTitle("启用 酒馆助手", { exact: true }).isDisabled(), true);
		assert.equal(await helper.getByTitle("酒馆助手自动更新", { exact: true }).getAttribute("aria-pressed"), "true");
		await helper.getByRole("button", { name: "安装原版", exact: true }).click(); await helper.getByText("已校验 1.0.0", { exact: true }).waitFor();
		assert.equal(plugins[0].enabled, false); assert.equal(plugins[1].installed, false); assert.deepEqual(await page.evaluate(() => window.__changes), [{id:"helper"}]);
		await helper.getByTitle("启用 酒馆助手", { exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="酒馆助手来源与更新"] .toggle')?.getAttribute("aria-pressed") === "true");
		assert.equal(plugins[0].enabled, true); assert.equal(plugins[1].enabled, false);
		await helper.getByTitle("酒馆助手自动更新", { exact: true }).click(); await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="酒馆助手来源与更新"] .toggle')][1]?.getAttribute("aria-pressed") === "false");
		assert.equal(plugins[0].autoUpdate, false);
		await helper.getByRole("button", { name: "检查更新", exact: true }).click(); await helper.getByText(/候选 2.0.0/).waitFor(); assert.equal(plugins[0].version, "1.0.0");
		pendingUpdate = true; await helper.getByRole("button", { name: "更新并激活", exact: true }).click(); await page.getByRole("status").filter({ hasText: "等待空闲" }).waitFor(); assert.equal(plugins[0].version, "1.0.0");
		pendingUpdate = false; await helper.getByRole("button", { name: "更新并激活", exact: true }).click(); await helper.getByText("已校验 2.0.0", { exact: true }).waitFor();
		await helper.getByRole("button", { name: "回退上一版", exact: true }).click(); await helper.getByText("已校验 1.0.0", { exact: true }).waitFor();
		await page.reload({ waitUntil: "domcontentloaded" });await helper.getByTitle("启用 酒馆助手",{exact:true}).waitFor(); assert.equal(await helper.getByTitle("启用 酒馆助手", { exact: true }).getAttribute("aria-pressed"), "true");
		const changesBefore = await page.evaluate(() => window.__changes.length);
		failConfig = true; const successBefore = await page.evaluate(() => window.__toasts.filter(item => item.level === "info").length);
		await helper.getByTitle("启用 酒馆助手", { exact: true }).click(); await page.locator(".panel-error").filter({ hasText: "合成配置写入失败" }).waitFor();
		assert.equal(plugins[0].enabled, true); assert.equal(await helper.getByTitle("启用 酒馆助手", { exact: true }).getAttribute("aria-pressed"), "true");
		assert.equal(await page.evaluate(() => window.__toasts.filter(item => item.level === "info").length), successBefore); assert.equal(await page.evaluate(() => window.__changes.length), changesBefore); failConfig = false;
		await helper.getByRole("button", { name: "打开上游管理台", exact: true }).click();
		const manager = page.getByRole("dialog", { name: "酒馆助手原上游管理台" }); await manager.waitFor(); await page.frameLocator('.tavern-plugins-manager iframe').getByText("合成 helper 原设置fixture", { exact: true }).waitFor();
		assert.equal(await manager.locator("iframe").getAttribute("src"), "/tavern-plugin-host.html?view=manager&plugin=helper"); assert.deepEqual(managerRequests, ["helper"]);
		await page.setViewportSize({ width: 390, height: 844 }); const box = await manager.boundingBox(); assert.ok(box.x >= 9 && box.width <= 371 && box.height <= 825); assert.equal(await manager.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
		failManager = true; await manager.getByRole("button", { name: "重新载入上游管理台", exact: true }).click(); await page.frameLocator('.tavern-plugins-manager iframe').getByRole("alert").filter({ hasText: /合成宿主加载失败/ }).waitFor();
		await manager.getByRole("button", { name: "关闭上游管理台", exact: true }).click(); assert.equal(await page.locator(".tavern-plugins-backdrop").count(), 0);
		await template.getByRole("button", { name: "安装原版", exact: true }).click(); await template.getByText("已校验 1.0.0", { exact: true }).waitFor();
		failManager = false; await template.getByRole("button", { name: "打开上游管理台", exact: true }).click(); await page.frameLocator('.tavern-plugins-manager iframe').getByText("合成 template 原设置fixture", { exact: true }).waitFor(); assert.equal(managerRequests.at(-1), "template"); await page.keyboard.press("Escape");
		assert.equal(await page.locator(".tavern-plugins-backdrop").count(), 0); assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth), true);
		assert.equal(writes.every(item => ["id", "enabled", "autoUpdate"].includes(Object.keys(item.body)[0]) && Object.keys(item.body).every(key => ["id", "enabled", "autoUpdate"].includes(key))), true);
		assert.deepEqual(await page.evaluate(() => window.__changes), [{id:"template"}]); assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
	} finally { await browser?.close(); if (server) {server.closeIdleConnections?.();server.closeAllConnections?.();await new Promise(resolve => server.close(resolve));} await rm(cwd, { recursive: true, force: true }); }
});
