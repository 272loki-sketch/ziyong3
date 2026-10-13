import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {TavernPluginHttp} from '../server/tavern-plugin-http.ts';
import {syntheticTavernPluginContext} from '../server/tavern-plugin-runtime.ts';
test('historical MVU publishes only target variables and receipt into the current frozen branch',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'mvu-history-')),context=syntheticTavernPluginContext();
 context.chat.push({mes:'Synthetic ancestor',is_user:false,__liyuanEntryId:'ancestor',__liyuanAuthorDelivery:'Synthetic complete ancestor'}, {mes:'Synthetic correct latest',is_user:false,__liyuanEntryId:'latest',__liyuanAuthorDelivery:'Synthetic complete latest'});
 context.visibleEntryIds.push('ancestor','latest');context.sourceEntryId='latest';
 const api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>false});
 const head=api.binding(),initial=api.store.read(head);initial.state.messages.ancestor={variables:[{stat_data:{level:1}}]};initial.state.messages.latest={variables:[{stat_data:{level:8}}]};initial.state.extensionSettings={unknown:'preserve'};api.store.save(head,initial.revision,initial.state,()=>{});
 const frozen=api.store.read(head).state;api.boundSourceEntryId='ancestor';api.mvuRecovery={head,sourceEntryId:'ancestor'};api.turnSignal=new AbortController().signal;
 const server=createServer((req,res)=>void api.handle(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const base=`http://127.0.0.1:${(server.address() as any).port}`,read=await(await fetch(base+'/api/tavern-plugins/context')).json();assert.equal(read.sourceEntryId,'ancestor');assert.equal(read.state.messages.latest,undefined);
 read.state.messages.ancestor.variables=[{stat_data:{level:2}}];read.state.extensionSettings.unknown='must not publish';read.state.chatMetadata.__liyuanMvuProcessed={ancestor:{status:'updated'}};
 const response=await fetch(base+'/api/tavern-plugins/state',{method:'POST',headers:{'content-type':'application/json','x-liyuan-tavern-scope':head.scopeKey,'x-liyuan-tavern-source':'ancestor','x-liyuan-tavern-host':api.internalToken,'x-liyuan-tavern-turn':api.turnNonce},body:JSON.stringify({revision:read.revision,state:read.state})});assert.equal(response.status,200);
 const next=api.store.read(head).state;assert.deepEqual(next.messages.latest,frozen.messages.latest);assert.deepEqual(next.extensionSettings,frozen.extensionSettings);assert.equal((next.messages.ancestor.variables as any)[0].stat_data.level,2);
 api.boundSourceEntryId='sibling';assert.throws(()=>api.binding(),/当前分支/);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));api.sources.close();rmSync(cwd,{recursive:true,force:true});}
});

test('historical MVU state publication rejects a cancelled retry and a replaced branch head',async()=>{
 for(const invalidate of ['cancel','head','revision'] as const){
  const cwd=mkdtempSync(join(tmpdir(),'mvu-history-guard-')),context=syntheticTavernPluginContext();
  context.chat.push({mes:'Synthetic ancestor',is_user:false,__liyuanEntryId:'ancestor',__liyuanAuthorDelivery:'Synthetic complete ancestor'},{mes:'Synthetic head',is_user:false,__liyuanEntryId:'latest',__liyuanAuthorDelivery:'Synthetic complete latest'});
  context.visibleEntryIds.push('ancestor','latest');context.sourceEntryId='latest';
  const api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>false} as any),head=api.binding(),initial=api.store.read(head);
  initial.state.messages.ancestor={variables:[{stat_data:{level:1}}]};api.store.save(head,initial.revision,initial.state,()=>{});
  api.boundSourceEntryId='ancestor';api.mvuRecovery={head,sourceEntryId:'ancestor'};const controller=new AbortController();api.turnSignal=controller.signal;
  const server=createServer((req,res)=>void api.handle(req,res));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const base=`http://127.0.0.1:${(server.address() as any).port}`,read=await(await fetch(base+'/api/tavern-plugins/context')).json();
   read.state.messages.ancestor.variables=[{stat_data:{level:2}}];read.state.chatMetadata.__liyuanMvuProcessed={ancestor:{status:'updated'}};
   if(invalidate==='cancel')controller.abort(new DOMException('Synthetic cancellation','AbortError'));else if(invalidate==='head')context.sourceEntryId='sibling-head';else{const concurrent=api.store.read(head);concurrent.state.extensionSettings.concurrentChange=true;api.store.save(head,concurrent.revision,concurrent.state,()=>{});}
   const response=await fetch(base+'/api/tavern-plugins/state',{method:'POST',headers:{'content-type':'application/json','x-liyuan-tavern-scope':head.scopeKey,'x-liyuan-tavern-source':'ancestor','x-liyuan-tavern-host':api.internalToken,'x-liyuan-tavern-turn':api.turnNonce},body:JSON.stringify({revision:read.revision,state:read.state})});
   assert.equal(response.status,409,`${invalidate} must reject publication`);
   const state=api.store.read(head).state;assert.equal((state.messages.ancestor.variables as any)[0].stat_data.level,1);assert.equal((state.chatMetadata.__liyuanMvuProcessed as any)?.ancestor,undefined);if(invalidate==='revision')assert.equal(state.extensionSettings.concurrentChange,true,'CAS conflict must preserve the concurrent head write');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));api.sources.close();rmSync(cwd,{recursive:true,force:true});}
 }
});

test('historical MVU model allowance is charged to the requested source, persists, and blocks attempt nine before generation',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'mvu-history-budget-')),context=syntheticTavernPluginContext();
 context.chat.push({mes:'Synthetic ancestor',is_user:false,__liyuanEntryId:'ancestor',__liyuanAuthorDelivery:'Synthetic complete ancestor'},{mes:'Synthetic head',is_user:false,__liyuanEntryId:'latest',__liyuanAuthorDelivery:'Synthetic complete latest'});
 context.visibleEntryIds.push('ancestor','latest');context.sourceEntryId='latest';let calls=0;
 const api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>false,generateManagesBudget:true,generate:async(_messages:any,_signal:any,options:any)=>{options.claimRequest();calls++;return 'synthetic candidate only';}} as any);
 api.sources.status=()=>({plugins:[{id:'helper',enabled:true,installed:true}]}) as any;
 const head=api.binding();api.mvuRecovery={head,sourceEntryId:'ancestor'};api.boundSourceEntryId='ancestor';api.turnSignal=new AbortController().signal;
 const server=createServer((req,res)=>void api.handle(req,res));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${(server.address() as any).port}`,headers={'content-type':'application/json','x-liyuan-tavern-scope':head.scopeKey,'x-liyuan-tavern-source':'ancestor','x-liyuan-tavern-host':api.internalToken,'x-liyuan-tavern-turn':api.turnNonce},body=JSON.stringify({messages:[{role:'user',content:'Synthetic MVU request'}]});
  for(let i=0;i<8;i++)assert.equal((await fetch(base+'/api/tavern-plugins/generate',{method:'POST',headers,body})).status,200);
  const ninth=await fetch(base+'/api/tavern-plugins/generate',{method:'POST',headers,body});assert.equal(ninth.status,400);assert.match((await ninth.json()).error,/8次预算/);assert.equal(calls,8);
  assert.equal(api.store.claimModelRequest(head,8,()=>{}).calls,1,'head and historical target retain independent source allowances');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));api.sources.close();rmSync(cwd,{recursive:true,force:true});}
});
