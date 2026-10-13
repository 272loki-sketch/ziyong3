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
