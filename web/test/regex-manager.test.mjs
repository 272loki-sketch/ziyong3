// Real browser + original preview Worker, synthetic cards/presets/sample text only.
// No production story, private settings, card image, or model is loaded or written.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);
const sampleA = "TOKEN\n<status>可见合成面板</status>\n后段同伴吃完了饭。";
const sampleB = "TOKEN\n<status>新绑定合成面板</status>\n第二张合成卡尾段。";
const slowText = "a".repeat(30_000) + "!";

test("正则管理：保留GLOBAL/预设/局部与全局选项，恢复原稿Worker预览/单规则/深度/取消/1s超时/390px主题", { timeout: 120_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-regex-preview-browser-"));
	let server, browser;
	const requests = [], pageErrors = [], externalRequests = [];
	let failures = 1, activeCard = 0;
	const rule = (id, name, scope, patch = {}) => {
		const value = {
			id, sourceId: scope === "preset" ? `preset-${activeCard}` : `card-${activeCard}`, scope, index: 0, name,
			find: "/<status>([\\s\\S]*?)<\\/status>/g", replace: "<div>$1</div>", disabled: false,
			placement: [2], markdownOnly: true, promptOnly: false, trim: [], displayActive: true, promptActive: false, notes: [], ...patch,
		};
		const parsed = /^\/([\s\S]+)\/([a-z]*)$/.exec(value.find);
		// Deliberately leave a stale displayRule on disabled test rows: the preview must still reject them.
		value.displayRule = { name, source: parsed[1], flags: parsed[2] || "g", replace: value.replace,
			...(value.minDepth === undefined ? {} : { minDepth: value.minDepth }), ...(value.maxDepth === undefined ? {} : { maxDepth: value.maxDepth }) };
		return value;
	};
	const globalSource = { id: "global", kind: "global", scope: "global", name: "梨园全局规则", path: ".liyuan/regex-global.json", ruleCount: 1 };
	const globalDisabled = () => rule("global-disabled-rule", "全局关闭规则保留", "global", { sourceId: "global", disabled: true, displayActive: false, replace: "GLOBAL_DISABLED_MUST_NOT_RENDER", notes: ["原规则已关闭"] });
	const snapshots = [
		{
			cardPath: "synthetic-card-a.png", charName: "合成卡 A", userName: "合成用户 A", skinEnabled: false,
			sources: [globalSource,
				{ id: "preset-0", kind: "preset", scope: "preset", name: "合成预设 A", path: "preset-a.json", ruleCount: 1 },
				{ id: "lore-0", kind: "lorebook", scope: "lorebook", name: "已挂载合成世界书", path: "lore-a.json", ruleCount: 0 },
				{ id: "card-0", kind: "card", scope: "local", name: "合成卡 A", path: "card-a.json", ruleCount: 3 },
			],
			rules: [globalDisabled(),
				rule("preset-a-rule", "仅 A 预设规则", "preset", { find: "/TOKEN/g", replace: "PRESET_A_OUTPUT" }),
				rule("card-a-rule", "A 局部关闭规则", "local", { sourceId: "card-0", disabled: true, displayActive: false, replace: "LOCAL_DISABLED_MUST_NOT_RENDER", notes: ["原规则已关闭"] }),
				rule("card-a-open-rule", "A 局部规则（卡皮肤总开关关闭）", "local", { sourceId: "card-0", minDepth: 1, maxDepth: 2,
					replace: '<div class="regex-synthetic-panel" style="padding:12px;border:1px solid var(--hairline)"><strong>{{char}}</strong>：$1</div>' }),
				rule("slow-rule", "合成慢规则", "local", { sourceId: "card-0", find: "/^(a+)+$/g", replace: "SLOW_RESULT" }),
			],
		},
		{
			cardPath: "synthetic-card-b.png", charName: "合成卡 B", userName: "合成用户 B", skinEnabled: true,
			sources: [globalSource,
				{ id: "preset-1", kind: "preset", scope: "preset", name: "合成预设 B", path: "preset-b.json", ruleCount: 1 },
				{ id: "card-1", kind: "card", scope: "local", name: "合成卡 B", path: "card-b.json", ruleCount: 1 },
			],
			rules: [globalDisabled(),
				rule("preset-b-rule", "仅 B 预设规则", "preset", { sourceId: "preset-1", find: "/TOKEN/g", replace: "PRESET_B_OUTPUT" }),
				rule("card-b-rule", "B 局部可用规则", "local", { sourceId: "card-1", replace: '<div class="regex-synthetic-panel"><strong>{{char}}</strong>：$1</div>' }),
			],
		},
	];
	const snapshotsBefore = JSON.stringify(snapshots);

	try {
		const fixture = `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {RegexManager} from './src/components/RegexManager.tsx'; import {ActionOptionsCard} from './src/options-card.tsx';
		const NativeWorker=window.Worker;window.__previewWorkers=[];window.Worker=class extends NativeWorker{constructor(url,options){super(url,options);this.__terminated=false;window.__previewWorkers.push(this)}terminate(){this.__terminated=true;super.terminate()}};
		const samples=${JSON.stringify([sampleA, sampleB])};
		function Harness(){const [open,setOpen]=useState(false),[tick,setTick]=useState(0),[card,setCard]=useState(0);window.__switchCard=async()=>{await fetch('/__switch-card',{method:'POST'});setCard(1);setTick(n=>n+1)};return <><button id="open-regex" className="regex-entry" onClick={()=>setOpen(true)}>正则与渲染</button><main id="story-marker">synthetic story marker</main><ActionOptionsCard text={'正文之前\\n<options>\\n1. 观察四周，不暴露来意\\n2. 向守门人询问来客\\n</options>\\n正文之后'} onSelectOption={text=>window.__selectedOption=text}/>{open&&<RegexManager onClose={()=>setOpen(false)} contextTick={tick} sample={samples[card]}/>}</>};createRoot(document.getElementById('root')).render(<Harness/>);`;
		await build({
			stdin: { contents: fixture, resolveDir: join(root, "web"), loader: "tsx" }, bundle: true, format: "esm", jsx: "automatic",
			outfile: join(cwd, "fixture.js"), loader: { ".css": "empty" }, logLevel: "silent",
			plugins: [{ name: "synthetic-worker-url", setup(builder) {
				builder.onLoad({ filter: /RegexPreviewPanel\.tsx$/ }, async (args) => ({
					contents: (await readFile(args.path, "utf8")).replace('new URL("../regex-preview-worker.ts", import.meta.url)', 'new URL("/preview-worker.js", import.meta.url)'), loader: "tsx",
				}));
			} }],
		});
		await build({ entryPoints: [join(root, "web/src/regex-preview-worker.ts")], bundle: true, format: "esm", outfile: join(cwd, "preview-worker.js"), logLevel: "silent" });
		const css = [await readFile(join(root, "web/src/app.css"), "utf8"), await readFile(join(root, "web/src/components/RegexManager.css"), "utf8"), await readFile(join(root, "web/src/regex-options.css"), "utf8")].join("\n");
		await writeFile(join(cwd, "fixture.css"), css);
		await writeFile(join(cwd, "index.html"), `<!doctype html><html data-theme="light" lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:sans-serif}#root{width:100%;max-width:720px;margin:auto;padding:10px}</style></head><body><div id="root"></div><script>window.__selectedOption='';window.__rpNarrative='synthetic narrative unchanged';window.__rpAuthorDraft='synthetic author draft unchanged';window.__previewScriptRan=false;</script><script type="module" src="/fixture.js"></script></body></html>`);
		server = createServer(async (req, res) => {
			const url = new URL(req.url, "http://127.0.0.1");
			if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(await readFile(join(cwd, "index.html"))); }
			if (url.pathname === "/__switch-card" && req.method === "POST") { activeCard = 1; res.writeHead(204); return res.end(); }
			if (url.pathname === "/api/cardfront/regex") {
				requests.push(`${req.method} ${url.pathname}`);
				if (failures-- > 0) { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "合成规则读取失败" })); }
				res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(snapshots[activeCard]));
			}
			const path = url.pathname.slice(1), type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "application/octet-stream";
			if (["fixture.js", "fixture.css", "preview-worker.js"].includes(path)) { res.writeHead(200, { "content-type": type }); return res.end(await readFile(join(cwd, path))); }
			res.writeHead(404); res.end();
		});
		await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const baseUrl = `http://127.0.0.1:${server.address().port}`;
		const executable = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE, libraries = process.env.LIYUAN_DATABASE_BROWSER_LIBS;
		assert.ok(executable && libraries, "public Chromium executable/libraries are required; never skip browser assertions");
		browser = await chromium.launch({ headless: true, executablePath: executable, env: { ...process.env, LD_LIBRARY_PATH: libraries }, args: ["--no-sandbox"] });
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
		page.setDefaultTimeout(12_000);
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("request", (request) => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== baseUrl) externalRequests.push(request.url()); });
		await page.route("**/*", (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
		await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
		const optionCard = page.getByRole("region", { name: "全局行动选项" });
		await optionCard.getByRole("button", { name: /选择行动：观察四周/ }).click();
		assert.equal(await page.evaluate(() => window.__selectedOption), "观察四周，不暴露来意");
		await page.getByRole("button", { name: "正则与渲染", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "正则与渲染" });
		await dialog.getByRole("alert").filter({ hasText: "合成规则读取失败" }).waitFor();
		await dialog.getByRole("button", { name: "重新读取规则" }).click();
		await dialog.getByRole("region", { name: "全局内置行动选项规则" }).waitFor();
		await dialog.getByText("GLOBAL · 梨园内置", { exact: true }).waitFor();
		const globalRules = dialog.getByRole("region", { name: "用户全局正则规则" });
		await globalRules.getByText("全局关闭规则保留", { exact: true }).waitFor();
		assert.equal(await globalRules.getByText("已关闭", { exact: true }).count(), 1);
		assert.equal(await dialog.locator(".global-options-card__item").count(), 2, "new fixed global layout preview remains present");

		const previewPanel = dialog.locator(".regex-preview");
		const input = previewPanel.getByLabel("作者原文 / 测试文本");
		const run = previewPanel.getByRole("button", { name: "运行本地预览", exact: true });
		const apply = previewPanel.getByRole("checkbox", { name: /预览应用显示正则/ });
		const range = previewPanel.getByLabel("规则范围");
		const depth = previewPanel.getByLabel("消息深度");
		const output = previewPanel.getByRole("region", { name: "正则渲染预览" });
		const rawOutput = previewPanel.getByLabel("替换后的完整文本");
		const workersActive = () => page.evaluate(() => window.__previewWorkers.filter((worker) => !worker.__terminated).length);
		assert.equal(await input.inputValue(), "", "sample is not loaded automatically");
		assert.equal(await page.evaluate(() => window.__previewWorkers.length), 0, "opening the manager never automatically executes preview");
		await previewPanel.getByRole("button", { name: "载入当前显示轮原稿" }).click();
		assert.equal(await input.inputValue(), sampleA, "explicitly loading the saved author sample is restored");
		assert.equal(await page.evaluate(() => window.__previewWorkers.length), 0, "loading does not run the Worker");
		assert.equal(await apply.isChecked(), false, "per-card master-off remains the preview default");
		await run.click(); await output.waitFor();
		await previewPanel.getByText(/实际应用 0 条显示规则/).waitFor();
		await apply.check(); await depth.fill("1"); await run.click(); await output.waitFor();
		const firstFrame = page.frameLocator(".regex-preview-result iframe");
		await firstFrame.getByText("合成卡 A", { exact: true }).waitFor();
		await firstFrame.getByText(/可见合成面板/).waitFor();
		await output.getByText("后段同伴吃完了饭。", { exact: false }).waitFor();
		await previewPanel.locator(".regex-preview-source summary").click();
		assert.match(await rawOutput.inputValue(), /PRESET_A_OUTPUT/);
		assert.doesNotMatch(await rawOutput.inputValue(), /(?:GLOBAL|LOCAL)_DISABLED_MUST_NOT_RENDER/);

		await dialog.getByRole("button", { name: /当前预设/ }).click({ noWaitAfter: true });
		await dialog.getByText("仅 A 预设规则", { exact: true }).waitFor();
		assert.equal(await dialog.getByText("仅 B 预设规则", { exact: true }).count(), 0);
		await dialog.getByRole("button", { name: /角色卡局部/ }).click({ noWaitAfter: true });
		const closedRule = dialog.locator(".regex-rule").filter({ hasText: "A 局部关闭规则" });
		await closedRule.locator("summary").click();
		assert.equal(await closedRule.getByRole("button", { name: "仅预览这条显示规则" }).isDisabled(), true, "disabled rules cannot be selected or forced by preview");
		assert.equal(await range.locator('option[value="card-a-rule"]').evaluate((option) => option.disabled), true);
		const activeRule = dialog.locator(".regex-rule").filter({ hasText: "A 局部规则（卡皮肤总开关关闭）" });
		await activeRule.locator("summary").click();
		await activeRule.getByRole("button", { name: "仅预览这条显示规则" }).click();
		assert.equal(await range.inputValue(), "card-a-open-rule", "per-row single-rule preview is restored");
		await depth.fill("0"); await run.click(); await output.waitFor();
		await previewPanel.getByText(/实际应用 0 条显示规则/).waitFor();
		await depth.fill("1"); await run.click(); await output.waitFor();
		await previewPanel.getByText(/实际应用 1 条显示规则/).waitFor();
		await previewPanel.locator(".regex-preview-source summary").click();
		assert.match(await rawOutput.inputValue(), /TOKEN/);
		assert.doesNotMatch(await rawOutput.inputValue(), /PRESET_A_OUTPUT|DISABLED_MUST_NOT_RENDER/);
		await range.selectOption("@current-scope"); await run.click(); await output.waitFor();
		await previewPanel.getByText(/实际应用 2 条显示规则/).waitFor();
		await dialog.getByRole("button", { name: /当前预设/ }).click({ noWaitAfter: true });
		assert.equal(await output.count(), 0, "switching scope invalidates the previous preview");
		await run.click(); await output.waitFor();
		await previewPanel.getByText(/实际应用 1 条显示规则/).waitFor();

		await dialog.getByRole("button", { name: /角色卡局部/ }).click({ noWaitAfter: true });
		await range.selectOption("slow-rule"); await input.fill(slowText); await run.click();
		await previewPanel.getByRole("alert").filter({ hasText: "超过 1 秒" }).waitFor();
		assert.equal(await workersActive(), 0, "timeout terminates the real Worker instead of freezing the page");
		assert.equal(await output.count(), 0);
		await run.click(); await previewPanel.getByRole("button", { name: "取消预览", exact: true }).click();
		await previewPanel.getByRole("status").filter({ hasText: "已取消本地预览" }).waitFor();
		assert.equal(await workersActive(), 0);
		await page.evaluate(() => window.__previewWorkers.at(-1).dispatchEvent(new MessageEvent("message", { data: { ok: true, result: { display: "IGNORED_AFTER_CANCEL", steps: [] } } })));
		assert.equal(await dialog.getByText("IGNORED_AFTER_CANCEL").count(), 0, "a late canceled response cannot become current preview");
		await run.click();
		await previewPanel.getByRole("button", { name: "取消预览", exact: true }).waitFor();
		await page.evaluate(() => window.__switchCard());
		await dialog.locator(".regex-context strong").getByText("合成卡 B", { exact: true }).waitFor();
		await dialog.getByText("B 局部可用规则", { exact: true }).waitFor();
		assert.equal(await workersActive(), 0, "card/preset metadata change terminates the in-flight old Worker");
		assert.equal(await input.inputValue(), "", "new binding never auto-loads a different author sample");
		assert.equal(await output.count(), 0);
		assert.equal(await range.inputValue(), "");
		await dialog.getByRole("button", { name: /当前预设/ }).click({ noWaitAfter: true });
		await dialog.getByText("仅 B 预设规则", { exact: true }).waitFor();
		assert.equal(await dialog.getByText("仅 A 预设规则", { exact: true }).count(), 0);
		await previewPanel.getByRole("button", { name: "载入当前显示轮原稿" }).click();
		assert.equal(await input.inputValue(), sampleB);
		await run.click(); await output.waitFor();
		await page.frameLocator(".regex-preview-result iframe").getByText("合成卡 B", { exact: true }).waitFor();

		const unsafeHtml = '<!doctype html><html><head><link rel="stylesheet" href="https://preview.invalid/style.css"><meta http-equiv="refresh" content="0;url=https://preview.invalid/redirect"><style>@import url("https://preview.invalid/import.css");</style></head><body><div>静态安全合成预览</div><script>parent.__previewScriptRan=true;</script><img src="https://preview.invalid/image.png" onerror="parent.__previewScriptRan=true"><iframe src="https://preview.invalid/frame"></iframe><a href="https://preview.invalid/link">无外链跳转</a></body></html>';
		await apply.uncheck(); await input.fill(unsafeHtml); await run.click(); await output.waitFor();
		const safeFrame = page.frameLocator(".regex-preview-result iframe");
		await safeFrame.getByText("静态安全合成预览", { exact: true }).waitFor();
		assert.equal(await output.locator("iframe").getAttribute("sandbox"), "");
		assert.doesNotMatch(await output.locator("iframe").getAttribute("srcdoc"), /<script\b/i);
		assert.equal(await safeFrame.locator("a").getAttribute("href"), null);
		await safeFrame.getByText("无外链跳转", { exact: true }).click();
		assert.equal(await page.evaluate(() => window.__previewScriptRan), false);
		assert.deepEqual(externalRequests, [], "static iframe preview has no external resources or navigations");
		await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
		await page.waitForFunction(() => document.querySelector('.regex-preview-result iframe')?.getAttribute('srcdoc')?.includes('data-theme="dark"'));
		await safeFrame.getByText("静态安全合成预览", { exact: true }).waitFor();
		assert.equal(await safeFrame.locator("html").getAttribute("data-theme"), "dark");
		assert.equal(await safeFrame.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(20, 17, 16)");
		await page.setViewportSize({ width: 390, height: 844 });
		const box = await dialog.boundingBox();
		assert.ok(box && box.x >= 0 && box.width <= 376);
		for (const element of [dialog, dialog.locator(".regex-manager__body"), previewPanel, output]) {
			assert.equal(await element.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "390px preview/dialog layout must not overflow horizontally");
		}
		await dialog.getByRole("button", { name: /全局/ }).click({ noWaitAfter: true });
		await dialog.getByText("GLOBAL · 梨园内置", { exact: true }).waitFor();
		assert.equal(await dialog.locator(".global-options-card__item").count(), 2, "restoring preview does not remove the new global fixed preview");
		await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
		assert.equal(await workersActive(), 0);
		assert.equal(await page.evaluate(() => document.activeElement.id), "open-regex");
		assert.equal(await page.evaluate(() => window.__rpNarrative), "synthetic narrative unchanged");
		assert.equal(await page.evaluate(() => window.__rpAuthorDraft), "synthetic author draft unchanged");
		assert.equal(JSON.stringify(snapshots), snapshotsBefore, "local preview never changes original rules or disabled metadata");
		assert.deepEqual(requests, ["GET /api/cardfront/regex", "GET /api/cardfront/regex", "GET /api/cardfront/regex"]);
		assert.deepEqual(pageErrors, []);
	} finally {
		await browser?.close();
		if (server) { server.closeIdleConnections?.(); server.closeAllConnections?.(); await new Promise((resolveClose) => server.close(resolveClose)); }
		await rm(cwd, { recursive: true, force: true });
	}
});
