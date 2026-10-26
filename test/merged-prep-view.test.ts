import test from 'node:test';
import assert from 'node:assert/strict';
import {displayPrepPhases,mergedPrepView,MERGED_PREP_LABEL} from '../src/stage/merged-prep-view.ts';
import {npcReceiptFromBranch,type NpcParallelReceipt} from '../src/stage/npc-parallel.ts';
import {toWireMsg} from '../server/wire.ts';
import {diagnosticsFromBranch} from '../src/stage/diagnostics.ts';
const phases={
 'prep.database':{durationMs:2100,calls:2,usageCalls:2,status:'success' as const,inputTokens:500,outputTokens:90},
 'prep.director':{durationMs:0,calls:0,status:'skipped' as const,reason:'merged-database-recall' as const},
 'prep.memoryRecall':{durationMs:0,calls:0,status:'skipped' as const},
 'prep.memoryArcs':{durationMs:0,calls:0,status:'skipped' as const},
};
test('merged phases appear once with native wall time / usage, no duplicated legacy zero calls',()=>{
 const before=structuredClone(phases),view=displayPrepPhases(phases);
 assert.equal(view.length,1);assert.equal(view[0][0],'prep.recallDirector');assert.equal(view[0][1].calls,2);assert.equal(view[0][1].durationMs,2100);assert.equal(view[0][1].inputTokens,500);assert.deepEqual(phases,before);
 assert.equal(mergedPrepView({},phases)?.label,MERGED_PREP_LABEL);
 assert.equal(mergedPrepView({},phases)?.status,'success');
 assert.equal(mergedPrepView({}, {...phases,'prep.director':{...phases['prep.director'],reason:'missing-director-candidate'}})?.status,'degraded');
});
test('legacy merged receipts remain honest, real standalone work stays separate',()=>{
 const historical={...phases,'prep.director':{durationMs:0,calls:0,status:'skipped' as const}};
 assert.equal(displayPrepPhases(historical).length,1);assert.equal(mergedPrepView({},historical)?.status,'skipped');
 const independent={...phases,'prep.director':{durationMs:100,calls:1,status:'success' as const}};
 assert.equal(displayPrepPhases(independent).length,4);assert.equal(mergedPrepView({},independent),undefined);
 const actualRecall={...phases,'prep.memoryRecall':{durationMs:100,calls:1,status:'success' as const}};
 assert.equal(displayPrepPhases(actualRecall).length,2);
});
test('workflow and director-room diagnostics use the same merged role and suppress the old recall stub',()=>{
 const details={rpNarrative:'synthetic narrative',rpWorkflow:{appends:1},rpPrep:{recallDirectorMerged:true,literaryDirectionData:{scenePressure:'synthetic'},workflowStatus:{director:'success'}}};
 const wire=toWireMsg({role:'assistant',content:[{type:'text',text:'synthetic narrative'}],details},{charName:'synthetic',userName:'synthetic'});
 assert.equal(wire?.workflow?.stages.find(s=>s.id==='director')?.label,MERGED_PREP_LABEL);
 const view=diagnosticsFromBranch([{id:'story',type:'message',message:{role:'assistant',details}}]).turns[0];
 assert.equal(view.stages.find(s=>s.id==='director')?.label,MERGED_PREP_LABEL);assert.equal(view.stages.some(s=>s.id==='memory-recall'),false);
});
test('a later failed retry retains prior unadmitted text without changing its outcome or source',()=>{
 const receipt=(source='story',entries:NpcParallelReceipt['entries']=[],commit='a'.repeat(40)):NpcParallelReceipt=>({version:1,sourceEntryId:source,upstreamVersion:'fixture',upstreamCommit:commit,calls:2,status:'failed',entries});
 const entry={id:'candidate',name:'synthetic',actorId:'actor',hash:'hash',text:'synthetic retained text',status:'rejected' as const,reason:'synthetic failure',eventIds:[]};
 const first=receipt('story',[entry]),last=receipt();
 const branch=[{customType:'rp-npc-parallel',data:receipt('sibling',[{...entry,hash:'wrong'}])},{customType:'rp-npc-parallel',data:first},{customType:'rp-npc-parallel',data:last}];
 const view=npcReceiptFromBranch(branch,'story')!;
 assert.equal(view.status,'failed');assert.deepEqual(view.entries,[]);assert.equal(view.retainedEntries?.length,1);assert.equal(view.retainedEntries![0].text,entry.text);assert.equal(last.retainedEntries,undefined);assert.deepEqual(first.entries[0].eventIds,[]);
 assert.equal(npcReceiptFromBranch([...branch,{customType:'rp-npc-parallel',data:{...last,status:'accepted'}}],'story')?.retainedEntries,undefined);
});
