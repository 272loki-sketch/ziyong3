import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultLiteraryEcologyState, normalizeLiteraryEcologyState, validateEcologyTransition} from '../src/stage/literary-ecology.ts';

const knowledge = (ref: string, route = 'witnessed') => ({id:'k',subjectRef:`occurrence:${ref}`,sourceRef:`occurrence:${ref}`,summary:'The notice was read.',route,certainty:'confirmed',evidence:'literal model-event'});
const event = (id: string) => ({id,name:'Notice',patternKey:'notice-pattern',kind:'ambient',publicSurface:{publicity:'public',headline:'Notice'}});

test('same-report pattern merging preserves valid raw occurrence references', () => {
 const previous=defaultLiteraryEcologyState();
 const raw={actors:[{id:'reader',name:'Reader',knowledgeLedger:[knowledge('model-event','public-channel')]}],occurrences:[event('canonical-event'),event('model-event')]};
 assert.ok(raw.occurrences.some(e=>`occurrence:${e.id}`===raw.actors[0].knowledgeLedger[0].subjectRef));
 const before=JSON.stringify(raw),next=normalizeLiteraryEcologyState(raw,previous)!;
 assert.deepEqual(next.occurrences.map(e=>e.id),['canonical-event']);
 assert.equal(next.actors[0].knowledgeLedger![0].subjectRef,'occurrence:canonical-event');
 assert.equal(next.actors[0].knowledgeLedger![0].sourceRef,'occurrence:canonical-event');
 assert.equal(next.actors[0].knowledgeLedger![0].evidence,'literal model-event');
 assert.deepEqual(validateEcologyTransition(previous,next),[]);
 assert.equal(JSON.stringify(raw),before);
});

test('existing active pattern identity binds new structured refs without changing provenance', () => {
 const previous=normalizeLiteraryEcologyState({occurrences:[event('canonical-event')]},defaultLiteraryEcologyState())!;
 const before=JSON.stringify(previous);
 const next=normalizeLiteraryEcologyState({actors:[{id:'reader',name:'Reader',knowledgeLedger:[knowledge('model-event')]}],occurrences:[event('model-event'),{id:'followup',name:'Followup',patternKey:'followup',causedBy:['model-event'],development:'literal model-event',userRole:'committed',userCommitment:{source:'latest-user',sourceEntryId:'model-event',occurrenceId:'wrong-event',quote:'model-event'}}]},previous)!;
 assert.equal(next.actors[0].knowledgeLedger![0].subjectRef,'occurrence:canonical-event');
 assert.deepEqual(next.occurrences.find(e=>e.id==='followup')!.causedBy,['canonical-event']);
 assert.equal(next.occurrences.find(e=>e.id==='followup')!.development,'literal model-event');
 validateEcologyTransition(previous,next,[],{latestUserEntryId:'real-user',latestUserText:'model-event'});
 assert.equal(next.occurrences.find(e=>e.id==='followup')!.userRole,'optional');
 assert.equal(JSON.stringify(previous),before);
});

test('missing and ambiguous refs are not fabricated into valid objects', () => {
 for(const occurrences of [[],[event('canonical-event'),{...event('model-event'),patternKey:'notice-pattern'},{...event('model-event'),patternKey:'different-pattern'}]]){
  const previous=defaultLiteraryEcologyState();
  const next=normalizeLiteraryEcologyState({actors:[{id:'reader',name:'Reader',knowledgeLedger:[knowledge(occurrences.length?'unresolved':'missing')]}],occurrences},previous)!;
  assert.match(validateEcologyTransition(previous,next).join(';'),/不存在的对象/);
 }
 const ids=new Map<string,string>();
 normalizeLiteraryEcologyState({occurrences:[event('canonical-event'),event('model-event'),{...event('model-event'),patternKey:'different-pattern'}]},defaultLiteraryEcologyState(),ids);
 assert.equal(ids.has('model-event'),false);
});

test('cooldown and terminal rejection cannot create reference aliases', () => {
 for(const status of ['resolved','expired']){
  const previous=normalizeLiteraryEcologyState({occurrences:[{...event('canonical-event'),status,cooldownUntilRound:10}]},defaultLiteraryEcologyState())!;
  const ids=new Map<string,string>(),next=normalizeLiteraryEcologyState({actors:[{id:'reader',name:'Reader',knowledgeLedger:[knowledge('model-event')]}],occurrences:[event('model-event')]},previous,ids)!;
  assert.equal(ids.size,0);
  assert.equal(next.occurrences[0].status,status);
  assert.match(validateEcologyTransition(previous,next).join(';'),/不存在的对象/);
 }
 const previous={...defaultLiteraryEcologyState(),round:5,recentUses:[{key:'notice-pattern',round:4}]};
 const ids=new Map<string,string>(),next=normalizeLiteraryEcologyState({actors:[{id:'reader',name:'Reader',knowledgeLedger:[knowledge('model-event')]}],occurrences:[event('model-event')]},previous,ids)!;
 assert.equal(ids.size,0);assert.equal(next.occurrences.length,0);
 assert.match(validateEcologyTransition(previous,next).join(';'),/不存在的对象/);
});

test('alias rebinding does not refresh inherited frozen knowledge or causal edges', () => {
 const previous=normalizeLiteraryEcologyState({actors:[{id:'reader',name:'Reader',knowledgeLedger:[knowledge('model-event')]}],occurrences:[event('canonical-event'),{id:'historic',name:'Historic',patternKey:'historic',causedBy:['model-event']}]},defaultLiteraryEcologyState())!;
 const before=JSON.stringify(previous);
 const next=normalizeLiteraryEcologyState({actors:[{id:'reader',name:'Reader',activity:'Resting'}],occurrences:[event('model-event')]},previous)!;
 assert.deepEqual(next.actors[0].knowledgeLedger,previous.actors[0].knowledgeLedger);
 assert.deepEqual(next.occurrences.find(e=>e.id==='historic')!.causedBy,['model-event']);
 assert.equal(JSON.stringify(previous),before);
});
