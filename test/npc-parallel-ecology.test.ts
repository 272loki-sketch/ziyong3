import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {computeNpcEcology,type NpcEcologyInput} from '../src/stage/npc-ecology.ts';
import {admitNpcBatch,assertNpcModelContent,npcFailureReason,sealNpcCandidates,npcReceiptFromBranch,NPC_PARALLEL_ENTRY_TYPE,type NpcParallelBatch} from '../src/stage/npc-parallel.ts';
import {classifyModelFailure} from '../src/stage/model-failure.ts';
import {settlementFailureRetryable} from '../src/stage/settlement-retry.ts';
import {defaultLiteraryEcologyState,normalizeLiteraryEcologyState,emptyEcologyGlobalPool,emptyEcologyCardPool} from '../src/stage/literary-ecology.ts';
import {defaultState} from '../src/state.ts';
import {normalizeStepModels,resolveStepModel} from '../src/model-routing.ts';
const scope={sessionId:'synthetic-session',card:'synthetic-card',sourceEntryId:'saved-narrative',visibleEntryIds:['saved-narrative']};
const ecology=normalizeLiteraryEcologyState({actors:[{id:'a',name:'阿青',location:'书店',activity:'整理书架'}]},defaultLiteraryEcologyState())!;
const batch:NpcParallelBatch={version:'1.1.0',commit:'a'.repeat(40),calls:1,errors:[],entries:[{name:'阿青',text:'阿青把最后一本书放回书架，接着去柜台记账。',info:'知道：今天的账目'}]};
const sealed=sealNpcCandidates(batch,scope,ecology);
test('builtin ecology output example exposes admission decisions in the same top-level snapshot',()=>{
 const body=readFileSync(new URL('../skills/人物与场所生态/SKILL.md',import.meta.url),'utf8');
 const example=JSON.parse(body.match(/```json\s*([\s\S]*?)```/)![1]);
 assert.ok(Array.isArray(example.npc_parallel_decisions));assert.ok(Array.isArray(example.actors));
 assert.equal(Object.keys(example)[0],'npc_parallel_decisions');
 const admission=readFileSync(new URL('../skills/众生侧写生态接入/SKILL.md',import.meta.url),'utf8');
 assert.ok(admission.includes('"candidateId":"candidate.id"'));assert.ok(admission.includes('"actorId":"candidate.actorId"'));
});
function accepted(){return{actors:[{id:'a',name:'阿青',location:'书店',activity:'在柜台记账'}],npc_parallel_decisions:[{candidateId:sealed[0].id,actorId:'a',verdict:'accept',quote:'接着去柜台记账',reason:'本拍时间和已知状态相容',eventIds:[]}]};}
function fixture(overrides:Partial<NpcEcologyInput>={}){
 let claims=0,generation=0;const steps:string[]=[];
 const input:NpcEcologyInput={scope,ecology,committedEcology:ecology,global:emptyEcologyGlobalPool(),cardPool:emptyEcologyCardPool('key','card'),lore:[],state:defaultState(),history:[],userText:'继续整理',userName:'用户',charName:'主角',narrative:'主角在另一间屋里整理纸张。',worldSignals:[],skillBody:'ecology',npcSkillBody:'npc admission',preTurn:true,previousRound:0,guard:()=>{},
  provider:{enabled:()=>true,claimRequest:(_s,g)=>{g();claims++;},generate:async request=>{generation++;await request.generate({messages:[{role:'user',content:'native fixture prompt'}],maxTokens:1000});return structuredClone(batch);}},
  side:async(step,_sp,ut)=>{steps.push(step);if(ut==='native fixture prompt')return batch.entries[0].text;const data=JSON.parse(ut);assert.equal(data.latest_turn.narrative_entry_id,scope.sourceEntryId);return JSON.stringify(accepted());},...overrides};
 return{input,claims:()=>claims,generation:()=>generation,steps};
}
test('NPC seals include source, card, session, upstream and raw text; stable actor IDs',()=>{
 assert.equal(sealed[0].actorId,'a');assert.deepEqual(sealNpcCandidates(batch,scope,ecology),sealed);
 for(const change of [{sessionId:'sibling'},{card:'other'},{sourceEntryId:'other'}])assert.notEqual(sealNpcCandidates(batch,{...scope,...change},ecology)[0].id,sealed[0].id);
 assert.notEqual(sealNpcCandidates({...batch,commit:'b'.repeat(40)},scope,ecology)[0].id,sealed[0].id);
 assert.throws(()=>sealNpcCandidates({...batch,entries:[batch.entries[0],batch.entries[0]]},scope,ecology),/重复/);
});
test('dedicated Flash step has no silent author fallback',()=>{
 assert.deepEqual(normalizeStepModels({npcParallel:{provider:'new',id:'gemini-3.8-flash'}})?.npcParallel,{provider:'new',id:'gemini-3.8-flash'});
 assert.equal(resolveStepModel('npcParallel',{}, {id:'author'},()=>undefined).model,undefined);
 assert.equal(resolveStepModel('npcParallel',{npcParallel:{provider:'deleted',id:'missing'}},{id:'author'},()=>undefined).model,undefined);
});
test('delta preserves untouched zero-round actors and binds new local identities without verdict',async()=>{
 const base=structuredClone(ecology);base.round=8;base.actors[0].lastAdvancedRound=0;
 const b={...batch,entries:[{name:'Synthetic newcomer',text:'The newcomer sorts books.'}]};
 const c=sealNpcCandidates(b,scope,base)[0];
 const f=fixture({ecology:base,committedEcology:base,previousRound:8,provider:{enabled:()=>true,claimRequest:(_s,g)=>g(),generate:async()=>b},side:async()=>JSON.stringify({output_mode:'delta',actors:[{id:'local-new',name:c.name,activity:'sorts books'}],npc_parallel_decisions:[{candidateId:c.id,actorId:'local-new',quote:c.text,eventIds:[]}]})});
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,false);assert.equal(result.npcReceipt?.status,'accepted');
 assert.deepEqual(result.state?.actors.find(a=>a.id==='a'),base.actors[0]);
 assert.equal(result.state?.actors.find(a=>a.name===c.name)?.id,c.actorId);
});
test('native generation plus one unified intake, no second independent ecology story',async()=>{
 const f=fixture(),before=JSON.stringify(ecology),r=await computeNpcEcology(f.input);
 assert.equal(r.degraded,false);assert.equal(r.npcReceipt?.status,'accepted');assert.equal(r.state?.actors[0].activity,'在柜台记账');
 assert.deepEqual(f.steps,['npcParallel','npcParallel']);assert.equal(f.claims(),2);assert.equal(f.generation(),1);
 assert.equal(JSON.stringify(ecology),before);assert.equal(r.npcReceipt?.entries[0].text,batch.entries[0].text);
});
for(const npc of [false,true])test(`${npc?'NPC':'ordinary'} ecology admits new offscreen observations without narrative quotations`,async()=>{
 const report={...accepted(),actors:[{...accepted().actors[0],relations:['与柜台同事共同核账'],knowledgeLedger:[{id:'ledger',subjectRef:'occurrence:accounting',summary:'账目已核对',certainty:'confirmed',route:'witnessed',evidence:'在柜台亲手核对账页',sourceRef:'occurrence:accounting'}]}],occurrences:[{id:'accounting',name:'柜台核账',origin:'generated-offscreen',time:'当前清晨',location:'书店',participants:['a'],cause:'书架整理完毕后处理账目',development:'阿青在柜台记账',userRole:'none'}]};
 report.npc_parallel_decisions[0].eventIds=['accounting'];
 const f=fixture({...(npc?{}:{provider:undefined}),side:async(step,_sp,ut)=>{f.steps.push(step);return ut==='native fixture prompt'?batch.entries[0].text:JSON.stringify(report);}});
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,false);assert.equal(result.state?.round,1);
 assert.equal(result.state?.occurrences[0].origin,'generated-offscreen');assert.equal(result.state?.occurrences[0].narrativeEvidence,undefined);
 assert.equal(result.state?.actors[0].knowledgeLedger?.[0].sourceRef,'occurrence:accounting');
 assert.ok(!f.input.narrative.includes('柜台'));assert.equal(f.steps.length,npc?2:1);
});
for(const npc of [false,true])test(`${npc?'NPC':'ordinary'} ecology rejects forged canonical extraction and secret omniscience`,async()=>{
 for(const secret of [false,true]){
  const report:any={...accepted(),occurrences:[{id:'accounting',name:'柜台核账',origin:'narrative',narrativeEvidence:{sourceEntryId:scope.sourceEntryId,quote:'正文没有的柜台核账'},participants:['a']}]};
  if(secret){report.occurrences=[];report.secrets=[{id:'hidden',subject:'密账',truth:'秘密',knownBy:['a']}];report.actors[0].knowledgeLedger=[{id:'leak',subjectRef:'secret:hidden',summary:'秘密',certainty:'confirmed',route:'witnessed',sourceRef:'secret:hidden',evidence:'后台全知'}];}
  const f=fixture({...(npc?{}:{provider:undefined}),side:async(_step,_sp,ut)=>ut==='native fixture prompt'?batch.entries[0].text:JSON.stringify(report)});
  const result=await computeNpcEcology(f.input);assert.equal(result.degraded,true);assert.match(result.error!,secret?/实际获知事件/:/正文提取来源或引文无效/);
  assert.deepEqual(result.state?.actors,ecology.actors);assert.equal(f.claims(),npc?3:0);
 }
});
test('explicit business rejection discards ALL model state without inventing success',async()=>{
 const f=fixture({side:async(_step,_sp,ut)=>ut==='native fixture prompt'?'text':JSON.stringify({...accepted(),actors:[{id:'a',name:'阿青',location:'车站',activity:'离开书店'}],npc_parallel_decisions:[{candidateId:sealed[0].id,actorId:'a',verdict:'reject',reason:'未经过足够时间'}]})});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,false);assert.equal(r.quarantined,true);assert.equal(r.npcReceipt?.status,'rejected');
 assert.deepEqual(r.state?.actors,ecology.actors);assert.equal(r.npcReceipt?.entries[0].status,'rejected');
});
test('partial admission cannot commit seemingly accepted sibling changes',()=>{
 const b={...batch,entries:[...batch.entries,{name:'阿白',text:'阿白去了车站。'}]},c=sealNpcCandidates(b,scope,ecology);
 const next=normalizeLiteraryEcologyState({actors:[...ecology.actors,{id:c[1].actorId,name:'阿白'}]},ecology)!;
 const result=admitNpcBatch(JSON.stringify({npc_parallel_decisions:[{candidateId:c[0].id,actorId:c[0].actorId,verdict:'accept',quote:'去柜台记账',eventIds:[]},{candidateId:c[1].id,verdict:'reject',reason:'时间冲突'}]}),b,scope,c,next);
 assert.equal(result.explicitRejection,true);assert.ok(result.receipt.entries.every(e=>e.status==='rejected'));assert.equal(result.receipt.status,'rejected');
});
test('missing decision for an actor already written into ecology is an implicit acceptance, no paid repair',async()=>{
 const f=fixture({side:async(_step,_sp,ut)=>ut==='native fixture prompt'?'text':JSON.stringify({actors:[{id:'a',name:'阿青',activity:'下午去仓库搬货'}]})});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,false);assert.equal(r.npcReceipt?.status,'accepted');assert.equal(r.state?.actors[0].activity,'下午去仓库搬货');assert.equal(f.claims(),2);
});
test('a foreign actor identity still fails; quote and event notes are soft provenance',()=>{
 const wrong=accepted();Object.assign(wrong.npc_parallel_decisions[0],{actorId:'sibling-actor'});
 assert.ok(admitNpcBatch(JSON.stringify(wrong),batch,scope,sealed,normalizeLiteraryEcologyState(wrong,ecology)!).errors.length);
 for(const patch of [{quote:'原侧写里不存在'},{eventIds:['invented']}]){
  const data=accepted();Object.assign(data.npc_parallel_decisions[0],patch);
  const result=admitNpcBatch(JSON.stringify(data),batch,scope,sealed,normalizeLiteraryEcologyState(data,ecology)!);
  assert.deepEqual(result.errors,[]);assert.equal(result.receipt.status,'accepted');assert.deepEqual(result.receipt.entries[0].eventIds,[]);
 }
});
test('event admission keeps only events the actor really took part in',()=>{
 const data={...accepted(),occurrences:[{id:'other-event',name:'其他人物的事件',participants:['b','c']},{id:'own-event',name:'阿青的事',participants:['a']}]};
 Object.assign(data.npc_parallel_decisions[0],{eventIds:['other-event','missing-event',42,'own-event']});
 const result=admitNpcBatch(JSON.stringify(data),batch,scope,sealed,normalizeLiteraryEcologyState(data,ecology)!);
 assert.deepEqual(result.errors,[]);assert.equal(result.receipt.status,'accepted');assert.deepEqual(result.receipt.entries[0].eventIds,['own-event']);
});
test('provider exception keeps original ecology and does not run fallback story writer',async()=>{
 const f=fixture({provider:{enabled:()=>true,claimRequest:()=>{},generate:async()=>{throw Error('合成断流');}}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.match(r.error!,/合成断流/);assert.deepEqual(f.steps,[]);assert.deepEqual(r.state?.actors,ecology.actors);
});
test('partial generated content stays failed and never enters intake until generation completes',async()=>{
 const f=fixture({provider:{enabled:()=>true,claimRequest:()=>{throw Error('must not charge intake');},generate:async()=>({...batch,errors:['HTTP 403'],calls:7})}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.equal(r.npcReceipt?.status,'failed');
 assert.equal(r.npcReceipt?.entries[0].text,batch.entries[0].text);assert.deepEqual(f.steps,[]);assert.deepEqual(r.state?.actors,ecology.actors);
});
test('explicit upstream error envelopes are not NPC content, while ordinary error-related prose is allowed',()=>{
 for(const text of ['[ProxySystem Error] HTTP 403 forbidden','{"error":{"code":403,"message":"denied"}}','Request blocked due to safety settings'])
  assert.throws(()=>sealNpcCandidates({...batch,entries:[{name:'阿青',text}]},scope,ecology));
 assert.equal(sealNpcCandidates({...batch,entries:[{name:'阿青',text:'阿青发现账目有 error 字样，继续核对。'}]},scope,ecology).length,1);
});
test('explicit provider failures retain sanitized permanent and retryable categories',()=>{
 for(const [text,kind]of [
  ['[ProxySystem Error] HTTP 403 private-secret','auth'],
  ['{"error":{"code":"SAFETY","message":"private-secret"}}','content-filter'],
  ['{"error":{"code":429,"message":"private-secret"}}','rate-limit'],
  ['{"error":{"message":"insufficient_quota private-secret"}}','quota'],
 ]as const){
  assert.throws(()=>assertNpcModelContent(text),(error:Error)=>{assert.equal(classifyModelFailure(error).kind,kind);assert.equal(classifyModelFailure(error.message).kind,kind);assert.doesNotMatch(error.message,/private-secret/);return true;});
 }
 assert.doesNotThrow(()=>assertNpcModelContent('{"error":"a story field","actors":[]}'));
});
test('ordinary ecology repair failure supersedes the original JSON error',async()=>{
 for(const error of ['HTTP 403 authentication failed','[ProxySystem Error] SAFETY']){
  const f=fixture({provider:undefined,side:async()=> 'invalid json',repair:async()=>({error})});
  const r=await computeNpcEcology(f.input);assert.equal(r.error,error);assert.equal(classifyModelFailure(r.error).retryable,false);
 }
});
test('local budget exhaustion stays quota while unknown failures never become schema',async()=>{
 for(const message of ['原脚本本来源的合成/辅助模型请求已达8次预算，未继续收费调用','NPC Parallel 单任务受管模型调用达到8次上限','辅助模型预算已耗尽','local model budget exhausted']){
  for(const error of [message,new Error(message)])assert.equal(npcFailureReason(error),'quota exceeded');
  const f=fixture({provider:{enabled:()=>true,claimRequest:()=>{},generate:async()=>({...batch,entries:[],calls:28,errors:['schema format failure',message]})}});
  const r=await computeNpcEcology(f.input);assert.equal(r.error,'quota exceeded');assert.equal(settlementFailureRetryable(r.error!),false);
  assert.equal(r.npcReceipt?.calls,28);assert.equal(r.npcReceipt?.status,'failed');assert.deepEqual(f.steps,[]);
 }
 for(const message of ['unrecognized callback failure','原始目标名单缺失，无法安全续跑']){
  const reason=npcFailureReason(message);assert.doesNotMatch(reason,/schema/);assert.equal(settlementFailureRetryable(reason),false);
  const f=fixture({provider:{enabled:()=>true,claimRequest:()=>{},generate:async()=>({...batch,entries:[],errors:[message]})}});
  const r=await computeNpcEcology(f.input);assert.equal(r.error,reason);assert.equal(settlementFailureRetryable(r.error!),false);
 }
});
test('generic partial generation is retryable but permanent provider failures dominate',async()=>{
 for(const [errors,kind]of [
   [['schema 原版插件报告1名NPC生成失败'],'format'],
  [['原版插件报告1名NPC生成失败','HTTP 403'],'auth'],
  [['network failed','[ProxySystem Error] SAFETY'],'content-filter'],
  [['schema failed','quota exceeded'],'quota'],
 ]as const){
  const f=fixture({provider:{enabled:()=>true,claimRequest:()=>{},generate:async()=>({...batch,errors:[...errors]})}});
  const r=await computeNpcEcology(f.input);assert.equal(classifyModelFailure(r.error).kind,kind);assert.equal(r.npcReceipt?.status,'failed');
 }
});
test('immutable partial caches explicitly stop settlement retries and retain sanitized original classifications',async()=>{
 for(const [error,kind]of [['network failed private-secret','transport'],['HTTP 403 private-secret','auth'],['[ProxySystem Error] SAFETY private-secret','content-filter']]as const){
  const f=fixture({provider:{enabled:()=>true,claimRequest:()=>{throw Error('must not charge');},generate:async()=>({...batch,cached:true,errors:[error]})}});
  const r=await computeNpcEcology(f.input);
  assert.match(r.error!,/；原始目标名单缺失，无法安全续跑$/);
  assert.doesNotMatch(r.error!,/private-secret/);assert.equal(classifyModelFailure(r.error).kind,kind);
  assert.equal(settlementFailureRetryable(r.error!),false);assert.equal(r.npcReceipt?.status,'failed');
  assert.equal(r.npcReceipt?.entries[0].text,batch.entries[0].text);assert.deepEqual(f.steps,[]);
 }
});
test('cancelled/stale work is not admitted and does not start new charges',async()=>{
 const abort=new AbortController();abort.abort();const f=fixture({signal:abort.signal});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.equal(f.claims(),0);assert.equal(f.generation(),0);
 const g=fixture({guard:()=>{throw Error('分支已变化');}});assert.equal((await computeNpcEcology(g.input)).degraded,true);assert.equal(g.claims(),0);
});
test('disabled provider leaves normal existing ecology pipeline unchanged',async()=>{
 const f=fixture({provider:{enabled:()=>false,claimRequest:()=>{throw Error('must not charge');},generate:async()=>{throw Error('must not run');}},side:async step=>{f.steps.push(step);return JSON.stringify({actors:ecology.actors});}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,false);assert.equal(r.npcReceipt,undefined);assert.deepEqual(f.steps,['ecologyRuntime']);
});
test('missing intake Skill fails before invoking original plugin or charging',async()=>{
 const f=fixture({npcSkillBody:undefined});assert.equal((await computeNpcEcology(f.input)).degraded,true);assert.equal(f.generation(),0);assert.equal(f.claims(),0);
});
test('receipts are source-bound and latest branch-only',()=>{
 const f={version:1,sourceEntryId:'old',entries:[]} as any,g={version:1,sourceEntryId:'current',entries:[]} as any;
 assert.equal(npcReceiptFromBranch([{customType:NPC_PARALLEL_ENTRY_TYPE,data:f},{customType:NPC_PARALLEL_ENTRY_TYPE,data:g}],'old'),f);
 assert.equal(npcReceiptFromBranch([{customType:NPC_PARALLEL_ENTRY_TYPE,data:f}],'sibling'),undefined);
});
test('invented user commitment cannot survive as optional event prose',async()=>{
 const f=fixture({side:async(_step,_sp,ut)=>ut==='native fixture prompt'?'text':JSON.stringify({...accepted(),occurrences:[{id:'invented-promise',name:'用户答应离开屋子',userRole:'committed',participants:['a'],development:'用户已经答应',userCommitment:{source:'npc',sourceEntryId:'fake',quote:'用户答应'}}]})});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.equal(r.npcReceipt?.status,'failed');
 assert.equal(r.state?.occurrences.find(e=>e.id==='invented-promise'),undefined);assert.equal(f.claims(),3);
});

test('native small presence caps reserve reasoning output without borrowing the author',async()=>{
 const budgets:number[]=[];
 const f=fixture({side:async(_step,_sp,ut,max)=>{budgets.push(max);return ut==='native fixture prompt'?batch.entries[0].text:JSON.stringify(accepted());}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,false);assert.deepEqual(budgets,[4096,16384]);assert.equal(f.claims(),2);
});


test('unsupported user commitment repairs once into NPC-only development',async()=>{
 let intake=0;const f=fixture({side:async(_step,_sp,ut)=>{if(ut==='native fixture prompt')return 'candidate';if(++intake===1)return JSON.stringify({...accepted(),occurrences:[{id:'bad',name:'无来源承诺',userRole:'committed',participants:['a'],userCommitment:{source:'npc',sourceEntryId:'fake',quote:'fake'}}]});return JSON.stringify(accepted());}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,false);assert.equal(intake,2);assert.equal(r.state?.occurrences.find(e=>e.id==='bad'),undefined);
});

test('empty reports cannot accept candidates using inherited old actors',async()=>{
 for(const report of [{},{output_mode:'delta'}]){
  const f=fixture({side:async(_step,_sp,ut)=>ut==='native fixture prompt'?'text':JSON.stringify(report)});
  const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.notEqual(r.npcReceipt?.status,'accepted');
 }
});

test('only the exact legacy validation-as-success receipt is recoverable; business rejection remains settled',async()=>{
 const {hasLegacyUnsettledNpcValidation}=await import('../src/stage/npc-parallel.ts');
 const bad={version:1,sourceEntryId:'source',status:'rejected',reason:'场外候选包含缺少真实来源的用户承诺，整批隔离；原生态保留',entries:[]};
 const branch=[{customType:NPC_PARALLEL_ENTRY_TYPE,data:bad}];assert.equal(hasLegacyUnsettledNpcValidation(branch,'source'),true);assert.equal(hasLegacyUnsettledNpcValidation(branch,'sibling'),false);
 assert.equal(hasLegacyUnsettledNpcValidation([...branch,{customType:'rp-turn-settlement',data:{narrativeEntryId:'source',npcValidationRecovered:true,ecologyDone:true}}],'source'),false);
 assert.equal(hasLegacyUnsettledNpcValidation([...branch,{customType:NPC_PARALLEL_ENTRY_TYPE,data:{...bad,status:'accepted'}}],'source'),false);
 assert.equal(hasLegacyUnsettledNpcValidation([...branch,{customType:NPC_PARALLEL_ENTRY_TYPE,data:{...bad,status:'failed',reason:'repair still invalid'}}],'source'),true);
 assert.equal(hasLegacyUnsettledNpcValidation([{customType:NPC_PARALLEL_ENTRY_TYPE,data:{...bad,reason:'批次存在冲突候选，整批未入账；保留原生态状态'}}],'source'),false);
});

function freshActorFixture(change:(report:any,candidate:any)=>void=()=>{}) {
 const newBatch:NpcParallelBatch={...batch,entries:[{name:'阿澄',text:'阿澄在茶铺核对进货账目。'}]};
 const candidate=sealNpcCandidates(newBatch,scope,ecology)[0];
 const alias='model-new-actor';let intakes=0;
 const report:any={actors:[...ecology.actors,{id:alias,name:candidate.name,location:'茶铺',activity:'核对进货账目'}],
  occurrences:[{id:'stock-check',name:'核对货单',participants:[alias],publicSurface:{publicity:'public',audience:[alias]},communication:{senderRef:alias,recipientRefs:['a'],channel:'纸条',state:'queued'}}],
  secrets:[{id:'stock-secret',subject:'库存差额',truth:'有一笔待核对',knownBy:[alias]}],
  npc_parallel_decisions:[{candidateId:candidate.id,actorId:alias,verdict:'accept',quote:'在茶铺核对进货账目',reason:'与当前时间相容',eventIds:['stock-check']}]};
 change(report,candidate);
 const original=JSON.stringify(report);
 const f=fixture({provider:{enabled:()=>true,claimRequest:(_s,g)=>g(),generate:async input=>{
  await input.generate({messages:[{role:'user',content:'native fixture prompt'}],maxTokens:1000});return structuredClone(newBatch);
 }},side:async(step,_sp,ut)=>{f.steps.push(step);if(ut==='native fixture prompt')return newBatch.entries[0].text;intakes++;return JSON.stringify(report);}});
 return{...f,candidate,alias,report,original,intakes:()=>intakes};
}

test('fresh NPC actor identity is bound from its unique sealed candidate without regenerating the complete report',async()=>{
 const f=freshActorFixture(),before=JSON.stringify(ecology),r=await computeNpcEcology(f.input);
 assert.equal(r.degraded,false);assert.equal(r.npcReceipt?.status,'accepted');assert.equal(f.intakes(),1);
 assert.equal(r.state?.actors.find(a=>a.name==='阿澄')?.id,f.candidate.actorId);
 assert.ok(!r.state?.actors.some(a=>a.id===f.alias));
 const event=r.state?.occurrences.find(e=>e.id==='stock-check');
 assert.deepEqual(event?.participants,[f.candidate.actorId]);
 assert.deepEqual(event?.publicSurface?.audience,[f.candidate.actorId]);
 assert.equal(event?.communication?.senderRef,f.candidate.actorId);
 assert.deepEqual(event?.communication?.recipientRefs,['a']);
 assert.deepEqual(r.state?.secrets.find(s=>s.id==='stock-secret')?.knownBy,[f.candidate.actorId]);
 assert.equal(JSON.stringify(ecology),before);assert.equal(JSON.stringify(f.report),f.original);
 assert.equal(r.npcReceipt?.entries[0].text,'阿澄在茶铺核对进货账目。');
});

for(const [name,change]of Object.entries({
 'decision identity disagrees with actor row':(r:any)=>{r.npc_parallel_decisions[0].actorId='another-id';},
 'alias steals a committed actor id':(r:any)=>{r.actors[1].id='a';r.npc_parallel_decisions[0].actorId='a';},
 'alias steals a committed actor name':(r:any)=>{r.actors[1].id='阿青';r.npc_parallel_decisions[0].actorId='阿青';},
 'duplicate named actors':(r:any)=>{r.actors.push({...r.actors[1],id:'duplicate-new'});},
 'duplicate alias owned by another actor':(r:any)=>{r.actors.push({id:'model-new-actor',name:'阿白'});},
 'unknown candidate source':(r:any)=>{r.npc_parallel_decisions[0].candidateId='foreign-candidate';},
 'alias collides with an occurrence id':(r:any)=>{r.actors[1].id='stock-check';r.npc_parallel_decisions[0].actorId='stock-check';},
}))test(`fresh actor binding does not weaken intake validation: ${name}`,async()=>{
 const f=freshActorFixture(change),r=await computeNpcEcology(f.input);
 assert.equal(r.degraded,true);assert.equal(r.npcReceipt?.status,'failed');assert.equal(f.intakes(),2);
 assert.deepEqual(r.state?.actors,ecology.actors);
});

test('fresh actor identity binding does not rewrite prose, evidence quotes, occurrence ids or user commitment source ids',async()=>{
 const f=freshActorFixture((r:any)=>{
  const actor=r.actors[1];actor.activity='model-new-actor 是账目中的原样编号';
  actor.knowledgeLedger=[{id:'knowledge-row',subjectRef:'model-new-actor',summary:'收到纸条',sourceRef:'model-new-actor',route:'message',certainty:'suspected',evidence:'model-new-actor'}];
  r.occurrences[0].development='纸上保留编号 model-new-actor';
  r.occurrences[0].userRole='committed';r.occurrences[0].userCommitment={source:'latest-user',sourceEntryId:'model-new-actor',occurrenceId:'stock-check',quote:'继续整理'};
 });
 const r=await computeNpcEcology(f.input);
 // The invalid user provenance is not "fixed" into an accepted commitment.
 assert.equal(r.degraded,true);assert.equal(r.npcReceipt?.status,'failed');assert.equal(JSON.stringify(f.report),f.original);
});


test('fresh actor aliases cannot steal another sealed candidate identity',async()=>{
 const b={...batch,entries:[{name:'阿澄',text:'阿澄在茶铺核对货单。'},{name:'阿白',text:'阿白在花店浇花。'}]};
 const cs=sealNpcCandidates(b,scope,ecology),alias=cs[1].actorId;
 const f=fixture({provider:{enabled:()=>true,claimRequest:(_s,g)=>g(),generate:async()=>structuredClone(b)},side:async()=>JSON.stringify({
  actors:[...ecology.actors,{id:alias,name:cs[0].name},{id:'second-model-id',name:cs[1].name}],
  npc_parallel_decisions:cs.map((c,i)=>({candidateId:c.id,actorId:i===0?alias:'second-model-id',verdict:'accept',quote:i===0?'核对货单':'在花店浇花',eventIds:[]})),
 })});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.equal(r.npcReceipt?.status,'failed');
});

test('fresh actor identity binding leaves literal prose and provenance fields unchanged',()=>{
 const f=freshActorFixture((r:any)=>{r.actors[1].activity='model-new-actor 原样文字';r.actors[1].knowledgeLedger=[{id:'k',subjectRef:'actor:model-new-actor',sourceRef:'occurrence:model-new-actor',evidence:'model-new-actor'}];r.occurrences[0].development='model-new-actor';r.occurrences[0].userCommitment={source:'latest-user',sourceEntryId:'model-new-actor',occurrenceId:'stock-check',quote:'model-new-actor'};});
 const raw=f.original;
 return import('../src/stage/npc-actor-identity.ts').then(({bindNewNpcActorIds})=>{
  const bound=JSON.parse(bindNewNpcActorIds(raw,[f.candidate],ecology));
  assert.equal(bound.actors[1].id,f.candidate.actorId);assert.equal(bound.actors[1].activity,f.report.actors[1].activity);
  assert.deepEqual(bound.actors[1].knowledgeLedger,f.report.actors[1].knowledgeLedger);
  assert.equal(bound.occurrences[0].development,f.report.occurrences[0].development);
  assert.deepEqual(bound.occurrences[0].userCommitment,f.report.occurrences[0].userCommitment);
  assert.equal(JSON.stringify(f.report),raw);
 });
});

test('only an explicit manual ecology recovery forwards the failed-cache retry flag',async()=>{
 for(const explicitRetry of [undefined,true]){
  const f=fixture({explicitRetry}),provider=f.input.provider!,generate=provider.generate;
  provider.generate=async request=>{assert.equal(request.explicitRetry,explicitRetry);return generate(request)};
  const result=await computeNpcEcology(f.input);assert.equal(result.degraded,false);assert.equal(f.claims(),2);
 }
});

test('NPC admission and cognition share canonical occurrence merge identities',async()=>{
  for(const delta of [false,true])for(const forged of [false,true]){
  let intakes=0;
  const f=fixture({side:async(_step,_sp,ut)=>{
   if(ut==='native fixture prompt')return 'candidate';intakes++;
    const report:any=accepted();
    if(delta){report.output_mode='delta';delete report.actors[0].name;}
   report.actors[0].knowledgeLedger=[{id:'k',subjectRef:'occurrence:model-event',sourceRef:'occurrence:model-event',summary:'Read the notice',route:'public-channel',certainty:'confirmed',evidence:'literal model-event'}];
   report.occurrences=['canonical-event','model-event'].map(id=>({id,name:'Notice',patternKey:'shared-notice',participants:forged?['other-actor']:['a'],publicSurface:{publicity:'public',headline:'Notice'}}));
   report.npc_parallel_decisions[0].eventIds=['model-event'];
   return JSON.stringify(report);
  }});
  const before=JSON.stringify(ecology),result=await computeNpcEcology(f.input);
  assert.equal(JSON.stringify(ecology),before);
  if(forged){assert.equal(result.npcReceipt?.status==='accepted'?result.npcReceipt.entries[0].eventIds.length:0,0,'a forged participation note is dropped');}
  else{assert.equal(intakes,1);
   assert.equal(result.npcReceipt?.status,'accepted');
   assert.deepEqual(result.npcReceipt.entries[0].eventIds,['canonical-event']);
   assert.equal(result.state?.actors[0].knowledgeLedger?.[0].sourceRef,'occurrence:canonical-event');
  }
  }
});

test('managed delta updates A while retaining B, frozen knowledge, secrets and locations without full recopy',async()=>{
 const base=normalizeLiteraryEcologyState({actors:[...ecology.actors,{id:'b',name:'Reader',tier:'background',knowledge:['old knowledge'],knowledgeLedger:[{id:'k',subjectRef:'secret:s',summary:'frozen belief',route:'inferred'}]}],secrets:[{id:'s',subject:'Hidden',truth:'old truth',knownBy:['b'],traces:['old trace']}],locationStates:[{location:'Shop',state:'open',activities:['reading']}]},ecology)!;
 const report={output_mode:'delta',actors:[{id:'a',activity:'在柜台记账'}],npc_parallel_decisions:accepted().npc_parallel_decisions};
 const before=JSON.stringify(base);
 const f=fixture({ecology:base,committedEcology:base,side:async(_step,_sp,ut)=>{
  if(ut==='native fixture prompt')return 'candidate';
  const data=JSON.parse(ut);assert.equal(data.response_mode.output_mode,'delta');
  assert.deepEqual(data.current_ecology,base);assert.equal(ut,JSON.stringify(data));
  return JSON.stringify(report);
 }});
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,false);assert.equal(result.state?.actors[0].activity,'在柜台记账');
 assert.deepEqual(result.state?.actors[1],base.actors[1]);assert.deepEqual(result.state?.secrets,base.secrets);
 assert.deepEqual(result.state?.locationStates,base.locationStates);
 assert.ok(JSON.stringify(report).length<JSON.stringify({...base,npc_parallel_decisions:report.npc_parallel_decisions}).length/2);
 assert.equal(JSON.stringify(base),before);assert.equal((result.state as any).output_mode,undefined);
});

test('delta repair always starts from the frozen baseline, not failed actors, knowledge or events',async()=>{
 let calls=0;
 const f=fixture({side:async(_step,_sp,ut)=>{
  if(ut==='native fixture prompt')return 'candidate';
  if(++calls===1)return JSON.stringify({output_mode:'delta',actors:[{id:'a',activity:'failed action',knowledge:['failed knowledge']}],occurrences:[{id:'bad',name:'forged extraction',origin:'narrative',narrativeEvidence:{sourceEntryId:'wrong',quote:'fake'}}],npc_parallel_decisions:accepted().npc_parallel_decisions});
  return JSON.stringify({output_mode:'delta',actors:[{id:'a',nextAction:'rest'}],npc_parallel_decisions:accepted().npc_parallel_decisions});
 }});
 const result=await computeNpcEcology(f.input);assert.equal(result.degraded,false);assert.equal(calls,2);
 assert.equal(result.state?.actors[0].activity,ecology.actors[0].activity);
 assert.deepEqual(result.state?.actors[0].knowledge,ecology.actors[0].knowledge);assert.deepEqual(result.state?.occurrences,[]);
});

test('cancellation after a delta response never admits its changes',async()=>{
 const abort=new AbortController();
 const f=fixture({signal:abort.signal,side:async(_step,_sp,ut)=>{
  if(ut==='native fixture prompt')return 'candidate';
  abort.abort();return JSON.stringify({output_mode:'delta',actors:[{id:'a',activity:'late change'}],npc_parallel_decisions:accepted().npc_parallel_decisions});
 }});
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,true);assert.deepEqual(result.state?.actors,ecology.actors);assert.equal(f.claims(),2);
});

test('delta rejects duplicate identities, name conflicts and capacity overflow without dropping old state',async()=>{
 const {expandEcologyDelta}=await import('../src/stage/npc-ecology.ts');
 const base=normalizeLiteraryEcologyState({actors:Array.from({length:60},(_,i)=>({id:`a${i}`,name:`Actor${i}`})),secrets:Array.from({length:40},(_,i)=>({id:`s${i}`,subject:`Secret${i}`})),locationStates:Array.from({length:30},(_,i)=>({location:`Place${i}`})),occurrences:Array.from({length:80},(_,i)=>({id:`e${i}`,name:`Event${i}`,patternKey:`pattern${i}`}))},defaultLiteraryEcologyState())!;
 for(const patch of [
  {actors:[{id:'a0'},{id:'a0'}]}, {actors:[{id:'new',name:'Actor0'}]}, {actors:[{id:'a0',name:'Other'}]},
  {actors:null}, {secrets:[{id:'s0'},{id:'s0'}]}, {locationStates:[{location:'Place0'},{location:'Place0'}]},
  {actors:[{id:'new',name:'New'}]}, {secrets:[{id:'new',subject:'New'}]}, {locationStates:[{location:'New'}]},
  {occurrences:[{id:'new',name:'New'}]}, {occurrences:[{id:'e0'},{id:'e0'}]},
 ])assert.throws(()=>expandEcologyDelta(JSON.stringify({output_mode:'delta',...patch}),base),/生态delta/);
});

test('delta shallow merges secrets and locations, replaces internal arrays, and fills existing event identity once',async()=>{
 const {expandEcologyDelta}=await import('../src/stage/npc-ecology.ts');
 const base=normalizeLiteraryEcologyState({actors:[{id:'a',name:'A',tier:'core',knowledge:['old']}],secrets:[{id:'s',subject:'Hidden',truth:'truth',knownBy:['a'],traces:['old']}],locationStates:[{location:'Shop',state:'open',activities:['old']}],occurrences:[{id:'e',name:'Event',patternKey:'stable',participants:['a'],development:'old'}]},defaultLiteraryEcologyState())!;
 const raw=JSON.stringify({output_mode:'delta',actors:[{id:'a',knowledge:[]}],secrets:[{id:'s',traces:[]}],locationStates:[{location:'Shop',activities:['new']}],occurrences:[{id:'e',development:'new'}]});
 const next=normalizeLiteraryEcologyState(expandEcologyDelta(raw,base),base)!;
 assert.equal(next.actors[0].tier,'core');assert.deepEqual(next.actors[0].knowledge,[]);
 assert.equal(next.secrets[0].truth,'truth');assert.deepEqual(next.secrets[0].knownBy,['a']);assert.deepEqual(next.secrets[0].traces,[]);
 assert.equal(next.locationStates[0].state,'open');assert.deepEqual(next.locationStates[0].activities,['new']);
 assert.equal(next.occurrences[0].name,'Event');assert.equal(next.occurrences[0].patternKey,'stable');assert.equal(next.occurrences[0].development,'new');
});

for(const delta of [false,true])for(const scenario of ['valid','reject','actor','quote','event','commitment','duplicate','invalid-verdict','null-verdict'] as const)
test(`${delta?'delta':'snapshot'} five decisions without required verdict preserve intake validation: ${scenario}`,async()=>{
   const b={...batch,entries:Array.from({length:5},(_,i)=>({name:`synthetic-${i}`,text:`synthetic-${i} sorts books.`}))};
   const cs=sealNpcCandidates(b,scope,ecology);
    const report:any={actors:cs.map(c=>({id:c.actorId,name:c.name,activity:'sorts books'})),npc_parallel_decisions:cs.map(c=>({candidateId:c.id,actorId:c.actorId,reason:'Compatible offscreen activity',quote:c.text,eventIds:[]}))};
    if(delta)report.output_mode='delta';
   const decision=report.npc_parallel_decisions[0];
   if(scenario==='reject')decision.verdict='reject';
   if(scenario==='actor')decision.actorId=cs[1].actorId;
   if(scenario==='quote')decision.quote='forged quote';
   if(scenario==='event')decision.eventIds=['nonexistent-event'];
   if(scenario==='commitment')report.occurrences=[{id:'false-promise',name:'invented promise',participants:[cs[0].actorId],userRole:'committed',userCommitment:{source:'npc',sourceEntryId:'fake',quote:'fake'}}];
   if(scenario==='duplicate')report.npc_parallel_decisions[4]={...decision};
   if(scenario==='invalid-verdict')decision.verdict='accepted';
   if(scenario==='null-verdict')decision.verdict=null;
   let calls=0,claims=0,generations=0;
   const before=JSON.stringify(ecology);
   const f=fixture({provider:{enabled:()=>true,claimRequest:(_s,g)=>{g();claims++;},generate:async()=>{generations++;return structuredClone(b);}},side:async(step,_sp,ut)=>{
    assert.equal(step,'npcParallel');calls++;const data=JSON.parse(ut);
     assert.equal(data.npc_parallel.decision_schema.items.properties.verdict,undefined);
    assert.ok(!data.npc_parallel.decision_schema.items.required.includes('verdict'));
    assert.equal(data.npc_parallel.decision_schema.minItems,5);
    if(calls===1)assert.equal(data.repair,undefined);
    else{assert.equal(calls,2);assert.deepEqual(JSON.parse(data.repair.invalid_report),report);}
    return JSON.stringify(report);
   }});
    const r=await computeNpcEcology(f.input),accepted=['valid','invalid-verdict','null-verdict','quote','event'].includes(scenario),failed=!accepted&&scenario!=='reject';
   assert.equal(calls,failed?2:1);assert.equal(claims,calls);assert.equal(generations,1);
   assert.equal(JSON.stringify(ecology),before);assert.equal(r.degraded,failed);
   assert.equal(r.npcReceipt?.entries.length,5);
    if(accepted){
    assert.equal(r.npcReceipt?.status,'accepted');assert.ok(r.npcReceipt.entries.every(e=>e.status==='accepted'));
    for(const c of cs)assert.equal(r.state?.actors.find(a=>a.id===c.actorId)?.activity,'sorts books');
   }else if(scenario==='reject'){
    assert.equal(r.npcReceipt?.status,'rejected');assert.equal(r.quarantined,true);
    assert.ok(r.npcReceipt.entries.every(e=>e.status==='rejected'));assert.deepEqual(r.state?.actors,ecology.actors);
   }else{
    assert.equal(r.npcReceipt?.status,'failed');assert.deepEqual(r.state?.actors,ecology.actors);
    assert.deepEqual(r.state?.occurrences,ecology.occurrences);
   }
});
