// Synthetic navigation/UI only: no original plugin assets, models or story state.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("MVU detail has one focusable heading and keeps the helper settings route at desktop/390/320px", { timeout: 45_000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), "liyuan-mvu-heading-"));
 let browser, server, stage = "setup";
 const writes = [], loads = [], errors = [];
 t.signal.addEventListener("abort", () => { void browser?.close(); server?.closeAllConnections?.(); }, { once: true });
 try {
  await build({
   stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{TavernPluginsManager}from'./src/components/TavernPluginsManager.tsx';function Harness(){const[open,setOpen]=useState(true);return <><main id="story">Synthetic story unchanged<button className="tavern-plugin-entry" onClick={()=>setOpen(true)}>Open plugins</button></main>{open&&<TavernPluginsManager onClose={()=>setOpen(false)} toast={()=>{}} contextTick={0}/>}</>;}createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: join(root, "web"), loader: "tsx",
   },
   bundle: true, format: "esm", jsx: "automatic", outfile: join(cwd, "fixture.js"), loader: { ".css": "empty" }, logLevel: "silent",
  });
  const css = (await Promise.all(["app.css", "components/TavernPluginsPanel.css", "components/MvuPanel.css"].map(path => readFile(join(root, "web/src", path), "utf8")))).join("\n");
  await writeFile(join(cwd, "fixture.css"), css);
  const plugins = [{ id: "helper", name: "酒馆助手", installed: true, enabled: true, autoUpdate: false, version: "synthetic-helper", commit: "synthetic-helper-commit" }];
  const view = { enabled: true, installed: true, version: "synthetic-mvu", commit: "synthetic-mvu-commit", dependencies: 75, helper: { enabled: true, installed: true }, binding: { scopeKey: "synthetic-scope", sourceEntryId: "synthetic-reply" }, streaming: false, pluginBusy: false, canRecover: true, variables: { rootCount: 2, hasData: true } };
  server = createServer((req, res) => { void (async () => {
   const url = new URL(req.url, "http://localhost");
   const json = value => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
   if (req.method !== "GET") { writes.push({ method: req.method, path: url.pathname }); res.writeHead(405); return res.end(); }
   if (url.pathname === "/api/tavern-plugins/status") return json({ plugins, checking: false });
   if (url.pathname === "/api/tavern-plugins/mvu/view") return json(view);
   if (url.pathname === "/tavern-plugin-host.html") {
    loads.push(Object.fromEntries(["view", "plugin", "focus"].map(key => [key, url.searchParams.get(key)])));
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<html><body><div id="status">原插件已就绪（合成设置）</div><h2>Synthetic helper MVU settings</h2><script>window.LiyuanTavernPlugins={host:{flush:async()=>{}}};</script></body></html>`);
   }
   if (url.pathname === "/tavern-plugin-sw.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(""); }
   if (url.pathname === "/fixture.js" || url.pathname === "/fixture.css") {
    res.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css" });
    return res.end(await readFile(join(cwd, url.pathname.slice(1))));
   }
   if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
   }
   res.writeHead(404); res.end();
  })().catch(error => { errors.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, ".liyuan-database-plugin/browser/headless_shell")) ? join(root, ".liyuan-database-plugin/browser/headless_shell") : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS || join(root, ".liyuan-database-plugin/browser-libs/lib64") }, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(5_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : (errors.push("external request"), route.abort()));
  stage = "navigation"; await page.goto(base);
  await page.locator("#story").evaluate(node => { window.__story = node; });
  const dialog = page.locator(".tavern-app-manager");
  assert.equal(await dialog.getAttribute("role"), "dialog");
  for (const width of [1280, 390, 320]) {
   stage = `detail-${width}`;
   await page.setViewportSize({ width, height: width === 1280 ? 1000 : 844 });
   const entry = dialog.getByRole("button", { name: "管理MVU 变量框架", exact: true });
   await entry.focus(); await page.keyboard.press("Enter");
   await dialog.locator(".mvu-panel").waitFor();
   const heading = dialog.getByRole("heading", { name: "MVU 变量框架", exact: true });
   assert.equal(await heading.count(), 1, `${width}px: only the panel owns the MVU heading`);
   assert.equal(await dialog.locator(".mvu-panel").getByRole("heading", { name: "MVU 变量框架", exact: true }).count(), 1);
   stage = `focus-${width}`; await page.waitForFunction(() => document.activeElement === document.querySelector(".mvu-panel-heading h3"));
   assert.equal(await heading.getAttribute("tabindex"), "-1");
   assert.equal(await dialog.locator(".plugin-center-heading").count(), 0, "no duplicate wrapper heading");
   assert.equal(await dialog.getByRole("switch", { name: "启用MVU" }).count(), 1);
   await page.waitForFunction(() => document.querySelector('.mvu-panel [role="switch"]')?.disabled === false);
   await heading.scrollIntoViewIfNeeded();
   const box = await heading.boundingBox();
   assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${width}px: heading stays in viewport`);
   assert.equal(await page.locator("body").evaluate(node => node.scrollWidth <= innerWidth), true);
   assert.deepEqual(writes, [], "opening a detail cannot update variables or settings");
   assert.equal(loads.length, 0, "detail navigation does not start the original plugin");
   await dialog.locator(".plugin-center-nav button").filter({ hasText: "全部插件" }).click();
   await dialog.getByRole("heading", { name: "让创作，各有所长", exact: true }).waitFor();
  }
  stage = "helper-detail"; await dialog.getByRole("button", { name: "管理酒馆助手", exact: true }).click();
  await dialog.locator(".plugin-center-heading").getByRole("heading", { name: "酒馆助手", exact: true }).waitFor();
  await dialog.locator(".plugin-center-nav button").filter({ hasText: "MVU 变量框架" }).click();
  stage = "original-settings"; await dialog.getByRole("button", { name: "打开原版 MVU 设置", exact: true }).click();
  await page.frameLocator(".tavern-plugin-frame-wrap iframe").getByRole("heading", { name: "Synthetic helper MVU settings" }).waitFor();
  assert.deepEqual(loads, [{ view: "manager", plugin: "helper", focus: "mvu" }], "native MVU settings still belong to Tavern Helper");
  await dialog.getByRole("button", { name: "返回酒馆插件", exact: true }).click();
  await dialog.locator(".mvu-panel").waitFor();
  assert.equal(await dialog.getByRole("heading", { name: "MVU 变量框架", exact: true }).count(), 1);
  stage = "close"; await dialog.getByRole("button", { name: "关闭酒馆插件管理", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.locator("#story").evaluate(node => node === window.__story && !node.inert), true);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
 } catch (error) { console.error("Synthetic heading diagnostic:", stage, error.message); throw error; } finally {
  await browser?.close();
  if (server) { server.closeIdleConnections?.(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await rm(cwd, { recursive: true, force: true });
 }
});
