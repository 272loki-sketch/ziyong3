/** Opt-in integration using installed original plugin assets, synthetic stories/UI only.
 * All persisted state is temporary; external resources are served from verified assets.
 * No production card, variables, endpoints or model settings are loaded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { TavernPluginHttp } from "../server/tavern-plugin-http.ts";
import { TavernPluginSources } from "../server/tavern-plugin-source.ts";
import { syntheticTavernPluginContext } from "../server/tavern-plugin-runtime.ts";
import { mvuStatus } from "../server/mvu-assets.ts";
import { mvuDisplaySuffixes } from "../server/mvu-display.ts";
import { toWireHistory } from "../server/wire.ts";
import { splitRichContentParts } from "../web/src/richContentParts.ts";

const assets = process.env.LIYUAN_MVU_UI_FIXTURES;
test("original MVU processing → durable receipt → wire regex → original-helper interactive frame",{skip:!assets,timeout:120000},async()=>{
 const root=process.cwd(),cwd=await mkdtemp(join(tmpdir(),"liyuan-mvu-card-ui-"));let browser,server;
 const errors:string[]=[],blocked:string[]=[],modelCalls:string[]=[];let contextReads=0;
 try {
  assert.equal(mvuStatus(assets!).installed,true,"explicit verified original MVU assets required");
  const context=syntheticTavernPluginContext();
  context.readonlyBooks={};context.character={name:"Synthetic character",avatar:"synthetic.png",data:{name:"Synthetic character",extensions:{tavern_helper:{scripts:[{type:'script',enabled:true,id:'synthetic-disabled-container',name:'Synthetic embedded automation',content:'window.parent.__syntheticUnexpectedAutomation=true;'}]}}}};
  const data={stat_data:{ability:23,relationship:"synthetic classmate"},initialized_lorebooks:{},schema:{type:"object",properties:{ability:{type:"number"},relationship:{type:"string"}}}};
  context.chat[0].variables=[structuredClone(data)];
  const author='<content>SYNTHETIC FACTS</content><UpdateVariable><JSONPatch>[{"op":"replace","path":"/ability","value":37}]</JSONPatch></UpdateVariable>';
  context.chat.push({__liyuanEntryId:"reply",is_user:false,name:"Synthetic character",mes:"SYNTHETIC FACTS",__liyuanAuthorDelivery:author,variables:[structuredClone(data)],swipe_id:0,extra:{}});
  context.sourceEntryId="reply";context.visibleEntryIds.push("reply");
  const canonical=JSON.stringify(context);
  const api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>false,generate:async()=>{modelCalls.push("unexpected");throw Error("No model permitted");}},assets);
  api.fallbackSources=new TavernPluginSources(assets!);
  const installedStatus=api.fallbackSources.status();api.fallbackSources.status=()=>({...installedStatus,plugins:installedStatus.plugins.filter(plugin=>plugin.id==='helper')});
  const original=api.store.read(context);for(const message of context.chat)original.state.messages[String(message.__liyuanEntryId)]={variables:structuredClone(message.variables)};
  api.store.save(context,original.revision,original.state,()=>{});
  server=createServer((req,res)=>{void(async()=>{if(req.url==='/api/tavern-plugins/context')contextReads++;if(req.url?.startsWith('/tavern-plugin-host.html')){res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(join(root,'web/public/tavern-plugin-host.html')));return;}if(!await api.handle(req,res)){res.writeHead(404);res.end();}})().catch(error=>{res.writeHead(500);res.end(String(error));});});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const binary=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,libs=process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH;
  browser=await chromium.launch({headless:true,...(binary?{executablePath:binary}:{}),env:{...process.env,...(libs?{LD_LIBRARY_PATH:libs}:{})},args:['--no-sandbox']});
  const bc=await browser.newContext({serviceWorkers:'block'});
  await bc.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),binding=api.binding();
   const headers={...req.headers(),'x-liyuan-tavern-host':api.internalToken,'x-liyuan-tavern-scope':binding.scopeKey,'x-liyuan-tavern-source':binding.sourceEntryId,'x-liyuan-tavern-turn':api.turnNonce};
   if(url.origin===base)return route.continue({headers});
   // Cosmetic upstream CSS is irrelevant to the synthetic UI. No external requests.
   if(url.pathname.endsWith('.css'))return route.fulfill({contentType:'text/css',body:''});
   blocked.push(url.href);return route.abort();
  });
  const page=await bc.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
  await page.goto(base+'/tavern-plugin-host.html?view=render&entryId=reply&scopeKey='+api.binding().scopeKey);
  await page.waitForFunction(()=> (window as any).LiyuanTavernPlugins?.ready());
  assert.equal(await page.getByRole('dialog').count(),0,'render realm never covers the supplied UI with an enable-automation prompt');
  const native=await page.evaluate(async()=>{const w=window as any,h=w.LiyuanTavernPlugins,message=h.host.chat[1],seen:string[]=[];let mes=message.mes;Object.defineProperty(message,'mes',{configurable:true,enumerable:true,get:()=>mes,set:value=>{seen.push(value);mes=value;}});await h.after();await new Promise(resolve=>setTimeout(resolve,350));await h.host.flush();return {nativeMarker:seen.some(text=>text.endsWith('\n\n<StatusPlaceHolderImpl/>')),mes:h.host.chat[1].mes,ability:w.TavernHelper.getVariables({type:'message',message_id:1}).stat_data.ability,errors:h.status().errors};});
  assert.equal(native.mes,'SYNTHETIC FACTS',"native display mutation does not replace the story");assert.equal(native.ability,37);assert.equal(native.nativeMarker,true,'unmodified native MVU emitted the same display protocol');assert.deepEqual(native.errors,[]);
  const saved=api.store.read(context),before=JSON.stringify(saved),suffixes=mvuDisplaySuffixes(context,saved.state,true);
  assert.equal(suffixes.get('reply'),'\n\n<StatusPlaceHolderImpl/>');
  const widget='```html\n<html><head><style>body{margin:0;font:16px sans-serif}button{padding:12px}.panel[hidden]{display:none}</style></head><body><button id="ability-tab">Ability</button><button id="relation-tab">Relationship</button><section id="ability" class="panel"></section><section id="relationship" class="panel" hidden></section><script type="module">await waitGlobalInitialized("Mvu");window.__syntheticUiInstance=Math.random();window.__syntheticRefreshes=0;const populate=()=>{const data=getAllVariables().stat_data;document.getElementById("ability").textContent="ABILITY="+data.ability;document.getElementById("relationship").textContent=data.relationship;};populate();eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,()=>{window.__syntheticRefreshes++;populate();});document.getElementById("ability-tab").onclick=()=>{ability.hidden=false;relationship.hidden=true};document.getElementById("relation-tab").onclick=()=>{ability.hidden=true;relationship.hidden=false};</script></body></html>\n```';
  const skin={charName:'Synthetic character',userName:'Synthetic user',rules:[{name:'Synthetic supplied UI',source:'<StatusPlaceHolderImpl/>',flags:'g',replace:widget,maxDepth:3}]};
  const wire=toWireHistory([{role:'assistant',content:'SYNTHETIC FACTS',details:{rpEntryId:'reply',rpGenerationMode:'direct',rpNarrative:'SYNTHETIC FACTS',rpAuthorDraft:author}}],skin,{skin,displaySuffixes:suffixes})[0];
  assert.equal(JSON.stringify(api.store.read(context)),before,'projection alone never saves plugin state');assert.equal(wire.authorDelivery,author);assert.doesNotMatch(wire.text,/StatusPlaceHolderImpl/);
  const html=splitRichContentParts(wire.text,skin).find(part=>part.kind==='html'&&part.html.includes('ability-tab'));
  assert.ok(html?.kind==='html'&&html.scripts);
  await page.evaluate(async html=>{await (window as any).LiyuanTavernPlugins.renderHtml(html,1);},html.html);
  const frame=page.frameLocator('iframe[id^="TH-message--"]').first();await frame.locator('#ability').waitFor();assert.equal(await page.getByRole('dialog').count(),0,(await page.getByRole('dialog').allTextContents()).join(' | '));
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:900});await frame.locator('#ability-tab').click();assert.equal(await frame.locator('#ability').innerText(),'ABILITY=37');
   await frame.locator('#relation-tab').click();assert.equal(await frame.locator('#relationship').innerText(),'synthetic classmate');assert.equal(await frame.locator('#ability').isVisible(),false);
   await frame.locator('#ability-tab').click();assert.equal(await frame.locator('#ability').isVisible(),true);
  }
  const after=api.store.read(context);assert.deepEqual(after.state.messages,saved.state.messages,'display never repeats variable updates');assert.deepEqual(after.state.chatMetadata.__liyuanMvuProcessed,saved.state.chatMetadata.__liyuanMvuProcessed,'display never creates a new processing receipt');
  assert.equal((await page.evaluate(()=>(window as any).__syntheticUnexpectedAutomation)),undefined);assert.deepEqual(after.state.extensionSettings.tavern_helper?.script.enabled.characters,[]);assert.ok(!after.state.extensionSettings.tavern_helper?.script.popuped?.characters?.includes('synthetic.png'),'render-only consent is not persisted');
  // Author-ready can mount the original UI before backend MVU settlement.
  // A later saved snapshot must update this SAME iframe via native display
  // callbacks, not chat/render/parser hooks or another script execution.
  await frame.locator('#relation-tab').click();
  const nativeFrame=page.frames().find(candidate=>candidate!==page.mainFrame()&&candidate.url()==='about:srcdoc'&&candidate.name().startsWith('TH-message--'))!;
  assert.ok(nativeFrame);const instance=await nativeFrame.evaluate(()=>(window as any).__syntheticUiInstance);
  await page.evaluate(async()=>{const w=window as any;w.__syntheticUnexpectedLifecycle=[];const bridge=await import(String('/tavern-compat/bridge.js'));for(const event of [w.Mvu.events.VARIABLE_UPDATE_ENDED,w.Mvu.events.COMMAND_PARSED,bridge.event_types.CHAT_CHANGED,bridge.event_types.CHARACTER_MESSAGE_RENDERED,bridge.event_types.MESSAGE_RECEIVED,bridge.event_types.GENERATION_ENDED])bridge.eventSource.on(event,()=>w.__syntheticUnexpectedLifecycle.push(event));});
  const changed=structuredClone(after.state),slot=(changed.messages.reply.variables as any[])[0];slot.stat_data.ability=81;slot.stat_data.relationship='synthetic updated relationship';
  api.store.save(context,after.revision,changed,()=>{});const savedUpdate=JSON.stringify(api.store.read(context)),readsBefore=contextReads;
  await page.evaluate(scope=>window.postMessage({type:'liyuan-tavern-refresh-state',entryId:'other',entryScope:scope,requestId:1},location.origin),api.binding().scopeKey);
  await page.waitForTimeout(100);assert.equal(contextReads,readsBefore,'foreign entry cannot even fetch a snapshot');
  const refresh=()=>page.evaluate(scope=>window.postMessage({type:'liyuan-tavern-refresh-state',entryId:'reply',entryScope:scope,requestId:2},location.origin),api.binding().scopeKey);
  await refresh();await frame.locator('#relationship').filter({hasText:'synthetic updated relationship'}).waitFor();
  assert.equal(await frame.locator('#ability').innerText(),'ABILITY=81');assert.equal(await frame.locator('#relationship').isVisible(),true,'selected native tab is preserved');
  assert.equal(await nativeFrame.evaluate(()=>(window as any).__syntheticUiInstance),instance,'original iframe is not recreated');assert.equal(await nativeFrame.evaluate(()=>(window as any).__syntheticRefreshes),1);
  await refresh();await page.waitForTimeout(150);assert.equal(await nativeFrame.evaluate(()=>(window as any).__syntheticRefreshes),1,'duplicate revision does not repeat callbacks');
  assert.equal(JSON.stringify(api.store.read(context)),savedUpdate,'read-only refresh does not save normalized state or repeat MVU');
  assert.deepEqual(await page.evaluate(()=>(window as any).__syntheticUnexpectedLifecycle),[],'global/MVU/automation listeners are not replayed for a display refresh');
  await nativeFrame.evaluate(()=>{const w=window as any;w.__syntheticRetry=0;w.eventOn(w.Mvu.events.VARIABLE_UPDATE_ENDED,()=>{if(++w.__syntheticRetry===1)throw Error('SYNTHETIC_DISPLAY_CALLBACK_FAILURE');});});
  const retryState=api.store.read(context);(retryState.state.messages.reply.variables as any[])[0].stat_data.ability=82;api.store.save(context,retryState.revision,retryState.state,()=>{});
  await refresh();await nativeFrame.waitForFunction(()=>(window as any).__syntheticRetry===1);assert.equal(await nativeFrame.evaluate(()=>(window as any).__syntheticRefreshes),2);
  await refresh();await nativeFrame.waitForFunction(()=>(window as any).__syntheticRetry===2);assert.equal(await nativeFrame.evaluate(()=>(window as any).__syntheticRefreshes),2,'retry only repeats the failed display callback');
  assert.equal(await frame.locator('#ability').innerText(),'ABILITY=82');

  assert.equal(await page.evaluate(()=>(window as any).LiyuanTavernPlugins.host.chat[1].mes),'SYNTHETIC FACTS');
  // Opening original settings for an installed but globally disabled helper
  // is only a manager-local preview. Resource adaptation must precede import.
  api.fallbackSources.status=()=>({...installedStatus,plugins:installedStatus.plugins.filter(plugin=>plugin.id==='helper').map(plugin=>({...plugin,enabled:false}))});
  const manager=await bc.newPage();manager.on('pageerror',error=>errors.push(error.message));await manager.goto(base+'/tavern-plugin-host.html?view=manager&plugin=helper&network=isolated');await manager.waitForFunction(()=>(window as any).LiyuanTavernPlugins?.ready());
  assert.equal(await manager.locator('#tavern_helper').count(),1);assert.equal(api.fallbackSources.status().plugins[0].enabled,false,'manager preview never enables production configuration');
  const disabledMvu=await bc.newPage(),expectedErrors:string[]=[];disabledMvu.on('pageerror',error=>expectedErrors.push(error.message));await disabledMvu.goto(base+'/tavern-plugin-host.html?view=manager&plugin=helper&focus=mvu&network=isolated');await disabledMvu.locator('#status').filter({hasText:'请先启用已校验'}).waitFor({state:'attached'});assert.equal(await disabledMvu.evaluate(()=>!!(window as any).TavernHelper),false,'MVU manager cannot pretend a disabled helper is enabled');assert.ok(expectedErrors.some(error=>error.includes('请先启用已校验')));

  assert.equal(JSON.stringify(context),canonical);assert.deepEqual(modelCalls,[]);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
 } finally {await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}await rm(cwd,{recursive:true,force:true});}
});

test('author-ready original UI receives later native-runtime settlement without restarting either realm',{skip:!assets,timeout:120000},async()=>{
 const root=process.cwd(),cwd=await mkdtemp(join(tmpdir(),'liyuan-mvu-live-settlement-'));let browser,server;
 const errors:string[]=[],blocked:string[]=[],modelCalls:string[]=[];
 try{
  const context=syntheticTavernPluginContext();context.readonlyBooks={};context.character={name:'Synthetic character',avatar:'synthetic.png',data:{extensions:{}}};
  const data={stat_data:{ability:23,relationship:'synthetic classmate'},initialized_lorebooks:{},schema:{type:'object',properties:{ability:{type:'number'},relationship:{type:'string'}}}};context.chat[0].variables=[structuredClone(data)];
  context.chat.push({__liyuanEntryId:'reply',is_user:false,mes:'SYNTHETIC SAVED STORY',name:'Synthetic character',__liyuanAuthorDelivery:'<content>SYNTHETIC SAVED STORY</content><UpdateVariable><JSONPatch>[{"op":"replace","path":"/ability","value":62}]</JSONPatch></UpdateVariable>',variables:[structuredClone(data)],swipe_id:0,extra:{}});context.sourceEntryId='reply';context.visibleEntryIds.push('reply');
  const api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>false,generate:async()=>{modelCalls.push('unexpected');throw Error('No model permitted');}},assets);api.fallbackSources=new TavernPluginSources(assets!);const status=api.fallbackSources.status();assert.equal(status.plugins.find(plugin=>plugin.id==='template')?.installed,true,'explicit original template assets required for the combined lifecycle test');api.fallbackSources.status=()=>status;
  const initial=api.store.read(context);for(const message of context.chat)initial.state.messages[String(message.__liyuanEntryId)]={variables:structuredClone(message.variables)};api.store.save(context,initial.revision,initial.state,()=>{});
  server=createServer((req,res)=>{void(async()=>{if(req.url?.startsWith('/tavern-plugin-host.html')){res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(join(root,'web/public/tavern-plugin-host.html')));return;}if(!await api.handle(req,res)){res.writeHead(404);res.end();}})().catch(error=>{res.writeHead(500);res.end(String(error));});});await new Promise<void>(ok=>server!.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH},args:['--no-sandbox']});const bc=await browser.newContext({serviceWorkers:'block'});
  await bc.route('**/*',route=>{const request=route.request(),url=new URL(request.url()),binding=api.binding();if(url.origin===base)return route.continue({headers:{...request.headers(),'x-liyuan-tavern-host':api.internalToken,'x-liyuan-tavern-scope':binding.scopeKey,'x-liyuan-tavern-source':binding.sourceEntryId,'x-liyuan-tavern-turn':api.turnNonce}});if(url.pathname.endsWith('.css'))return route.fulfill({body:'',contentType:'text/css'});blocked.push(url.href);return route.abort();});
  const display=await bc.newPage();display.on('pageerror',e=>errors.push(e.message));await display.goto(base+'/tavern-plugin-host.html?view=render&entryId=reply&scopeKey='+api.binding().scopeKey);await display.waitForFunction(()=>(window as any).LiyuanTavernPlugins?.ready());
  await display.evaluate(async()=>{const w=window as any;w.__syntheticRefreshFailures=[];w.addEventListener('message',(e:MessageEvent)=>{if(e.data?.type==='liyuan-tavern-state-refresh-error')w.__syntheticRefreshFailures.push(e.data.error);});window.postMessage({type:'liyuan-tavern-render',entryId:'reply',html:'<html><body><button id="tab">Relationship</button><section id="panel" hidden>CLASSMATE</section><div id="value">pending</div><script type="module">window.instance=Math.random();await waitGlobalInitialized("Mvu");const populate=()=>document.getElementById("value").textContent="ABILITY="+getAllVariables().stat_data.ability;populate();eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,populate);document.getElementById("tab").onclick=()=>document.getElementById("panel").hidden=false;</script></body></html>'},location.origin);});
  const widget=display.frameLocator('iframe[id^="TH-message--"]').first();await widget.locator('#value').filter({hasText:'ABILITY=23'}).waitFor();await widget.locator('#tab').click();const nativeFrame=display.frames().find(frame=>frame!==display.mainFrame()&&frame.name().startsWith('TH-message--'))!,instance=await nativeFrame.evaluate(()=>(window as any).instance);
  const backend=await bc.newPage();backend.on('pageerror',e=>errors.push(e.message));await backend.goto(base+'/tavern-plugin-host.html?view=runtime');await backend.waitForFunction(()=>(window as any).LiyuanTavernPlugins?.ready());await backend.evaluate(async()=>{const h=(window as any).LiyuanTavernPlugins;await h.after();await new Promise(ok=>setTimeout(ok,350));await h.host.flush();});
  await display.waitForTimeout(100);assert.equal(await display.evaluate(()=>{const h=(window as any).LiyuanTavernPlugins.host;return JSON.stringify(h.state())===h.persistedStateJSON;}),true,'deferred original-template accounting is local bootstrap, not an unsaved edit');
  const settled=api.store.read(context);assert.equal((settled.state.messages.reply.variables as any[])[0].stat_data.ability,62);assert.equal(await widget.locator('#value').innerText(),'ABILITY=23','separate render realm still has the author-ready snapshot until notified');
  await display.evaluate(scope=>window.postMessage({type:'liyuan-tavern-refresh-state',entryId:'reply',entryScope:scope,requestId:1},location.origin),api.binding().scopeKey);
  await display.waitForTimeout(200);const refreshFailure=await display.evaluate(()=>(window as any).__syntheticRefreshFailures);assert.deepEqual(refreshFailure,[]);
  await widget.locator('#value').filter({hasText:'ABILITY=62'}).waitFor({timeout:5000});assert.deepEqual(await display.evaluate(()=>(window as any).__syntheticRefreshFailures),[]);assert.equal(await nativeFrame.evaluate(()=>(window as any).instance),instance);assert.equal(await widget.locator('#panel').isVisible(),true);await display.evaluate(()=>(window as any).LiyuanTavernPlugins.host.flush());assert.deepEqual(api.store.read(context),settled,'display sync makes no new persistence/processing receipt');assert.deepEqual(modelCalls,[]);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(ok=>server!.close(()=>ok()));}await rm(cwd,{recursive:true,force:true});}
});
