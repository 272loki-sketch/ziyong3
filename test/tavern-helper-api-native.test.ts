/** Explicit verified original helper assets, entirely synthetic UI/state; no production or real models. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir, cp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { TavernPluginHttp } from "../server/tavern-plugin-http.ts";
import { TavernPluginSources } from "../server/tavern-plugin-source.ts";
import { syntheticTavernPluginContext } from "../server/tavern-plugin-runtime.ts";

const assets = process.env.LIYUAN_TAVERN_API_FIXTURES;
test("original helper renderer APIs: composer bridge, real rejection, events/variables/worldbook, filtered history and stale source", { skip: !assets, timeout: 90_000 }, async t => {
 const root = process.cwd(), cwd = await mkdtemp(join(tmpdir(), "liyuan-helper-api-native-"));
 let browser: any, server: any, stage = "setup";
 t.signal.addEventListener("abort", () => { void browser?.close(); server?.closeAllConnections?.(); }, { once: true });
 const errors: string[] = [], external: string[] = [], calls: string[] = [];
 let candidateAllowed=false, cancelled=false;
 try {
  const context = syntheticTavernPluginContext();
  context.chat.push({ mes: "SYNTHETIC assistant facts", name: "Synthetic", is_user: false, is_system: false, extra: {}, variables: [{}], swipe_id: 0, __liyuanEntryId: "reply" });
  context.visibleEntryIds.push("reply"); context.sourceEntryId = "reply";
  const canonical = JSON.stringify(context);
  const originalSources=new TavernPluginSources(assets!);assert.equal(originalSources.verify('helper').ok,true);
  const pinned=originalSources.status().plugins.find(plugin=>plugin.id==='helper'&&plugin.installed)!;
  const key=pinned.commit+'-'+pinned.sha256;
  await mkdir(join(cwd,'.liyuan-tavern-plugins/versions/helper'),{recursive:true,mode:0o700});
  await cp(join(assets!,'.liyuan-tavern-plugins/versions/helper',key),join(cwd,'.liyuan-tavern-plugins/versions/helper',key),{recursive:true});
  await writeFile(join(cwd,'.liyuan-tavern-plugins/state.json'),JSON.stringify({version:1,plugins:{helper:{enabled:true,autoUpdate:false,active:key},template:{enabled:false,autoUpdate:false}}}),{mode:0o600});

  const api = new TavernPluginHttp(cwd, { context: () => structuredClone(context), isStreaming: () => false, generate: async (messages,signal) => { if(!candidateAllowed){calls.push("unexpected model request");throw Error("No real model allowed");}calls.push(messages.map(row=>row.content).join("\n"));if(messages.some(row=>row.content.includes("SYNTHETIC_CANCEL"))){return new Promise<string>((_resolve,reject)=>{const cancel=()=>{cancelled=true;reject(Error("Synthetic candidate cancelled"));};if(signal?.aborted)cancel();else signal?.addEventListener("abort",cancel,{once:true});});}return "SYNTHETIC CANDIDATE"; } }, assets);
  api.fallbackSources = originalSources;
  assert.equal(api.sources.verify("helper").ok,true);
  assert.equal(api.fallbackSources.verify("helper").ok, true);
  const status = api.fallbackSources.status(); assert.equal(status.plugins.find(plugin => plugin.id === "helper")?.version, "4.11.3");
  const scope = api.binding().scopeKey;
  const state = api.store.read(context);
  state.state.extensionSettings.regex = [{id:'synthetic-regex',scriptName:'Synthetic display regex',findRegex:'/SYNTHETIC_REGEX/g',replaceString:'REGEX_APPLIED',trimStrings:[],placement:[2],disabled:false,markdownOnly:true,promptOnly:false,runOnEdit:true,minDepth:null,maxDepth:null,substituteRegex:0}];
  api.store.save(context,state.revision,state.state,()=>{});

  const html = `<!doctype html><html><body><button id="fill">Fill</button><button id="send">Send</button><button id="vars">Variables</button><button id="export">Export</button><div id="result">Ready</div><script>
   const statusNode=document.getElementById('result');
   document.getElementById('export').onclick=()=>{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob(['SYNTHETIC EXPORT'],{type:'text/plain'}));link.download='synthetic-helper-export.txt';link.click();};
   document.getElementById('fill').onclick=async()=>{try{statusNode.textContent=await triggerSlash('/setinput SYNTHETIC filled');}catch(error){statusNode.textContent='ERROR:'+error.message;}};
   document.getElementById('send').onclick=async()=>{try{statusNode.textContent='OK:'+await triggerSlash('/send SYNTHETIC native button | plain|/trigger');}catch(error){statusNode.textContent='ERROR:'+error.message;}};
   eventOn('synthetic-ui-event',value=>{document.body.dataset.event=value;});
   document.getElementById('vars').onclick=async()=>{replaceVariables({syntheticCounter:42},{type:'chat'});await parent.LiyuanTavernPlugins.host.flush();statusNode.textContent='VARIABLES:'+getVariables({type:'chat'}).syntheticCounter;};
   </script></body></html>`;
     // Web dependencies are only required when explicit original fixtures enable this test.
   const { build } = await import("../web/node_modules/esbuild/lib/main.js");
   const bundle = await build({ stdin: { resolveDir: join(root, "web"), loader: "tsx", contents: `import React from'react';import{createRoot}from'react-dom/client';import{TavernMessageFrame,TavernEntryContext}from'./src/components/TavernMessageFrame.tsx';import{registerTavernChatBridge}from'./src/tavernShim.ts';window.__submitted=[];window.__input='';window.__refuse=false;registerTavernChatBridge({getInput:()=>window.__input,setInput:value=>window.__input=value,sendPrompt:value=>{if(window.__refuse)return{accepted:false,reason:'Synthetic outbox refusal'};window.__submitted.push(value);return{accepted:true};}});createRoot(document.getElementById('root')).render(<TavernEntryContext.Provider value={{entryId:'reply',entryScope:${JSON.stringify(scope)}}}><TavernMessageFrame html={${JSON.stringify(html)}}><div>STATIC</div></TavernMessageFrame></TavernEntryContext.Provider>);` }, bundle: true, format: "esm", jsx: "automatic", write: false, loader: { ".css": "empty" }, logLevel: "silent" });
  server = createServer((req, res) => { void (async () => {
   const path = new URL(req.url!, "http://localhost").pathname;
   if (path === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>'); }
   if (path === "/fixture.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(bundle.outputFiles[0].text); }
   if (path === "/api/tavern-plugins/status") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ...status, runtimeEnabled: true })); }
   if (path === "/tavern-plugin-host.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(await readFile(join(root, "web/public/tavern-plugin-host.html"))); }
   if (!await api.handle(req, res)) { res.writeHead(404); res.end(); }
  })().catch(error => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const binary = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE, libs = process.env.LIYUAN_DATABASE_BROWSER_LIBS;
  browser = await chromium.launch({ headless: true, ...(binary ? { executablePath: binary } : {}), env: { ...process.env, ...(libs ? { LD_LIBRARY_PATH: libs } : {}) }, args: ["--no-sandbox"] });
  const browserContext = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  await browserContext.route("**/*", route => {
   const url = new URL(route.request().url());
   if (url.origin === base) return route.continue();
   if (url.pathname.endsWith(".css")) return route.fulfill({ contentType: "text/css", body: "" });
   external.push(url.href); return route.abort();
  });
  const page = await browserContext.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", error => errors.push(error.message));
  stage="navigate"; await page.goto(base);
  const host = page.frameLocator('iframe[title="原酒馆插件交互显示"]'), native = host.frameLocator('iframe[id^="TH-message--"]');
  stage="native-widget"; await native.locator("#send").waitFor();
  for (const width of [1280, 390, 320]) {
   await page.setViewportSize({ width, height: 900 });
   await native.locator("#fill").click(); await page.waitForFunction(() => (window as any).__input === "SYNTHETIC filled").catch(async error => { console.log("NATIVE FILL DIAGNOSTIC", { result: await native.locator("#result").innerText(), parent: await page.evaluate(() => ({input: (window as any).__input, sent: (window as any).__submitted})), errors }); throw error; });
   await native.locator("#send").click(); await native.locator("#result").filter({ hasText: "OK:SYNTHETIC native button | plain" }).waitFor();
  }
  assert.deepEqual(await page.evaluate(() => (window as any).__submitted), Array(3).fill("SYNTHETIC native button | plain"));
  await page.evaluate(() => { (window as any).__refuse = true; }); await native.locator("#send").click(); await native.locator("#result").filter({ hasText: "ERROR:Synthetic outbox refusal" }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).__submitted.length), 3);
  await native.locator("#vars").click(); await native.locator("#result").filter({ hasText: "VARIABLES:42" }).waitFor();
  assert.equal((api.store.read(context).state.chatMetadata.variables as any).syntheticCounter, 42);
  stage="native-read-apis";
  const frame = page.frames().find(frame => frame.url().includes("/tavern-plugin-host.html"))!;
  const nativeMessage=page.frames().find(frame=>frame.name().startsWith('TH-message--'))!;
  assert.equal(await nativeMessage.evaluate(()=>(window as any).retrieveDisplayedMessage((window as any).getCurrentMessageId()).find('iframe[id^="TH-message--"]').length),1,'displayed-message API reads its own native host, not the unrelated App document');
  const probe = await frame.evaluate(async () => {
   const helper = (window as any).TavernHelper, h = (window as any).LiyuanTavernPlugins.host;
   const macros = await import("/tavern-compat/scripts/macros.js");
   const vars = helper.getVariables({ type: "chat" });
   const world = await helper.getWorldbook("Synthetic-Readonly");
   const preset = helper.getLoadedPresetName();
   const persona = helper.getPersona('current'), character = await helper.getCharacter('current');
   if(persona.name !== h.context.userName || persona.description !== h.context.userPersona || !Array.isArray(character.first_messages)) throw Error('Current identity projection mismatch');
   const install = await helper.getExtensionStatus(helper.getTavernHelperExtensionId());
   const manager = (await import('/tavern-compat/scripts/preset-manager.js')).getPresetManager();
   let presetBlocked=false;try{await manager.savePreset(h.presets[0].name,{...h.presets[0],prompts:[{content:'SYNTHETIC forbidden preset edit'}]});}catch(error){presetBlocked=String((error as Error).message).includes('生产预设');}
   if(!presetBlocked)throw Error('Preset mutation was silently accepted');

   if(!helper.isInstalledExtension(helper.getTavernHelperExtensionId()) || !/^[a-f0-9]{40}$/.test(install.current_commit_hash) || 'is_up_to_date' in install) throw Error('Pinned extension status mismatch');
   const messages = helper.getChatMessages("0-1");
   if(helper.formatAsTavernRegexedString('SYNTHETIC_REGEX','ai_output','display') !== 'REGEX_APPLIED') throw Error('Native display regex was not applied');
   const capabilities: Record<string, string> = {};
   const checks: Record<string, () => unknown> = {
    audioRead: () => helper.getAudioSettings('bgm'), audioList: () => helper.getAudioList('bgm'),
    characterNames: () => helper.getCharacterNames(), characterRead: () => helper.getCharacter('current'),
    personaRead: () => helper.getPersona('current'), presetRead: () => helper.getPreset('in_use'),
    scriptsRead: () => helper.getScriptTrees({type:'global'}), regexRead: () => helper.getTavernRegexes({type:'global'}),
    regexFormat: () => helper.formatAsTavernRegexedString('SYNTHETIC','ai_output','display'),
    displayedFormat: () => helper.formatAsDisplayedMessage('SYNTHETIC',{message_id:'last_user'}),
    worldbookNames: () => helper.getWorldbookNames(), boundWorldbooks: () => helper.getCharWorldbookNames('current'),
    extensionRead: () => helper.getExtensionStatus(helper.getTavernHelperExtensionId()),
   };
   for(const [name,check] of Object.entries(checks)){try{await check();capabilities[name]='returned';}catch(error){capabilities[name]=String((error as Error).message).slice(0,200);}}

   await helper._bind._eventEmit.call(window, "synthetic-ui-event", "received");
   return { capabilities, version: helper.getTavernHelperVersion(), exported: Object.keys(helper).filter(key => !key.startsWith("_")).length, filtered: macros.getLastMessageId({ filter: (row: any) => row.is_user }), empty: macros.getLastMessageId({ filter: () => false }), vars: vars.syntheticCounter, world: world.length, preset, messages: messages.length, headersBound: h.getContext().getRequestHeaders()["x-liyuan-tavern-scope"] === h.context.scopeKey };
  });
  const downloaded = page.waitForEvent("download"); await native.locator("#export").click(); const download = await downloaded; assert.equal(download.suggestedFilename(), "synthetic-helper-export.txt"); assert.equal(await download.failure(), null);
  assert.ok(Object.values(probe.capabilities).every(value => value === "returned"), JSON.stringify(probe.capabilities));
  assert.equal(probe.version, "4.11.3"); assert.ok(probe.exported >= 150); assert.equal(probe.filtered, 0); assert.equal(probe.empty, null); assert.equal(probe.vars, 42); assert.equal(probe.world, 1); assert.equal(probe.messages, 2); assert.ok(probe.preset); assert.equal(probe.headersBound, true);
  assert.equal(await native.locator("body").getAttribute("data-event"), "received");
  stage="native-candidate"; candidateAllowed=true;
  assert.equal(await frame.evaluate(()=>(window as any).TavernHelper.generateRaw({user_input:'SYNTHETIC_CANDIDATE',ordered_prompts:[{role:'user',content:'SYNTHETIC_CANDIDATE'}],should_stream:false})),'SYNTHETIC CANDIDATE');
  stage="native-cancel"; await frame.evaluate(()=>{const helper=(window as any).TavernHelper;(window as any).__cancelOutcome=helper.generateRaw({generation_id:'synthetic-cancel',user_input:'SYNTHETIC_CANCEL',ordered_prompts:[{role:'user',content:'SYNTHETIC_CANCEL'}],should_stream:false}).then(()=>false,()=>true);});
  for(let count=0;count<100&&!calls.some(text=>text.includes('SYNTHETIC_CANCEL'));count++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls.some(text=>text.includes('SYNTHETIC_CANCEL')),true);await frame.evaluate(()=>(window as any).TavernHelper.stopGenerationById('synthetic-cancel'));
  assert.equal(await frame.evaluate(()=>(window as any).__cancelOutcome),true);
  for(let count=0;count<100&&!cancelled;count++)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(cancelled,true,'native stop cancels the in-flight host request');
  const beforeUnsupported=calls.length;
  await assert.rejects(()=>frame.evaluate(()=>(window as any).TavernHelper.generateRaw({user_input:'SYNTHETIC_TOOLS',ordered_prompts:[{role:'user',content:'SYNTHETIC_TOOLS'}],should_stream:false,tools:[{type:'function',function:{name:'synthetic_tool',description:'Synthetic only',parameters:{type:'object',properties:{}}}}]})),/工具或结构化输出/);
  assert.equal(calls.length,beforeUnsupported,'unsupported native tool requests cannot silently bill a text-only request');
  candidateAllowed=false;
  context.sourceEntryId = "new-source"; context.visibleEntryIds.push("new-source");
  await native.locator("#send").click(); await native.locator("#result").filter({ hasText: "ERROR:" }).waitFor(); assert.equal(await page.evaluate(() => (window as any).__submitted.length), 3);
  context.sourceEntryId = "reply"; context.visibleEntryIds.pop(); assert.equal(JSON.stringify(context), canonical);
  assert.equal(calls.length, 2); assert.equal(calls.includes("unexpected model request"), false); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  console.log("Original helper API probe:", JSON.stringify(probe));
  api.sources.close(); api.fallbackSources.close();
 } catch(error) {console.error("NATIVE API DIAGNOSTIC",stage,(error as Error).message,JSON.stringify({errors,calls: calls.length,cancelled}));throw error;} finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve)); } await rm(cwd, { recursive: true, force: true }); }
});
