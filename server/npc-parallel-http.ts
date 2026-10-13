import {createHash} from 'node:crypto';
/** Dedicated NPC host: raw upstream assets + guarded derived state, no production story writes. */
import {readFileSync} from 'node:fs';
import {pluginGitNetworkOptions} from './plugin-git-network.ts';
import {join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {NpcParallelSources} from './npc-parallel-source.ts';
import {NpcParallelRuntime} from './npc-parallel-runtime.ts';
import {TavernPluginStore,tavernPluginScope} from './tavern-plugin-store.ts';
import {tavernVendorAsset} from './tavern-plugin-vendor.ts';
import {npcActorId,npcReceiptFromBranch,type NpcParallelScope,type NpcParallelBatch,type NpcParallelGenerationInput,type NpcParallelProvider} from '../src/stage/npc-parallel.ts';
import type {LiteraryEcologyState} from '../src/stage/literary-ecology.ts';
import type {LorebookEntry} from '../src/types.ts';
export interface NpcParallelHost {
 binding():NpcParallelScope;
 isBusy():boolean;
 config():{ecologyEnabled:boolean;model?:{provider:string;id:string}};
 branch():Array<{id?:string;type?:string;customType?:string;data?:any;message?:any}>;
 ecology():LiteraryEcologyState;
 materials():{card:{name:string};config:{userName:string};entries:LorebookEntry[]};
}
const clone=<T>(value:T):T=>structuredClone(value);
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
async function body(req:IncomingMessage){let bytes=0,text='';for await(const chunk of req){bytes+=chunk.length;if(bytes>4*1024*1024)throw Error('侧写管理请求过大');text+=chunk;}return JSON.parse(text||'{}');}
const text=(value:any)=>typeof value==='string'?value:Array.isArray(value)?value.filter(p=>p?.type==='text').map(p=>p.text??'').join(''):'';
export function npcWorldbooks(entries:LorebookEntry[]):Record<string,{entries:Array<Record<string,unknown>>}>{
 const books:Record<string,{entries:Array<Record<string,unknown>>}>=Object.create(null);
 for(const entry of entries){if(!entry.enabled)continue;const name=entry.source??'card';(books[name]??={entries:[]}).entries.push({...entry,key:entry.keys,keysecondary:entry.secondaryKeys,disable:false,uid:entry.uid});}
 return books;
}
export class NpcParallelHttp {
 readonly sources:NpcParallelSources;runtime:NpcParallelRuntime;readonly store:TavernPluginStore;
 private management:{scope:NpcParallelScope;alive:()=>boolean;revision:number}|undefined;
 readonly cwd:string;readonly host:NpcParallelHost;readonly assetsCwd:string;
 constructor(cwd:string,host:NpcParallelHost,assetsCwd=cwd){
  this.cwd=cwd;this.host=host;this.assetsCwd=assetsCwd;
  this.sources=new NpcParallelSources(cwd,{isIdle:()=>!host.isBusy()&&!this.runtime?.busy()&&this.managementStillCurrent(),validateCandidate:async candidate=>{
   const probe=new NpcParallelRuntime({assetsCwd,sources:{active:()=>candidate,resolveAsset:(p:string)=>this.sources.resolveAsset(p,candidate)}});
   try{
    let calls=0;const result=await probe.run({sessionId:'npc-canary',card:'synthetic-card',sourceEntryId:'synthetic-source',chat:[{entryId:'synthetic-user',is_user:true,mes:'合成用户在屋内看书。'},{entryId:'synthetic-source',is_user:false,mes:'合成主角在屋内整理书页，远处的阿青仍在书店工作。'}],npcs:[{name:'阿青',notes:'阿青在书店，负责整理书架。'}],worldbooks:{},settings:{pickBeforeGen:false,minGenTokens:0,minWords:40,maxWords:120,maxPerRound:2,autoSyncDatabase:false,autoDetectPresence:false},metadata:{},constraintText:'这是隔离合成验收，仅提出阿青在书店的场外生活，不写用户行为。',guard:()=>{},generate:async request=>{calls++;const p=request.messages.map(m=>m.content).join('\n');return p.includes('在场')&&(p.includes('判定')||p.includes('离场'))&&!p.includes('npc正文')?'阿青｜离场':'<npc正文>阿青把最后一本书放回架子，回到柜台核对今天的账目。</npc正文><npc信息>知道：店里的工作安排\n不知道：主角屋内的事</npc信息>';}});
    return result.entries.some(e=>e.name==='阿青'&&e.text.includes('书'))&&calls>0&&result.errors.length===0;
   }finally{await probe.close();}
  },onActivated:async()=>{if(this.runtime)await this.runtime.close();this.runtime=new NpcParallelRuntime({assetsCwd,sources:this.sources});}});
  this.store=new TavernPluginStore(join(cwd,'.liyuan-npc-parallel'));
  this.runtime=new NpcParallelRuntime({assetsCwd,sources:this.sources});
 }
 networkOptions():{proxy?:string}{return pluginGitNetworkOptions(this.cwd,'npc-parallel');}
 managementStillCurrent():boolean{const lease=this.management;if(!lease)return true;try{const current=this.host.binding();return lease.alive()&&current.sessionId===lease.scope.sessionId&&current.card===lease.scope.card&&current.sourceEntryId===lease.scope.sourceEntryId&&this.store.read(lease.scope).revision===lease.revision;}catch{return false;}}
 scopeGuard(scope:NpcParallelScope){const current=this.host.binding();if(current.sessionId!==scope.sessionId||current.card!==scope.card||!current.visibleEntryIds.includes(scope.sourceEntryId)&&current.sourceEntryId!==scope.sourceEntryId)throw Object.assign(Error('侧写会话、卡或祖先来源已改变'),{statusCode:409});}
 enabled(){const s=this.sources.status();if(!s.installed||!s.enabled||!this.host.config().ecologyEnabled)return false;const original=this.store.read(this.host.binding()).state.extensionSettings.npc_parallel as Record<string,unknown>|undefined;return original?.enabled!==false&&original?.autoTrigger!==false;}
 provider():NpcParallelProvider{return{enabled:()=>this.enabled(),claimRequest:(scope,guard)=>this.store.claimModelRequest(scope,8,()=>{guard();this.scopeGuard(scope);}),generate:input=>this.generate(input)};}
 status(){
  const scope=this.host.binding(),receipt=npcReceiptFromBranch(this.host.branch(),scope.sourceEntryId),config=this.host.config();
  const original=this.store.read(scope).state.extensionSettings.npc_parallel as Record<string,unknown>|undefined;
  const executionReason=original?.enabled===false?'原版设置中的启用已关闭':original?.autoTrigger===false?'原版设置中的自动触发已关闭':undefined;
  return{...this.sources.status(),scopeKey:tavernPluginScope(scope),sourceEntryId:scope.sourceEntryId,revision:this.store.read(scope).revision,upstreamCommit:this.sources.active()?.commit,executionEnabled:this.enabled(),...(executionReason?{executionReason}:{}),busy:this.host.isBusy()||this.runtime.busy(),ecologyEnabled:config.ecologyEnabled,model:config.model,...(receipt?{receipt:{status:receipt.status,sourceEntryId:receipt.sourceEntryId,total:receipt.entries.length,accepted:receipt.entries.filter(e=>e.status==='accepted').length,rejected:receipt.entries.filter(e=>e.status!=='accepted').length}}:{})};
 }
 frame(scope=this.host.binding(),input?:NpcParallelGenerationInput){
  this.scopeGuard(scope);const stored=this.store.read(scope),metadata=clone(stored.state.chatMetadata),settings=clone((stored.state.extensionSettings.npc_parallel??{pickBeforeGen:false,pickSkip:true,maxPerRound:3,minWords:200,maxWords:600,responseTokens:1600,minGenTokens:0}) as Record<string,unknown>);
  const branch=this.host.branch().filter(e=>!!e.id&&scope.visibleEntryIds.includes(e.id));
  const chat:Array<{entryId:string;is_user:boolean;mes:string;name?:string;extra?:Record<string,unknown>}>=[];
  for(const entry of branch){let mes:string|undefined,is_user=false;
   if(entry.type==='message'&&entry.message?.role==='user'){mes=text(entry.message.content);is_user=true;}
   else if(entry.type==='message'&&entry.message?.role==='assistant'&&typeof entry.message.details?.rpNarrative==='string')mes=entry.message.details.rpNarrative;
   else if(entry.customType==='rp-greeting'){mes=typeof entry.data?.text==='string'?entry.data.text:typeof entry.data?.content==='string'?entry.data.content:undefined;}
   if(!mes)continue;const receipt=npcReceiptFromBranch(branch,entry.id!);
   chat.push({entryId:entry.id!,is_user,mes,...(receipt?.status==='accepted'?{extra:{npc_parallel:receipt.entries.map(e=>({name:e.name,text:e.text,info:e.info,pov:e.pov,ts:e.ts}))}}:{})});
  }
  if(input&&!chat.some(e=>e.entryId===scope.sourceEntryId))chat.push({entryId:scope.sourceEntryId,is_user:false,mes:input.narrative});
  // Seed only committed ecology/roster identities. No unchecked model-discovered person becomes a fact.
  const ecology=input?.ecology??this.host.ecology(),materials=this.host.materials(),userName=input?.userName??materials.config.userName,charName=input?.charName??materials.card.name;
  const previous=Array.isArray((metadata.npc_parallel as any)?.npcs)?(metadata.npc_parallel as any).npcs:[];
  const ignored=new Set(Array.isArray((metadata.npc_parallel as any)?.ignoredNpcs)?(metadata.npc_parallel as any).ignoredNpcs:[]);
  const roster=new Map<string,any>(previous.filter((n:any)=>n?.name&&n.name!==userName&&n.name!==charName).map((n:any)=>[n.name,n]));
  for(const actor of ecology.actors){if(actor.name===userName||actor.name===charName||ignored.has(actor.name)||roster.has(actor.name))continue;roster.set(actor.name,{name:actor.name,notes:JSON.stringify({id:actor.id,location:actor.location,activity:actor.activity,shortGoal:actor.shortGoal,longGoal:actor.longGoal,knowledgeLedger:actor.knowledgeLedger}),weight:actor.tier==='background'?1:2});}
  if(input)for(const [name,notes]of Object.entries(input.state.roster?.characters??{})){if(name!==userName&&name!==charName&&!ignored.has(name)&&!roster.has(name))roster.set(name,{name,notes:String(notes),weight:1});}
  const npcs=[...roster.values()].slice(0,24);
  metadata.npc_parallel={...((metadata.npc_parallel as any)??{}),npcs};
  const constraintText=JSON.stringify({provider:'npc-parallel',sourceEntryId:scope.sourceEntryId,canonicalNarrative:input?.narrative??chat.at(-1)?.mes??'',currentEcology:ecology,sceneReference:input?.state??null,actorIds:Object.fromEntries(npcs.map(n=>[n.name,npcActorId(n.name,ecology)])),contract:{candidateOnly:true,originalDraftReadOnly:true,sameTimeWindow:true,noUserCommitment:true,noKnowledgeWithoutRoute:true,oneSharedOccurrence:true,priorStateReferenceOnly:true}});
  const candidate=this.sources.active();
  return{...scope,scope:{...scope},scopeKey:tavernPluginScope(scope),revision:stored.revision,chat,npcs,worldbooks:npcWorldbooks(input?.lore??materials.entries),settings,metadata,constraintText,userName,characterName:charName,version:candidate?.version,upstreamCommit:candidate?.commit,manifest:candidate?.manifest,model:this.host.config().model};
 }
 async generate(input:NpcParallelGenerationInput):Promise<NpcParallelBatch>{
  const {scope}=input;input.guard();this.scopeGuard(scope);if(!this.enabled())throw Error('众生侧写或鲜活世界未启用');
  const current=this.store.read(scope),cached=current.state.messages[scope.sourceEntryId]?.extra?.npc_parallel_batch as any;
  if(cached?.sourceEntryId===scope.sourceEntryId&&cached.narrativeHash===createHash('sha256').update(input.narrative).digest('hex')&&cached.batch?.entries?.length&&!cached.batch?.errors?.length){return{...clone(cached.batch),cached:true};}
  const frame=this.frame(scope,input);
  const result=await this.runtime.run({...frame,signal:input.signal,guard:()=>{input.guard();this.scopeGuard(scope);},generate:input.generate});input.guard();this.scopeGuard(scope);
  const batch:NpcParallelBatch={version:result.version,commit:result.commit,entries:result.entries,calls:result.calls,errors:result.errors};
  // Raw proposed text is saved independently for exact-source retry; it is NOT admitted ecology.
  const state=clone(current.state);state.extensionSettings.npc_parallel=clone(result.settings);state.chatMetadata=clone(result.metadata);
  state.messages[scope.sourceEntryId]={...state.messages[scope.sourceEntryId],extra:{...state.messages[scope.sourceEntryId]?.extra,npc_parallel_batch:{sourceEntryId:scope.sourceEntryId,narrativeHash:createHash('sha256').update(input.narrative).digest('hex'),batch}}};
  this.store.save(scope,current.revision,state,()=>{input.guard();this.scopeGuard(scope);});return batch;
 }
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??'/', 'http://localhost'),path=url.pathname;
  if(!path.startsWith('/api/npc-parallel/')&&!path.startsWith('/npc-parallel/')&&path!=='/npc-parallel-host.html')return false;
  try{
   if(req.method==='GET'&&path==='/api/npc-parallel/status'){json(res,200,this.status());return true;}
   if(req.method==='GET'&&path==='/api/npc-parallel/context'){json(res,200,this.frame());return true;}
   if(req.method==='POST'&&path==='/api/npc-parallel/settings'){
    if(this.host.isBusy()||this.runtime.busy())throw Object.assign(Error('正文或生态结算进行中，不能修改侧写设置'),{statusCode:409});
    const data=await body(req),scope=this.host.binding();this.scopeGuard(scope);
    if(data.chat||data.messages||data.state?.chat||data.state?.messages)throw Error('原管理页不编辑已采纳历史；请使用梨园分支操作');
    if(data.upstreamCommit!==this.sources.active()?.commit)throw Object.assign(Error('原设置页上游版本已换代，请重新打开'),{statusCode:409});
    if(data.scopeKey!==tavernPluginScope(scope)||data.sourceEntryId!==scope.sourceEntryId)throw Object.assign(Error('原设置页来源过期，请重新打开'),{statusCode:409});
    const saved=this.store.read(scope),next=clone(saved.state);next.extensionSettings.npc_parallel=data.settings??data.state?.settings;next.chatMetadata=data.metadata??data.state?.metadata??next.chatMetadata;
    if(!next.extensionSettings.npc_parallel||typeof next.extensionSettings.npc_parallel!=='object'||Array.isArray(next.extensionSettings.npc_parallel))throw Error('原设置不是有效对象');
    const result=this.store.save(scope,data.revision,next,()=>{this.scopeGuard(scope);if(this.host.binding().sourceEntryId!==scope.sourceEntryId||this.host.isBusy())throw Object.assign(Error('侧写设置提交前宿主已忙或来源换代'),{statusCode:409});});json(res,200,{...result,scopeKey:tavernPluginScope(scope),sourceEntryId:scope.sourceEntryId});return true;
   }
   if((req.method==='PUT'&&path==='/api/npc-parallel/config')||(req.method==='POST'&&/^\/api\/npc-parallel\/(install|check|update|rollback)$/.test(path))){
    const scope=this.host.binding(),saved=this.store.read(scope),commit=this.sources.active()?.commit;
    const guardManagement=()=>{const current=this.host.binding();if(current.sessionId!==scope.sessionId||current.card!==scope.card||current.sourceEntryId!==scope.sourceEntryId||req.aborted||res.destroyed||this.host.isBusy()||this.runtime.busy())throw Object.assign(Error('侧写管理来源已变化或宿主正忙，未切换设置'),{statusCode:409});};
    guardManagement();const patch=await body(req);guardManagement();
    if(patch.scopeKey!==tavernPluginScope(scope)||patch.sourceEntryId!==scope.sourceEntryId||patch.revision!==saved.revision||this.store.read(scope).revision!==saved.revision||patch.upstreamCommit!==commit||this.sources.active()?.commit!==commit)throw Object.assign(Error('侧写管理页来源、版本或revision过期，请重新读取'),{statusCode:409});
    if(path.endsWith('/config')){
     if(patch.enabled&&!this.host.config().ecologyEnabled)throw Error('请先显式启用鲜活世界，不自动开启其它模块');if(patch.enabled&&!this.host.config().model)throw Error('众生侧写独立模型岗位未配置');guardManagement();this.sources.configure({...(typeof patch.enabled==='boolean'?{enabled:patch.enabled}:{}),...(typeof patch.autoUpdate==='boolean'?{autoUpdate:patch.autoUpdate}:{})});
    }else{
     if(this.management)throw Object.assign(Error('已有侧写管理任务，请等待'),{statusCode:409});this.management={scope,revision:saved.revision,alive:()=>!req.aborted&&!res.destroyed};
     try{const action=path.split('/').at(-1)!;
      if(action==='install'){if(this.sources.status().updateAvailable)await this.sources.activateStaged();else await this.sources.install(this.networkOptions());}
      if(action==='check')await this.sources.checkUpdate(this.networkOptions());
      if(action==='update'){if(this.sources.status().updateAvailable)await this.sources.activateStaged();else await this.sources.update(this.networkOptions());}
      if(action==='rollback')await this.sources.rollback();guardManagement();
     }finally{this.management=undefined;}
    }
    json(res,200,this.status());return true;
   }
   if(req.method==='POST'&&path==='/api/npc-parallel/generate'){throw Error('原管理页不直接生成或改写历史事实；侧写在鲜活世界后台自动运行');}
   if(path.startsWith('/api/npc-parallel/')){json(res,404,{error:'未支持的众生侧写接口；没有执行故事写入'});return true;}
   if(req.method!=='GET'){json(res,405,{error:'原插件资源只读'});return true;}
   let file:string|null=null,mime='text/javascript; charset=utf-8';
   if(path==='/npc-parallel-host.html'){file=join(this.assetsCwd,'web/public/npc-parallel-host.html');mime='text/html; charset=utf-8';}
   else if(path==='/npc-parallel/script.js')file=join(this.assetsCwd,'web/public/npc-parallel/script.js');
   else if(path==='/npc-parallel/scripts/extensions.js')file=join(this.assetsCwd,'web/public/npc-parallel/extensions.js');
   else if(['/npc-parallel/host.js','/npc-parallel/host.css'].includes(path)){file=join(this.assetsCwd,'web/public',path.replace('/npc-parallel/','npc-parallel/'));if(path.endsWith('.css'))mime='text/css; charset=utf-8';}
   else if(path.startsWith('/npc-parallel/vendor/'))file=tavernVendorAsset(this.assetsCwd,path.slice('/npc-parallel/vendor/'.length));
   else if(path.startsWith('/npc-parallel/scripts/extensions/third-party/npc-parallel/')){const relative=decodeURIComponent(path.slice('/npc-parallel/scripts/extensions/third-party/npc-parallel/'.length));file=this.sources.resolveAsset(relative);if(relative.endsWith('.css'))mime='text/css; charset=utf-8';if(relative.endsWith('.json'))mime='application/json; charset=utf-8';}
   if(!file){json(res,404,{error:'未安装或未允许的原插件资源'});return true;}
   const bytes=readFileSync(file);res.writeHead(200,{'content-type':mime,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);return true;
  }catch(error){const e=error as any;json(res,e.code==='ENOSPC'||e.code==='EDQUOT'?507:e.statusCode??400,{error:error instanceof Error?error.message:'侧写操作失败'});return true;}
 }
 async close(){this.sources.close();await this.runtime.close();}
}
