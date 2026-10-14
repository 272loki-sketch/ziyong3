/** Stable ecology-provider contract. Upstream text is a proposal, never the author draft. */
import { createHash } from 'node:crypto';
import type { LiteraryEcologyState } from './literary-ecology.ts';
import type { WorldState, LorebookEntry } from '../types.ts';
import type { BeatMsg } from './assemble.ts';
export const NPC_PARALLEL_ENTRY_TYPE = 'rp-npc-parallel';
export interface NpcParallelScope { sessionId:string; card:string; sourceEntryId:string; visibleEntryIds:string[] }
export interface NpcParallelEntry { name:string; text:string; info?:string; pov?:string; ts?:number }
export interface NpcParallelCandidate extends NpcParallelEntry { id:string; actorId:string; hash:string }
export interface NpcParallelBatch { version:string; commit:string; entries:NpcParallelEntry[]; calls:number; errors:string[]; cached?:boolean }
export interface NpcParallelModelRequest { messages:Array<{role:string;content:string}>; maxTokens:number; temperature?:number; purpose?:string }
export interface NpcParallelGenerationInput {
 scope:NpcParallelScope; ecology:LiteraryEcologyState; state:WorldState; lore:LorebookEntry[]; history:BeatMsg[];
 userName:string; charName:string; userText:string; narrative:string; signal?:AbortSignal; guard:()=>void;
 generate:(request:NpcParallelModelRequest,signal?:AbortSignal)=>Promise<string>;
}
export interface NpcParallelProvider {
 enabled():boolean;
 generate(input:NpcParallelGenerationInput):Promise<NpcParallelBatch>;
 claimRequest(scope:NpcParallelScope,guard:()=>void):void;
}
export interface NpcParallelReceipt {
 version:1; sourceEntryId:string; upstreamVersion:string; upstreamCommit:string; calls:number;
 status:'accepted'|'rejected'|'empty'|'failed'; reason?:string;
 entries:Array<NpcParallelCandidate & {status:'accepted'|'rejected';reason:string;eventIds:string[]}>;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function npcActorId(name:string,ecology:LiteraryEcologyState):string {
 return ecology.actors.find(a=>a.name===name)?.id ?? `npc-${hash(name).slice(0,20)}`;
}
export function sealNpcCandidates(batch:NpcParallelBatch,scope:NpcParallelScope,ecology:LiteraryEcologyState):NpcParallelCandidate[] {
 if(!/^[a-f0-9]{40}$/.test(batch.commit)||!batch.version||!Array.isArray(batch.entries)||batch.entries.length>24)throw Error('众生侧写来源或人物数量无效');
 const names=new Set<string>();let size=0;
 return batch.entries.map(entry=>{
  const name=String(entry.name??'').trim(),text=String(entry.text??'').trim();
  if(!name||name.length>120||!text||text.length>80_000||names.has(name))throw Error('众生侧写人物重复、空文本或长度越界');
  names.add(name);size+=text.length+String(entry.info??'').length;if(size>240_000)throw Error('众生侧写批次过大');
  const digest=hash(JSON.stringify([scope.sessionId,scope.card,scope.sourceEntryId,batch.commit,name,text,entry.info??'']));
  return {...entry,name,text,id:`npc-candidate-${digest.slice(0,24)}`,actorId:npcActorId(name,ecology),hash:digest};
 });
}
export function npcReceipt(batch:NpcParallelBatch,scope:NpcParallelScope,candidates:NpcParallelCandidate[],status:NpcParallelReceipt['status'],reason=''):NpcParallelReceipt {
 return {version:1,sourceEntryId:scope.sourceEntryId,upstreamVersion:batch.version,upstreamCommit:batch.commit,calls:batch.calls,status,...(reason?{reason}:{}),entries:candidates.map(entry=>({...entry,status:status==='accepted'?'accepted':'rejected',reason,eventIds:[]}))};
}
export function npcJson(raw:string):Record<string,unknown>|undefined {
 for(const value of [raw,raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],raw.match(/\{[\s\S]*\}/)?.[0]]){
  if(!value)continue;try{const o=JSON.parse(value);if(o&&typeof o==='object'&&!Array.isArray(o))return o;}catch{}
 }
}
/** Atomic admission: a partly rejected batch never leaks changes from its model state. */
export function admitNpcBatch(raw:string,batch:NpcParallelBatch,scope:NpcParallelScope,candidates:NpcParallelCandidate[],next:LiteraryEcologyState):{receipt:NpcParallelReceipt;errors:string[];explicitRejection:boolean} {
 const receipt=npcReceipt(batch,scope,candidates,'rejected');
 const data=npcJson(raw),rows=Array.isArray(data?.npc_parallel_decisions)?data!.npc_parallel_decisions as Array<Record<string,unknown>>:[];
 const errors:string[]=[];const seen=new Set<string>();let explicitRejection=false;
 for(const candidate of candidates){
  const matches=rows.filter(r=>r&&r.candidateId===candidate.id);
  if(matches.length!==1){errors.push(`${candidate.name} 缺少唯一接入决策`);continue;}
  const r=matches[0];seen.add(candidate.id);const target=receipt.entries.find(e=>e.id===candidate.id)!;
  const reason=typeof r.reason==='string'?r.reason.slice(0,1000):'';
  if(r.verdict==='reject'){explicitRejection=true;target.reason=reason||'生态明确拒绝该场外候选';continue;}
  if(r.verdict!=='accept'||r.actorId!==candidate.actorId){errors.push(`${candidate.name} 接入身份或裁决无效`);continue;}
  const actor=next.actors.find(a=>a.id===candidate.actorId&&a.name===candidate.name);
  if(!actor){errors.push(`${candidate.name} 未归入唯一生态人物`);continue;}
  if(typeof r.quote!=='string'||!r.quote.trim()||r.quote.length>2000||!candidate.text.includes(r.quote)){
   errors.push(`${candidate.name} 接入引用不属于原侧写`);continue;
  }
   const ids=Array.isArray(r.eventIds)?r.eventIds:[];
   const eventErrors:string[]=[];
   if(ids.length>20)eventErrors.push(`${candidate.name} eventIds超过20项：actorId=${JSON.stringify(candidate.actorId)}`);
   for(const id of ids){
    const event=typeof id==='string'?next.occurrences.find(e=>e.id===id):undefined;
    if(typeof id!=='string'||!event||!event.participants.some(p=>p===candidate.actorId||p===candidate.name)){
     eventErrors.push(`${candidate.name} 共享事件引用或参与者不匹配：eventId=${JSON.stringify(id)}，actorId=${JSON.stringify(candidate.actorId)}，participants=${event?JSON.stringify(event.participants):'[]'}；${typeof id!=='string'?'eventId必须是字符串':!event?'事件不存在':'该actor不在事件participants中'}`);
    }
   }
   if(eventErrors.length){errors.push(...eventErrors);continue;}
  target.status='accepted';target.reason=reason;target.eventIds=ids as string[];
 }
 if(rows.length!==candidates.length||rows.some(r=>!r||typeof r.candidateId!=='string'||!seen.has(r.candidateId)))errors.push('侧写决策含未知或重复来源');
 if(!errors.length&&!explicitRejection){receipt.status='accepted';return{receipt,errors,explicitRejection:false};}
 // The ENTIRE proposed state is discarded, including apparently accepted siblings.
 const reason=explicitRejection?'批次存在冲突候选，整批未入账；保留原生态状态':errors.join('；');
 receipt.reason=reason;for(const entry of receipt.entries){entry.status='rejected';entry.reason=entry.reason||reason;entry.eventIds=[];}
 return{receipt,errors,explicitRejection};
}
export function npcReceiptFromBranch(branch:Array<{customType?:string;data?:unknown}>,sourceEntryId?:string):NpcParallelReceipt|undefined {
 for(let i=branch.length-1;i>=0;i--){const e=branch[i];if(e.customType!==NPC_PARALLEL_ENTRY_TYPE)continue;const d=e.data as NpcParallelReceipt|undefined;if(d?.version===1&&(!sourceEntryId||d.sourceEntryId===sourceEntryId)&&Array.isArray(d.entries))return d;}
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
