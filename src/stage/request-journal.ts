import { requestFailure, type RequestFailure } from "./request-failure.ts";
import { modelResponseFailure } from "./model-failure.ts";
import { abortable, abortableEvents } from "../async-abort.ts";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TransportObservation } from "@liyuan/ai";
export interface RequestScope {sessionId:string;card:string}
export interface RequestRecord {transport?:Array<TransportObservation & {elapsedMs:number}>;endpointHash?:string}
export interface RequestRecord {failure?:RequestFailure;version:1;id:string;scope:RequestScope;sourceEntryId:string;groupId?:string;narrativeEntryId?:string;phase:string;provider:string;model:string;startedAt:string;durationMs?:number;firstTokenMs?:number;status:"running"|"success"|"failed"|"aborted";capture:"sdk-context"|"api-payload";context?:unknown;payload?:unknown;usage?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number;totalTokens?:number};usageSource:"missing"|"provider-sdk";processId?:number;stopReason?:string}
const hash=(scope:RequestScope)=>createHash("sha256").update(JSON.stringify([scope.sessionId,scope.card])).digest("hex");
const secret=/^(?:headers|apiKey|api_key|authorization|cookie|password|access_token|refresh_token)$/i;
/** Only the pre-story plot worker has a session/card root source; never grant arbitrary root access. */
const visibleRequest = (row: RequestRecord, visible: Set<string>): boolean => visible.has(row.narrativeEntryId ?? row.sourceEntryId) || !row.narrativeEntryId && row.sourceEntryId === "root" && ["dailyPlot", "plot.embedding"].includes(row.phase);
function clean(value:unknown,depth=0):unknown {if(Array.isArray(value))return value.map(v=>clean(v,depth+1));if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>depth>0||!secret.test(key)).map(([key,v])=>[key,clean(v,depth+1)]));return value;}
export class RequestJournal {
 readonly root:string;
 constructor(cwd:string){this.root=join(cwd,".liyuan","request-journal");}
 #directory(scope:RequestScope){return join(this.root,hash(scope));}
 #write(row:RequestRecord){const folder=this.#directory(row.scope);mkdirSync(folder,{recursive:true,mode:0o700});const file=join(folder,row.id+".json"),temp=file+".tmp";writeFileSync(temp,JSON.stringify(row),{mode:0o600});renameSync(temp,file);const meta=join(folder,row.id+".meta.json"),metaTemp=meta+".tmp";writeFileSync(metaTemp,JSON.stringify(requestSummary(row)),{mode:0o600});renameSync(metaTemp,meta);}
  begin(input:Pick<RequestRecord,"scope"|"sourceEntryId"|"groupId"|"phase"|"provider"|"model">,context:unknown,baseUrl?:string){
  const start=performance.now();let row:RequestRecord={version:1,...input,id:randomUUID(),startedAt:new Date().toISOString(),status:"running",processId:process.pid,capture:"sdk-context",context:clean(context),usageSource:"missing"};
   if(baseUrl)row.endpointHash=createHash("sha256").update(baseUrl).digest("hex");
   this.#write(row);let closed=false;
   const transport=(event:TransportObservation)=>{
    if(closed||!['transportStarted','responseHeaders','firstByte','firstEffectiveDelta','bodyEnd','transportError'].includes(event.type)||!/^[a-f0-9-]{36}$/.test(event.traceId)||!Number.isFinite(event.timestamp))return;
    const receipt:TransportObservation & {elapsedMs:number}={type:event.type,traceId:event.traceId,timestamp:event.timestamp,elapsedMs:Math.max(0,Math.round(performance.now()-start))};
    if(typeof event.status==='number'&&Number.isInteger(event.status)&&event.status>=100&&event.status<=599)receipt.status=event.status;
    if(event.requestId&&/^[A-Za-z0-9_.:-]{1,128}$/.test(event.requestId))receipt.requestId=event.requestId;
    if(event.errorCode&&/^(?:UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORT_ERR)$/.test(event.errorCode))receipt.errorCode=event.errorCode;
    row.transport??=[];if(row.transport.length>=128)return;row.transport.push(receipt);try{this.#write(row);}catch{}
   };
  return {id:row.id,payload:(value:unknown)=>{if(closed)return;row={...row,payload:clean(value),capture:"api-payload"};this.#write(row);},first:()=>{if(!closed&&row.firstTokenMs===undefined){row.firstTokenMs=Math.max(0,Math.round(performance.now()-start));try{this.#write(row);}catch{/* Observability cannot interrupt a live model stream. */}}},end:(status:RequestRecord["status"],usage?:unknown,stopReason?:string,failure?:RequestFailure)=>{
   if(closed)return;closed=true;row.status=status;row.durationMs=Math.max(0,Math.round(performance.now()-start));row.stopReason=stopReason;if(failure)row.failure=failure;
   if(usage&&typeof usage==="object"){const raw=usage as Record<string,unknown>,numbers=Object.fromEntries(["input","output","cacheRead","cacheWrite","totalTokens"].flatMap(key=>typeof raw[key]==="number"&&Number.isFinite(raw[key])&&Number(raw[key])>=0?[[key,raw[key]]]:[]));if(Object.values(numbers).some(n=>Number(n)>0)){row.usage=numbers;row.usageSource="provider-sdk";}}
   this.#write(row);this.#prune(input.scope);
   },transport};
 }
 list(scope:RequestScope,visible:Set<string>,includeDetails=true):RequestRecord[]{let files:string[];try{files=readdirSync(this.#directory(scope));}catch{return [];}return files.filter(file=>/^[\w-]+\.json$/.test(file)).flatMap(file=>{try{const meta=file.replace(/\.json$/,".meta.json"),preferred=includeDetails?file:files.includes(meta)?meta:file;const row=JSON.parse(readFileSync(join(this.#directory(scope),preferred),"utf8"))as RequestRecord;if(row.version!==1||row.scope?.sessionId!==scope.sessionId||row.scope?.card!==scope.card||!visibleRequest(row,visible))return [];return [row.status==="running"&&row.processId!==undefined&&row.processId!==process.pid?{...row,status:"aborted" as const,stopReason:"process-restarted-without-final-receipt"}:row];}catch{return [];}}).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));}
 detail(scope:RequestScope,visible:Set<string>,id:string){if(!/^[a-f0-9-]{36}$/.test(id)||!this.list(scope,visible,false).some(row=>row.id===id))return undefined;try{const row=JSON.parse(readFileSync(join(this.#directory(scope),id+".json"),"utf8"))as RequestRecord;if(row.id!==id||row.scope.sessionId!==scope.sessionId||row.scope.card!==scope.card||!visibleRequest(row,visible))return undefined;return row.status==="running"&&row.processId!==undefined&&row.processId!==process.pid?{...row,status:"aborted" as const,stopReason:"process-restarted-without-final-receipt"}:row;}catch{return undefined;}}
  bindGroup(scope:RequestScope,groupId:string,narrativeEntryId:string,userEntryId?:string,startedAfter?:number){const visible=new Set<string>();const folder=this.#directory(scope);let files:string[];try{files=readdirSync(folder);}catch{return;}for(const file of files){if(!file.endsWith(".json")||file.endsWith(".meta.json"))continue;try{const row=JSON.parse(readFileSync(join(folder,file),"utf8"))as RequestRecord;if(row.groupId===groupId||(!row.groupId&&row.sourceEntryId===userEntryId&&["database","database.before","tavern-helper","embedding"].includes(row.phase)&&Date.parse(row.startedAt)>=(startedAfter??Infinity))){row.groupId=groupId;row.narrativeEntryId=narrativeEntryId;this.#write(row);}}catch{}}void visible;}
 #prune(scope:RequestScope){const folder=this.#directory(scope);let files=readdirSync(folder).filter(f=>f.endsWith(".json")&&!f.endsWith(".meta.json")).map(file=>({file,size:statSync(join(folder,file)).size,time:statSync(join(folder,file)).mtimeMs})).sort((a,b)=>b.time-a.time);let bytes=0;for(const [index,file]of files.entries()){bytes+=file.size;if(index>=100||bytes>64*1024*1024){unlinkSync(join(folder,file.file));try{unlinkSync(join(folder,file.file.replace(/\.json$/,".meta.json")));}catch{}}}}
}
export function requestSummary(row:RequestRecord){const{context,payload,...summary}=row;void context;void payload;return summary;}

/** The SDK applies this known non-streaming transformation after onPayload. Only project the receipt, not the request. */
export function requestPayloadSnapshot(value: unknown, model: { api?: unknown; compat?: { streaming?: unknown } }): unknown {
 if (model.api !== "openai-completions" || model.compat?.streaming !== false || !value || typeof value !== "object" || Array.isArray(value)) return value;
 const snapshot = { ...(value as Record<string, unknown>), stream: false }; delete (snapshot as Record<string, unknown>).stream_options; return snapshot;
}

/** Observe a real SDK invocation outside the story collector (director room/plugins). */
export function captureSdkCall(cwd:string,scope:RequestScope,sourceEntryId:string,phase:string,model:any,context:any,options:any,run:(model:any,context:any,options:any)=>any):any {
 let record:ReturnType<RequestJournal["begin"]>|undefined;
  try{record=new RequestJournal(cwd).begin({scope,sourceEntryId,phase,provider:String(model.provider??""),model:String(model.id??"")},context,model.baseUrl);}catch{}
  const previous=options?.onPayload;
  options=withRequestTransport(options??{},record);
 let source:any;
 try{source=run(model,context,{...options,onPayload:async(value:unknown,actual:any)=>{const next=await previous?.(value,actual)??value;try{record?.payload(requestPayloadSnapshot(next,actual));}catch{}return next;}});}catch(error){try{record?.end("failed",undefined,undefined,requestFailure(error,options?.signal,options?.apiKey));}catch{}throw error;}
 let terminalMessage:any;
 const finish=(message:any,error?:unknown)=>{
  if(message)terminalMessage=message;
  const cause=error??modelResponseFailure(message);
  const failure=cause!==undefined?requestFailure(cause,options?.signal,options?.apiKey):undefined;
  try{record?.end(failure?(failure.origin==="cancelled"?"aborted":"failed"):"success",message?.usage,message?.stopReason,failure);}catch{}
 };
 return {
  async *[Symbol.asyncIterator](){
    try{for await(const event of abortableEvents<any>(source,options?.signal)){if(event.type==="text_delta"||event.type==="thinking_delta")record?.first();if(event.type==="done"||event.type==="error"){finish(event.message??event.error,event.type==="error"?event.error instanceof Error?event.error:event.error?.errorMessage??modelResponseFailure(event.error)??"Provider stream error":undefined);yield event;return;}yield event;}finish(undefined,"Provider stream ended without a terminal message");}
   catch(error){finish(undefined,error);throw error;}

  },
  async result(){try{if(terminalMessage)return terminalMessage;const value=await abortable(source.result(),options?.signal);finish(value);return value;}catch(error){finish(undefined,error);throw error;}}
 };
}

export function withRequestTransport<T extends Record<string,unknown>>(options:T,record:ReturnType<RequestJournal["begin"]>|undefined):T {
 const previous=options.onTransport;
 return {...options,onTransport:(event:TransportObservation)=>{try{record?.transport(event);}catch{}try{if(typeof previous==='function')previous(event);}catch{}}};
}
