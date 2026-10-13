import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
export interface RequestScope {sessionId:string;card:string}
export interface RequestRecord {version:1;id:string;scope:RequestScope;sourceEntryId:string;groupId?:string;narrativeEntryId?:string;phase:string;provider:string;model:string;startedAt:string;durationMs?:number;firstTokenMs?:number;status:"running"|"success"|"failed"|"aborted";capture:"sdk-context"|"api-payload";context?:unknown;payload?:unknown;usage?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number;totalTokens?:number};usageSource:"missing"|"provider-sdk";processId?:number;stopReason?:string}
const hash=(scope:RequestScope)=>createHash("sha256").update(JSON.stringify([scope.sessionId,scope.card])).digest("hex");
const secret=/^(?:headers|apiKey|api_key|authorization|cookie|password|access_token|refresh_token)$/i;
function clean(value:unknown,depth=0):unknown {if(Array.isArray(value))return value.map(v=>clean(v,depth+1));if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>depth>0||!secret.test(key)).map(([key,v])=>[key,clean(v,depth+1)]));return value;}
export class RequestJournal {
 readonly root:string;
 constructor(cwd:string){this.root=join(cwd,".liyuan","request-journal");}
 #directory(scope:RequestScope){return join(this.root,hash(scope));}
 #write(row:RequestRecord){const folder=this.#directory(row.scope);mkdirSync(folder,{recursive:true,mode:0o700});const file=join(folder,row.id+".json"),temp=file+".tmp";writeFileSync(temp,JSON.stringify(row),{mode:0o600});renameSync(temp,file);const meta=join(folder,row.id+".meta.json"),metaTemp=meta+".tmp";writeFileSync(metaTemp,JSON.stringify(requestSummary(row)),{mode:0o600});renameSync(metaTemp,meta);}
 begin(input:Pick<RequestRecord,"scope"|"sourceEntryId"|"groupId"|"phase"|"provider"|"model">,context:unknown){
  const start=performance.now();let row:RequestRecord={version:1,...input,id:randomUUID(),startedAt:new Date().toISOString(),status:"running",processId:process.pid,capture:"sdk-context",context:clean(context),usageSource:"missing"};
  this.#write(row);let closed=false;
  return {id:row.id,payload:(value:unknown)=>{if(closed)return;row={...row,payload:clean(value),capture:"api-payload"};this.#write(row);},first:()=>{if(row.firstTokenMs===undefined)row.firstTokenMs=Math.max(0,Math.round(performance.now()-start));},end:(status:RequestRecord["status"],usage?:unknown,stopReason?:string)=>{
   if(closed)return;closed=true;row.status=status;row.durationMs=Math.max(0,Math.round(performance.now()-start));row.stopReason=stopReason;
   if(usage&&typeof usage==="object"){const raw=usage as Record<string,unknown>,numbers=Object.fromEntries(["input","output","cacheRead","cacheWrite","totalTokens"].flatMap(key=>typeof raw[key]==="number"&&Number.isFinite(raw[key])&&Number(raw[key])>=0?[[key,raw[key]]]:[]));if(Object.values(numbers).some(n=>Number(n)>0)){row.usage=numbers;row.usageSource="provider-sdk";}}
   this.#write(row);this.#prune(input.scope);
  }};
 }
 list(scope:RequestScope,visible:Set<string>,includeDetails=true):RequestRecord[]{let files:string[];try{files=readdirSync(this.#directory(scope));}catch{return [];}return files.filter(file=>/^[\w-]+\.json$/.test(file)).flatMap(file=>{try{const meta=file.replace(/\.json$/,".meta.json"),preferred=includeDetails?file:files.includes(meta)?meta:file;const row=JSON.parse(readFileSync(join(this.#directory(scope),preferred),"utf8"))as RequestRecord;if(row.version!==1||row.scope?.sessionId!==scope.sessionId||row.scope?.card!==scope.card||!visible.has(row.narrativeEntryId??row.sourceEntryId))return [];return [row.status==="running"&&row.processId!==undefined&&row.processId!==process.pid?{...row,status:"aborted" as const,stopReason:"process-restarted-without-final-receipt"}:row];}catch{return [];}}).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));}
 detail(scope:RequestScope,visible:Set<string>,id:string){if(!/^[a-f0-9-]{36}$/.test(id)||!this.list(scope,visible,false).some(row=>row.id===id))return undefined;try{const row=JSON.parse(readFileSync(join(this.#directory(scope),id+".json"),"utf8"))as RequestRecord;if(row.id!==id||row.scope.sessionId!==scope.sessionId||row.scope.card!==scope.card||!visible.has(row.narrativeEntryId??row.sourceEntryId))return undefined;return row.status==="running"&&row.processId!==undefined&&row.processId!==process.pid?{...row,status:"aborted" as const,stopReason:"process-restarted-without-final-receipt"}:row;}catch{return undefined;}}
  bindGroup(scope:RequestScope,groupId:string,narrativeEntryId:string,userEntryId?:string,startedAfter?:number){const visible=new Set<string>();const folder=this.#directory(scope);let files:string[];try{files=readdirSync(folder);}catch{return;}for(const file of files){if(!file.endsWith(".json")||file.endsWith(".meta.json"))continue;try{const row=JSON.parse(readFileSync(join(folder,file),"utf8"))as RequestRecord;if(row.groupId===groupId||(!row.groupId&&row.sourceEntryId===userEntryId&&["database","database.before","tavern-helper","embedding"].includes(row.phase)&&Date.parse(row.startedAt)>=(startedAfter??Infinity))){row.groupId=groupId;row.narrativeEntryId=narrativeEntryId;this.#write(row);}}catch{}}void visible;}
 #prune(scope:RequestScope){const folder=this.#directory(scope);let files=readdirSync(folder).filter(f=>f.endsWith(".json")&&!f.endsWith(".meta.json")).map(file=>({file,size:statSync(join(folder,file)).size,time:statSync(join(folder,file)).mtimeMs})).sort((a,b)=>b.time-a.time);let bytes=0;for(const [index,file]of files.entries()){bytes+=file.size;if(index>=100||bytes>64*1024*1024){unlinkSync(join(folder,file.file));try{unlinkSync(join(folder,file.file.replace(/\.json$/,".meta.json")));}catch{}}}}
}
export function requestSummary(row:RequestRecord){const{context,payload,...summary}=row;void context;void payload;return summary;}

/** Observe a real SDK invocation outside the story collector (director room/plugins). */
export function captureSdkCall(cwd:string,scope:RequestScope,sourceEntryId:string,phase:string,model:any,context:any,options:any,run:(model:any,context:any,options:any)=>any):any {
 let record:ReturnType<RequestJournal["begin"]>|undefined;
 try{record=new RequestJournal(cwd).begin({scope,sourceEntryId,phase,provider:String(model.provider??""),model:String(model.id??"")},context);}catch{}
 const previous=options?.onPayload;
 let source:any;
 try{source=run(model,context,{...options,onPayload:async(value:unknown,actual:any)=>{const next=await previous?.(value,actual)??value;try{record?.payload(next);}catch{}return next;}});}catch(error){try{record?.end("failed");}catch{}throw error;}
 const finish=(message:any)=>{try{record?.end(message?.stopReason==="aborted"?"aborted":message?.stopReason==="error"?"failed":"success",message?.usage,message?.stopReason);}catch{}};
 return {async *[Symbol.asyncIterator](){try{for await(const event of source){if(event.type==="text_delta"||event.type==="thinking_delta")record?.first();if(event.type==="done"||event.type==="error")finish(event.message??event.error);yield event;}}catch(error){try{record?.end(options.signal?.aborted?"aborted":"failed");}catch{}throw error;}},async result(){try{const value=await source.result();finish(value);return value;}catch(error){try{record?.end("failed");}catch{}throw error;}}};
}
