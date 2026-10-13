// Entirely synthetic records; no original plugin assets or model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { build } from "../node_modules/esbuild/lib/main.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const text = "合成完整内容 <inner>字面标签</inner>\n```text\n  保留空格\n```\n" + "完整段落。".repeat(100) + "SOURCE-END";
test("dossiers preserve full text, manual secrets, receipt statuses and responsive disclosure", { timeout: 180000 }, async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-dossiers-"));
	let server, browser;
	try {
		await build({ stdin: { resolveDir: join(root, "web"), loader: "tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import './src/app.css';
import {ModularWorldCard,EcologyStateCard,NpcParallelViews,VeridisRewriteView} from './src/components/Messages.tsx';
const text=${JSON.stringify(text)};
const ecology={round:2,digest:'合成生态摘要',public:{locations:[text],events:['公开事件'],actors:['公开人物']},discovered:{events:['探索事件'],actors:['探索人物']},spoilers:{actors:['SECRET-ACTOR'],events:['SECRET-EVENT'],secrets:['SECRET-TRUTH'],cognition:['SECRET-COGNITION'],actorAdvances:['SECRET-ADVANCE']},propagation:[{occurrenceId:'p',headline:'传播标题',sourceType:'official',claimStatus:'rumor',publicity:'trace',trace:'传播痕迹'}]};
function Fixture(){const [round,setRound]=React.useState(2);const [secret,setSecret]=React.useState('SECRET-TRUTH');React.useLayoutEffect(()=>{window.secretCommits??=[];window.secretCommits.push({round,secret,visible:document.querySelector('.ecology-spoiler')?.textContent.includes(secret)});},[round,secret]);return <main style={{maxWidth:1000,margin:'auto',padding:12}}>
<button onClick={()=>setRound(round+1)}>下一快照</button>
<button onClick={()=>setRound(2)}>返回快照</button>
<button onClick={()=>setSecret('SECRET-REVISED')}>更新幕后内容</button>
<ModularWorldCard world={{round:2,digest:'世界摘要',modules:[{id:'m',name:'合成模块',revision:3,summary:text,publicRecords:[{label:'公开记录',summary:text}],discoverableRecords:[{label:'探索记录',summary:'探索完整内容'}],secretCount:2}]}} audit={{status:'committed',summary:'审计摘要',warnings:['审计警告']}}/>
<EcologyStateCard ecology={{...ecology,round,spoilers:{...ecology.spoilers,secrets:[secret]}}}/>
{['accepted','rejected','empty','failed'].map(status=><NpcParallelViews key={status} receipt={{status,reason:'原因 '+status,entries:status==='empty'?[]:[{id:'npc',name:'合成人物',status:status==='accepted'?'accepted':'rejected',text,info:'完整补充信息',reason:'人物原因'}],upstreamVersion:'fixture',upstreamCommit:'abcdef0123456789',sourceEntryId:'synthetic-source'}}/>)}
{[{status:'complete',changed:true,text:text+'DISPLAY-END'},{status:'complete',changed:false},{status:'skipped',reason:'未命中规则'},{status:'failed',error:'合成失败'}].map((receipt,i)=><VeridisRewriteView key={i} original={text} receipt={receipt}/>)}
<details className="world-state-card" id="unrelated"><summary>其他卡片</summary></details>
</main>};createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle: true, jsx: "automatic", format: "esm", outfile: join(cwd, "fixture.js"), logLevel: "silent" });
		await writeFile(join(cwd, "index.html"), '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
		server = createServer(async (req, res) => {
			const file = { "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" }[req.url];
			if (!file) { res.writeHead(404).end(); return; }
			res.setHeader("content-type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
			res.end(await readFile(join(cwd, file)));
		});
		await new Promise(r => server.listen(0, "127.0.0.1", r));
		const origin = `http://127.0.0.1:${server.address().port}`;
		t.diagnostic("Fixture built and served");
		browser = await chromium.launch({ headless: true, executablePath: process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE ?? join(root, ".liyuan-database-plugin/browser/headless_shell"), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? join(root, ".liyuan-database-plugin/browser-libs/lib64") }, args: ["--no-sandbox"] });
		const page = await browser.newPage();
		t.diagnostic("Browser ready");
		page.setDefaultTimeout(5000);
		const errors = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
		for (const width of [1440, 390, 320]) for (const theme of ["light", "dark"]) {
			t.diagnostic(`Checking ${width}px ${theme}`);
			await page.setViewportSize({ width, height: 900 });
			await page.goto(origin, { waitUntil: "domcontentloaded" });
			await page.locator(".turn-dossier").first().waitFor();
			await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
			const dossiers = page.locator(".turn-dossier");
			assert.equal(await dossiers.count(), 10);
			for (const dossier of await dossiers.all()) {
				assert.equal(await dossier.getAttribute("open"), null);
				await dossier.locator(":scope > summary").click();
			}
			assert.equal(await page.getByText("SECRET-TRUTH", { exact: true }).count(), 0);
			await page.getByRole("button", { name: "查看幕后剧透（5 条）" }).click();
			for (const secret of ["ACTOR", "EVENT", "TRUTH", "COGNITION", "ADVANCE"]) assert.ok(await page.getByText(`SECRET-${secret}`, { exact: true }).isVisible());
			await page.getByRole("button", { name: "收起剧透" }).click();
			assert.equal(await page.getByText("SECRET-TRUTH", { exact: true }).count(), 0);
			await page.getByRole("button", { name: "查看幕后剧透（5 条）" }).click();
			await page.getByRole("button", { name: "下一快照" }).click();
			assert.equal(await page.getByText("SECRET-TRUTH", { exact: true }).count(), 0);
			assert.equal(await page.evaluate(() => window.secretCommits.at(-1).visible), false, "new snapshot must be hidden in the commit, before passive effects");
			await page.getByRole("button", { name: "返回快照" }).click();
			assert.equal(await page.getByText("SECRET-TRUTH", { exact: true }).count(), 0, "returning to an old snapshot requires fresh consent");
			await page.getByRole("button", { name: "查看幕后剧透（5 条）" }).click();
			await page.getByRole("button", { name: "更新幕后内容" }).click();
			assert.equal(await page.getByText("SECRET-REVISED", { exact: true }).count(), 0);
			assert.equal(await page.evaluate(() => window.secretCommits.at(-1).visible), false, "same-round content changes must be hidden before effects");
			for (const detail of await page.locator(".turn-dossier .world-state-body details").all()) {
				if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
			}
			for (const p of await page.locator(".turn-dossier-compare > details:first-child > p").all()) assert.equal(await p.textContent(), text);
			assert.equal(await page.locator(".turn-dossier-compare > details:nth-child(2) > p").textContent(), text + "DISPLAY-END");
			assert.equal(await page.locator(".npc-parallel-views details > p:first-of-type").count(), 3);
			for (const p of await page.locator(".npc-parallel-views details > p:first-of-type").all()) assert.equal(await p.textContent(), text);
			assert.equal(await dossiers.first().locator(".world-state-summary").nth(1).textContent(), text);
			assert.equal(await page.locator(".turn-dossier inner, .turn-dossier script").count(), 0);
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
			assert.equal(await page.locator("#unrelated").evaluate(el => getComputedStyle(el).getPropertyValue("--dossier-paper")), "");
			assert.equal(await dossiers.first().evaluate(el => getComputedStyle(el).backgroundColor), theme === "dark" ? "rgb(40, 35, 32)" : "rgb(250, 246, 238)");
			for (const dossier of await dossiers.all()) {
				await dossier.locator(":scope > summary").focus();
				await page.keyboard.press("Enter");
				assert.equal(await dossier.getAttribute("open"), null);
			}
		}
		assert.deepEqual(errors, []);
	} finally {
		await browser?.close();
		server?.closeAllConnections();
		if (server) await new Promise(r => server.close(r));
		await rm(cwd, { recursive: true, force: true });
	}
});
