// Only synthetic card data/scripts and real local REST routes; no original plugin/model/production writes.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";
import { configPath, handleApiRequest } from "../../server/rest.ts";
import { DEFAULT_CONFIG } from "../../src/types.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const cardUi = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif;margin:12px}button{padding:12px;margin:4px;max-width:95%}#status{overflow-wrap:anywhere}</style></head><body>
<h1>合成篇章选择</h1><button data-year="A">篇章 A</button><button data-year="B">篇章 B</button><button data-year="C">篇章 C</button>
<button id="sync">同步并初始化</button><div id="status" role="status">尚未同步</div>
<script>
var selected="A";
document.querySelectorAll("[data-year]").forEach(function(button){button.onclick=function(){selected=button.dataset.year;};});
async function setByTag(tag,enabled){
 var name=getCharWorldbookNames("current").primary;
 var entries=await getWorldbook(name);
 var updated=entries.map(function(entry){if(!entry.name.includes(tag))return entry;var copy={};for(var k in entry){if(Object.prototype.hasOwnProperty.call(entry,k))copy[k]=entry[k];}copy.enabled=enabled;return copy;});
 await replaceWorldbook(name,updated);
}
document.getElementById("sync").onclick=async function(){
 var button=this,status=document.getElementById("status");button.disabled=true;status.textContent="同步中";
 try{for(var tag of ["A_","B_","C_"])await setByTag(tag,false);await setByTag(selected+"_",true);status.textContent="已同步篇章 "+selected;}
 catch(error){status.textContent="同步失败："+error.message;}
 finally{button.disabled=false;}
};
</script></body></html>`;

test("程序卡世界书：桌面/390px实际点击四次连续启停，真实REST回写且失败可重试", { timeout: 60_000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), "liyuan-worldbook-browser-"));
 let server, browser, busy = false;
 let greetingSession = "synthetic-session";
 const errors = [], forbidden = [], writes = [];
 t.signal.addEventListener("abort", () => { void browser?.close(); server?.closeAllConnections?.(); }, { once: true });
 const host = { cwd, isStreaming: () => busy, softRefreshConfig: async () => undefined, notify: () => undefined };
 try {
  await mkdir(join(cwd, "assets/lorebooks"), { recursive: true });
  await writeFile(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "fixture.json" }));
  await writeFile(join(cwd, "fixture.json"), JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: { name: "离线合成卡", first_mes: "合成开场", character_book: { name: "离线合成书", keepBook: 17, entries: [
   { id: 1, comment: "A_篇章", content: "相同合成正文", enabled: true, extensions: { keep: "A" } },
   { id: 1, comment: "B_篇章", content: "相同合成正文", enabled: false, extensions: { keep: "B" } },
   { id: 3, comment: "C_篇章", content: "合成正文C", enabled: false },
   { id: 4, comment: "未涉及的默认关闭模块", content: "合成关闭模块", enabled: false, untouched: true },
  ] } } }));
  const bundle = join(cwd, "fixture.js");
  await build({ stdin: { contents: `import {installParentTavernShim,IFRAME_TAVERN_BRIDGE_SNIPPET} from ${JSON.stringify(join(root,"web/src/tavernShim.ts"))};installParentTavernShim();const f=document.createElement("iframe");f.style="width:100%;height:650px;border:0";f.srcdoc=${JSON.stringify(cardUi)}.replace("</head>",IFRAME_TAVERN_BRIDGE_SNIPPET+"</head>");document.body.append(f);`, resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, platform: "browser", format: "iife", logLevel: "silent" });
  server = createServer(async (req, res) => {
   const url = new URL(req.url, "http://localhost");
   try {
    if (url.pathname === "/api/tavern/greeting-context") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ sessionId: greetingSession, card: "fixture.json", leafId: "synthetic-opening", messageCount: 1, greetingIndex: 0, greetings: ["合成开场"] })); }
    if (["/api/tavern/worldbooks", "/api/tavern/worldbook"].includes(url.pathname)) {
     if (req.method === "PUT") writes.push(url.pathname);
     if (await handleApiRequest(req, res, host)) return;
    }
    if (url.pathname === "/fixture.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(await readFile(bundle)); }
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style></head><body><script src="/fixture.js"></script></body></html>'); }
    if (url.pathname !== "/favicon.ico") forbidden.push(url.pathname);
    res.writeHead(404); res.end();
   } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const publicBrowser = join(root, ".liyuan-database-plugin/browser/headless_shell"), publicLibs = join(root, ".liyuan-database-plugin/browser-libs/lib64");
  const executablePath = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(publicBrowser) ? publicBrowser : undefined);
  const libraryPath = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || (existsSync(publicLibs) ? publicLibs : "");
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), env: { ...process.env, LD_LIBRARY_PATH: libraryPath }, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { forbidden.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe");
  for (const [year, width] of [["A", 1440], ["B", 1440], ["C", 390]]) {
   await page.setViewportSize({ width, height: 950 });
   await frame.getByRole("button", { name: `篇章 ${year}`, exact: true }).click();
   await frame.getByRole("button", { name: "同步并初始化", exact: true }).click();
   await frame.getByRole("status").filter({ hasText: `已同步篇章 ${year}` }).waitFor();
   const data = JSON.parse(await readFile(join(cwd, "fixture.json"), "utf8"));
   assert.deepEqual(data.data.character_book.entries.map(e => e.enabled), [year === "A", year === "B", year === "C", false]);
   assert.deepEqual(data.data.character_book.entries[0].extensions, { keep: "A" });
   assert.deepEqual(data.data.character_book.entries[1].extensions, { keep: "B" });
   assert.equal(data.data.character_book.keepBook, 17);
   assert.equal(await frame.locator("body").evaluate(body => body.scrollWidth <= body.clientWidth + 1), true);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  assert.equal(writes.length, 12);
  busy = true;
  const before = await readFile(join(cwd, "fixture.json"));
  await frame.getByRole("button", { name: "同步并初始化", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "同步失败" }).waitFor();
  assert.equal(writes.length, 13, "失败不自动重试");
  assert.ok((await readFile(join(cwd, "fixture.json"))).equals(before));
  assert.equal(await frame.getByRole("button", { name: "同步并初始化", exact: true }).isEnabled(), true);
  busy = false;
  await frame.getByRole("button", { name: "同步并初始化", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "已同步篇章 C" }).waitFor();
  assert.equal(writes.length, 17);
  greetingSession = "different-synthetic-session";
  const after = await readFile(join(cwd, "fixture.json"));
  await frame.getByRole("button", { name: "同步并初始化", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "同步失败" }).waitFor();
  assert.match(await frame.getByRole("status").textContent(), /会话.*变化/);
  assert.equal(writes.length, 17, "旧帧不能重新读取并接管另一会话的世界书");
  assert.ok((await readFile(join(cwd, "fixture.json"))).equals(after));
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
 } finally { await browser?.close(); server?.closeAllConnections?.(); if (server) await new Promise(resolve => server.close(resolve)); await rm(cwd, { recursive: true, force: true }); }
});
