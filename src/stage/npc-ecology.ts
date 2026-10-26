/** One ecology computation chain: upstream proposes, ecology admits, engine alone commits. */
import {
 buildEcologyRuntimePrompt, normalizeLiteraryEcologyState, validateEcologyTransition,
 commitLiteraryEcologyRound, degradedLiteraryEcologyRound,
 type LiteraryEcologyState, type EcologyGlobalPool, type EcologyCardPool,
} from './literary-ecology.ts';
import {admitNpcBatch,assertNpcModelContent,npcFailureReason,npcReceipt,npcJson,sealNpcCandidates,type NpcParallelProvider,type NpcParallelScope,type NpcParallelBatch,type NpcParallelReceipt} from './npc-parallel.ts';
import {classifyModelFailure} from './model-failure.ts';
import {bindNewNpcActorIds} from './npc-actor-identity.ts';
import type {WorldState,LorebookEntry} from '../types.ts';
import type {BeatMsg} from './assemble.ts';
import type {SideModelStep} from '../model-routing.ts';
export interface NpcEcologyInput {
 provider?:NpcParallelProvider;scope:NpcParallelScope;ecology:LiteraryEcologyState;committedEcology:LiteraryEcologyState;
 global:EcologyGlobalPool;cardPool:EcologyCardPool;lore:LorebookEntry[];state:WorldState;history:BeatMsg[];
 userText:string;userEntryId?:string;userName:string;charName:string;narrative:string;worldSignals:unknown[];
 skillBody:string;npcSkillBody?:string;preTurn:boolean;previousRound:number;signal?:AbortSignal;guard:()=>void;
 side:(step:SideModelStep,systemPrompt:string,userText:string,maxTokens:number,signal?:AbortSignal,temperature?:number)=>Promise<string|{error:string}>;
 repair?:(step:SideModelStep,prompt:{systemPrompt:string;userText:string},raw:string,errors:string[],maxTokens:number)=>Promise<string|{error:string}>;
 activity?:(text:string)=>void;
 /** Host-owned substage labels only; never sent to a model or saved as story. */
 progress?:(stage:string)=>void;
 recoveryAttemptId?:string;
 explicitRetry?:boolean;
 admissionCandidateHashes?:string[];
}
export interface NpcEcologyResult {state?:LiteraryEcologyState;degraded:boolean;error?:string;npcReceipt?:NpcParallelReceipt;quarantined?:boolean}
/** Quiet presence checks are short prose, but provider reasoning also spends output tokens.
 * Keep a host-owned transport floor, not an upstream patch or a main-model fallback.
 * Every actual request is still recorded in persistent source accounting.
 */
export function npcManagedOutputBudget(requested:number):number {
 if(!Number.isFinite(requested)||requested<1)throw Error('众生侧写输出预算无效');
 return Math.min(32000,Math.max(4096,Math.floor(requested)));
}
/** Expand only the managed aftermath protocol; legacy readers keep snapshot semantics. */
export function expandEcologyDelta(raw:string,previous:LiteraryEcologyState):unknown {
 const data=npcJson(raw);
 if(data?.output_mode!=='delta')return raw;
 const out={...data};
 for(const [field,key,limit]of [['actors','id',60],['secrets','id',40],['locationStates','location',30]]as const){
  const old=previous[field] as unknown as Record<string,unknown>[];
  const rows=Object.hasOwn(data,field)?data[field]:[];
  if(!Array.isArray(rows))throw Error(`生态delta ${field} 必须是数组`);
  const seen=new Set<string>();
  const updates=rows.map((row:unknown)=>{
   if(!row||typeof row!=='object'||Array.isArray(row))throw Error(`生态delta ${field} 条目无效`);
   const item=row as Record<string,unknown>,id=item[key];
   if(typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>(key==='id'?80:120)||seen.has(id))throw Error(`生态delta ${field} 身份缺失或重复`);
   seen.add(id);
   const prior=old.find(value=>value[key]===id);
   if(field==='actors'){
    if(Object.hasOwn(item,'name')&&(typeof item.name!=='string'||!item.name.trim()||item.name!==item.name.trim()||item.name.length>100))throw Error('生态delta 人物姓名无效');
    if(prior&&Object.hasOwn(item,'name')&&item.name!==prior.name)throw Error('生态delta 不得改写已有身份姓名');
    if(!prior&&!item.name)throw Error('生态delta 新人物缺少姓名');
    // The normalizer already inherits actor fields and frozen knowledge by id.
    return {...item,name:item.name??prior?.name,tier:item.tier??prior?.tier};
   }
   const merged={...prior,...item};
   if(field==='secrets'&&!merged.subject&&!merged.truth)throw Error('生态delta 秘密缺少主题或事实');
   return merged;
  });
  const merged=old.map(value=>updates.find(row=>row[key]===value[key])??(field==='actors'?{id:value.id,name:value.name,tier:value.tier}:value));
  merged.push(...updates.filter(row=>!old.some(value=>value[key]===row[key])));
  if(new Set(merged.map(row=>row[key])).size!==merged.length)throw Error(`生态delta ${field} 基线身份重复`);
  if(merged.length>limit)throw Error(`生态delta ${field} 容量超过 ${limit}，不能丢弃旧状态`);
  if(field==='actors'){
   const identities=new Set<string>();
   for(const actor of merged){
    const id=String(actor.id),name=String(actor.name);
    if(identities.has(id)||identities.has(name))throw Error('生态delta 人物姓名或id冲突');
    identities.add(id);identities.add(name);
   }
  }
  out[field]=merged;
 }
 const events=Object.hasOwn(data,'occurrences')?data.occurrences:[];
 if(!Array.isArray(events)||events.length>80)throw Error('生态delta occurrences 无效或超过容量');
 const ids=new Set<string>();
 out.occurrences=events.map((row:unknown)=>{
  if(!row||typeof row!=='object'||Array.isArray(row))throw Error('生态delta 事件无效');
  const item=row as Record<string,unknown>,id=item.id;
  if(typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>80||ids.has(id))throw Error('生态delta 事件身份缺失或重复');
  ids.add(id);
  const old=previous.occurrences.find(event=>event.id===id);
  if(!old&&(typeof item.name!=='string'||!item.name.trim()))throw Error('生态delta 新事件缺少名称');
  return {...item,...(old?{name:item.name??old.name,patternKey:item.patternKey??old.patternKey}:{})};
 });
 // Reserve capacity before normalization's bounded merge can evict old events.
 const patterns=new Set(previous.occurrences.map(event=>event.patternKey));
 let count=previous.occurrences.length;
 for(const event of out.occurrences as Record<string,unknown>[]){
  if(previous.occurrences.some(old=>old.id===event.id))continue;
  if(typeof event.patternKey==='string'&&event.patternKey&&patterns.has(event.patternKey))continue;
  count++;if(typeof event.patternKey==='string'&&event.patternKey)patterns.add(event.patternKey);
 }
 if(count>80)throw Error('生态delta 事件容量超过 80，不能丢弃旧状态');
 if(!Object.hasOwn(data,'recentPatterns'))out.recentPatterns=previous.recentPatterns;
 return out;
}
export async function computeNpcEcology(input:NpcEcologyInput):Promise<NpcEcologyResult>{
 const baseline=structuredClone(input.ecology),committedBaseline=structuredClone(input.committedEcology);
 const {provider,scope}=input;let batch:NpcParallelBatch|undefined,receipt:NpcParallelReceipt|undefined;let nativeRequests=0,managedRequests=0;
 const guard=()=>{if(input.signal?.aborted)throw Error('生态侧写已取消');input.guard();};
 const npcSide=async(sp:string,ut:string,max:number,signal=input.signal,temperature?:number)=>{
  if(signal?.aborted)throw Error('侧写请求已取消');
   guard();provider!.claimRequest(scope,guard,input.recoveryAttemptId);guard();
   managedRequests++;
   const result=await input.side('npcParallel',sp,ut,npcManagedOutputBudget(max),signal,temperature);guard();if(signal?.aborted)throw Error('侧写请求已取消');if(typeof result==='string')assertNpcModelContent(result);return result;
 };
 try{
  guard();
  if(input.admissionCandidateHashes&&!provider?.enabled())throw Error("众生侧写未启用，不能以其它岗位替代已有候选的采纳");
  if(provider?.enabled()){
   if(!input.npcSkillBody)throw Error('众生侧写生态接入Skill缺失，不启动侧写收费请求');
   input.activity?.(input.admissionCandidateHashes?'众生侧写：复用已保存候选，仅补鲜活世界采纳，不重写正文或侧写':'众生侧写：提出本轮场外经历，鲜活世界统一结算');
   batch=await provider.generate({admissionCandidateHashes:input.admissionCandidateHashes,explicitRetry:input.explicitRetry,scope,ecology:input.ecology,state:input.state,lore:input.lore,history:input.history,userName:input.userName,charName:input.charName,userText:input.userText,narrative:input.narrative,signal:input.signal,guard,
    generate:async(request,requestSignal)=>{
     input.progress?.(`侧写请求 ${++nativeRequests}`);
     const systems=request.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
     const messages=request.messages.filter(m=>m.role!=='system');
     const result=await npcSide(systems,messages.length===1?messages[0].content:JSON.stringify(messages),request.maxTokens,requestSignal??input.signal,request.temperature);
     if(typeof result!=='string')throw Error(result.error);return result;
    }});guard();
   if(input.admissionCandidateHashes&&batch.admissionOnly!==true)throw Error("宿主未确认复用已保存候选，不把重生成冒称仅补采纳");
   const initial=sealNpcCandidates(batch,scope,input.ecology);
   receipt=npcReceipt(batch,scope,initial,initial.length?'rejected':'empty');
    if(batch.errors.length){
      const reasons=batch.errors.map(npcFailureReason);
      const permanent=reasons.find(e=>['auth','content-filter','quota','model'].includes(classifyModelFailure(e).kind));
      const classified=reasons.find(e=>classifyModelFailure(e).kind!=='unknown');
       const reason=permanent??reasons.find(e=>e.includes('原始目标名单缺失'))??classified??'unknown NPC failure';
        // The provider resumes only sealed unresolved targets. Any remaining
        // failure blocks intake; legacy caches cannot reconstruct a selection.
       throw Error(batch.cached?`${reason}；${batch.selectedTargets?'逐目标恢复未完成，无法安全续跑':'原始目标名单缺失，无法安全续跑'}`:reason);
    }
  }
  const candidates=batch?sealNpcCandidates(batch,scope,input.ecology):[];
  const prompt=buildEcologyRuntimePrompt(input.skillBody,{phase:'aftermath',ecology:input.ecology,global:input.global,cardPool:input.cardPool,lore:input.lore,state:input.state,history:input.history,userText:input.userText,userEntryId:input.userEntryId,narrativeText:input.narrative,
   ...(input.preTurn?{trustedNarrative:{entryId:scope.sourceEntryId,text:input.narrative},stateBasis:'pre-turn' as const}:{}),worldSignals:input.worldSignals});
   const data=JSON.parse(prompt.userText);
   data.response_mode={output_mode:'delta',identity_keys:{actors:'id',secrets:'id',locationStates:'location',occurrences:'id'},merge:'只输出变化条目；未列人物、秘密、场所和事件保留。已有条目字段浅合并；内部数组提供时完整替换，省略继承。不支持删除；新条目填写完整必要字段。事件沿用id；旧完整快照仍兼容。'};
    if(input.preTurn)data.response_mode.narrative_evidence_schema={type:'object',required:['sourceEntryId','quote'],properties:{sourceEntryId:{type:'string',const:scope.sourceEntryId},quote:{type:'string',minLength:1,maxLength:2000,description:'latest_turn.narrative 的连续逐字原文；不拼接、省略或转述。仅 origin=narrative 的事件填写 narrativeEvidence；generated-offscreen 不填写。'}}};
   prompt.userText=JSON.stringify(data);
   const step:SideModelStep=candidates.length?'npcParallel':'ecologyRuntime';
  if(candidates.length){
   prompt.systemPrompt+='\n\n'+input.npcSkillBody;
    const data=JSON.parse(prompt.userText);data.npc_parallel={sourceEntryId:scope.sourceEntryId,upstream:{version:batch!.version,commit:batch!.commit},owned_actor_ids:candidates.map(c=>c.actorId),candidates,
      decision_schema:{type:'array',minItems:candidates.length,maxItems:candidates.length,items:{type:'object',required:['candidateId','actorId','reason','quote','eventIds'],properties:{candidateId:{type:'string',enum:candidates.map(c=>c.id)},actorId:{type:'string',enum:candidates.map(c=>c.actorId)},reason:{type:'string'},quote:{type:'string'},eventIds:{type:'array',items:{type:'string'},maxItems:20}}}}};prompt.userText=JSON.stringify(data);
  }
  input.progress?.(candidates.length?'生态接入':'生态推进');
  let result=step==='npcParallel'?await npcSide(prompt.systemPrompt,prompt.userText,16384):await input.side(step,prompt.systemPrompt,prompt.userText,16384);
  guard();if(typeof result!=='string')throw Error(result.error);
   const check=(raw:string)=>{
    assertNpcModelContent(raw);
    const previous=structuredClone(baseline);
    const bound=candidates.length?bindNewNpcActorIds(raw,candidates,previous):raw;
     const occurrenceIds=new Map<string,string>();
     let expanded:unknown;
     try{expanded=expandEcologyDelta(bound,previous);}catch(error){return{parsed:null,admission:undefined,errors:[error instanceof Error?error.message:String(error)]};}
      const parsed=normalizeLiteraryEcologyState(expanded,previous,occurrenceIds);
    if(!parsed)return{parsed,admission:undefined,errors:['生态JSON不可解析']};
    if(npcJson(bound)?.output_mode==='delta'){
     const changed=new Set((npcJson(bound)?.actors as Array<{id?:string}>|undefined)?.map(actor=>actor.id)??[]);
     parsed.actors=parsed.actors.map(actor=>!changed.has(actor.id)?previous.actors.find(old=>old.id===actor.id)??actor:actor);
    }
    const admission=candidates.length?admitNpcBatch(bound,batch!,scope,candidates,parsed,occurrenceIds):undefined;
   if(admission?.errors.length)return{parsed,admission,errors:admission.errors};
   // A real business rejection discards the WHOLE proposal. It is not a schema
   // failure; never repair a rejection until it happens to become an acceptance.
   if(admission?.explicitRejection)return{parsed,admission,errors:[]};
     const proposedCommitments=parsed.occurrences.filter(e=>e.userRole==='committed'&&!committedBaseline.occurrences.some(old=>old.id===e.id&&old.userRole==='committed')).map(e=>e.id);
     const errors=validateEcologyTransition(previous,parsed,input.worldSignals as never,{latestUserText:input.userText,latestUserEntryId:input.userEntryId,committedState:structuredClone(committedBaseline),
     ...(input.preTurn?{trustedNarrative:{entryId:scope.sourceEntryId,text:input.narrative}}:{})});
     // Downgrading metadata alone leaves invented promises in event prose.
     // Only claims about the user's commitments require narrative/input evidence.
     if(candidates.length&&proposedCommitments.some(id=>parsed.occurrences.find(e=>e.id===id)?.userRole!=='committed'))errors.push('用户承诺来源校验失败：不替主角承诺参与事件；将该事件改为其他人物自主发展，不保留虚构的主角承诺。');
    return{parsed,admission,errors};
  };
  let checked=check(result);
  // One bounded, charged repair of the same report/role, including provenance
  // validation. Previously unsupported commitments quarantined an OLD snapshot
  // and advanced its round as success, although there was no valid intake.
  if(checked.errors.length){
   if(step==='npcParallel'){
     const report=npcJson(result);
      const reportedActors=Array.isArray(report?.actors)?report.actors as Array<{id?:string}>:[];
      const missingDecisions=!!checked.parsed&&!!report&&!Object.hasOwn(report,'npc_parallel_decisions')&&candidates.every(candidate=>reportedActors.some(actor=>actor.id===candidate.actorId))&&checked.errors.every(error=>error.includes('缺少接入决策'));
     input.progress?.(missingDecisions?'补齐接入决策（最多一次）':'校验修复（最多一次）');
     const data=JSON.parse(prompt.userText);data.repair={invalid_report:result,errors:checked.errors,
      ...(missingDecisions?{output_fields:['npc_parallel_decisions'],frozen_fields:Object.keys(report!).filter(key=>key!=='npc_parallel_decisions')}:{})};
     const fixed=await npcSide(prompt.systemPrompt,JSON.stringify(data),missingDecisions?4096:16384);guard();
     if(typeof fixed!=='string')throw Error(fixed.error);
     // A decision-only repair cannot rewrite a previously generated ecology or bypass its validation.
     result=missingDecisions?JSON.stringify({...report,npc_parallel_decisions:npcJson(fixed)?.npc_parallel_decisions}):fixed;
     checked=check(result);
   }else if(input.repair){
    input.progress?.('校验修复（最多一次）');
    const fixed=await input.repair(step,prompt,result,checked.errors,16384);guard();
     if(typeof fixed!=='string')throw Error(fixed.error);
     result=fixed;checked=check(fixed);
   }
  }
  const {parsed,admission}=checked;
  if(checked.errors.length)throw Error(checked.errors.join('；'));
  if(!parsed)throw Error('生态输出不可解析');
  if(admission){
   receipt={...admission.receipt,...(input.admissionCandidateHashes?{calls:managedRequests}: {})};
   if(admission.explicitRejection){
    input.activity?.('众生侧写：冲突批次整批隔离，原生态事实保留；明确业务拒绝，非技术成功伪装');
    return{state:commitLiteraryEcologyRound(input.ecology,input.previousRound),degraded:false,npcReceipt:receipt,quarantined:true};
   }
  }
  guard();return{state:commitLiteraryEcologyRound(parsed,input.previousRound),degraded:false,...(receipt?{npcReceipt:receipt}:{})};
 }catch(error){
  const message=error instanceof Error?error.message:String(error);
  if(receipt){receipt={...receipt,...(input.admissionCandidateHashes?{calls:managedRequests}:{}),status:'failed',reason:message,entries:receipt.entries.map(e=>({...e,status:'rejected',reason:message,eventIds:[]}))};}
  return{state:degradedLiteraryEcologyRound(input.ecology,input.previousRound,'aftermath',message),degraded:true,error:message,...(receipt?{npcReceipt:receipt}:{})};
 }
}
