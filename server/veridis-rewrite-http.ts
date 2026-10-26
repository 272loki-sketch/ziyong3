/** Original Veridis core with private cache; immutable author source + separate guarded display artifact. */
import {readFileSync,lstatSync} from 'node:fs';
import {tavernVendorAsset} from './tavern-plugin-vendor.ts';
import{pluginGitNetworkOptions}from'./plugin-git-network.ts';import{join}from'node:path';import type{IncomingMessage,ServerResponse}from'node:http';
import{VeridisRewriteSources}from'./veridis-rewrite-source.ts';import{VeridisRewriteRuntime,defaultVeridisHostSettings}from'./veridis-rewrite-runtime.ts';import{TavernPluginStore,tavernPluginScope}from'./tavern-plugin-store.ts';
import{authorDraftHash,rewriteReceiptFromBranch,type VeridisRewriteInput,type VeridisRewriteProvider,type VeridisRewriteResult}from'../src/stage/veridis-rewrite.ts';
import type{NpcParallelScope}from'../src/stage/npc-parallel.ts';
export interface VeridisRewriteHost {binding():NpcParallelScope;isBusy():boolean;model():{provider:string;id:string}|undefined;branch():Array<{customType?:string;data?:unknown}>}
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
async function body(req:IncomingMessage){let bytes=0,text='';for await(const chunk of req){bytes+=chunk.length;if(bytes>4*1024*1024)throw Error('净化设置请求过大');text+=chunk;}return JSON.parse(text||'{}');}
const credentialKey=/^(?:api[_-]?key|key|api[_-]?token|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|private[_-]?key|password|passwd|passphrase|credential|credentials|authorization|oauth)$/i;
function publicRewriteString(value:string):string{
 if(/^https?:\/\//i.test(value))try{
  const url=new URL(value);let changed=!!(url.username||url.password);url.username='';url.password='';
  for(const key of url.searchParams.keys())if(credentialKey.test(key)){url.searchParams.set(key,'host-managed');changed=true;}
  if(changed)return url.toString();
 }catch{}
 if(/^[ \t]*(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|[\w-]*token)\s*:/im.test(value))return value.replace(/^([ \t]*(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|[\w-]*token)\s*:)[^\r\n]*/gim,'$1 host-managed');
 return value;
}
export function publicRewriteSettings(value:unknown):any{
 if(Array.isArray(value))return value.map(publicRewriteSettings);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!credentialKey.test(k)).map(([k,v])=>[k,publicRewriteSettings(v)]));
 return typeof value==='string'?publicRewriteString(value):value;
}
function hasPrivateSettings(value:any):boolean{
 if(typeof value==='string')return publicRewriteString(value)!==value;
 return !!value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>credentialKey.test(k)&&v!==''&&v!==null||hasPrivateSettings(v));
}
function mergePrivateSettings(before:any,proposed:any):any{
 // Restore bytes only when the user returned this exact string's public projection.
 // Changed URLs/headers are replacements, never a basis for splicing old credentials.
 if(typeof before==='string'&&typeof proposed==='string'&&publicRewriteString(before)!==before&&proposed===publicRewriteString(before))return before;
 if((Array.isArray(before)!==Array.isArray(proposed)||typeof before!==typeof proposed||(before===null)!==(proposed===null))&&hasPrivateSettings(before))throw Error('字段含隐藏凭据，不能删除或替换其数据结构；请保留原字段');
 if(Array.isArray(proposed)){
  const previous=Array.isArray(before)?before:[];
  const key=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.id==='string'&&value.id?value.id:undefined;
  if(previous.some(hasPrivateSettings)){
   const ids=previous.map(key),nextIds=proposed.map(key);
   if(ids.every(Boolean)&&nextIds.every(Boolean)&&new Set(ids).size===ids.length&&new Set(nextIds).size===nextIds.length){
    const nextKeys=new Set(nextIds);if(previous.some(value=>hasPrivateSettings(value)&&!nextKeys.has(key(value))))throw Error('数组项含隐藏凭据，不能删除；请保留原id');
    const indexed=new Map(previous.map(value=>[key(value),value]));return proposed.map(value=>mergePrivateSettings(indexed.get(key(value)),value));
   }
   if(JSON.stringify(publicRewriteSettings(previous))!==JSON.stringify(publicRewriteSettings(proposed)))throw Error('数组含隐藏凭据且没有唯一稳定id，不能确认重排后的归属；请保持结构');
  }
  return proposed.map((value,index)=>mergePrivateSettings(previous[index],value));
 }
 if(!proposed||typeof proposed!=='object')return proposed;
 const result:any=Object.fromEntries(Object.entries(proposed).filter(([k])=>!credentialKey.test(k)).map(([k,v])=>[k,mergePrivateSettings(before?.[k],v)]));
 if(before&&typeof before==='object'&&!Array.isArray(before))for(const[k,v]of Object.entries(before)){
  if(credentialKey.test(k))result[k]=v;
  else if(!Object.hasOwn(result,k)&&hasPrivateSettings(v))throw Error('字段含隐藏凭据，不能删除；请保留原字段');
 }
 return result;
}
function assertSettings(value:unknown,depth=0):void{
 if(depth>64)throw Error('净化设置嵌套过深');if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
 if(!value||typeof value!=='object')throw Error('净化设置不是有效JSON');
 for(const[k,v]of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(k))throw Error('净化设置含危险字段');if(credentialKey.test(k)){if(v!==''&&v!==null)throw Error('宿主规则设置不修改凭据，模型从独立岗位读取');continue;}assertSettings(v,depth+1);}
}
const settingsHash=(settings:unknown)=>authorDraftHash(JSON.stringify(publicRewriteSettings(settings??{})));

export class VeridisRewriteHttp {
 private management:{scope:NpcParallelScope;alive:()=>boolean;revision:number}|undefined;
 readonly cwd:string;readonly host:VeridisRewriteHost;readonly assetsCwd:string;readonly sources:VeridisRewriteSources;runtime:VeridisRewriteRuntime;readonly store:TavernPluginStore;
 constructor(cwd:string,host:VeridisRewriteHost,assetsCwd=cwd){
  this.cwd=cwd;this.host=host;this.assetsCwd=assetsCwd;
  this.sources=new VeridisRewriteSources(cwd,{isIdle:()=>!host.isBusy()&&!this.runtime?.busy?.()&&this.managementStillCurrent(),validateCandidate:async candidate=>{
   const probe=new VeridisRewriteRuntime({assetsCwd,sources:{active:()=>candidate,resolveAsset:(path:string)=>this.sources.resolveAsset(path,candidate)}});let calls=0;
   try{const original='他说话时，眼底闪过一抹复杂的情绪。',result=await probe.run({sourceEntryId:'synthetic-veridis',authorDraft:original+'\n<options>继续交谈</options>',narrative:original,guard:()=>{},generate:async request=>{
    calls++;const prompt=request.messages.map(m=>m.content).join('\n'),targets=[...prompt.matchAll(/<rewrite_target\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/rewrite_target>/g)];if(!targets.length)throw Error('原净化模型请求缺少真实目标');return JSON.stringify(Object.fromEntries(targets.map(m=>[m[1],m[2].replace('眼底闪过一抹复杂的情绪','语气有些迟疑')])));
   }});return calls>0&&result.changed&&result.errors.length===0&&result.text.includes('<options>继续交谈</options>');}finally{await probe.close();}
  },onActivated:async()=>{if(this.runtime)await this.runtime.close();this.runtime=new VeridisRewriteRuntime({assetsCwd,sources:this.sources});}});
  this.store=new TavernPluginStore(join(cwd,'.liyuan-veridis-rewrite'));this.runtime=new VeridisRewriteRuntime({assetsCwd,sources:this.sources});
 }
  networkOptions():{proxy?:string}{return pluginGitNetworkOptions(this.cwd,'veridis-rewrite');}
  globalPresetLibrary():{presets:Record<string,any>;defaultPreset?:string}{
   const path=join(this.cwd,'.liyuan-veridis-rewrite','global-presets.json');let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {presets:{}};throw error;}if(stat.isSymbolicLink()||!stat.isFile()||stat.size>4*1024*1024)throw Error('Invalid global Veridis preset file');
   const data=JSON.parse(readFileSync(path,'utf8'));if(data.version!==1||!data.presets||typeof data.presets!=='object'||Array.isArray(data.presets))throw Error('Invalid global Veridis preset library');
   assertSettings(data.presets);if(data.defaultPreset!==undefined&&(typeof data.defaultPreset!=='string'||!Object.hasOwn(data.presets,data.defaultPreset)))throw Error('Invalid global Veridis default preset');// Keep private library values intact; status() is the browser projection boundary.
   return {presets:data.presets,defaultPreset:data.defaultPreset};
  }
  effectiveSettings(stored:any):any{
   const library=this.globalPresetLibrary(),settings=structuredClone(stored??defaultVeridisHostSettings());
   if(Object.keys(library.presets).length)settings.presets={...library.presets,...settings.presets};
   if(library.defaultPreset&&settings.useGlobalDefaultPreset!==false&&!settings.activePreset&&(!stored||!Array.isArray(settings.rules)||settings.rules.length===0)){
     const preset=settings.presets[library.defaultPreset],rules=Array.isArray(preset)?preset:preset?.rules;
    if(!Array.isArray(rules))throw Error('Invalid global Veridis default rules');
    settings.activePreset=library.defaultPreset;settings.defaultPreset=library.defaultPreset;settings.rules=structuredClone(rules);
    if(preset.aiRewrite){const parameters=structuredClone(preset.aiRewrite);delete parameters.enabled;delete parameters.autoTriggerEnabled;settings.aiRewrite={...settings.aiRewrite,...parameters};}
   }
   return settings;
  }
 managementStillCurrent():boolean{const lease=this.management;if(!lease)return true;try{const current=this.host.binding();return lease.alive()&&current.sessionId===lease.scope.sessionId&&current.card===lease.scope.card&&current.sourceEntryId===lease.scope.sourceEntryId&&this.store.read(lease.scope).revision===lease.revision;}catch{return false;}}
 guard(scope:NpcParallelScope){const current=this.host.binding();if(current.sessionId!==scope.sessionId||current.card!==scope.card||!current.visibleEntryIds.includes(scope.sourceEntryId)&&current.sourceEntryId!==scope.sourceEntryId)throw Object.assign(Error('净化会话、卡或祖先来源已变化'),{statusCode:409});}
 enabled(){const s=this.sources.status();if(!s.enabled||!s.installed)return false;const settings=this.store.read(this.host.binding()).state.extensionSettings.veridis_rewrite as any;return settings?.enabled!==false&&settings?.aiRewrite?.enabled!==false&&settings?.aiRewrite?.autoTriggerEnabled!==false;}
  status(){const scope=this.host.binding(),receipt=rewriteReceiptFromBranch(this.host.branch(),scope.sourceEntryId),settings=this.store.read(scope).state.extensionSettings.veridis_rewrite as Record<string,unknown>|undefined;const stored=this.store.read(scope);return{...this.sources.status(),scopeKey:tavernPluginScope(scope),sourceEntryId:scope.sourceEntryId,revision:stored.revision,upstreamCommit:this.sources.active()?.commit,busy:this.host.isBusy()||!!this.runtime.busy?.(),model:this.host.model(),settings:publicRewriteSettings(this.effectiveSettings(settings)),...(receipt?{receipt:{status:receipt.status,changed:receipt.changed,calls:receipt.calls,error:receipt.error,reason:receipt.reason,hits:receipt.hits,projectionMode:receipt.projectionMode}}:{})};}
 provider():VeridisRewriteProvider{return{enabled:()=>this.enabled(),claimRequest:(scope,guard)=>{this.store.recordModelRequest(scope,()=>{guard();this.guard(scope);});},run:input=>this.run(input)};}
 async run(input:VeridisRewriteInput):Promise<VeridisRewriteResult>{
  input.guard();this.guard(input.scope);if(!this.enabled())throw Error('原净化插件或自动运行已关闭');
   const saved=this.store.read(input.scope),settings=this.effectiveSettings(saved.state.extensionSettings.veridis_rewrite);
  const cached=saved.state.messages[input.scope.sourceEntryId]?.extra?.veridis_rewrite as any,hash=authorDraftHash(input.authorDraft),narrativeHash=authorDraftHash(input.narrative),commit=this.sources.active()?.commit;
  const project=(result:any):VeridisRewriteResult=>({...result,...(result.skipReason?{reason:result.skipReason}:{}),hits:result.hits});
  if(cached?.authorHash===hash&&cached.narrativeHash===narrativeHash&&cached.upstreamCommit===commit&&cached.settingsHash===settingsHash(settings)&&!cached.result?.errors?.length)return project(structuredClone(cached.result));
  const result=await this.runtime.run({...input,sourceEntryId:input.scope.sourceEntryId,settings,guard:()=>{input.guard();this.guard(input.scope);}});input.guard();this.guard(input.scope);
  const state=structuredClone(saved.state);if(result.settings)state.extensionSettings.veridis_rewrite=mergePrivateSettings(settings,result.settings);
  state.messages[input.scope.sourceEntryId]={...state.messages[input.scope.sourceEntryId],extra:{...state.messages[input.scope.sourceEntryId]?.extra,veridis_rewrite:{authorHash:hash,narrativeHash,upstreamCommit:result.commit,settingsHash:settingsHash(state.extensionSettings.veridis_rewrite),result}}};
  // The starting revision is the CAS basis. Concurrent settings/state are never overwritten by a late result.
  this.store.save(input.scope,saved.revision,state,()=>{input.guard();this.guard(input.scope);});return project(result);
 }
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const path=new URL(req.url??'/','http://localhost').pathname;if(!path.startsWith('/api/veridis-rewrite/')&&!path.startsWith('/veridis-rewrite/')&&path!=='/veridis-rewrite-host.html')return false;
  try{
   if(req.method==='GET'&&path==='/api/veridis-rewrite/context'){
     if(!this.sources.active())throw Error('原净化工作台来源尚未安装');json(res,200,{...this.status(),manifest:this.sources.active()!.manifest});return true;
   }
   if(req.method==='GET'&&(path==='/veridis-rewrite-host.html'||path.startsWith('/veridis-rewrite/'))){
    let file:string|null=null;const hosts:Record<string,string>={'/veridis-rewrite-host.html':'web/public/veridis-rewrite-host.html','/veridis-rewrite/host.js':'web/public/veridis-rewrite/host.js','/veridis-rewrite/host.css':'web/public/veridis-rewrite/host.css'};
    if(hosts[path])file=join(this.assetsCwd,hosts[path]);
    else if(path==='/veridis-rewrite/vendor/jquery.js')file=tavernVendorAsset(this.assetsCwd,'jquery.js');
    else {const prefix='/veridis-rewrite/scripts/extensions/third-party/Veridis-Rewrite/';if(path.startsWith(prefix)){let rel:string;try{rel=decodeURIComponent(path.slice(prefix.length));}catch{throw Error('原净化资源路径无效');}if(/^(?:src|styles|templates|images|vendor)\//.test(rel)||['style.css','manifest.json'].includes(rel))file=this.sources.resolveAsset(rel);}}
    if(!file||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()){json(res,404,{error:'原净化工作台资源不可用'});return true;}
    const ext=file.split('.').at(-1)?.toLowerCase(),mime:Record<string,string>={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json; charset=utf-8',png:'image/png',svg:'image/svg+xml',jpg:'image/jpeg',woff2:'font/woff2'};
    res.writeHead(200,{'content-type':mime[ext??'']??'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff',...(path==='/veridis-rewrite-host.html'?{'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"}:{})});res.end(readFileSync(file));return true;
   }
   if(req.method==='GET'&&path==='/api/veridis-rewrite/status'){json(res,200,this.status());return true;}
   const allowed=req.method==='PUT'&&['/api/veridis-rewrite/config','/api/veridis-rewrite/settings'].includes(path)||req.method==='POST'&&/^\/api\/veridis-rewrite\/(install|check|update|rollback)$/.test(path);
   if(!allowed){json(res,404,{error:'未支持的净化宿主接口；原稿未改变'});return true;}
   const scope=this.host.binding(),saved=this.store.read(scope),commit=this.sources.active()?.commit;
   const checkBusy=()=>{const current=this.host.binding();if(current.sessionId!==scope.sessionId||current.card!==scope.card||current.sourceEntryId!==scope.sourceEntryId)throw Object.assign(Error('净化管理来源已换代'),{statusCode:409});if(req.aborted||res.destroyed||this.host.isBusy()||this.runtime.busy())throw Object.assign(Error('正文或后台任务进行中，未修改净化插件或规则'),{statusCode:409});};
   checkBusy();const data=await body(req);checkBusy();this.guard(scope);
   if(data.scopeKey!==tavernPluginScope(scope)||data.sourceEntryId!==scope.sourceEntryId||data.revision!==saved.revision||this.store.read(scope).revision!==saved.revision||data.upstreamCommit!==commit||this.sources.active()?.commit!==commit)throw Object.assign(Error('净化管理页来源、版本或revision已过期，请重新读取'),{statusCode:409});
   if(path.endsWith('/config')){
    if(data.enabled&&!this.host.model())throw Error('净化独立3.8Flash岗位未配置');checkBusy();this.sources.configure({...(typeof data.enabled==='boolean'?{enabled:data.enabled}:{}),...(typeof data.autoUpdate==='boolean'?{autoUpdate:data.autoUpdate}:{})});
   }else if(path.endsWith('/settings')){
    if(!data.settings||typeof data.settings!=='object'||Array.isArray(data.settings))throw Error('净化规则设置必须是对象');assertSettings(data.settings);
    const state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite=mergePrivateSettings(this.effectiveSettings(saved.state.extensionSettings.veridis_rewrite),data.settings);
    this.store.save(scope,saved.revision,state,()=>{this.guard(scope);checkBusy();});
   }else{
    const action=path.split('/').at(-1);checkBusy();if(this.management)throw Object.assign(Error('已有净化管理任务，请等待'),{statusCode:409});this.management={scope,revision:saved.revision,alive:()=>!req.aborted&&!res.destroyed};try{
    if(action==='install'){if(this.sources.status().updateAvailable)await this.sources.activateStaged();else await this.sources.install(this.networkOptions());}if(action==='check')await this.sources.checkUpdate(this.networkOptions());if(action==='update'){if(this.sources.status().updateAvailable)await this.sources.activateStaged();else await this.sources.update(this.networkOptions());}if(action==='rollback')await this.sources.rollback();
    checkBusy();}finally{this.management=undefined;}
   }
   json(res,200,this.status());return true;
  }catch(error){const e=error as any;json(res,e.code==='ENOSPC'||e.code==='EDQUOT'?507:e.statusCode??400,{error:error instanceof Error?error.message:'净化操作失败'});return true;}
 }
 async close(){this.sources.close();await this.runtime.close();}
}
