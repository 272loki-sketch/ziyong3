// Synthetic host/API only. Never loads a private story, real plugin runtime, or external model.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("众生侧写管理卡：安装/开关/候选/状态失败/原页就绪与返回/昼夜主题/390px（合成）", { timeout: 120_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-npc-parallel-panel-"));
	let browser, server;
	const writes = [], managerRequests = [];
	const state = {
		installed: false, enabled: false, autoUpdate: true, version: undefined, commit: undefined,
		sha256: undefined, candidateVersion: undefined, updateAvailable: false, pendingActivation: false,
		lastError: undefined, busy: false, ecologyEnabled: true,
		autoTrigger: false, executionEnabled: false, executionReason: "原插件 autoTrigger=false，自动触发关闭",
		model: { provider: "new", id: "gemini-3.8-flash" },
		source: {},
		receipt: { status: "rejected", sourceEntryId: "synthetic-entry-1", accepted: 0, rejected: 3, total: 3 },
	};
	let statusFailuresRemaining = 1, failConfig = false, activateUpdate = false, frameReadyDelay = 1200;
	try {
		await build({
			stdin: {
				contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {NpcParallelPanel} from './src/components/NpcParallelPanel.tsx'; function Fixture(){const [tick,setTick]=useState(0);return <NpcParallelPanel contextTick={tick} toast={(level,text)=>{window.__toasts.push({level,text});}}/>;} createRoot(document.getElementById('root')).render(<Fixture/>);`,
				resolveDir: join(root, "web"), loader: "tsx",
			},
			bundle: true, format: "esm", jsx: "automatic", outfile: join(cwd, "fixture.js"), logLevel: "silent",
		});
		await writeFile(join(cwd, "index.html"), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>
			*{box-sizing:border-box}:root{--bg:#f7f4f0;--surface:#fffcfa;--surface-dim:#f3efe9;--surface-deep:#e8e2da;--text:#3d3833;--text-strong:#1c1917;--text-soft:#6a635c;--hairline:#ebe6df;--hairline-strong:#d9d2c8;--accent:#bc4123;--accent-strong:#9d3319;--accent-wash:#faeee7;--ok:#65a30d}html[data-theme=dark]{--bg:#141110;--surface:#1e1a18;--surface-dim:#272220;--surface-deep:#322c29;--text:#eee8e1;--text-strong:#faf6f1;--text-soft:#c4bbb1;--hairline:#3a342f;--hairline-strong:#4d4540;--accent:#e25a3c;--accent-strong:#f06a4c;--accent-wash:#3a221c;--ok:#86b83a}body{margin:0;padding:9px;background:var(--bg);font-family:sans-serif;color:var(--text)}#root{width:100%;max-width:720px;margin:auto}</style></head><body><div id="root"></div><script>window.__toasts=[];</script><script type="module" src="/fixture.js"></script></body></html>`);
		server = createServer(async (req, res) => {
			const url = new URL(req.url, "http://127.0.0.1");
			if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(await (await import("node:fs/promises")).readFile(join(cwd, "index.html"))); }
			const json = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
			if (url.pathname === "/api/npc-parallel/status" && req.method === "GET") {
				if (statusFailuresRemaining > 0) { statusFailuresRemaining--; return json(503, { error: "合成状态服务暂不可用" }); }
				return json(200, state);
			}
			if (url.pathname === "/api/npc-parallel/config" && req.method === "PUT") {
				let raw = ""; for await (const chunk of req) raw += chunk;
				const body = JSON.parse(raw); writes.push({ path: url.pathname, method: req.method, body });
				if (failConfig) return json(503, { error: "合成配置写入失败" });
				if ("enabled" in body) state.enabled = body.enabled;
				if ("autoUpdate" in body) state.autoUpdate = body.autoUpdate;
				return json(200, state);
			}
			if (url.pathname.startsWith("/api/npc-parallel/") && req.method === "POST") {
				const operation = url.pathname.split("/").at(-1); writes.push({ path: url.pathname, method: req.method });
				if (operation === "install") Object.assign(state, { installed: true, enabled: false, version: "1.0.0", commit: "a".repeat(40), sha256: "b".repeat(64) });
				else if (operation === "check") Object.assign(state, { updateAvailable: true, candidateVersion: "2.0.0", pendingActivation: false });
				else if (operation === "update" && activateUpdate) Object.assign(state, { source: { previousVersion: state.version }, version: "2.0.0", commit: "c".repeat(40), updateAvailable: false, pendingActivation: false });
				else if (operation === "update") Object.assign(state, { updateAvailable: true, candidateVersion: "2.0.0", pendingActivation: true });
				else if (operation === "rollback") Object.assign(state, { source: { previousVersion: state.version }, version: "1.0.0", commit: "a".repeat(40), updateAvailable: false, pendingActivation: false });
				else return json(404, { error: "synthetic unknown action" });
				return json(200, state);
			}
			if (url.pathname === "/npc-parallel-host.html") {
				managerRequests.push({ view: url.searchParams.get("view"), theme: url.searchParams.get("theme") });
				res.writeHead(200, { "content-type": "text/html" });
				const delay = frameReadyDelay;
				return res.end(`<!doctype html><html><body><main>合成众生侧写原设置 fixture</main><button id="escape">iframe内按Escape返回</button><script>window.LiyuanNpcParallel={flush:async()=>{}};setTimeout(()=>parent.postMessage({type:'liyuan:npc-parallel-ready'},location.origin),${delay});</script></body></html>`);
			}
			if (url.pathname === "/fixture.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(await (await import("node:fs/promises")).readFile(join(cwd, "fixture.js"))); }
			if (url.pathname === "/fixture.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end(await (await import("node:fs/promises")).readFile(join(cwd, "fixture.css"))); }
			res.writeHead(404); res.end("not found");
		});
		await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
		const executablePath=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE;
        browser = await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH??""},args:process.getuid?.()===0?["--no-sandbox"]:[]});
		const pageErrors = [];
		const page = await browser.newPage({ viewport: { width: 980, height: 900 } });
		page.setDefaultTimeout(6_000);
		page.on("pageerror", error => { pageErrors.push(error.message); });
		await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
		const card = page.locator(".npc-parallel-card");
		await page.getByRole("alert").filter({ hasText: "合成状态服务暂不可用" }).waitFor();
		assert.equal(await card.getByRole("button", { name: /安装/ }).count(), 0, "状态读取失败时不显示可写操作");
		await page.getByRole("button", { name: "重试读取状态" }).click();
		await card.getByText("尚未安装", { exact: true }).waitFor();
		assert.equal(await card.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(255, 252, 250)", "白昼主题应使用暖白surface");
		await card.getByText(/最近鲜活世界回执：整批拒绝（业务审阅）/).waitFor();
		await card.getByText(/正常业务拒绝：本批候选未入账，原生态状态保持不变/).waitFor();
		assert.equal(await card.getByRole("alert").count(), 0, "业务拒绝回执不是技术错误告警");
		await card.getByText("gemini-3.8-flash", { exact: true }).waitFor();
		await card.getByText("new/gemini-3.8-flash", { exact: true }).waitFor();
		assert.equal(await card.getByRole("button", { name: "显式安装原版" }).isDisabled(), false);
		assert.equal(await card.getByRole("switch", { name: "众生侧写原版插件启用开关" }).isDisabled(), true, "未安装时不可直接启用");
		await card.getByRole("button", { name: "显式安装原版" }).click();
		await card.getByText("已安装 1.0.0", { exact: true }).waitFor();
		assert.equal(state.enabled, false, "安装不能默默启用运行开关");
		assert.equal(await card.getByRole("button", { name: "回退上一版", exact: true }).isDisabled(), true, "没有previousVersion时不伪称可回退");
		await card.getByText("暂无上一版本，暂不可回退。", { exact: true }).waitFor();
		await card.getByRole("switch", { name: "众生侧写原版插件启用开关" }).click();
		await card.getByText(/原版开关已开启；是否自动执行以服务端 executionEnabled 为准/).waitFor();
		await card.getByText("后台自动执行已停用", { exact: true }).waitFor();
		await card.getByText(/autoTrigger=false，自动触发关闭/).waitFor();
		assert.equal(state.enabled, true);
		failConfig = true;
		await card.getByRole("switch", { name: "众生侧写原版插件启用开关" }).click();
		await card.getByRole("alert").filter({ hasText: "合成配置写入失败" }).waitFor();
		assert.equal(state.enabled, true, "失败配置不应假装成功或乐观翻转开关");
		failConfig = false;
		await card.getByRole("switch", { name: "众生侧写原版插件启用开关" }).click();
		await page.waitForFunction(() => document.querySelector('[aria-label="众生侧写原版插件启用开关"]')?.getAttribute("aria-checked") === "false");
		assert.equal(state.enabled, false);

		state.busy = true;
		assert.equal(await card.getByRole("button", { name: "检查更新", exact: true }).isDisabled(), false, "服务端busy时仍允许单独检查更新");
		await card.getByRole("button", { name: "检查更新", exact: true }).click();
		await card.getByText(/发现候选，尚未成为当前版本/).waitFor();
		await card.getByRole("button", { name: "检查更新", exact: true }).click();
		await card.getByRole("button", { name: "检查更新", exact: true }).waitFor();
		assert.equal(writes.filter(item => item.path === "/api/npc-parallel/check").length, 2, "server busy时仍允许再次检查");
		assert.equal(await card.getByRole("button", { name: "更新并激活", exact: true }).isDisabled(), true, "busy时不得更新");
		assert.equal(await card.getByRole("switch", { name: "众生侧写原版插件启用开关" }).isDisabled(), true, "busy时不得启停");
		state.busy = false;
		await page.reload({ waitUntil: "domcontentloaded" });
		const refreshedCard = page.locator(".npc-parallel-card");
		await refreshedCard.getByText("已安装 1.0.0", { exact: true }).waitFor();
		await refreshedCard.getByRole("button", { name: "更新并激活", exact: true }).click();
		await refreshedCard.getByText(/候选已暂存，等待空闲切换/).waitFor();
		await refreshedCard.getByText(/当前激活版本仍为 1.0.0/).waitFor();
		assert.equal(state.version, "1.0.0", "pending候选不能显示为已更新");
		assert.equal(await refreshedCard.getByRole("button", { name: "更新并激活", exact: true }).isDisabled(), true, "待空闲切换的候选不应重复提交更新");
		activateUpdate = true;
		state.pendingActivation = false;
		await page.reload({ waitUntil: "domcontentloaded" });
		const activatedCard = page.locator(".npc-parallel-card");
		await activatedCard.getByText("候选版本 2.0.0 · 当前版本 1.0.0", { exact: true }).waitFor();
		await activatedCard.getByRole("button", { name: "更新并激活", exact: true }).click();
		await activatedCard.getByText("已安装 2.0.0", { exact: true }).waitFor();
		assert.equal(await activatedCard.getByRole("button", { name: "回退上一版", exact: true }).isDisabled(), false);
		state.busy = true;
		await page.reload({ waitUntil: "domcontentloaded" });
		const busyCard = page.locator(".npc-parallel-card");
		await busyCard.getByText("已安装 2.0.0", { exact: true }).waitFor();
		assert.equal(await busyCard.getByRole("button", { name: "回退上一版", exact: true }).isDisabled(), true, "busy时不能回退");
		assert.equal(await busyCard.getByRole("button", { name: "检查更新", exact: true }).isDisabled(), false, "busy时检查更新保持可用");
		state.busy = false;
		await page.reload({ waitUntil: "domcontentloaded" });
		const activatedCardIdle = page.locator(".npc-parallel-card");
		await activatedCardIdle.getByText("已安装 2.0.0", { exact: true }).waitFor();
		await activatedCardIdle.getByRole("button", { name: "回退上一版", exact: true }).click();
		await activatedCardIdle.getByText("已安装 1.0.0", { exact: true }).waitFor();
		activateUpdate = false;

		await activatedCardIdle.getByRole("button", { name: "打开原版设置" }).click();
		const lightManager = page.getByRole("region", { name: "众生侧写原版设置" });
		await lightManager.getByRole("status").filter({ hasText: "等待原版插件报告就绪" }).waitFor();
		const lightFrame = page.frameLocator('iframe[title="众生侧写原版设置"]');
		await lightFrame.locator("body").waitFor({ state: "attached" });
		await page.waitForFunction(() => document.querySelector('.npc-parallel-frame-wrap')?.classList.contains('is-not-ready') === false);
		assert.deepEqual(managerRequests.at(-1), { view: "manager", theme: "light" });
		await lightFrame.locator("#escape").press("Escape");
		await activatedCardIdle.getByRole("button", { name: "打开原版设置" }).waitFor();

		await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
		const darkBackground = await refreshedCard.evaluate(element => getComputedStyle(element).backgroundColor);
		assert.notEqual(darkBackground, "rgb(255, 252, 250)", "夜间主题应使用宿主夜间surface变量");
		await page.setViewportSize({ width: 390, height: 844 });
		const cardBox = await refreshedCard.boundingBox();
		assert.ok(cardBox && cardBox.x >= 0 && cardBox.width <= 372, `390px视口下卡片应收敛：${JSON.stringify(cardBox)}`);
		assert.equal(await refreshedCard.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "390px卡片不应产生横向溢出");
		await refreshedCard.getByRole("button", { name: "打开原版设置" }).click();
		const manager = page.getByRole("region", { name: "众生侧写原版设置" });
		await manager.getByRole("status").filter({ hasText: "等待原版插件报告就绪" }).waitFor();
		const frame = page.frameLocator('iframe[title="众生侧写原版设置"]');
		await frame.locator("body").waitFor({ state: "attached" });
		assert.equal(await manager.locator("iframe").evaluate(element => getComputedStyle(element).visibility), "hidden", "iframe load不等于runtime ready");
		await page.waitForFunction(() => document.querySelector('.npc-parallel-frame-wrap')?.classList.contains('is-not-ready') === false);
		assert.deepEqual(managerRequests.at(-1), { view: "manager", theme: "dark" });
		const managerBox = await manager.boundingBox();
		assert.ok(managerBox && managerBox.width <= 372 && managerBox.x >= 0, `原设置面板应适配390px：${JSON.stringify(managerBox)}`);
		await frame.locator("#escape").press("Escape");
		await refreshedCard.getByRole("button", { name: "打开原版设置" }).waitFor();
		assert.deepEqual(writes.map(item => item.path), [
			"/api/npc-parallel/install", "/api/npc-parallel/config", "/api/npc-parallel/config", "/api/npc-parallel/config",
			"/api/npc-parallel/check", "/api/npc-parallel/check", "/api/npc-parallel/update", "/api/npc-parallel/update", "/api/npc-parallel/rollback",
		]);
		assert.ok(writes.slice(1, 4).every(item => item.method === "PUT"));
		assert.deepEqual(pageErrors, [], "合成管理面板不应产生前端运行异常");
	} finally {
		await browser?.close();
		if (server) { server.closeIdleConnections?.(); server.closeAllConnections?.(); await new Promise(resolveClose => server.close(resolveClose)); }
		await rm(cwd, { recursive: true, force: true });
	}
});
