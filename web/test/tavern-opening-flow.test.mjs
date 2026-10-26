// Synthetic end-to-end opening acceptance: actual App, real isolated main, loopback model stub.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { chromium } from "playwright";
import { workspaceFixture } from "../../test/helpers/workspace-fixture.ts";
const root = resolve(new URL("../..", import.meta.url).pathname), exec = promisify(execFile);
const doc = body => '```html\n<!doctype html><html><head><style>body{font:16px sans-serif;margin:12px}button,input{margin:5px;padding:8px;max-width:90%}</style></head><body>' + body + '</body></html>\n```';
const chooser = doc(`<button data-pick="A" data-swipe="1">选择篇章 A</button><button data-pick="B" data-swipe="2">选择篇章 B</button><button id="extensions">扩展管理</button><button id="sync" disabled>同步并初始化</button><button id="enter" disabled>确认进入</button><p role="status" id="status">请选择</p><script>
const extensions=document.getElementById('extensions'),sync=document.getElementById('sync'),enter=document.getElementById('enter'),status=document.getElementById('status');let chosen,index;document.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{chosen=b.dataset.pick;index=+b.dataset.swipe;sync.disabled=false;enter.disabled=true;});
extensions.onclick=()=>go(3);async function go(i){const rows=getChatMessages('0',{include_swipe:true});await setChatMessage(rows[0].swipes[i],0,{swipe_id:i,refresh:'display_and_render_current'});}
sync.onclick=async()=>{sync.disabled=true;try{const name=getCharWorldbookNames('current').primary,rows=await getWorldbook(name);await replaceWorldbook(name,rows.map(e=>({...e,enabled:e.name==='A'||e.name==='B'?e.name===chosen:e.enabled})));status.textContent='同步成功';enter.disabled=false;}catch(e){status.textContent='同步失败：'+e.message;}finally{sync.disabled=false;}};
enter.onclick=async()=>{enter.disabled=true;try{await go(index);}catch(e){status.textContent='进入失败：'+e.message;enter.disabled=false;}};
</script>`);
const form = label => doc(`<h1>合成登记 ${label}</h1><label>合成姓名<input id="who" value="合成玩家"></label><p id="step">第1步</p><button id="next">下一步</button><button id="back">返回封面</button><button id="submit" disabled>确认开局</button><p id="preview"></p><script>
const next=document.getElementById('next'),step=document.getElementById('step'),submit=document.getElementById('submit'),preview=document.getElementById('preview'),who=document.getElementById('who'),back=document.getElementById('back');let n=1;next.onclick=()=>{n++;step.textContent='第'+n+'步';submit.disabled=n<3;preview.textContent='合成开局 ${label}：'+who.value;};
back.onclick=async()=>{const rows=await getChatMessages('0',{include_swipe:true});await setChatMessage(rows[0].swipes[0],0,{swipe_id:0});};
submit.onclick=()=>{const input=window.parent.document.querySelector('#send_textarea'),button=window.parent.document.querySelector('#send_but');input.value=preview.textContent;input.dispatchEvent(new Event('input',{bubbles:true}));button.click();};
</script>`);
const extensions = doc(`<h1>合成扩展</h1><button id="toggle">切换扩展</button><button id="back">返回封面</button><p role="status" id="status"></p><script>
const toggle=document.getElementById('toggle'),status=document.getElementById('status'),back=document.getElementById('back');toggle.onclick=async()=>{const name=getCharWorldbookNames().primary,rows=await getWorldbook(name);await replaceWorldbook(name,rows.map(e=>({...e,enabled:e.name==='Extension'?!e.enabled:e.enabled})));status.textContent='扩展已保存';};
back.onclick=async()=>{const rows=getChatMessages(0);await setChatMessage(rows[0].swipes[0],0,{swipe_id:0});};
</script>`);
const card = { spec: "chara_card_v3", spec_version: "3.0", data: { name: "合成完整开局卡", description: "entirely synthetic", first_mes: "<chooser></chooser>", alternate_greetings: ["<registerA></registerA>", "<registerB></registerB>", "<extensions></extensions>"], character_book: { name: "合成完整开局书", entries: [
 { id: 7, comment: "A", content: "合成同正文", enabled: true }, { id: 7, comment: "B", content: "合成同正文", enabled: false }, { id: 9, comment: "Extension", content: "合成扩展", enabled: false }, { id: 10, comment: "Closed", content: "合成关闭项", enabled: false },
 ] }, extensions: { world: "合成完整开局书", regex_scripts: [["chooser", chooser], ["registerA", form("A")], ["registerB", form("B")], ["extensions", extensions]].map(([tag, html], i) => ({ id: "synthetic-opening-" + i, scriptName: "合成开局" + i, findRegex: "/<" + tag + ">[\\s\\S]*?<\\/" + tag + ">/g", replaceString: html, placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, minDepth: null, maxDepth: 1 })) } } };

test("完整合成开局：同步→已有原文确认进入→刷新/返回→表单DOM提交→持久ACK/正文，桌面与390px", { timeout: 180_000 }, async () => {
 const temp = await mkdtemp(join(tmpdir(), "liyuan-complete-opening-browser-"));
 const dist = process.env.LIYUAN_TEST_WEB_DIST_DIR || join(temp, "dist");
 if (!process.env.LIYUAN_TEST_WEB_DIST_DIR) await exec(process.execPath, [join(root, "web/node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir"], { cwd: join(root, "web"), timeout: 90_000 });
 const binary = join(root, ".liyuan-database-plugin/browser/headless_shell"), libs = join(root, ".liyuan-database-plugin/browser-libs/lib64");
 let browser;
 try {
  browser = await chromium.launch({ headless: true, ...(existsSync(binary) ? { executablePath: binary } : {}), env: { ...process.env, ...(existsSync(libs) ? { LD_LIBRARY_PATH: libs } : {}) }, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  for (const [width, choice] of [[1440, "A"], [390, "B"]]) {
   const fixture = await workspaceFixture(dist, { Primary: card }, { "合成完整开局书": structuredClone(card.data.character_book) });
   let context;
   try {
    context = await browser.newContext({ viewport: { width, height: 1050 }, serviceWorkers: "block" });
    await context.addCookies([{ name: "liyuan_access", value: fixture.cookie.split("=")[1], url: fixture.base }]);
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    const frames = [], errors = [], external = [];
    page.on("pageerror", e => { errors.push(e.message); console.error("synthetic page error:", e.message); });
    
    page.on("websocket", socket => { socket.on("framesent", e => { try { frames.push({ direction: "out", ...JSON.parse(String(e.payload)) }); } catch {} }); socket.on("framereceived", e => { try { frames.push({ direction: "in", ...JSON.parse(String(e.payload)) }); } catch {} }); });
    await page.route(new RegExp("^https?://(?!127\\.0\\.0\\.1:" + new URL(fixture.base).port + "(?:/|$))"), route => { external.push(route.request().url()); return route.abort(); });
    await page.goto(fixture.base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    const frame = page.frameLocator("iframe").first();
    await frame.locator("#extensions").click(); await frame.locator("h1").filter({ hasText: "合成扩展" }).waitFor();
    await frame.locator("#toggle").click(); await frame.getByRole("status").filter({ hasText: "扩展已保存" }).waitFor();
    await frame.locator("#back").click(); await frame.locator(`[data-pick="${choice}"]`).click();
    await frame.locator("#sync").click(); await frame.getByRole("status").filter({ hasText: "同步成功" }).waitFor();
    let failOnce = true;
    await page.route("**/api/tavern/greeting-select", async route => { if (failOnce) { failOnce = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "合成进入失败，可重试" }) }); } return route.fallback(); });
    await frame.locator("#enter").click(); await frame.getByRole("status").filter({ hasText: "进入失败" }).waitFor(); assert.equal(await frame.locator("#enter").isEnabled(), true);
    await frame.locator("#enter").click(); await frame.locator("h1").filter({ hasText: `合成登记 ${choice}` }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" }); await frame.locator("h1").filter({ hasText: `合成登记 ${choice}` }).waitFor();
    const beforeRestart = await (await fetch(fixture.base + "/healthz")).json();
    await fixture.stop(); await fixture.start();
    const afterRestart = await (await fetch(fixture.base + "/healthz")).json();
    assert.equal(afterRestart.sessionId, beforeRestart.sessionId, "开场确认后未发言也持久保留同一会话");
    await context.addCookies([{ name: "liyuan_access", value: fixture.cookie.split("=")[1], url: fixture.base }]);
    await page.unrouteAll({ behavior: "wait" });
    await page.route(new RegExp("^https?://(?!127\\.0\\.0\\.1:" + new URL(fixture.base).port + "(?:/|$))"), route => { external.push(route.request().url()); return route.abort(); });
    await page.goto(fixture.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "开始对话") || [...document.querySelectorAll("iframe")].some(frame => frame.contentDocument?.querySelector("#back")));
    const welcome = page.getByRole("button", { name: "开始对话", exact: true }); if (await welcome.count()) await welcome.click();
    await frame.locator("h1").filter({ hasText: `合成登记 ${choice}` }).waitFor().catch(async error=>{console.error("SYNTHETIC_RESTART_DIAGNOSTIC",JSON.stringify({body:(await page.locator("body").innerText()).slice(0,1000),frames:page.frames().map(f=>f.url()),ws:frames.filter(f=>f.direction==="in"&&["hello","notify","error"].includes(f.type)).slice(-3).map(f=>({type:f.type,sessionId:f.sessionId,count:f.messages?.length,text:f.text})),server:fixture.log.slice(-1500)}));throw error;});
    await frame.locator("#back").click(); await frame.locator(`[data-pick="${choice}"]`).click(); await frame.locator("#sync").click(); await frame.getByRole("status").filter({ hasText: "同步成功" }).waitFor(); await frame.locator("#enter").click(); await frame.locator("#who").fill("合成验收玩家");
    await frame.locator("#next").click(); await frame.locator("#next").click();
    assert.equal(await frame.locator("#submit").isEnabled(), true);
    assert.equal(await page.locator("#send_but").isDisabled(), true, "开始时父输入为空");
    const expected = `合成开局 ${choice}：合成验收玩家`;
    await frame.locator("#submit").click();
    await page.waitForFunction(text => document.body.textContent.includes(text), expected);
    await page.getByText("合成正文第1楼：独立故事沿着原有记忆继续。", { exact: false }).first().waitFor({ timeout: 30_000 });
    assert.equal(new Set(frames.filter(f => f.direction === "out" && f.type === "prompt" && f.text === expected).map(f => f.messageId)).size, 1, "传输重放复用同一输入身份，不新增第二次开局");
    assert.ok(frames.some(f => f.direction === "in" && f.type === "prompt_ack" && f.status === "accepted"), "输入须得到真实持久ACK");
    const main = await (await fetch(fixture.base + "/api/play-slots/main", { headers: { cookie: fixture.cookie } })).json();
    const headers = { cookie: fixture.cookie, "x-liyuan-workspace": main.workspace, "x-liyuan-workspace-lease": main.lease };
    const worldbook = await (await fetch(fixture.base + "/api/tavern/worldbook", { headers })).json();
    assert.equal(worldbook.source, "file"); assert.equal(worldbook.entries.length, 4);
    assert.deepEqual(worldbook.entries.map(e => e.enabled), [choice === "A", choice === "B", true, false]);
    assert.ok(!JSON.stringify(fixture.requests).includes("合成关闭项"), "disabled lore must not reach any actual captured local-model request");
    const greeting = await (await fetch(fixture.base + "/api/tavern/greeting-context", { headers })).json(); assert.equal(greeting.messageCount, 3, "开场、单次用户输入和单份正文");
    const blocked = await fetch(fixture.base + "/api/tavern/greeting-select", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ index: 0, expected: { sessionId: greeting.sessionId, card: greeting.card, leafId: greeting.leafId, greetingIndex: greeting.greetingIndex } }) }); assert.equal(blocked.status, 409, "已开聊不开放正文改写");
    await page.locator("#send_textarea").fill("合成普通追加输入");
    await page.locator("#send_but").click();
    await page.getByText("合成正文第2楼：独立故事沿着原有记忆继续。", { exact: false }).first().waitFor({ timeout: 30_000 });
    assert.equal(frames.filter(f => f.direction === "out" && f.type === "prompt" && f.text === "合成普通追加输入").length, 1, "普通输入仍使用原有可靠投递");
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.ok(fixture.writers >= 2);
   } finally { await context?.close(); await fixture.close(); }
  }
 } finally { await browser?.close(); await rm(temp, { recursive: true, force: true }); }
});
