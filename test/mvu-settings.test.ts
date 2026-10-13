/** Real pinned upstream MVU UI on temporary synthetic state; no production mutations or model calls. */
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,symlink,rm} from "node:fs/promises";
import {readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {execFileSync} from "node:child_process";
import {chromium} from "playwright";
import {TavernPluginHttp} from "../server/tavern-plugin-http.ts";
import {syntheticTavernPluginContext} from "../server/tavern-plugin-runtime.ts";
import {ensureTavernPluginVendors} from "../server/tavern-plugin-vendor.ts";
import {TAVERN_CDN_ASSETS} from "../server/tavern-plugin-cdn.ts";
import {mvuAssetMap,mvuAsset,setMvuEnabled} from "../server/mvu-assets.ts";
const originals=process.env.LIYUAN_TAVERN_PLUGIN_FIXTURES,mvu=process.env.LIYUAN_MVU_NATIVE_FIXTURES;
test("原MVU设置：真实挂载/折叠、原控件持久化、专用导航、390px昼夜布局、关闭不假报就绪",{skip:!originals||!mvu,timeout:180000},async()=>{
 const root=process.cwd(),cwd=await mkdtemp(join(tmpdir(),"liyuan-mvu-settings-"));let api:TavernPluginHttp|undefined,server:any,browser:any;
 try{
  await symlink(join(root,"web"),join(cwd,"web"),"dir");await symlink(join(root,"node_modules"),join(cwd,"node_modules"),"dir");await ensureTavernPluginVendors(cwd,{fixtureRoot:originals});
  execFileSync(process.execPath,[join(root,"scripts/install-mvu.mjs"),"--verified-fixtures",mvu!],{cwd,stdio:"pipe"});setMvuEnabled(cwd,true);
  const context=syntheticTavernPluginContext();context.chat.push({mes:"SYNTHETIC_COMPLETE_STORY",is_user:false,name:"合成角色",variables:[{stat_data:{food:4}}],swipe_id:0,extra:{},__liyuanAuthorDelivery:"SYNTHETIC_ORIGINAL_DELIVERY",__liyuanEntryId:"synthetic-reply"});context.sourceEntryId="synthetic-reply";context.visibleEntryIds.push(context.sourceEntryId);let models=0;
  api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>false,generate:async()=>{models++;throw Error("settings cannot call models");}});
  for(const id of ["helper","template"] as const){await api.sources.install(id,{fixtureRepo:join(originals!,id)});api.sources.configure(id,{enabled:true});}
  const baseline=JSON.stringify(context),asset=readFileSync(mvuAsset(cwd,"bundle.js")!);
  server=createServer((req,res)=>{void(async()=>{if(req.url?.split("?")[0]==="/tavern-plugin-host.html"){res.writeHead(200,{"content-type":"text/html"});res.end(readFileSync(join(root,"web/public/tavern-plugin-host.html")));return;}if(!await api!.handle(req,res)){res.writeHead(404);res.end();}})().catch(error=>{if(!res.headersSent)res.writeHead(500);res.end(error.message);});});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const base=`http://127.0.0.1:${server.address().port}`;
  const executablePath=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE||(existsSync(join(root,".liyuan-database-plugin/browser/headless_shell"))?join(root,".liyuan-database-plugin/browser/headless_shell"):undefined);
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS||join(root,".liyuan-database-plugin/browser-libs/lib64")},args:["--no-sandbox"]});const page=await browser.newPage({locale:"en-US",viewport:{width:1180,height:900},serviceWorkers:"block"});const errors:string[]=[];
  page.on("pageerror",(error:Error)=>errors.push(error.message));page.on("dialog",(dialog:any)=>void dialog.dismiss());
  await page.route("**/*",(route:any)=>{const url=new URL(route.request().url()),mapped={...TAVERN_CDN_ASSETS,...mvuAssetMap(cwd)}[url.href];if(mapped){const file=mapped.startsWith("/tavern-compat/mvu/")?mvuAsset(cwd,mapped.split("/").at(-1)!):mapped.includes("/vendor/")?join(cwd,".liyuan-tavern-plugins/vendor",mapped.split("/").at(-1)!):api!.resolveOriginalAsset(mapped);if(!file){errors.push("missing pinned original asset");return route.abort();}return route.fulfill({status:200,contentType:"text/javascript",body:readFileSync(file),headers:{"access-control-allow-origin":"*"}});}if(url.origin!==base){errors.push("unexpected external resource "+url.hostname);return route.abort();}return route.continue();});
  const target=base+"/tavern-plugin-host.html?view=manager&plugin=helper&focus=mvu&network=isolated";
  await page.goto(target);await page.waitForFunction(()=>!!(window as any).LiyuanTavernPlugins?.ready(),{},{timeout:45000});const drawer=page.locator(".liyuan-mvu-settings");await drawer.waitFor();assert.match(await drawer.locator(":scope > .inline-drawer-header").innerText(),/MVU变量框架|MVU 变量框架/);assert.equal(await page.evaluate(()=>(window as any).SillyTavern.getCurrentLocale()),"zh-CN");assert.equal(await page.locator("#extensions_settings").isVisible(),false);assert.equal(await page.locator("#tavern_helper").isVisible(),false);assert.equal(await drawer.locator(".mvu-section").count()>4,true,"must be the real original MVU sections, not an empty shell");
  const header=drawer.locator(":scope > .inline-drawer-header");assert.equal(await header.getAttribute("aria-expanded"),"true");await header.click();assert.equal(await header.getAttribute("aria-expanded"),"false");await header.focus();await page.keyboard.press("Space");assert.equal(await header.getAttribute("aria-expanded"),"true");
  const input=drawer.locator('input[type="checkbox"]:not(:disabled)').first();assert.equal(await input.count(),1,"original MVU must provide real editable controls");const checked=await input.isChecked();await input.setChecked(!checked);await page.evaluate(async()=>{await (window as any).LiyuanTavernPlugins.host.flush();});
  await page.reload();await page.waitForFunction(()=>!!(window as any).LiyuanTavernPlugins?.ready(),{},{timeout:45000});assert.equal(await drawer.locator('input[type="checkbox"]:not(:disabled)').first().isChecked(),!checked,"original setting persists across host reload");
  const screenshots=process.env.LIYUAN_MVU_UI_SCREENSHOTS;if(screenshots){await mkdir(screenshots,{recursive:true});await page.screenshot({path:join(screenshots,"mvu-native-desktop.png"),fullPage:true});}
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"native MVU must fit 390px");if(screenshots)await page.screenshot({path:join(screenshots,"mvu-native-mobile.png"),fullPage:true});
  await page.evaluate(()=>document.documentElement.dataset.theme="dark");if(screenshots)await page.screenshot({path:join(screenshots,"mvu-native-dark.png"),fullPage:true});assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),"rgb(20, 17, 16)");
  assert.deepEqual(errors,[]);assert.equal(models,0);assert.equal(JSON.stringify(context),baseline);assert.ok(readFileSync(mvuAsset(cwd,"bundle.js")!).equals(asset),"original bundle bytes must remain unchanged");
  setMvuEnabled(cwd,false);await page.reload();await page.waitForFunction(()=>document.querySelector("#status")?.textContent?.includes("原插件加载失败"));assert.equal(await page.evaluate(()=>(window as any).LiyuanTavernPlugins.ready()),false);assert.match(await page.locator("#status").textContent()!,/请先启用已校验/);assert.equal(models,0);
  console.log("PASS original MVU settings: pinned bytes, real controls/persistence, native drawer/keyboard, 390px/day/night, no model/story edits");
 }finally{await browser?.close();api?.sources.close();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(resolve));}await rm(cwd,{recursive:true,force:true});}
});
