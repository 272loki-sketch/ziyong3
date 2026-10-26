import test from 'node:test';
import assert from 'node:assert/strict';
import {savedNpcAdmissionBatch,sealNpcCandidates,npcReceipt,validateNpcAdmissionRequest} from '../src/stage/npc-parallel.ts';
import {defaultLiteraryEcologyState} from '../src/stage/literary-ecology.ts';
const ecology=defaultLiteraryEcologyState(),scope={sessionId:'synthetic-session',card:'synthetic-card',sourceEntryId:'story',visibleEntryIds:['story','receipt']};
const batch={version:'fixture',commit:'a'.repeat(40),calls:2,errors:[],entries:Array.from({length:5},(_,i)=>({name:'合成人物'+i,text:'合成人物'+i+'在书店整理书籍。'}))};
const sealed=sealNpcCandidates(batch,scope,ecology),receipt=npcReceipt(batch,scope,sealed,'failed','schema format failure'),hashes=sealed.map(e=>e.hash),branch=[{id:'receipt',customType:'rp-npc-parallel',data:receipt}],upstream={version:batch.version,commit:batch.commit};
test('explicit admission selects an entire exact saved batch without turning its old failure receipt into success',()=>{
 const before=JSON.stringify(branch),result=savedNpcAdmissionBatch(branch,scope,hashes,upstream,ecology);
 assert.equal(result.admissionOnly,true);assert.equal(result.cached,true);assert.deepEqual(result.errors,[]);assert.deepEqual(result.entries,batch.entries);assert.equal(JSON.stringify(branch),before);assert.equal(receipt.status,'failed');assert.equal(result.calls,2);
 assert.deepEqual(sealNpcCandidates(result,scope,ecology).map(e=>e.hash),hashes);
});
test('saved candidates cannot cross session/card/source/upstream or be combined, changed or submitted as raw text',()=>{
 for(const change of [{sessionId:'sibling'},{card:'other'},{sourceEntryId:'other',visibleEntryIds:['other','receipt']}])assert.throws(()=>savedNpcAdmissionBatch(branch,{...scope,...change},hashes,upstream,ecology));
 assert.throws(()=>savedNpcAdmissionBatch(branch,scope,hashes,{...upstream,commit:'b'.repeat(40)},ecology));
 for(const selected of [hashes.slice(1),[hashes[0],hashes[0]],['b'.repeat(64)],[]])assert.throws(()=>savedNpcAdmissionBatch(branch,scope,selected,upstream,ecology));
 for(const field of ['text','actorId','id'] as const){const modified=structuredClone(branch);(modified[0].data.entries[0] as any)[field]='tampered';assert.throws(()=>savedNpcAdmissionBatch(modified,scope,hashes,upstream,ecology));}
 assert.throws(()=>savedNpcAdmissionBatch(branch,{...scope,visibleEntryIds:['story']},hashes,upstream,ecology));
 assert.throws(()=>validateNpcAdmissionRequest({expectedSessionId:scope.sessionId,expectedSourceEntryId:scope.sourceEntryId,candidateHashes:hashes,text:'untrusted replacement'}));
});
test('an already accepted or explicitly rejected batch never re-enters model admission',()=>{
 for(const status of ['accepted','rejected'] as const){const rows=[...branch,{id:'latest',customType:'rp-npc-parallel',data:{...receipt,status}}];assert.throws(()=>savedNpcAdmissionBatch(rows,{...scope,visibleEntryIds:[...scope.visibleEntryIds,'latest']},hashes,upstream,ecology),/已有完成或业务裁决/);}
});
