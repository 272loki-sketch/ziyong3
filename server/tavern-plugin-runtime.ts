import {mvuAssetMap,mvuAsset,mvuStatus} from "./mvu-assets.ts";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAVERN_CDN_ASSETS } from "./tavern-plugin-cdn.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
// @ts-ignore Shared browser projection has no TypeScript declaration.
import { mvuParsingProjection, mvuParseSource } from "../web/public/tavern-compat/mvu-adapter.js";
import { TavernPluginHttp, type TavernPluginContext } from "./tavern-plugin-http.ts";
import { TavernPluginSources, type TavernPluginCandidate } from "./tavern-plugin-source.ts";
export interface TavernPreparedPrompt {systemPrompt:string;messages:unknown[];worldbookEntries?:Array<{source?:string;uid:number;entryKey?:string;comment:string;content:string;enabled:boolean}>;card?:string;retainedWorldbookIndices?:number[]}
function untilAbort<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return work;
 return new Promise<T>((resolve,reject)=>{
  const onAbort=()=>{work.catch(()=>{});reject(new Error('插件任务已取消'));};
  if(signal.aborted){onAbort();return;}
  signal.addEventListener('abort',onAbort,{once:true});
  work.then(value=>{signal.removeEventListener('abort',onAbort);resolve(value);},error=>{signal.removeEventListener('abort',onAbort);reject(error);});
 });
}
export class TavernPluginRuntime {
 private browser:Browser|null=null;private page:Page|null=null;private key="";private browserKey="";private queue:Promise<unknown>=Promise.resolve();private active=0;
 // Bumped by close(): an ensure() that started earlier must not install its browser/page afterwards.
 private epoch=0;
 readonly http:TavernPluginHttp;readonly origin:()=>string;
 constructor(http:TavernPluginHttp,origin:()=>string){this.http=http;this.origin=origin;}
 enabled(){this.http.sources.config();const plugins=this.http.sources.status().plugins;const invalid=plugins.find(p=>p.enabled&&!p.installed);if(invalid)throw new Error('已启用原插件不可用或完整性校验失败，未发送作者请求：'+invalid.name);return plugins.some(p=>p.enabled&&p.installed);}
 busy(){return this.active>0;}
 async close(invalidateTurn=true){this.epoch++;if(invalidateTurn)this.http.turnSignal=undefined;await this.discard();}
 private async discard(){const browser=this.browser;this.browser=null;this.page=null;this.key="";this.browserKey="";await browser?.close();}
  private async ensure(mvuRetry=false){
   const epoch=this.epoch,stale=()=>{if(this.epoch!==epoch)throw new Error('插件任务已取消');};
  const binding=this.http.binding(),turnNonce=this.http.turnNonce,fingerprint=this.http.sources.status().plugins.map(p=>`${p.id}:${p.enabled}:${p.commit}`).join('|'),key=`${binding.scopeKey}:${binding.sourceEntryId}:${fingerprint}:${mvuStatus(this.http.assetsCwd).enabled}:${this.http.turnNonce}`;
   // Reuse the browser process, not a realm whose native callbacks retain an old source/nonce.
   const browserKey=`${binding.scopeKey}:${fingerprint}:${mvuStatus(this.http.assetsCwd).enabled}`;
   if(this.page&&!this.page.isClosed()&&this.key===key)return this.page;
   if(!this.browser?.isConnected()||this.browserKey!==browserKey)await this.discard();
   else {const page=this.page;this.page=null;this.key="";await page?.context().close();}
   stale();
  const binary=join(this.http.assetsCwd,".liyuan-database-plugin/browser/headless_shell"),libs=join(this.http.assetsCwd,".liyuan-database-plugin/browser-libs/lib64");
  const executablePath=process.env.LIYUAN_TAVERN_BROWSER_EXECUTABLE??process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE??(existsSync(binary)?binary:undefined);
   // Private computation pages must not enter GPU frame-sink recovery when private ANGLE libraries are inaccessible.
    if(!this.browser){
     const launched=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_TAVERN_BROWSER_LIBS??process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH??(existsSync(libs)?libs:'')},args:['--disable-gpu',...(process.getuid?.()===0?['--no-sandbox']:[])]});
     // A close() (turn abort/deadline) during launch must not leave an orphan browser installed for the next turn.
     if(this.epoch!==epoch){await launched.close().catch(()=>{});stale();}
     this.browser=launched;
    }
   this.browserKey=browserKey;
  const context=await this.browser.newContext({serviceWorkers:"block"});stale();
  await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());const mapped: string | undefined=({...TAVERN_CDN_ASSETS,...mvuAssetMap(this.http.assetsCwd)} as Record<string, string>)[url.href];if(mapped){const file=mapped.startsWith('/tavern-compat/mvu/')?mvuAsset(this.http.assetsCwd,mapped.split('/').at(-1)!):mapped.includes('/vendor/')?this.http.assetsCwd+'/.liyuan-tavern-plugins/vendor/'+mapped.split('/').at(-1):this.http.resolveOriginalAsset(mapped);if(!file)return route.abort();return route.fulfill({status:200,contentType:'text/javascript',body:readFileSync(file),headers:{'access-control-allow-origin':'*'}});}if(url.origin!==this.origin()||(!url.pathname.startsWith('/tavern-compat/')&&!url.pathname.startsWith('/api/tavern-plugins/')&&url.pathname!=='/tavern-plugin-host.html'&&url.pathname!=='/version'&&!url.pathname.startsWith('/scripts/extensions/third-party/JS-Slash-Runner/')))return route.abort('blockedbyclient');return route.continue({headers:{...req.headers(),'x-liyuan-tavern-host':this.http.internalToken,'x-liyuan-tavern-scope':binding.scopeKey,'x-liyuan-tavern-source':binding.sourceEntryId,'x-liyuan-tavern-turn':turnNonce}});});
   const page=await context.newPage();if(this.epoch!==epoch){await context.close().catch(()=>{});stale();}
   this.page=page;page.on('dialog',d=>{void d.dismiss();});
   // Use the local page: an abandoned ensure must never drive a page installed by a later turn.
   await page.goto(this.origin()+'/tavern-plugin-host.html?view=runtime'+(mvuRetry?'&mvuRetry=1':''));
  try{await page.waitForFunction(()=>!!(window as any).LiyuanTavernPlugins?.ready(),{},{timeout:45_000});}
  catch{const status=await page.evaluate(()=>document.getElementById('status')?.textContent??'').catch(()=> '');throw new Error('原酒馆插件加载未完成：'+status);}
   stale();this.http.assertBinding(binding.scopeKey,binding.sourceEntryId);this.key=key;return page;
 }
   private async owned<T>(work:(page:Page)=>Promise<T>,signal?:AbortSignal,sourceEntryId?:string,expected?:{scopeKey:string;sourceEntryId:string},mvuRetry=false):Promise<T>{
  const job=this.queue.then(async()=>{
    if(signal?.aborted)throw new Error('插件任务已取消');if(expected)this.http.assertBinding(expected.scopeKey,expected.sourceEntryId);if(mvuRetry&&sourceEntryId)this.http.mvuRecovery={head:this.http.binding(),sourceEntryId};this.http.turnSignal=signal;this.active++;this.http.boundSourceEntryId=sourceEntryId;
   const stop=()=>{void this.close();};signal?.addEventListener('abort',stop,{once:true});
   // Settle on abort even if launch/goto/evaluate never answers: close() already discarded the browser, and a
   // wedged job must not hold the serialized queue for the next turn. Late results are ignored.
   try{const binding=this.http.binding(),page=await untilAbort(this.ensure(mvuRetry),signal);if(signal?.aborted){await this.close();throw new Error('插件任务已取消');}const result=await untilAbort(work(page),signal);if(signal?.aborted)throw new Error('插件任务已取消');this.http.assertBinding(binding.scopeKey,binding.sourceEntryId);return result;}
    finally{signal?.removeEventListener('abort',stop);if(mvuRetry)await this.close(false);this.http.mvuRecovery=undefined;this.http.boundSourceEntryId=undefined;this.active--;}
  });this.queue=job.catch(()=>{});return job;
 }

  async before(packet:TavernPreparedPrompt,signal?:AbortSignal):Promise<TavernPreparedPrompt>{
   if(!this.enabled())return packet.worldbookEntries?{...packet,retainedWorldbookIndices:packet.worldbookEntries.map((_,i)=>i)}:packet;
   return this.owned(page=>{if(packet.worldbookEntries&&packet.card!==this.http.binding().card)throw new Error('世界书过滤角色来源已变化');return page.evaluate(p=>p.worldbookEntries?(window as any).LiyuanTavernPlugins.filterWorldbookEntries(p):(window as any).LiyuanTavernPlugins.before(p),packet);},signal);
  }
 async after(entryId:string,signal?:AbortSignal){if(!this.enabled())return;await this.owned(page=>page.evaluate(()=>(window as any).LiyuanTavernPlugins.after()),signal,entryId);}
 async behaviorSmoke(){return this.owned(async page=>{
  const report=await page.evaluate(async()=>{
   const w=window as any,h=w.LiyuanTavernPlugins,report:{template?:boolean;variables?:boolean;html?:boolean}={};
   if(w.EjsTemplate){if(await w.EjsTemplate.evalTemplate('fixture <%= 6 * 7 %>',{})!=='fixture 42')throw new Error('原EJS表达式验收失败');const result=await h.before({systemPrompt:'fixture <%= 1+2 %>',messages:[{role:'user',content:[{type:'text',text:'fixture <%= 3+4 %>'}]}]});if(result.systemPrompt!=='fixture 3'||result.messages[0].content[0].text!=='fixture 7')throw new Error('原模板发送前消息验收失败');report.template=true;}
   const worldModule=await import(String('/tavern-compat/scripts/world-info.js'));const world=await worldModule.getWorldInfoPrompt(['synthetic keyword']);if(!world||!Array.isArray(world.worldInfoDepth)||!Array.isArray(world.worldInfoExamples)||!world.worldInfoBefore.includes('Synthetic-World'))throw new Error('原世界书事件/输出契约验收失败');if(w.EjsTemplate&&!world.worldInfoBefore.includes('42'))throw new Error('原世界书预处理没有实际投送求值结果');
   if(w.TavernHelper){w.TavernHelper.replaceVariables({fixtureSmoke:11},{type:'chat'});await h.host.flush();if(w.TavernHelper.getVariables({type:'chat'}).fixtureSmoke!==11)throw new Error('原变量API验收失败');report.variables=true;document.body.dataset.view='manager';await h.renderHtml('<html><head><meta charset="utf-8"></head><body><div id="fixture-native-smoke">pending</div><script>document.getElementById("fixture-native-smoke").textContent="fixture-smoke="+TavernHelper.getVariables({type:"chat"}).fixtureSmoke;</script></body></html>',0);report.html=true;}
   return report;
  });
  if(report.html){await page.waitForTimeout(50);const widget=page.frameLocator('iframe[id^="TH-message--"]').first().locator('#fixture-native-smoke');await widget.waitFor({timeout:10_000});if(await widget.innerText()!=='fixture-smoke=11')throw new Error('原助手HTML/变量iframe验收失败');}return report;
 });}
  async recoverMvu(signal?:AbortSignal,sourceEntryId?:string){
   const head=this.http.binding(),expected=sourceEntryId?{...head,sourceEntryId}:head,controller=new AbortController();
   if(!sourceEntryId){
    const saved=this.http.store?.read(head).state,message=head.chat.find(row=>row.__liyuanEntryId===head.sourceEntryId),receipt=(saved?.chatMetadata.__liyuanMvuProcessed as Record<string,any>)?.[head.sourceEntryId];
    if(message&&!message.is_user&&!message.__liyuanUnfinished&&typeof message.__liyuanAuthorDelivery==='string'){
     const materialHash=createHash('sha256').update(JSON.stringify([mvuParsingProjection(mvuParseSource(message.__liyuanAuthorDelivery,message.__liyuanSupplementaryVariables)).text,head.readonlyBooks,saved?.extensionSettings.mvu_settings])).digest('hex');
     if(receipt?.nativeRetry===true&&receipt.authorHistoryVersion===2&&receipt.materialHash===materialHash&&['updated','unchanged'].includes(receipt.status))return {scopeKey:head.scopeKey,sourceEntryId:head.sourceEntryId,status:'reused'};
    }
   }
   if(sourceEntryId){const message=head.chat.find(row=>row.__liyuanEntryId===sourceEntryId);if(!head.visibleEntryIds.includes(sourceEntryId)||!message||message.is_user||message.__liyuanUnfinished||!message.__liyuanAuthorDelivery)throw Error('历史MVU来源必须为当前分支完整作者交付');}
   const retrySignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
   try{return await this.owned(async page=>{
     this.http.assertBinding(expected.scopeKey,expected.sourceEntryId);
     if(sourceEntryId)this.http.mvuRecovery={head,sourceEntryId};
    this.http.internalPhase="after";
     try{return await page.evaluate(()=>(window as any).LiyuanTavernPlugins.recoverMvu());}
     catch(error){const text=error instanceof Error?error.message:String(error),message=text.replace(/^page\.evaluate:\s*(?:Error:\s*)?/,'').split('\n')[0];throw Error(message);}
     finally{this.http.internalPhase=undefined;this.http.mvuRecovery=undefined;}
     },retrySignal,sourceEntryId,head,true);}finally{controller.abort();if(this.http.turnSignal===retrySignal)this.http.turnSignal=undefined;}
  }

 async smoke(){return this.owned(page=>page.evaluate(()=>({status:(window as any).LiyuanTavernPlugins.status(),helper:!!(window as any).TavernHelper,template:!!(window as any).EjsTemplate})));}
}
export function syntheticTavernPluginContext():TavernPluginContext{return {sessionId:'synthetic-tavern-compatibility',card:'synthetic-card',sourceEntryId:'synthetic-user',visibleEntryIds:['synthetic-user'],userName:'合成用户',userPersona:'合成身份',chat:[{mes:'合成测试，不发送模型。',name:'合成用户',is_user:true,is_system:false,extra:{},variables:[{}],swipe_id:0,__liyuanEntryId:'synthetic-user'}],character:{name:'合成角色',avatar:'synthetic.png',description:'仅用于原插件兼容验收。',personality:'合成性格',scenario:'合成场景',first_mes:'合成开场',data:{name:'合成角色',description:'仅用于原插件兼容验收。',extensions:{world:'Synthetic-Readonly'},character_book:{entries:[]}}},readonlyBooks:{'Synthetic-Readonly':{entries:[{uid:73,comment:'Synthetic world preprocessing',content:'@@preprocessing\nSynthetic-World <%= 6 * 7 %>',key:[],keysecondary:[],constant:true,disable:false,enabled:true,order:100,position:0,depth:4}]}},preset:{name:'合成预设',prompts:[{identifier:'fixture',content:'合成预设',enabled:true}],extensions:{}},model:{id:'fixture-model',contextWindow:32768}};}
/** Upgrade gate uses a private synthetic server/state; never opens production story/card data. */
export async function validateTavernPluginCandidate(assetsCwd:string,candidate:TavernPluginCandidate):Promise<boolean>{
 const temp=await mkdtemp(join(tmpdir(),'liyuan-tavern-candidate-'));let runtime:TavernPluginRuntime|undefined;let server:ReturnType<typeof createServer>|undefined;
 try{
  const http=new TavernPluginHttp(temp,{context:syntheticTavernPluginContext,isStreaming:()=>false},assetsCwd);http.candidate=candidate;http.fallbackSources=new TavernPluginSources(assetsCwd);
  server=createServer((req,res)=>{void (async()=>{if(req.url?.split('?')[0]==='/tavern-plugin-host.html'){res.writeHead(200,{'content-type':'text/html'});const {readFileSync}=await import('node:fs');res.end(readFileSync(join(assetsCwd,'web/public/tavern-plugin-host.html')));return;}if(!await http.handle(req,res)){res.writeHead(404);res.end();}})().catch(error=>{res.writeHead(500);res.end(String(error));});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  runtime=new TavernPluginRuntime(http,()=>origin);const smoke=await runtime.smoke();await runtime.behaviorSmoke();if(candidate.id==='helper'&&!smoke.helper||candidate.id==='template'&&!smoke.template||smoke.status.errors.length)throw new Error('原插件初始化/依赖验收失败');
  return true;
 }finally{await runtime?.close();if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));await rm(temp,{recursive:true,force:true});}
}
