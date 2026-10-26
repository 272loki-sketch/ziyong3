import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {TavernPluginRuntime} from '../server/tavern-plugin-runtime.ts';

test('MVU retry owns a transient signal/nonce and after phase only inside its queue',async()=>{
 let source='reply',scope='scope',signal:AbortSignal|undefined,nonce=0,evaluations=0;
 const http:any={boundSourceEntryId:undefined,internalPhase:undefined,
  binding:()=>({scopeKey:scope,sourceEntryId:source,chat:[]}),
  assertBinding:(s:string,id:string)=>{if(s!==scope||id!==source)throw Error('stale source/scope');},
  get turnSignal(){return signal;},set turnSignal(value:AbortSignal|undefined){signal=value;nonce++;},
 };
 const runtime=new TavernPluginRuntime(http,()=>''),internals=runtime as any;
 internals.ensure=async()=>({evaluate:async()=>{
  evaluations++;assert.equal(signal?.aborted,false);assert.equal(http.internalPhase,'after');
  return {scopeKey:scope,sourceEntryId:source,status:'updated'};
 }});
 assert.equal((await runtime.recoverMvu() as any).status,'updated');assert.equal(evaluations,1);assert.equal(signal,undefined);assert.equal(http.internalPhase,undefined);assert.ok(nonce>=2);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>runtime.recoverMvu(cancelled.signal),/取消/);assert.equal(evaluations,1);
 for(const field of ['source','scope']){
  let release!:()=>void;internals.queue=new Promise<void>(resolve=>{release=resolve;});
  const retry=runtime.recoverMvu();if(field==='source')source='next';else scope='next-scope';release();
  await assert.rejects(()=>retry,/stale/);assert.equal(evaluations,1);assert.equal(http.internalPhase,undefined);
 }
 internals.ensure=async()=>({evaluate:async()=>{throw Error('synthetic native failure');}});
  await assert.rejects(()=>runtime.recoverMvu(),/synthetic native failure/);assert.equal(signal,undefined);assert.equal(http.internalPhase,undefined);
  internals.ensure=async()=>({evaluate:async()=>{throw Error('page.evaluate: Error: MVU candidate requests failed: insufficient_quota: provider credits exhausted\n    at privateRuntime:16');}});
  await assert.rejects(()=>runtime.recoverMvu(),error=>error instanceof Error&&error.message.includes('insufficient_quota')&&!error.message.includes('page.evaluate')&&!error.message.includes('privateRuntime'));
});
test('full-budget completed current MVU reuses before starting a realm; ancestor repair does not invalidate',async()=>{
 const head:any={scopeKey:'scope',sourceEntryId:'reply',chat:[{__liyuanEntryId:'ancestor',variables:{level:1}},{__liyuanEntryId:'reply',is_user:false,__liyuanAuthorDelivery:'Synthetic completed story'}],readonlyBooks:{rules:{entries:[{content:'Synthetic rule'}]}}};
 const settings={method:'synthetic'},receipt={nativeRetry:true,authorHistoryVersion:2,status:'updated',materialHash:createHash('sha256').update(JSON.stringify(['Synthetic completed story',head.readonlyBooks,settings])).digest('hex')};
 const http:any={binding:()=>head,store:{read:()=>({state:{chatMetadata:{__liyuanMvuProcessed:{reply:receipt}},extensionSettings:{mvu_settings:settings}}})}};
 const runtime=new TavernPluginRuntime(http,()=>''),internals=runtime as any;internals.owned=()=>{throw Error('NO_REALM_CLAIM_OR_MODEL_ALLOWED');};
 assert.equal((await runtime.recoverMvu() as any).status,'reused');head.chat[0].variables={level:99};assert.equal((await runtime.recoverMvu() as any).status,'reused');
 head.chat[1].__liyuanAuthorDelivery='Changed real author input';await assert.rejects(()=>runtime.recoverMvu(),/NO_REALM/);
 head.chat[1].__liyuanAuthorDelivery='Synthetic completed story';head.readonlyBooks.rules.entries[0].content='Changed actual rule';await assert.rejects(()=>runtime.recoverMvu(),/NO_REALM/);
});
test('repaired JSONPatch projection receipt reuses before any realm or paid claim; legacy receipts still fall through',async()=>{
 const raw='Synthetic completed story<UpdateVariable><JSONPatch>[{"op":"replace","path":"/level","value":3}]</UpdateVariable>';
 const projected=raw.replace('</UpdateVariable>','</JSONPatch>\n</UpdateVariable>');
 const head:any={scopeKey:'scope',sourceEntryId:'reply',chat:[{__liyuanEntryId:'reply',is_user:false,__liyuanAuthorDelivery:raw}],readonlyBooks:{}};
 const settings={method:'synthetic'},receipt:any={nativeRetry:true,authorHistoryVersion:2,status:'updated',projectionRepaired:true,materialHash:createHash('sha256').update(JSON.stringify([projected,head.readonlyBooks,settings])).digest('hex')};
 const http:any={binding:()=>head,store:{read:()=>({state:{chatMetadata:{__liyuanMvuProcessed:{reply:receipt}},extensionSettings:{mvu_settings:settings}}})}};
 const runtime=new TavernPluginRuntime(http,()=>''),internals=runtime as any;let claims=0;
 internals.owned=()=>{claims++;throw Error('NO_REALM_CLAIM_OR_MODEL_ALLOWED');};
 for(const status of ['updated','unchanged']){receipt.status=status;assert.equal((await runtime.recoverMvu() as any).status,'reused');}
 assert.equal(claims,0);assert.equal(head.chat[0].__liyuanAuthorDelivery,raw);
 delete receipt.authorHistoryVersion;const legacyReceipt=structuredClone(receipt);
 await assert.rejects(()=>runtime.recoverMvu(),/NO_REALM/);assert.deepEqual(receipt,legacyReceipt);
});

test('historical MVU retry binds the target ancestor while guarding the captured branch head',async()=>{
 const head:any={scopeKey:'scope',sourceEntryId:'reply',visibleEntryIds:['ancestor','reply'],chat:[
  {__liyuanEntryId:'ancestor',is_user:false,__liyuanAuthorDelivery:'Synthetic complete ancestor'},
  {__liyuanEntryId:'reply',is_user:false,__liyuanAuthorDelivery:'Synthetic complete current reply'},
 ]};
 const http:any={
  host:{context:()=>head},boundSourceEntryId:undefined,internalPhase:undefined,mvuRecovery:undefined,
  binding(){
   const value=this.host.context();
   if(this.boundSourceEntryId){const index=value.chat.findIndex((row:any)=>row.__liyuanEntryId===this.boundSourceEntryId);if(index<0)throw Error('target is not in current branch');return {...value,chat:value.chat.slice(0,index+1),sourceEntryId:this.boundSourceEntryId,visibleEntryIds:value.visibleEntryIds.slice(0,value.visibleEntryIds.indexOf(this.boundSourceEntryId)+1),scopeKey:'scope'};}
   return {...value,scopeKey:'scope'};
  },
  assertBinding(scope:string,source:string){const current=this.binding();if(current.scopeKey!==scope||current.sourceEntryId!==source)throw Error('stale source/scope');if(this.mvuRecovery){const actual=this.host.context();if(actual.scopeKey!==this.mvuRecovery.head.scopeKey||actual.sourceEntryId!==this.mvuRecovery.head.sourceEntryId)throw Error('stale branch head');}return current;},
  get turnSignal(){return this.signal;},set turnSignal(value:AbortSignal|undefined){this.signal=value;},
 };
 const runtime=new TavernPluginRuntime(http,()=>''),internals=runtime as any;let evaluated=0;
 internals.ensure=async()=>({evaluate:async()=>{
  evaluated++;assert.equal(http.binding().sourceEntryId,'ancestor');assert.equal(http.mvuRecovery.head.sourceEntryId,'reply');assert.equal(http.internalPhase,'after');
  return {scopeKey:'scope',sourceEntryId:'ancestor',status:'updated'};
 }});
 const result=await runtime.recoverMvu(undefined,'ancestor');
 assert.equal(result.status,'updated');assert.equal(evaluated,1);assert.equal(http.boundSourceEntryId,undefined);assert.equal(http.mvuRecovery,undefined);assert.equal(http.internalPhase,undefined);assert.equal(http.turnSignal,undefined);
});
