/** Post-author style projection. Original author/narrative remain the sole story source. */
import {createHash}from'node:crypto';
import type {NpcParallelScope,NpcParallelModelRequest}from'./npc-parallel.ts';
export interface VeridisRewriteModelRequest extends NpcParallelModelRequest {useProviderDefaultMaxTokens?:boolean}
export const VERIDIS_REWRITE_ENTRY_TYPE='rp-veridis-rewrite';
export const authorDraftHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export interface VeridisRewriteInput {scope:NpcParallelScope;authorDraft:string;narrative:string;signal?:AbortSignal;guard:()=>void;generate:(request:VeridisRewriteModelRequest,signal?:AbortSignal)=>Promise<string>}
export interface VeridisRewriteResult {text:string;changed:boolean;calls:number;errors:string[];version:string;commit:string;skipped?:boolean;reason?:string;hits?:number|unknown[];projectionMode?:'native'|'ai-targets-only'}
export interface VeridisRewriteProvider {enabled():boolean;run(input:VeridisRewriteInput):Promise<VeridisRewriteResult>;claimRequest(scope:NpcParallelScope,guard:()=>void):void}
export interface VeridisRewriteReceipt {version:1;sourceEntryId:string;authorHash:string;upstreamVersion:string;upstreamCommit:string;status:'complete'|'skipped'|'failed';changed:boolean;calls:number;text?:string;error?:string;reason?:string;hits?:number|unknown[];projectionMode?:'native'|'ai-targets-only'}
/** Structural guard only. It does NOT prove that a model preserved every literary/semantic detail. */
export function protectedRewriteSlices(text:string):string[]{
 const ranges:Array<{start:number;end:number}>=[];
 const opaque:Array<{start:number;end:number}>=[];
 for(const match of text.matchAll(/```[^\n]*\n[\s\S]*?(?:```|$)|<!--[\s\S]*?(?:-->|$)/g)){
  const span={start:match.index!,end:match.index!+match[0].length};opaque.push(span);ranges.push(span);
 }
 const protectedTags=new Set(['updatevariable','options','jsonpatch','initvar','script','style']);
 const stacks=new Map<string,number[]>();
 // Any original Unicode/HTML/XML tag is protected byte-for-byte. Quoted '>' does not terminate an attribute early.
 for(const match of text.matchAll(/<\/?([^\s<>/]+)(?:"[^"]*"|'[^']*'|[^"'<>])*>/gu)){
  const start=match.index!,end=start+match[0].length;
  if(opaque.some(span=>start>=span.start&&start<span.end))continue;
  const name=match[1].toLowerCase();ranges.push({start,end});
  if(!protectedTags.has(name)||/\/\s*>$/.test(match[0]))continue;
  const stack=stacks.get(name)??[];stacks.set(name,stack);
  if(!match[0].startsWith('</'))stack.push(start);
  else{const opened=stack.pop();if(opened!==undefined)ranges.push({start:opened,end});}
 }
 for(const stack of stacks.values())for(const start of stack)ranges.push({start,end:text.length});
 const merged:Array<{start:number;end:number}>=[];
 for(const span of ranges.sort((a,b)=>a.start-b.start||b.end-a.end)){const last=merged.at(-1);if(last&&span.start<last.end)last.end=Math.max(last.end,span.end);else merged.push({...span});}
 return merged.map(span=>text.slice(span.start,span.end));
}
export function validateRewriteProjection(original:string,rewritten:string):void {
 if(typeof rewritten!=='string'||(!rewritten.trim()&&original.trim())||rewritten.length>Math.max(original.length*3,original.length+10000))throw Error('净化显示稿为空或异常膨胀');
 if(JSON.stringify(protectedRewriteSlices(original))!==JSON.stringify(protectedRewriteSlices(rewritten)))throw Error('净化候选改动了原格式、变量或行动选项，未用于显示');
}
export function rewriteReceiptFromBranch(branch:Array<{customType?:string;data?:unknown}>,sourceEntryId:string,original?:string):VeridisRewriteReceipt|undefined{
 for(let i=branch.length-1;i>=0;i--){const e=branch[i],d=e.data as VeridisRewriteReceipt|undefined;if(e.customType!==VERIDIS_REWRITE_ENTRY_TYPE||d?.version!==1||d.sourceEntryId!==sourceEntryId)continue;if(original!==undefined&&d.authorHash!==authorDraftHash(original))continue;return d;}
}
export async function computeVeridisRewrite(provider:VeridisRewriteProvider,input:VeridisRewriteInput):Promise<VeridisRewriteReceipt>{
 const base={version:1 as const,sourceEntryId:input.scope.sourceEntryId,authorHash:authorDraftHash(input.authorDraft),changed:false,calls:0,upstreamVersion:'',upstreamCommit:''};
 try{
  input.guard();if(input.signal?.aborted)throw Error('净化任务已取消');
  const result=await provider.run({...input,generate:async(request,signal)=>{base.calls++;return input.generate(request,signal);}});Object.assign(base,{calls:Math.max(base.calls,result.calls),upstreamVersion:result.version,upstreamCommit:result.commit});input.guard();if(input.signal?.aborted)throw Error('净化任务已取消');
  if(!/^[a-f0-9]{40}$/.test(result.commit)||!result.version)throw Error('净化插件来源无效');
  if(result.errors.length)throw Error(result.errors.join('；'));
  validateRewriteProjection(input.authorDraft,result.text);
  return{...base,status:result.skipped?'skipped':'complete',changed:result.text!==input.authorDraft,calls:Math.max(base.calls,result.calls),upstreamVersion:result.version,upstreamCommit:result.commit,...(result.skipped?{}:{text:result.text}),...(result.reason?{reason:result.reason}:{}),...(result.hits?{hits:result.hits}:{}),...(result.projectionMode?{projectionMode:result.projectionMode}:{})};
 }catch(error){return{...base,status:'failed',error:error instanceof Error?error.message:'净化任务失败'};}
}
