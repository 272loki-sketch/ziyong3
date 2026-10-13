import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {NpcParallelHttp} from '../server/npc-parallel-http.ts';
import {TavernPluginStore} from '../server/tavern-plugin-store.ts';
import {defaultLiteraryEcologyState,normalizeLiteraryEcologyState} from '../src/stage/literary-ecology.ts';
async function fixture(fn:(x:any)=>Promise<void>){
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-npc-http-'));let busy=false,card='synthetic-card',source='story-a';
 const ecology=normalizeLiteraryEcologyState({actors:[{id:'actor-a',name:'阿青',location:'书店',activity:'整理书架'}]},defaultLiteraryEcologyState())!;
 const branch:any[]=[{id:'user-a',type:'message',message:{role:'user',content:'用户留在屋内。'}},{id:'story-a',type:'message',message:{role:'assistant',details:{rpNarrative:'原正文不变。',rpAuthorDraft:'原正文不变。<panel>格式</panel>'}}}];
 const api=new NpcParallelHttp(cwd,{binding:()=>({sessionId:'s',card,sourceEntryId:source,visibleEntryIds:[...branch.map(e=>e.id),source]}),isBusy:()=>busy,branch:()=>branch,config:()=>({ecologyEnabled:true,model:{provider:'new',id:'gemini-3.8-flash'}}),ecology:()=>ecology,materials:()=>({card:{name:'主角'},config:{userName:'用户'},entries:[]})},process.cwd());
 const server=createServer(async(req,res)=>{if(!await api.handle(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{await fn({api,base,branch,cwd,busy:(v:boolean)=>busy=v,source:(v:string)=>source=v,card:(v:string)=>card=v});}
 finally{await api.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(cwd,{recursive:true,force:true});}
}
test('NPC status is metadata-only, context carries stable original source and identity',async()=>fixture(async({base})=>{
 const status=await (await fetch(base+'/api/npc-parallel/status')).json();assert.equal(status.installed,false);assert.equal(status.model.id,'gemini-3.8-flash');
 assert.ok(!JSON.stringify(status).includes('原正文'));assert.ok(!JSON.stringify(status).includes('整理书架'));
 const ctx=await (await fetch(base+'/api/npc-parallel/context')).json();assert.equal(ctx.userName,'用户');assert.equal(ctx.characterName,'主角');assert.equal(ctx.chat.at(-1).mes,'原正文不变。');assert.equal(ctx.npcs[0].name,'阿青');assert.equal(ctx.settings.maxPerRound,3);
}));
test('original settings persist by revision/scope/source without touching author or helper state',async()=>fixture(async({base,api,branch,cwd})=>{
 const before=JSON.stringify(branch),ctx=await (await fetch(base+'/api/npc-parallel/context')).json();
 const payload={scopeKey:ctx.scopeKey,sourceEntryId:ctx.sourceEntryId,revision:ctx.revision,settings:{template:'原用户模板',futureField:{keep:true}},metadata:{npc_parallel:{npcs:[{name:'阿青',notes:'用户备注'}],ignoredNpcs:['阿白']}}};
 const result=await fetch(base+'/api/npc-parallel/settings',{method:'POST',body:JSON.stringify(payload)});assert.equal(result.status,200);
 const fresh=await (await fetch(base+'/api/npc-parallel/context')).json();assert.equal(fresh.settings.template,payload.settings.template);assert.equal(fresh.metadata.npc_parallel.npcs[0].notes,'用户备注');assert.equal(fresh.settings.futureField.keep,true);
 assert.equal(JSON.stringify(branch),before);assert.deepEqual(new TavernPluginStore(cwd).read({sessionId:'s',card:'synthetic-card',sourceEntryId:'story-a',visibleEntryIds:['user-a','story-a']}).state.extensionSettings,{});
 const stale=await fetch(base+'/api/npc-parallel/settings',{method:'POST',body:JSON.stringify(payload)});assert.equal(stale.status,409);
}));
test('busy, stale bindings, manual model and historical text editing fail closed',async()=>fixture(async({base,busy,source})=>{
 const ctx=await (await fetch(base+'/api/npc-parallel/context')).json();const payload={scopeKey:ctx.scopeKey,sourceEntryId:ctx.sourceEntryId,revision:ctx.revision,settings:{},metadata:{}};
 busy(true);assert.equal((await fetch(base+'/api/npc-parallel/settings',{method:'POST',body:JSON.stringify(payload)})).status,409);busy(false);
 assert.equal((await fetch(base+'/api/npc-parallel/settings',{method:'POST',body:JSON.stringify({...payload,chat:[{mes:'bad'}]})})).status,400);
 source('story-b');assert.equal((await fetch(base+'/api/npc-parallel/settings',{method:'POST',body:JSON.stringify(payload)})).status,409);
 assert.equal((await fetch(base+'/api/npc-parallel/generate',{method:'POST',body:'{}'})).status,400);
 assert.equal((await fetch(base+'/api/npc-parallel/unknown',{method:'POST',body:'{}'})).status,404);
}));
test('unadmitted raw sidewrites never appear as previous confirmed history',async()=>fixture(async({api,branch})=>{
 const scope=api.host.binding(),stored=api.store.read(scope),state=structuredClone(stored.state);state.messages['story-a']={extra:{npc_parallel_batch:{batch:{entries:[{name:'阿青',text:'未审阅的侧写'}]}}}};
 api.store.save(scope,stored.revision,state,()=>{});assert.equal(api.frame().chat.at(-1).extra,undefined);
 branch.push({id:'npc-receipt',customType:'rp-npc-parallel',data:{version:1,sourceEntryId:'story-a',status:'accepted',entries:[{name:'阿青',text:'已审阅的侧写'}]}});
 assert.equal(api.frame().chat.at(-1).extra.npc_parallel[0].text,'已审阅的侧写');
}));
test('persisted NPC quota survives host restart and is separate from other plugin quota',async()=>fixture(async({api,cwd})=>{
 const scope=api.host.binding();for(let i=0;i<8;i++)api.store.claimModelRequest(scope,8,()=>{});
 assert.throws(()=>new TavernPluginStore(join(cwd,'.liyuan-npc-parallel')).claimModelRequest(scope,8,()=>{}),/预算/);
 assert.equal(new TavernPluginStore(cwd).claimModelRequest(scope,8,()=>{}).calls,1);
}));
