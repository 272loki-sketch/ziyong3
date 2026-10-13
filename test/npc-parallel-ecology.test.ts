import assert from 'node:assert/strict';
import test from 'node:test';
import {computeNpcEcology,type NpcEcologyInput} from '../src/stage/npc-ecology.ts';
import {admitNpcBatch,sealNpcCandidates,npcReceiptFromBranch,NPC_PARALLEL_ENTRY_TYPE,type NpcParallelBatch} from '../src/stage/npc-parallel.ts';
import {defaultLiteraryEcologyState,normalizeLiteraryEcologyState,emptyEcologyGlobalPool,emptyEcologyCardPool} from '../src/stage/literary-ecology.ts';
import {defaultState} from '../src/state.ts';
import {normalizeStepModels,resolveStepModel} from '../src/model-routing.ts';
const scope={sessionId:'synthetic-session',card:'synthetic-card',sourceEntryId:'saved-narrative',visibleEntryIds:['saved-narrative']};
const ecology=normalizeLiteraryEcologyState({actors:[{id:'a',name:'阿青',location:'书店',activity:'整理书架'}]},defaultLiteraryEcologyState())!;
const batch:NpcParallelBatch={version:'1.1.0',commit:'a'.repeat(40),calls:1,errors:[],entries:[{name:'阿青',text:'阿青把最后一本书放回书架，接着去柜台记账。',info:'知道：今天的账目'}]};
const sealed=sealNpcCandidates(batch,scope,ecology);
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
test('native generation plus one unified intake, no second independent ecology story',async()=>{
 const f=fixture(),before=JSON.stringify(ecology),r=await computeNpcEcology(f.input);
 assert.equal(r.degraded,false);assert.equal(r.npcReceipt?.status,'accepted');assert.equal(r.state?.actors[0].activity,'在柜台记账');
 assert.deepEqual(f.steps,['npcParallel','npcParallel']);assert.equal(f.claims(),2);assert.equal(f.generation(),1);
 assert.equal(JSON.stringify(ecology),before);assert.equal(r.npcReceipt?.entries[0].text,batch.entries[0].text);
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
test('missing decision is repaired on same charged role; unrepaired result stays pending',async()=>{
 const f=fixture({side:async(_step,_sp,ut)=>ut==='native fixture prompt'?'text':JSON.stringify({actors:[{id:'a',name:'阿青',activity:'未经审计的新行动'}]})});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.equal(r.npcReceipt?.status,'failed');assert.equal(r.state?.actors[0].activity,ecology.actors[0].activity);assert.equal(f.claims(),3);
});
test('forged quote, actor identity and shared-event references cannot pass',()=>{
 for(const patch of [{quote:'原侧写里不存在'},{actorId:'sibling-actor'},{eventIds:['invented']}]){
  const data=accepted();Object.assign(data.npc_parallel_decisions[0],patch);
  assert.ok(admitNpcBatch(JSON.stringify(data),batch,scope,sealed,normalizeLiteraryEcologyState(data,ecology)!).errors.length);
 }
});
test('event admission reports every invalid reference with actor and known participants',()=>{
 const data={...accepted(),occurrences:[{id:'other-event',name:'其他人物的事件',participants:['b','c']}]};
 Object.assign(data.npc_parallel_decisions[0],{eventIds:['other-event','missing-event',42]});
 const result=admitNpcBatch(JSON.stringify(data),batch,scope,sealed,normalizeLiteraryEcologyState(data,ecology)!);
 assert.equal(result.errors.length,3);
 assert.match(result.errors[0],/eventId="other-event".*actorId="a".*participants=\["b","c"\]/);
 assert.match(result.errors[1],/eventId="missing-event".*actorId="a".*事件不存在/);
 assert.match(result.errors[2],/eventId=42.*actorId="a".*必须是字符串/);
 assert.equal(result.receipt.status,'rejected');assert.deepEqual(result.receipt.entries[0].eventIds,[]);
});
test('participant mismatch reaches the single charged repair; illegal reports never enter ecology',async()=>{
 for(const fix of [true,false]){
  const report={...accepted(),occurrences:[
   {id:'occ_jindi_collapse',name:'阿青参与的发生事件',participants:['a']},
   {id:'occ_zongmen_dabi_prep',name:'其他人物的筹备',participants:['b','c','d','e']},
  ]};
  Object.assign(report.npc_parallel_decisions[0],{eventIds:['occ_jindi_collapse','occ_zongmen_dabi_prep']});
  let intake=0;
  const f=fixture({side:async(step,_sp,ut)=>{
   assert.equal(step,'npcParallel');if(ut==='native fixture prompt')return 'candidate';
   const prompt=JSON.parse(ut);intake++;
   if(intake===1){assert.equal(prompt.repair,undefined);return JSON.stringify(report);}
   assert.equal(intake,2);assert.deepEqual(JSON.parse(prompt.repair.invalid_report),report);
   assert.equal(prompt.repair.errors.length,1);
   assert.match(prompt.repair.errors[0],/eventId="occ_zongmen_dabi_prep".*actorId="a".*participants=\["b","c","d","e"\]/);
   assert.match(prompt.repair.errors[0],/该actor不在事件participants中/);
   assert.deepEqual(prompt.npc_parallel.candidates,sealed);
   const repaired=structuredClone(report);
   if(fix)repaired.npc_parallel_decisions[0].eventIds=['occ_jindi_collapse'];
   return JSON.stringify(repaired);
  }});
  const before=JSON.stringify(ecology),r=await computeNpcEcology(f.input);
  assert.equal(intake,2);assert.equal(f.claims(),3);assert.equal(f.generation(),1);
  assert.equal(JSON.stringify(ecology),before);assert.equal(r.degraded,!fix);
  if(fix){
   assert.equal(r.npcReceipt?.status,'accepted');
   assert.deepEqual(r.npcReceipt?.entries[0].eventIds,['occ_jindi_collapse']);
   assert.deepEqual(r.state?.occurrences.find(e=>e.id==='occ_zongmen_dabi_prep')?.participants,['b','c','d','e']);
  }else{
   assert.equal(r.npcReceipt?.status,'failed');assert.match(r.error!,/occ_zongmen_dabi_prep/);
   assert.deepEqual(r.npcReceipt?.entries[0].eventIds,[]);
   assert.deepEqual(r.state?.actors,ecology.actors);assert.deepEqual(r.state?.occurrences,ecology.occurrences);
  }
 }
});
test('provider exception keeps original ecology and does not run fallback story writer',async()=>{
 const f=fixture({provider:{enabled:()=>true,claimRequest:()=>{},generate:async()=>{throw Error('合成断流');}}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.match(r.error!,/合成断流/);assert.deepEqual(f.steps,[]);assert.deepEqual(r.state?.actors,ecology.actors);
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
test('NPC-generated user commitment is quarantined, not silently downgraded while narrative claims success',async()=>{
 const f=fixture({side:async(_step,_sp,ut)=>ut==='native fixture prompt'?'text':JSON.stringify({...accepted(),occurrences:[{id:'invented-promise',name:'用户答应离开屋子',userRole:'committed',participants:['a'],development:'用户已经答应',userCommitment:{source:'npc',sourceEntryId:'fake',quote:'用户答应'}}]})});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,true);assert.equal(r.npcReceipt?.status,'failed');assert.equal(r.state?.occurrences.length,0);assert.equal(f.claims(),3);
});

test('native small presence caps reserve reasoning output without borrowing the author',async()=>{
 const budgets:number[]=[];
 const f=fixture({side:async(_step,_sp,ut,max)=>{budgets.push(max);return ut==='native fixture prompt'?batch.entries[0].text:JSON.stringify(accepted());}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,false);assert.deepEqual(budgets,[4096,16384]);assert.equal(f.claims(),2);
});


test('unsupported user commitment is repaired in the same intake, not hidden by an old snapshot',async()=>{
 let intake=0;const f=fixture({side:async(_step,_sp,ut)=>{if(ut==='native fixture prompt')return 'candidate';if(++intake===1)return JSON.stringify({...accepted(),occurrences:[{id:'bad',name:'无来源承诺',userRole:'committed',participants:['a'],userCommitment:{source:'npc',sourceEntryId:'fake',quote:'fake'}}]});const prompt=JSON.parse(ut);assert.match(prompt.repair.errors.join('；'),/承诺来源校验失败/);return JSON.stringify(accepted());}});
 const r=await computeNpcEcology(f.input);assert.equal(r.degraded,false);assert.equal(r.npcReceipt?.status,'accepted');assert.equal(r.state?.actors[0].activity,'在柜台记账');assert.equal(f.claims(),3);
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
