import {mvuManagementView} from "./mvu-view.ts";
import {mvuAsset,mvuAssetMap,mvuStatus,setMvuEnabled} from "./mvu-assets.ts";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TavernPluginSources, TAVERN_PLUGIN_UPSTREAMS, readTavernCandidateAsset, type TavernPluginCandidate } from "./tavern-plugin-source.ts";
import { TAVERN_CDN_ASSETS } from "./tavern-plugin-cdn.ts";
import { TAVERN_MODULE_IMPORTS } from "./tavern-plugin-imports.ts";
import { TavernPluginStore, tavernPluginScope, validateTavernPluginState, type TavernPluginBinding } from "./tavern-plugin-store.ts";
import { ensureTavernPluginVendors, tavernVendorAsset } from "./tavern-plugin-vendor.ts";
import type { ModelRef } from "../src/model-routing.ts";
export interface TavernGenerationOptions {
 purpose:"tavern-helper"|"mvu.parse"; payload:Record<string,unknown>;
 scope:{sessionId:string;card:string}; sourceEntryId:string; validateBinding:()=>void; claimRequest:()=>void;
}
export function managedMvuEndpoint(value:unknown):string {
 if(typeof value!=="string"||!value||value.length>2048)throw Error("MVU需要有效的受管API端点");
 const url=new URL(value);if(!["https:","http:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error("MVU端点不能包含凭据、查询或片段");
 return url.href.replace(/\/+$/,"");
}
export function resolveManagedMvuModel<M extends {provider:string;id:string;baseUrl:string}>(ref:ModelRef|undefined,payload:Record<string,unknown>,models:M[]):M {
 if(!ref)throw Error("未配置独立mvuParse模型，不能回退主作者");
 const model=models.find(m=>m.provider===ref.provider&&m.id===ref.id);
 if(!model||payload.model!==ref.id)throw Error("MVU模型必须精确匹配当前启用连接的mvuParse引用");
 if(payload.chat_completion_source!=="custom"||managedMvuEndpoint(payload.reverse_proxy)!==managedMvuEndpoint(model.baseUrl))throw Error("MVU端点不匹配受管模型连接");
 return model;
}
export function tavernSampler(payload:Record<string,unknown>,cap:number):{maxTokens:number;temperature?:number} {
 const allowed=new Set(["messages","model","reverse_proxy","chat_completion_source","purpose","stream","max_tokens","temperature","custom_include_headers","custom_include_body","custom_exclude_body"]);
 for(const key of Object.keys(payload))if(!allowed.has(key))throw Error("不支持的脚本模型参数: "+key);
 if(payload.stream!==undefined&&payload.stream!==false)throw Error("脚本模型通道不支持stream");
 for(const key of ["custom_include_headers","custom_include_body","custom_exclude_body"])if(payload[key]!==undefined&&payload[key]!=="")throw Error("受管模型不接受自定义鉴权或include/exclude参数");
 if(payload.max_tokens!==undefined&&(typeof payload.max_tokens!=="number"||!Number.isSafeInteger(payload.max_tokens)||payload.max_tokens<1))throw Error("max_tokens必须是正整数");
 if(payload.temperature!==undefined&&(typeof payload.temperature!=="number"||!Number.isFinite(payload.temperature)||payload.temperature<0||payload.temperature>2))throw Error("temperature超出安全范围");
 return {maxTokens:Math.min(cap,typeof payload.max_tokens==="number"?payload.max_tokens:cap),...(typeof payload.temperature==="number"?{temperature:payload.temperature}:{})};
}
export function createTavernPluginGenerator<M extends {provider:string;id:string;baseUrl:string;maxTokens?:number}>(deps:{models:()=>M[];mvuRef:()=>ModelRef|undefined;writer:()=>M|undefined;auth:(model:M)=>Promise<{ok:boolean;apiKey?:string;headers?:Record<string,string>}>;stream:(model:M,context:any,options:any,binding:TavernGenerationOptions)=>any}) {
 return async(messages:Array<{role:string;content:string}>,signal:AbortSignal|undefined,options:TavernGenerationOptions)=>{
  options.validateBinding();const model=options.purpose==="mvu.parse"?resolveManagedMvuModel(deps.mvuRef(),options.payload,deps.models()):deps.writer();if(!model)throw Error("尚未配置主作者模型");
  const sampler=tavernSampler(options.payload,Math.min(model.maxTokens??4096,8192));
  const auth=await deps.auth(model);options.validateBinding();if(signal?.aborted)throw Error("脚本模型请求已取消");if(!auth.ok)throw Error("脚本模型鉴权不可用");
  if(options.purpose==="mvu.parse"&&JSON.stringify(resolveManagedMvuModel(deps.mvuRef(),options.payload,deps.models()))!==JSON.stringify(model))throw Error("MVU连接在鉴权期间已变化");
  options.claimRequest();options.validateBinding();
   const context={systemPrompt:messages.filter(m=>m.role==="system").map(m=>m.content).join("\n\n"),messages:messages.filter(m=>m.role!=="system").map(m=>({role:m.role,content:[{type:"text",text:m.content}],timestamp:Date.now(),...(m.role==="assistant"?{api:(model as M & {api?:string}).api,provider:model.provider,model:model.id,stopReason:"stop",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}:{})}))};
   const stream=deps.stream(model,context,{apiKey:auth.apiKey,headers:{...auth.headers},signal,...sampler,onPayload:(payload:unknown)=>{options.validateBinding();signal?.throwIfAborted();return payload;}},options);
   const fail=(message:any)=>{const reason=String(message?.errorMessage||"脚本模型请求未完成");throw Error(auth.apiKey?reason.split(auth.apiKey).join("[redacted]"):reason);};
   for await(const event of stream){options.validateBinding();if(event.type==="error")fail(event.error);}
   const result=await stream.result();options.validateBinding();if(result.stopReason==="error"||result.stopReason==="aborted")fail(result);
  return result.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("");
 };
}
export interface TavernPluginContext extends TavernPluginBinding {
 worldbookSelections?: { primary: string | null; additional: string[]; global: string[]; chat: string[] };
 chat: Array<Record<string, unknown>>; character: Record<string, unknown>; userName: string; userPersona?: string;
 preset?: Record<string, unknown>; model?: {id:string;contextWindow?:number}; mvu?:{model?:{provider:string;id:string;managedEndpoint:string}}; readonlyBooks: Record<string, {entries:unknown[]}>;
}
export interface TavernPluginHost {
 context(): TavernPluginContext; isStreaming(): boolean; mvuBusy?:()=>boolean;
 managedMvuModels?:()=>Array<{provider:string;id:string;managedEndpoint:string}>;
 generateManagesBudget?:boolean;
 generate?: (messages: Array<{role:string;content:string}>, signal?:AbortSignal, options?:TavernGenerationOptions)=>Promise<string>;
 cancel?: ()=>void;
}
const slugs = { helper: "JS-Slash-Runner", template: "ST-Prompt-Template" } as const;
function id(value: unknown): keyof typeof slugs { if(value!=="helper"&&value!=="template")throw new Error("未知酒馆插件");return value; }
function response(res: ServerResponse, status: number, data: unknown){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(data));}
async function body(req:IncomingMessage){let bytes=0;const chunks:Buffer[]=[];for await(const raw of req){const chunk=Buffer.from(raw);bytes+=chunk.length;if(bytes>32*1024*1024)throw new Error("插件请求过大");chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");}
export class TavernPluginHttp {
 onMvuChanged?:()=>unknown;
 readonly sources: TavernPluginSources; readonly store: TavernPluginStore; readonly internalToken=randomBytes(32).toString("hex");
 onChanged?:()=>void|Promise<void>; fallbackSources?:TavernPluginSources; candidate: TavernPluginCandidate|null=null; boundSourceEntryId?:string;
 private currentTurnSignal?:AbortSignal; private currentTurnNonce=randomBytes(24).toString("hex");
  internalPhase?:"after";
  mvuRecovery?:{head:TavernPluginContext & {scopeKey:string};sourceEntryId:string};
 get turnSignal(){return this.currentTurnSignal;}
 set turnSignal(value:AbortSignal|undefined){if(value!==this.currentTurnSignal){this.currentTurnSignal=value;this.currentTurnNonce=randomBytes(24).toString("hex");}}
 get turnNonce(){return this.currentTurnNonce;}
 readonly cwd:string;readonly host:TavernPluginHost;readonly assetsCwd:string;
 constructor(cwd:string,host:TavernPluginHost,assetsCwd=cwd){this.cwd=cwd;this.host=host;this.assetsCwd=assetsCwd;this.store=new TavernPluginStore(cwd);const network=join(cwd,".liyuan-tavern-plugins/network.json");const proxy=process.env.LIYUAN_TAVERN_GIT_PROXY??(existsSync(network)?(()=>{const stat=lstatSync(network);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>4096)throw new Error("插件网络配置类型无效");return JSON.parse(readFileSync(network,"utf8")).gitProxy;})():undefined);this.sources=new TavernPluginSources(cwd,{...(typeof proxy==="string"?{proxy}:{})});}
 binding(){const ctx=this.host.context();if(this.boundSourceEntryId){const index=ctx.chat.findIndex(message=>message.__liyuanEntryId===this.boundSourceEntryId);if(index<0)throw Object.assign(new Error("待恢复插件来源不在当前分支"),{statusCode:409});ctx.chat=ctx.chat.slice(0,index+1);ctx.sourceEntryId=this.boundSourceEntryId;ctx.visibleEntryIds=ctx.visibleEntryIds.slice(0,ctx.visibleEntryIds.indexOf(this.boundSourceEntryId)+1);}return {...ctx,scopeKey:tavernPluginScope(ctx)};}
  assertBinding(scope:string,source:string){const ctx=this.binding(),head=this.mvuRecovery?this.host.context():undefined;if(ctx.scopeKey!==scope||ctx.sourceEntryId!==source||head&&(tavernPluginScope(head)!==this.mvuRecovery!.head.scopeKey||head.sourceEntryId!==this.mvuRecovery!.head.sourceEntryId))throw Object.assign(new Error("会话、角色卡或分支已变化，迟到插件操作未执行"),{statusCode:409});return ctx;}
 private assetBytes(path:string){
  const match=path.match(/^\/tavern-compat\/scripts\/extensions\/third-party\/(JS-Slash-Runner|ST-Prompt-Template)\/(.+)$/);
  if(!match)return null;const plugin=match[1]==="JS-Slash-Runner"?"helper":"template";
  const relative=match[2];if(relative.includes("\\")||relative.split("/").some(x=>!x||x==="."||x===".."||x.startsWith(".")))throw new Error("非法插件文件路径");
  if(this.candidate?.id===plugin)return readTavernCandidateAsset(this.candidate,relative);
  return this.sources.readAsset(plugin,relative)??this.fallbackSources?.readAsset(plugin,relative)??null;
 }
 private asset(path:string){return this.assetBytes(path)?.path??null;}
 resolveOriginalAsset(path:string){return this.asset(path);}
 private sendFile(res:ServerResponse,path:string,bytes?:Buffer){const type=({".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".html":"text/html; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".ttf":"font/ttf"} as Record<string,string>)[extname(path)]??"application/octet-stream";res.writeHead(200,{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff"});res.end(bytes??readFileSync(path));}
 async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const raw=new URL(req.url??"/","http://localhost");const path=raw.pathname==="/version"?"/api/tavern-plugins/legacy/version":raw.pathname.startsWith("/scripts/extensions/third-party/JS-Slash-Runner/")?"/tavern-compat"+raw.pathname:raw.pathname;if(!path.startsWith("/api/tavern-plugins/")&&!path.startsWith("/tavern-compat/"))return false;
  try{
   if(path.startsWith("/tavern-compat/")){
    const module=path.slice("/tavern-compat".length),names=TAVERN_MODULE_IMPORTS[module];
    if(module.startsWith("/mvu/")){const file=mvuAsset(this.assetsCwd,module.slice(5));if(!file){response(res,404,{error:"原MVU资产未安装或校验不一致"});return true;}this.sendFile(res,file);return true;}
    if(module==="/scripts/extensions/regex/engine.js"){const file=tavernVendorAsset(this.assetsCwd,"regex-engine.js");if(!file)throw new Error("原酒馆正则依赖尚未安装");this.sendFile(res,file);return true;}
    if(names){res.writeHead(200,{"content-type":"text/javascript; charset=utf-8","cache-control":"no-store"});res.end(`const H=globalThis.LiyuanTavern;\n${names.map(name=>`export const ${name}=H.resolve(${JSON.stringify(module)},${JSON.stringify(name)});`).join("\n")}`);return true;}
    if(module.startsWith("/vendor/yaml/")){const rel=module.slice("/vendor/yaml/".length);if(rel.split("/").some(x=>x===".."||x.startsWith("."))||!rel.endsWith(".js"))throw new Error("非法依赖路径");const file=join(this.assetsCwd,"node_modules/yaml/browser",rel);if(!existsSync(file)){response(res,404,{error:"YAML依赖不存在"});return true;}this.sendFile(res,file);return true;}
    if(module.startsWith("/vendor/")){const file=tavernVendorAsset(this.assetsCwd,module.slice("/vendor/".length));if(!file){response(res,404,{error:"请先安装酒馆兼容依赖"});return true;}this.sendFile(res,file);return true;}
    const upstream=this.assetBytes(path);if(upstream){this.sendFile(res,upstream.path,upstream.bytes);return true;}
    if(["/bridge.js","/host.js","/host-base.js","/frontend-api.js","/i18n.js","/settings-ui.js","/settings-host.css","/mvu-adapter.js","/native-resources.js"].includes(module)){this.sendFile(res,join(this.assetsCwd,"web/public/tavern-compat",module==="/bridge.js"?"bridge-worldbooks.js":module==="/host.js"?"host-frontends.js":module==="/host-base.js"?"host-worldbooks.js":module.slice(1)));return true;}
    response(res,404,{error:"插件文件不存在或不是固定安装产物"});return true;
   }
   const route=path.slice("/api/tavern-plugins".length);
    if(route==="/binding"&&req.method==="GET"){const value=this.binding();response(res,200,{scopeKey:value.scopeKey,sourceEntryId:value.sourceEntryId,sessionId:value.sessionId,card:value.card});return true;}
    if(route==="/mvu/models"&&req.method==="POST"){
     const scope=String(req.headers["x-liyuan-tavern-scope"]??""),source=String(req.headers["x-liyuan-tavern-source"]??"");
     const ctx=this.assertBinding(scope,source),data=await body(req);this.assertBinding(scope,source);
     const model=ctx.mvu?.model,status=mvuStatus(this.assetsCwd);
     if(!status.enabled||!status.installed||!this.sources.status().plugins.some(p=>p.id==="helper"&&p.enabled&&p.installed))throw Error("原MVU与酒馆助手必须已安装并启用");
     if(!model)throw Error("未配置独立mvuParse受管连接");
     if(!data||typeof data!=="object"||Array.isArray(data))throw Error("MVU模型列表请求格式无效");
     const allowed=new Set(["model","chat_completion_source","custom_url","reverse_proxy","custom_include_headers","proxy_password"]);
     if(Object.keys(data).some(key=>!allowed.has(key)))throw Error("MVU模型列表不接受额外参数或凭据");
     // The pinned original sends an empty Bearer header even when no key is set.
     let headers:unknown={};try{if(data.custom_include_headers!==undefined)headers=JSON.parse(data.custom_include_headers);}catch{throw Error("MVU模型列表不接受自定义鉴权");}
     if(!headers||typeof headers!=="object"||Array.isArray(headers)||Object.entries(headers).some(([key,value])=>key.toLowerCase()!=="authorization"||typeof value!=="string"||value.trim()!=="Bearer")||data.proxy_password!==undefined&&data.proxy_password!=="")throw Error("MVU模型列表不接受自定义鉴权");
     const endpoint=managedMvuEndpoint(model.managedEndpoint);
     if(data.chat_completion_source!=="custom"||data.model!==model.id||data.custom_url===undefined&&data.reverse_proxy===undefined||[data.custom_url,data.reverse_proxy].some(value=>value!==undefined&&managedMvuEndpoint(value)!==endpoint))throw Error("MVU模型列表必须精确匹配受管端点与模型");
     const models=this.host.managedMvuModels?.()??[model];
     const ids=[...new Set(models.filter(item=>item.provider===model.provider&&managedMvuEndpoint(item.managedEndpoint)===endpoint).map(item=>item.id))].sort();
     const current=this.assertBinding(scope,source).mvu?.model;
     if(!current||current.provider!==model.provider||current.id!==model.id||current.managedEndpoint!==model.managedEndpoint)throw Object.assign(Error("MVU受管连接已变化，请刷新设置"),{statusCode:409});
     if(!ids.includes(model.id))throw Error("MVU受管模型已不在启用连接中");
     response(res,200,{data:ids.map(id=>({id}))});return true;
    }
   if(route==="/mvu/view"&&req.method==="GET"){const ctx=this.binding(),saved=this.store.read(ctx),helper=this.sources.status().plugins.find(p=>p.id==="helper");response(res,200,mvuManagementView(mvuStatus(this.assetsCwd),ctx,saved.state,{enabled:!!helper?.enabled,installed:!!helper?.installed},this.host.isStreaming(),this.host.mvuBusy?.()??false));return true;}
   if(route==="/mvu"&&req.method==="GET"){response(res,200,mvuStatus(this.assetsCwd));return true;}
   if(route==="/mvu"&&req.method==="PUT"){if(this.host.isStreaming()||this.host.mvuBusy?.())throw Object.assign(new Error("正在生成或处理原插件任务，MVU启停请稍后"),{statusCode:409});let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>1024)throw Error("MVU开关请求过大");}const body=JSON.parse(raw||"{}");if(typeof body.enabled!=="boolean")throw Error("enabled需为布尔值");if(this.host.isStreaming()||this.host.mvuBusy?.())throw Object.assign(new Error("正在生成或处理原插件任务，MVU启停请稍后"),{statusCode:409});const next=setMvuEnabled(this.assetsCwd,body.enabled);try{await this.onMvuChanged?.();}catch{throw Object.assign(new Error("MVU开关已保存，但运行时重载失败；请刷新状态核对，不重复提交"),{statusCode:500});}response(res,200,next);return true;}
   if(route==="/asset-map"&&req.method==="GET"){response(res,200,{...TAVERN_CDN_ASSETS,...mvuAssetMap(this.assetsCwd)});return true;}
   if(route==="/status"&&req.method==="GET"){const status=this.sources.status();response(res,200,{...status,compatibility:{host:"Liyuan adapters",storyAuthority:"Session Tree/rpNarrative",nativeTavern:false},runtimeEnabled:status.plugins.some(p=>p.installed&&p.enabled)});return true;}
   if(route==="/context"&&req.method==="GET"){
     const ctx=this.binding(),saved=this.store.read(this.mvuRecovery?.head??ctx);if(this.mvuRecovery)(ctx as TavernPluginContext & {mvuHistoricalRecovery?:boolean}).mvuHistoricalRecovery=true;const statuses=this.fallbackSources?.status().plugins??this.sources.status().plugins;
     if(this.mvuRecovery){
      const visible=new Set(ctx.visibleEntryIds);saved.state.messages=Object.fromEntries(Object.entries(saved.state.messages).filter(([id])=>visible.has(id)));
      // User floors may retain a frozen pre-repair copy. Project the repaired preceding
      // assistant state as the next turn's basis; this projection is never published.
      let basis:unknown;for(const row of ctx.chat.slice(0,-1)){const id=String(row.__liyuanEntryId),fields=saved.state.messages[id];if(!row.is_user&&fields?.variables)basis=fields.variables;else if(row.is_user&&basis)saved.state.messages[id]={...fields,variables:structuredClone(basis)};}
     }
     response(res,200,{...ctx,...saved,mvu:{...mvuStatus(this.assetsCwd),...ctx.mvu},plugins:statuses.map(p=>({id:p.id,enabled:p.enabled&&p.installed,version:p.version})),...(this.candidate?{plugins:statuses.map(p=>({id:p.id,enabled:p.id===this.candidate!.id||p.enabled&&p.installed,version:p.id===this.candidate!.id?this.candidate!.version:p.version}))}:{})});return true;
   }
   if(route==="/legacy/characters/edit"&&req.method==="POST"){
    const scope=String(req.headers["x-liyuan-tavern-scope"]??""),source=String(req.headers["x-liyuan-tavern-source"]??"");const ctx=this.assertBinding(scope,source);
    if(this.host.isStreaming()&&req.headers["x-liyuan-tavern-host"]!==this.internalToken)throw Object.assign(new Error("正在生成，角色插件扩展请稍后保存"),{statusCode:409});
    let size=0;const chunks:Buffer[]=[];for await(const value of req){const chunk=Buffer.from(value);if((size+=chunk.length)>4*1024*1024)throw new Error("角色插件扩展请求过大");chunks.push(chunk);}
    const form=await new Response(Buffer.concat(chunks),{headers:{"content-type":String(req.headers["content-type"]??"")}}).formData();this.assertBinding(scope,source);
    const character=ctx.character,data=character.data as Record<string,unknown>;
    if(form.get("avatar_url")!==character.avatar)throw Object.assign(new Error("角色身份已变化，未保存扩展"),{statusCode:409});
    for(const key of ["description","personality","scenario","first_mes","mes_example"]){if(form.has(key)&&form.get(key)!==String(data[key]??character[key]??""))throw new Error("此插件接口仅保存派生扩展，不能改生产卡字段");}
    const extensions=JSON.parse(String(form.get("extensions")??"{}"));const saved=this.store.read(ctx);const state={...saved.state,characterExtensions:extensions};validateTavernPluginState(state,new Set([...ctx.visibleEntryIds,ctx.sourceEntryId]),new Set(Object.keys(ctx.readonlyBooks)));
    const revision=Number(req.headers["x-liyuan-tavern-revision"]);const result=this.store.save(ctx,Number.isSafeInteger(revision)?revision:saved.revision,state,()=>this.assertBinding(scope,source));response(res,200,result);return true;
   }
   if(route==="/legacy/extensions/version"&&req.method==="POST"){
    const scope=String(req.headers["x-liyuan-tavern-scope"]??""),source=String(req.headers["x-liyuan-tavern-source"]??"");
    this.assertBinding(scope,source);const data=await body(req);this.assertBinding(scope,source);
    const plugin=Object.entries(slugs).find(([,slug])=>slug===data.extensionName)?.[0] as keyof typeof slugs|undefined;
    if(!plugin||data.global!==undefined&&data.global!==false)throw new Error("仅支持查询当前已安装的固定来源扩展");
    const status=(this.fallbackSources?.status()??this.sources.status()).plugins.find(row=>row.id===plugin&&row.installed);
    if(!status)throw Object.assign(new Error("该固定来源扩展尚未安装"),{statusCode:404});
    response(res,200,{currentBranchName:"pinned",currentCommitHash:status.commit,remoteUrl:TAVERN_PLUGIN_UPSTREAMS[plugin].repository});return true;
   }
   if(route.startsWith("/legacy/")){if(route==="/legacy/version"){response(res,200,{pkgVersion:"1.13.4",liyuanCompat:true});return true;}if(route==="/legacy/worldinfo/get"){const data=await body(req);const ctx=this.binding();const derived=this.store.read(ctx).state.worldbooks;const value=ctx.readonlyBooks[data.name]??derived[data.name];if(!value)throw new Error("世界书不存在");response(res,200,{entries:Object.fromEntries(value.entries.map((e:any)=>[e.entryKey??e.uid,e]))});return true;}response(res,400,{error:"此酒馆服务器操作尚未适配，不执行生产写入"});return true;}
   if(route==="/config"&&req.method==="PUT"){if(this.host.isStreaming())throw new Error("生成期间不能切换插件；请结束后重试");const data=await body(req);const result=this.sources.configure(id(data.id),{...(typeof data.enabled==="boolean"?{enabled:data.enabled}:{}),...(typeof data.autoUpdate==="boolean"?{autoUpdate:data.autoUpdate}:{})});await this.onChanged?.();response(res,200,result);return true;}
   if(["/install","/check","/update","/rollback"].includes(route)&&req.method==="POST"){const data=await body(req);const plugin=id(data.id);const activeBefore=JSON.stringify(this.sources.status().plugins.map(p=>[p.id,p.commit,p.sha256]));if(route!=="/check")await ensureTavernPluginVendors(this.cwd,{proxy:process.env.LIYUAN_TAVERN_GIT_PROXY??(existsSync(join(this.cwd,".liyuan-tavern-plugins/network.json"))?JSON.parse(readFileSync(join(this.cwd,".liyuan-tavern-plugins/network.json"),"utf8")).gitProxy:undefined)});const value=route==="/install"?await this.sources.install(plugin):route==="/check"?await this.sources.checkUpdate(plugin):route==="/update"?await this.sources.update(plugin):await this.sources.rollback(plugin);if(route!=="/check"&&JSON.stringify(this.sources.status().plugins.map(p=>[p.id,p.commit,p.sha256]))!==activeBefore)await this.onChanged?.();response(res,200,value);return true;}
   const internal=req.headers["x-liyuan-tavern-host"]===this.internalToken;
   const ctx=this.assertBinding(String(req.headers["x-liyuan-tavern-scope"]??""),String(req.headers["x-liyuan-tavern-source"]??""));
   if(route==="/state"&&req.method==="POST"){
    const entryNonce=this.turnNonce,entrySignal=this.turnSignal;
     const guard=()=>{
      this.assertBinding(ctx.scopeKey,ctx.sourceEntryId);
      if(this.mvuRecovery&&!internal)throw Object.assign(new Error('历史MVU恢复正在持有作用域，外部状态保存请稍后'),{statusCode:409});
     if(req.aborted||res.destroyed||internal&&(req.headers["x-liyuan-tavern-turn"]!==entryNonce||entryNonce!==this.turnNonce||entrySignal?.aborted))throw Object.assign(new Error("回合已取消或换代，迟到插件状态未写入"),{statusCode:409});
     if(this.host.isStreaming()&&!internal)throw Object.assign(new Error("正在生成，前端插件状态写入请稍后重试"),{statusCode:409});
    };
     guard();const data=await body(req);guard();let state=validateTavernPluginState(data.state,new Set([...ctx.visibleEntryIds,ctx.sourceEntryId]),new Set(Object.keys(ctx.readonlyBooks)));
     const recovery=this.mvuRecovery;
     if(recovery){
      const current=this.host.context();if(tavernPluginScope(current)!==recovery.head.scopeKey||current.sourceEntryId!==recovery.head.sourceEntryId)throw Error('历史MVU恢复的当前分支已变化');
      const merged=this.store.read(recovery.head).state,id=recovery.sourceEntryId;
      merged.messages[id]={...merged.messages[id],variables:state.messages[id]?.variables};
      const receipts=merged.chatMetadata.__liyuanMvuProcessed as Record<string,unknown>??{};
      const receipt=(state.chatMetadata.__liyuanMvuProcessed as Record<string,unknown>)?.[id];if(receipt!==undefined)receipts[id]=receipt;
      merged.chatMetadata.__liyuanMvuProcessed=receipts;state=merged;
     }
     const result=this.store.save(recovery?.head??ctx,data.revision,state,guard);response(res,200,result);return true;
   }
   if(route==="/generate"&&req.method==="POST"){
     const entrySignal=this.turnSignal,entryNonce=this.turnNonce,entryPhase=this.internalPhase,abort=new AbortController();
    req.once("aborted",()=>abort.abort());res.once("close",()=>{if(!res.writableEnded)abort.abort();});
    const signal=internal&&entrySignal?AbortSignal.any([abort.signal,entrySignal]):abort.signal;
    const guard=(initial=false)=>{
     this.assertBinding(ctx.scopeKey,ctx.sourceEntryId);
     if(signal.aborted||req.aborted||res.destroyed||entryNonce!==this.turnNonce||
        internal&&(!entrySignal||entrySignal!==this.turnSignal||entrySignal.aborted||req.headers["x-liyuan-tavern-turn"]!==entryNonce))
      throw Object.assign(new Error("脚本辅助请求已取消或所属回合已换代，未调用／接受模型结果"),{statusCode:409});
     if(!this.sources.status().plugins.some(p=>p.enabled&&p.installed))throw Object.assign(new Error("酒馆插件未启用，不能调用脚本模型通道"),{statusCode:initial?400:409});
     if(this.host.isStreaming()&&!internal)throw Object.assign(new Error("主作者正在生成，外部脚本不能并发调用模型"),{statusCode:409});
    };
    guard(true);if(!this.host.generate)throw new Error("宿主没有启用脚本模型请求");
     const data=await body(req);if(!Array.isArray(data.messages)||data.messages.length>200||data.messages.some((m:any)=>!m||!["system","user","assistant"].includes(m.role)||typeof m.content!=="string")||data.messages.reduce((n:number,m:any)=>n+m.content.length,0)>240000)throw new Error("脚本模型消息格式无效或超出请求预算");
     const custom=data.chat_completion_source==="custom"||data.reverse_proxy!==undefined||data.model!==undefined||data.purpose==="mvu.parse";
      const mvuGuard=()=>{guard();if(!custom)return;const status=mvuStatus(this.assetsCwd),settings=this.store.read(this.mvuRecovery?.head??ctx).state.extensionSettings.mvu_settings as any;
      if(!internal||entryPhase!=="after"||this.internalPhase!==entryPhase||!status.enabled||!status.installed||settings?.更新方式!=="额外模型解析"||settings?.额外模型解析配置?.模型来源!=="自定义")throw Error("自定义模型请求仅允许当前MVU额外解析的受信任拍后任务");
      const config=settings.额外模型解析配置;if(config.模型名称!==data.model||managedMvuEndpoint(config.api地址)!==managedMvuEndpoint(data.reverse_proxy)||config.密钥)throw Error("MVU请求与当前设置不匹配或包含非受管鉴权");
     };
     mvuGuard();tavernSampler(data,8192);let claimed=false;const claimRequest=()=>{mvuGuard();if(claimed)throw Error("脚本模型请求不能重复计费");this.store.recordModelRequest(ctx,mvuGuard);claimed=true;};
     // Never refund automatically: even a cancelled/network-failed attempt may already have been billed.
     if(!this.host.generateManagesBudget)claimRequest();
     const content=await this.host.generate(data.messages,signal,{purpose:custom?"mvu.parse":"tavern-helper",payload:data,scope:{sessionId:ctx.sessionId,card:ctx.card??""},sourceEntryId:ctx.sourceEntryId,validateBinding:mvuGuard,claimRequest});mvuGuard();
    response(res,200,{choices:[{message:{role:"assistant",content},finish_reason:"stop"}],candidateOnly:true});return true;
   }
   if(route==="/cancel"&&req.method==="POST"){this.host.cancel?.();response(res,200,{ok:true});return true;}
   response(res,404,{error:"未知插件宿主接口"});return true;
  }catch(error){const code=(error as any).code;response(res,code==="ENOSPC"||code==="EDQUOT"?507:(error as any).statusCode??400,{error:error instanceof Error?error.message:"插件操作失败"});return true;}
 }
}
