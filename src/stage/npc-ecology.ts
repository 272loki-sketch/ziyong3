/** One ecology computation chain: upstream proposes, ecology admits, engine alone commits. */
import {
 buildEcologyRuntimePrompt, normalizeLiteraryEcologyState, validateEcologyTransition,
 commitLiteraryEcologyRound, degradedLiteraryEcologyRound,
 type LiteraryEcologyState, type EcologyGlobalPool, type EcologyCardPool,
} from './literary-ecology.ts';
import {admitNpcBatch,npcReceipt,sealNpcCandidates,type NpcParallelProvider,type NpcParallelScope,type NpcParallelBatch,type NpcParallelReceipt} from './npc-parallel.ts';
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
}
export interface NpcEcologyResult {state?:LiteraryEcologyState;degraded:boolean;error?:string;npcReceipt?:NpcParallelReceipt;quarantined?:boolean}
/** Quiet presence checks are short prose, but provider reasoning also spends output tokens.
 * Keep a host-owned transport floor, not an upstream patch or a main-model fallback.
 * Every actual request still consumes the same persistent 8-attempt allowance.
 */
export function npcManagedOutputBudget(requested:number):number {
 if(!Number.isFinite(requested)||requested<1)throw Error('众生侧写输出预算无效');
 return Math.min(32000,Math.max(4096,Math.floor(requested)));
}
export async function computeNpcEcology(input:NpcEcologyInput):Promise<NpcEcologyResult>{
 const {provider,scope}=input;let batch:NpcParallelBatch|undefined,receipt:NpcParallelReceipt|undefined;
 const guard=()=>{if(input.signal?.aborted)throw Error('生态侧写已取消');input.guard();};
 const npcSide=async(sp:string,ut:string,max:number,signal=input.signal,temperature?:number)=>{
  if(signal?.aborted)throw Error("原侧写请求已取消");
  guard();provider!.claimRequest(scope,guard);guard();
  const result=await input.side('npcParallel',sp,ut,npcManagedOutputBudget(max),signal,temperature);guard();if(signal?.aborted)throw Error('原侧写请求已取消');return result;
 };
 try{
  guard();
  if(provider?.enabled()){
   if(!input.npcSkillBody)throw Error('众生侧写生态接入Skill缺失，不启动原插件收费请求');
   input.activity?.('众生侧写：原插件提出本轮场外经历，鲜活世界统一结算');
   batch=await provider.generate({scope,ecology:input.ecology,state:input.state,lore:input.lore,history:input.history,userName:input.userName,charName:input.charName,userText:input.userText,narrative:input.narrative,signal:input.signal,guard,
    generate:async(request,requestSignal)=>{
     const systems=request.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
     const messages=request.messages.filter(m=>m.role!=='system');
     const result=await npcSide(systems,messages.length===1?messages[0].content:JSON.stringify(messages),request.maxTokens,requestSignal??input.signal,request.temperature);
     if(typeof result!=='string')throw Error(result.error);return result;
    }});guard();
   const initial=sealNpcCandidates(batch,scope,input.ecology);
   receipt=npcReceipt(batch,scope,initial,initial.length?'rejected':'empty');
   if(batch.errors.length)throw Error(batch.errors.join('；'));
  }
  const candidates=batch?sealNpcCandidates(batch,scope,input.ecology):[];
  const prompt=buildEcologyRuntimePrompt(input.skillBody,{phase:'aftermath',ecology:input.ecology,global:input.global,cardPool:input.cardPool,lore:input.lore,state:input.state,history:input.history,userText:input.userText,userEntryId:input.userEntryId,narrativeText:input.narrative,
   ...(input.preTurn?{trustedNarrative:{entryId:scope.sourceEntryId,text:input.narrative},stateBasis:'pre-turn' as const}:{}),worldSignals:input.worldSignals});
  const step:SideModelStep=candidates.length?'npcParallel':'ecologyRuntime';
  if(candidates.length){
   prompt.systemPrompt+='\n\n'+input.npcSkillBody;
   const data=JSON.parse(prompt.userText);data.npc_parallel={sourceEntryId:scope.sourceEntryId,upstream:{version:batch!.version,commit:batch!.commit},owned_actor_ids:candidates.map(c=>c.actorId),candidates};prompt.userText=JSON.stringify(data);
  }
  let result=step==='npcParallel'?await npcSide(prompt.systemPrompt,prompt.userText,16384):await input.side(step,prompt.systemPrompt,prompt.userText,16384);
  guard();if(typeof result!=='string')throw Error(result.error);
  const check=(raw:string)=>{
   const parsed=normalizeLiteraryEcologyState(raw,input.ecology);
   if(!parsed)return{parsed,admission:undefined,errors:['生态JSON不可解析']};
   const admission=candidates.length?admitNpcBatch(raw,batch!,scope,candidates,parsed):undefined;
   if(admission?.errors.length)return{parsed,admission,errors:admission.errors};
   // A real business rejection discards the WHOLE proposal. It is not a schema
   // failure; never repair a rejection until it happens to become an acceptance.
   if(admission?.explicitRejection)return{parsed,admission,errors:[]};
   const proposedCommitments=parsed.occurrences.filter(e=>e.userRole==='committed'&&!input.committedEcology.occurrences.some(old=>old.id===e.id&&old.userRole==='committed')).map(e=>e.id);
   const errors=validateEcologyTransition(input.ecology,parsed,input.worldSignals as never,{latestUserText:input.userText,latestUserEntryId:input.userEntryId,committedState:input.committedEcology,
    ...(input.preTurn?{trustedNarrative:{entryId:scope.sourceEntryId,text:input.narrative}}:{})});
   const warnings=(parsed.commitmentWarnings??[]).filter(w=>!(input.committedEcology.commitmentWarnings??[]).includes(w));
   if(candidates.length&&(warnings.length||proposedCommitments.some(id=>parsed.occurrences.find(e=>e.id===id)?.userRole!=='committed'))){
    errors.push('用户承诺来源校验失败：必须以本拍真实用户原文或已保存正文的逐字引文、正确source/sourceEntryId为依据；NPC候选不是用户承诺来源。不得把降级为optional的旧状态包装为接入成功。',...warnings);
   }
   return{parsed,admission,errors};
  };
  let checked=check(result);
  // One bounded, charged repair of the same report/role, including provenance
  // validation. Previously unsupported commitments quarantined an OLD snapshot
  // and advanced its round as success, although there was no valid intake.
  if(checked.errors.length){
   if(step==='npcParallel'){
    const data=JSON.parse(prompt.userText);data.repair={invalid_report:result,errors:checked.errors};
    const fixed=await npcSide(prompt.systemPrompt,JSON.stringify(data),16384);guard();
    if(typeof fixed!=='string')throw Error(fixed.error);result=fixed;checked=check(fixed);
   }else if(!checked.parsed&&input.repair){
    const fixed=await input.repair(step,prompt,result,checked.errors,16384);guard();
    if(typeof fixed==='string'){result=fixed;checked=check(fixed);}
   }
  }
  const {parsed,admission}=checked;
  if(checked.errors.length)throw Error(checked.errors.join('；'));
  if(!parsed)throw Error('生态输出不可解析');
  if(admission){
   receipt=admission.receipt;
   if(admission.explicitRejection){
    input.activity?.('众生侧写：冲突批次整批隔离，原生态事实保留；明确业务拒绝，非技术成功伪装');
    return{state:commitLiteraryEcologyRound(input.ecology,input.previousRound),degraded:false,npcReceipt:receipt,quarantined:true};
   }
  }
  guard();return{state:commitLiteraryEcologyRound(parsed,input.previousRound),degraded:false,...(receipt?{npcReceipt:receipt}:{})};
 }catch(error){
  const message=error instanceof Error?error.message:String(error);
  if(receipt){receipt={...receipt,status:'failed',reason:message,entries:receipt.entries.map(e=>({...e,status:'rejected',reason:message,eventIds:[]}))};}
  return{state:degradedLiteraryEcologyRound(input.ecology,input.previousRound,'aftermath',message),degraded:true,error:message,...(receipt?{npcReceipt:receipt}:{})};
 }
}
