import assert from 'node:assert/strict';
import test from 'node:test';
import {computeNpcEcology,type NpcEcologyInput} from '../src/stage/npc-ecology.ts';
import {defaultLiteraryEcologyState,emptyEcologyGlobalPool,emptyEcologyCardPool} from '../src/stage/literary-ecology.ts';
import {defaultState} from '../src/state.ts';

const narrative='The keeper closes the gate.\nThe lamps remain lit.';
const sourceEntryId='synthetic-current-branch';
function report(quote='The keeper closes the gate.',source=sourceEntryId){
 return JSON.stringify({output_mode:'delta',occurrences:[{id:'gate',name:'Gate closure',origin:'narrative',userRole:'none',narrativeEvidence:{sourceEntryId:source,quote}}]});
}
function fixture(raw:string){
 const ecology=defaultLiteraryEcologyState();let calls=0;
 const input:NpcEcologyInput={scope:{sessionId:'synthetic-session',card:'synthetic-card',sourceEntryId,visibleEntryIds:[sourceEntryId]},ecology,committedEcology:structuredClone(ecology),global:emptyEcologyGlobalPool(),cardPool:emptyEcologyCardPool('synthetic','Synthetic'),lore:[],state:defaultState(),history:[],userText:'Wait.',userEntryId:'synthetic-user',userName:'Visitor',charName:'Keeper',narrative,worldSignals:[],skillBody:'synthetic ecology protocol',preTurn:true,previousRound:0,guard:()=>{},side:async(step)=>{assert.equal(step,'ecologyRuntime');calls++;return raw;}};
 return{input,calls:()=>calls};
}

test('parseable provenance failure gets one same-role repair with frozen canonical input',async()=>{
 const raw=report('The keeper opens the gate.');const f=fixture(raw);let repairs=0;
 const before=structuredClone(f.input.ecology);
 f.input.repair=async(step,prompt,invalid,errors)=>{
  repairs++;assert.equal(step,'ecologyRuntime');assert.equal(invalid,raw);
  assert.ok(errors.some(error=>error.includes('正文提取来源或引文无效')));
  const payload=JSON.parse(prompt.userText);
  assert.equal(payload.latest_turn.narrative,narrative);
  assert.equal(payload.latest_turn.narrative_entry_id,sourceEntryId);
  assert.equal(payload.response_mode.narrative_evidence_schema.properties.sourceEntryId.const,sourceEntryId);
  return report();
 };
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,false);assert.equal(result.state?.round,1);
 assert.equal(result.state?.occurrences[0].narrativeEvidence?.quote,'The keeper closes the gate.');
 assert.equal(f.calls(),1);assert.equal(repairs,1);assert.deepEqual(f.input.ecology,before);
});

for(const [label,raw] of [
 ['sibling source',report('The keeper closes the gate.','synthetic-sibling')],
 ['paraphrase',report('The keeper shuts the gate.')],
 ['stitched fragments',report('The keeper closes ... The lamps remain lit.')],
 ['entity substitution',report('The keeper closes &quot;the gate&quot;.')],
] as const)test(`repair cannot admit ${label} or trigger another repair`,async()=>{
 const f=fixture(report('invalid evidence'));let repairs=0;
 f.input.repair=async()=>{repairs++;return raw;};
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,true);assert.match(result.error!,/正文提取来源或引文无效/);
 assert.deepEqual(result.state?.occurrences,[]);assert.equal(repairs,1);assert.equal(f.calls(),1);
});

test('valid narrative and offscreen development each finish in one computation',async()=>{
 for(const raw of [report(),JSON.stringify({output_mode:'delta',occurrences:[{id:'offscreen',name:'Keeper files receipts',origin:'generated-offscreen',userRole:'none'}]})]){
  const f=fixture(raw);f.input.repair=async()=>{throw Error('unexpected repair');};
  const result=await computeNpcEcology(f.input);
  assert.equal(result.degraded,false);assert.equal(result.state?.occurrences.length,1);assert.equal(f.calls(),1);
 }
});

test('repair transport failure remains failure and does not commit the invalid batch',async()=>{
 const f=fixture(report('invalid evidence'));let repairs=0;
 f.input.repair=async()=>{repairs++;return{error:'HTTP 403 authentication failed'};};
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,true);assert.equal(result.error,'HTTP 403 authentication failed');
 assert.deepEqual(result.state?.occurrences,[]);assert.equal(repairs,1);
});

test('branch changes during repair reject even a valid repaired response',async()=>{
 const f=fixture(report('invalid evidence'));let stale=false;let repairs=0;
 f.input.guard=()=>{if(stale)throw Error('synthetic branch changed');};
 f.input.repair=async()=>{repairs++;stale=true;return report();};
 const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,true);assert.equal(result.error,'synthetic branch changed');
 assert.deepEqual(result.state?.occurrences,[]);assert.equal(repairs,1);
});

test('without a repair callback invalid evidence stays rejected',async()=>{
 const f=fixture(report('invalid evidence'));const result=await computeNpcEcology(f.input);
 assert.equal(result.degraded,true);assert.deepEqual(result.state?.occurrences,[]);assert.equal(f.calls(),1);
});
