/** Stable ecology-provider contract. Upstream text is a proposal, never the author draft. */
import { createHash } from 'node:crypto';
import type { LiteraryEcologyState } from './literary-ecology.ts';
import type { WorldState, LorebookEntry } from '../types.ts';
import type { BeatMsg } from './assemble.ts';
import { classifyModelFailure, explicitProviderFailure } from './model-failure.ts';
export const NPC_PARALLEL_ENTRY_TYPE = 'rp-npc-parallel';
export interface NpcAdmissionRequest { expectedSessionId:string; expectedSourceEntryId:string; candidateHashes:string[] }
export function validateNpcAdmissionRequest(value:unknown):NpcAdmissionRequest {
 const input=value as NpcAdmissionRequest;
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['expectedSessionId','expectedSourceEntryId','candidateHashes'].includes(k))||
  typeof input.expectedSessionId!=='string'||!input.expectedSessionId.trim()||typeof input.expectedSourceEntryId!=='string'||!input.expectedSourceEntryId.trim()||
  !Array.isArray(input.candidateHashes)||input.candidateHashes.length<1||input.candidateHashes.length>24||input.candidateHashes.some(h=>typeof h!=='string'||! /^[a-f0-9]{64}$/.test(h))||new Set(input.candidateHashes).size!==input.candidateHashes.length)
  throw Error('必须提供当前会话、正文来源和唯一的已保存候选哈希；不接受候选原文或手写采纳结果');
 return{expectedSessionId:input.expectedSessionId,expectedSourceEntryId:input.expectedSourceEntryId,candidateHashes:[...input.candidateHashes]};
}
export interface NpcParallelScope { sessionId:string; card:string; sourceEntryId:string; visibleEntryIds:string[] }
export interface NpcParallelEntry { name:string; text:string; info?:string; pov?:string; ts?:number }
export interface NpcParallelCandidate extends NpcParallelEntry { id:string; actorId:string; hash:string }
export interface NpcParallelTarget { name:string; status:'generated'|'unresolved'; reason?:string }
export interface NpcParallelBatch { version:string; commit:string; entries:NpcParallelEntry[]; calls:number; errors:string[]; admissionOnly?:boolean; cached?:boolean; selectedTargets?:string[]; targets?:NpcParallelTarget[] }
export interface NpcParallelModelRequest { messages:Array<{role:string;content:string}>; maxTokens:number; temperature?:number; purpose?:string }
export interface NpcParallelGenerationInput {
 scope:NpcParallelScope; ecology:LiteraryEcologyState; state:WorldState; lore:LorebookEntry[]; history:BeatMsg[];
 userName:string; charName:string; userText:string; narrative:string; signal?:AbortSignal; guard:()=>void;
 /** Explicit manual retry only; source accounting is never reset. */
 explicitRetry?:boolean;
 admissionCandidateHashes?:string[];
 generate:(request:NpcParallelModelRequest,signal?:AbortSignal)=>Promise<string>;
}
export interface NpcParallelProvider {
 enabled():boolean;
 generate(input:NpcParallelGenerationInput):Promise<NpcParallelBatch>;
  claimRequest(scope:NpcParallelScope,guard:()=>void,recoveryAttemptId?:string):void;
}
export interface NpcParallelReceipt {
 version:1; sourceEntryId:string; sessionId?:string; admissionOnly?:boolean; upstreamVersion:string; upstreamCommit:string; calls:number;
 status:'accepted'|'rejected'|'empty'|'failed'; reason?:string;
 entries:Array<NpcParallelCandidate & {status:'accepted'|'rejected';reason:string;eventIds:string[]}>;
 /** Read-only earlier failed attempts; never part of this batch or admitted history. */
 retainedEntries?:NpcParallelReceipt['entries'];
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Reject explicit transport envelopes, not story prose mentioning an error. */
export function assertNpcModelContent(text:string):void {
 const failure=explicitProviderFailure(text);
 if(failure){
  const reason=npcFailureReason(failure);
  throw new Error(reason,{cause:new Error(reason)});
 }
}
/** Fixed public reasons retain retry classification without leaking provider payloads. */
export function npcFailureReason(error:unknown):string {
 const raw=error instanceof Error?error.message:String(error);
 if(/(?:预算|额度).*(?:耗尽|已用尽|不足|已达|用完)|(?:已达|达到).*(?:次预算|次上限)|(?:budget|quota).*(?:exhausted|exceeded|reached)/i.test(raw))return 'quota exceeded';
 if(raw.includes('原始目标名单缺失'))return '原始目标名单缺失，无法安全续跑';
 const failure=classifyModelFailure(error);
 const reasons={auth:'authentication failed',model:'model unavailable',quota:'quota exceeded','rate-limit':`HTTP ${failure.statusCode ?? 429} rate limit`,timeout:'model timeout',transport:'network transport failed',format:'schema format failure','content-filter':'[ProxySystem Error] SAFETY',unknown:'unknown NPC failure'};
 return reasons[failure.kind]+(failure.statusCode&&failure.kind!=='rate-limit'?` (HTTP ${failure.statusCode})`:'');
}
export function npcActorId(name:string,ecology:LiteraryEcologyState):string {
 return ecology.actors.find(a=>a.name===name)?.id ?? `npc-${hash(name).slice(0,20)}`;
}
export function sealNpcCandidates(batch:NpcParallelBatch,scope:NpcParallelScope,ecology:LiteraryEcologyState):NpcParallelCandidate[] {
 if(!/^[a-f0-9]{40}$/.test(batch.commit)||!batch.version||!Array.isArray(batch.entries)||batch.entries.length>24)throw Error('众生侧写来源或人物数量无效');
 const names=new Set<string>();let size=0;
 return batch.entries.map(entry=>{
   const name=String(entry.name??'').trim(),text=String(entry.text??'').trim();
   assertNpcModelContent(text);
  if(!name||name.length>120||!text||text.length>80_000||names.has(name))throw Error('众生侧写人物重复、空文本或长度越界');
  names.add(name);size+=text.length+String(entry.info??'').length;if(size>240_000)throw Error('众生侧写批次过大');
  const digest=hash(JSON.stringify([scope.sessionId,scope.card,scope.sourceEntryId,batch.commit,name,text,entry.info??'']));
  return {...entry,name,text,id:`npc-candidate-${digest.slice(0,24)}`,actorId:npcActorId(name,ecology),hash:digest};
 });
}
/** Explicitly selected saved proposals, not a successful native run or accepted facts.
 * The entire saved batch must match; never merge attempts or guess missing targets.
 */
export function savedNpcAdmissionBatch(branch:Array<{id?:string;customType?:string;data?:unknown}>,scope:NpcParallelScope,hashes:string[],upstream:{version:string;commit:string},ecology:LiteraryEcologyState):NpcParallelBatch {
 validateNpcAdmissionRequest({expectedSessionId:scope.sessionId,expectedSourceEntryId:scope.sourceEntryId,candidateHashes:hashes});
 if(!scope.visibleEntryIds.includes(scope.sourceEntryId))throw Error('采纳来源不在当前祖先分支');
 const latest=npcReceiptFromBranch(branch,scope.sourceEntryId);
 if(latest&&latest.status!=='failed')throw Error('该来源已有完成或业务裁决收据，不重复采纳');
 const wanted=new Set(hashes);
 for(let i=branch.length-1;i>=0;i--){
  const row=branch[i];if(row.customType!==NPC_PARALLEL_ENTRY_TYPE||row.id&&!scope.visibleEntryIds.includes(row.id))continue;
  const data=row.data as NpcParallelReceipt|undefined;
  if(data?.sourceEntryId!==scope.sourceEntryId||data.status!=='failed'||data.upstreamCommit!==upstream.commit||data.upstreamVersion!==upstream.version||!Array.isArray(data.entries)||data.entries.length!==hashes.length||data.entries.some(e=>!wanted.has(e.hash)))continue;
  const entries=data.entries.map(e=>({name:e.name,text:e.text,...(e.info!==undefined?{info:e.info}:{}),...(e.pov!==undefined?{pov:e.pov}:{}),...(e.ts!==undefined?{ts:e.ts}:{})}));
  const batch:NpcParallelBatch={version:upstream.version,commit:upstream.commit,entries,calls:data.calls,errors:[],admissionOnly:true,cached:true,selectedTargets:entries.map(e=>e.name),targets:entries.map(e=>({name:e.name,status:'generated'}))};
  const sealed=sealNpcCandidates(batch,scope,ecology);
  if(sealed.some((candidate,j)=>candidate.hash!==data.entries[j].hash||candidate.id!==data.entries[j].id||candidate.actorId!==data.entries[j].actorId))throw Error('已保存候选与会话、卡、人物或正文来源封存不一致，未请求模型');
  return batch;
 }
 throw Error('未找到与当前来源、上游版本和完整候选哈希一致的失败批次，未重生成侧写');
}
export function npcReceipt(batch:NpcParallelBatch,scope:NpcParallelScope,candidates:NpcParallelCandidate[],status:NpcParallelReceipt['status'],reason=''):NpcParallelReceipt {
 return {version:1,sourceEntryId:scope.sourceEntryId,...(batch.admissionOnly?{admissionOnly:true}:{}),upstreamVersion:batch.version,upstreamCommit:batch.commit,calls:batch.calls,status,...(reason?{reason}:{}),entries:candidates.map(entry=>({...entry,status:status==='accepted'?'accepted':'rejected',reason,eventIds:[]}))};
}
export function npcJson(raw:string):Record<string,unknown>|undefined {
 for(const value of [raw,raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],raw.match(/\{[\s\S]*\}/)?.[0]]){
  if(!value)continue;try{const o=JSON.parse(value);if(o&&typeof o==='object'&&!Array.isArray(o))return o;}catch{}
 }
}
/** Atomic admission: a partly rejected batch never leaks changes from its model state. */
export function admitNpcBatch(raw:string,batch:NpcParallelBatch,scope:NpcParallelScope,candidates:NpcParallelCandidate[],next:LiteraryEcologyState,occurrenceIds:ReadonlyMap<string,string>=new Map()):{receipt:NpcParallelReceipt;errors:string[];explicitRejection:boolean} {
 const receipt=npcReceipt(batch,scope,candidates,'rejected');
 const data=npcJson(raw),rows=Array.isArray(data?.npc_parallel_decisions)?data!.npc_parallel_decisions as Array<Record<string,unknown>>:[];
 const errors:string[]=[];const seen=new Set<string>();let explicitRejection=false;
 for(const candidate of candidates){
  const matches=rows.filter(r=>r&&r.candidateId===candidate.id);
  if(matches.length>1){errors.push(`${candidate.name} 有重复接入决策`);continue;}
   seen.add(candidate.id);const target=receipt.entries.find(e=>e.id===candidate.id)!;
   // A missing decision for a candidate whose actor is in the state is an implicit
   // acceptance; it is bookkeeping, not a reason to pay for another request.
   const suppliedActor=Array.isArray(data?.actors)&&(data.actors as Array<Record<string,unknown>>).some(actor=>actor?.id===candidate.actorId);
   if(!matches.length&&!suppliedActor){errors.push(`${candidate.name} 缺少接入决策或本轮人物更新`);continue;}
   const r:Record<string,unknown>=matches[0]??{candidateId:candidate.id,actorId:candidate.actorId,reason:'按本轮人物更新接入'};
   const reason=typeof r.reason==='string'?r.reason.slice(0,1000):'';
   if(r.verdict==='reject'){explicitRejection=true;target.reason=reason||'生态明确拒绝该场外候选';continue;}
   if(r.actorId!==undefined&&r.actorId!==candidate.actorId&&r.actorId!==candidate.name){errors.push(`${candidate.name} 接入身份无效：candidateId=${JSON.stringify(candidate.id)}，expectedActorId=${JSON.stringify(candidate.actorId)}，reportedActorId=${JSON.stringify(r.actorId)}`);continue;}
  const actor=next.actors.find(a=>a.id===candidate.actorId&&a.name===candidate.name);
  if(!actor){errors.push(`${candidate.name} 未归入唯一生态人物`);continue;}
   // quote/eventIds are provenance notes. Invalid ones are dropped, never fatal.
   const ids=(Array.isArray(r.eventIds)?r.eventIds:[]).map(id=>typeof id==='string'?occurrenceIds.get(id)??id:id).filter((id):id is string=>{
    const event=typeof id==='string'?next.occurrences.find(e=>e.id===id):undefined;
    return !!event&&event.participants.some(p=>p===candidate.actorId||p===candidate.name);
   }).slice(0,20);
  target.status='accepted';target.reason=reason;target.eventIds=ids;
 }
 if(rows.some(r=>!r||typeof r.candidateId!=='string'||!candidates.some(c=>c.id===r.candidateId)))errors.push('侧写决策含未知来源');
 if(!errors.length&&!explicitRejection){receipt.status='accepted';return{receipt,errors,explicitRejection:false};}
 // The ENTIRE proposed state is discarded, including apparently accepted siblings.
 const reason=explicitRejection?'批次存在冲突候选，整批未入账；保留原生态状态':errors.join('；');
 receipt.reason=reason;for(const entry of receipt.entries){entry.status='rejected';entry.reason=entry.reason||reason;entry.eventIds=[];}
 return{receipt,errors,explicitRejection};
}
export function npcReceiptFromBranch(branch:Array<{customType?:string;data?:unknown}>,sourceEntryId?:string):NpcParallelReceipt|undefined {
 let latest:NpcParallelReceipt|undefined;
 const retained:NpcParallelReceipt['entries']=[],seen=new Set<string>();
 for(let i=branch.length-1;i>=0;i--){
  const e=branch[i];if(e.customType!==NPC_PARALLEL_ENTRY_TYPE)continue;
  const d=e.data as NpcParallelReceipt|undefined;
  if(d?.version!==1||(sourceEntryId&&d.sourceEntryId!==sourceEntryId)||!Array.isArray(d.entries))continue;
  if(!latest){
   latest=d;
   if(d.status!=='failed')return d;
   for(const entry of d.entries)seen.add(entry.hash);
   continue;
  }
  if(d.sourceEntryId!==latest.sourceEntryId||d.upstreamCommit!==latest.upstreamCommit||d.upstreamVersion!==latest.upstreamVersion||d.status!=='failed')continue;
  for(const entry of d.entries){
   if(retained.length>=24||seen.has(entry.hash))continue;
   seen.add(entry.hash);retained.push({...entry,status:'rejected',eventIds:[]});
  }
 }
 return latest&&retained.length?{...latest,retainedEntries:retained}:latest;
}


/** v1.8.13/early v1.8.14 incorrectly completed a technically invalid intake by
 * quarantining the old ecology. Recover ONLY that exact legacy receipt, not
 * legitimate explicit business rejections or already accepted sidewrites. */
export function hasLegacyUnsettledNpcValidation(branch:Array<{customType?:string;data?:unknown}>,sourceEntryId:string):boolean {
 const settled=[...branch].reverse().find(e=>e.customType==='rp-turn-settlement'&&(e.data as Record<string,unknown>|undefined)?.narrativeEntryId===sourceEntryId)?.data as Record<string,unknown>|undefined;
 if(settled?.npcValidationRecovered===true&&settled.ecologyDone===true)return false;
 const receipt=npcReceiptFromBranch(branch,sourceEntryId);
 const legacyReason='场外候选包含缺少真实来源的用户承诺，整批隔离；原生态保留';
 if(receipt?.status==='rejected')return receipt.reason===legacyReason;
 // A failed bounded repair must not make the earlier invalid snapshot count as
 // settled on the next retry. Only a valid later receipt clears this migration.
 return receipt?.status==='failed'&&branch.some(e=>e.customType===NPC_PARALLEL_ENTRY_TYPE&&(e.data as NpcParallelReceipt|undefined)?.sourceEntryId===sourceEntryId&&(e.data as NpcParallelReceipt).status==='rejected'&&(e.data as NpcParallelReceipt).reason===legacyReason);
}
