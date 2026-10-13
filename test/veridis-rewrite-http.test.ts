import assert from'node:assert/strict';import test from'node:test';import{mkdtempSync,rmSync,writeFileSync,symlinkSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{createServer}from'node:http';
import{VeridisRewriteHttp}from'../server/veridis-rewrite-http.ts';
test('global default survives host recreation and supplies empty branches without replacing custom rules',async()=>fixture(async({http})=>{
 const path=join(http.cwd,'.liyuan-veridis-rewrite','global-presets.json');writeFileSync(path,JSON.stringify({version:1,defaultPreset:'shared',presets:{shared:{rules:[{id:'shared-rule'}],aiRewrite:{temperature:0.4}}}}),{mode:0o600});
 const empty={rules:[],activePreset:'',aiRewrite:{enabled:false},unknown:{keep:true}};
 const effective=http.effectiveSettings(empty);assert.equal(effective.activePreset,'shared');assert.equal(effective.defaultPreset,'shared');assert.equal(effective.rules.length,1);assert.equal(effective.aiRewrite.enabled,false);assert.equal(effective.aiRewrite.temperature,0.4);assert.equal(empty.rules.length,0);
 const restarted=new VeridisRewriteHttp(http.cwd,http.host,process.cwd());try{assert.deepEqual(restarted.effectiveSettings(empty),effective);assert.equal(restarted.status().settings.activePreset,'shared');}finally{await restarted.close();}
 assert.deepEqual(http.effectiveSettings({rules:[{id:'custom'}],activePreset:''}).rules,[{id:'custom'}]);assert.equal(http.effectiveSettings({...empty,useGlobalDefaultPreset:false}).activePreset,'');
}));
test('global default cannot resurrect saved switches through status, save or reopen',async()=>fixture(async({http,base})=>{
 const path=join(http.cwd,'.liyuan-veridis-rewrite','global-presets.json');writeFileSync(path,JSON.stringify({version:1,defaultPreset:'shared',presets:{shared:{rules:[{id:'shared-rule'}],aiRewrite:{enabled:true,autoTriggerEnabled:true,temperature:0.4,futurePreset:{keep:true}}}}}),{mode:0o600});
 const scope=http.host.binding(),saved=http.store.read(scope),state=structuredClone(saved.state),settings={enabled:false,rules:[],activePreset:'',aiRewrite:{enabled:false,autoTriggerEnabled:false,futureSource:{keep:true}},unknown:{keep:true}};state.extensionSettings.veridis_rewrite=settings;http.store.save(scope,saved.revision,state,()=>{});
 const before=http.store.read(scope),response=await fetch(base+'/api/veridis-rewrite/status');assert.equal(response.status,200);const status=await response.json();assert.deepEqual(http.store.read(scope),before);
 const expected={...settings,activePreset:'shared',defaultPreset:'shared',rules:[{id:'shared-rule'}],presets:{shared:{rules:[{id:'shared-rule'}],aiRewrite:{enabled:true,autoTriggerEnabled:true,temperature:0.4,futurePreset:{keep:true}}}},aiRewrite:{...settings.aiRewrite,temperature:0.4,futurePreset:{keep:true}}};assert.deepEqual(status.settings,expected);
 const result=await fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify({...status,settings:status.settings})});assert.equal(result.status,200);assert.deepEqual((await result.json()).settings,expected);assert.deepEqual(http.store.read(scope).state.extensionSettings.veridis_rewrite,expected);
 const restarted=new VeridisRewriteHttp(http.cwd,http.host,process.cwd());try{assert.deepEqual(restarted.status().settings,expected);}finally{await restarted.close();}
}));
test('global named presets are available across sources without activating rules or changing stored settings',async()=>fixture(async({http,base,source})=>{
 const path=join(http.cwd,'.liyuan-veridis-rewrite','global-presets.json');writeFileSync(path,JSON.stringify({version:1,presets:{shared:{rules:[{id:'shared-rule'}]}}}),{mode:0o600});
 (http.sources as any).active=()=>({commit:'a'.repeat(40),manifest:{}});
 const scope=http.host.binding(),saved=http.store.read(scope),state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite={rules:[],activePreset:'local',presets:{shared:{rules:[]},local:{rules:[]}}};http.store.save(scope,saved.revision,state,()=>{});
 const before=http.store.read(scope);let context=await(await fetch(base+'/api/veridis-rewrite/context')).json();assert.deepEqual(context.settings.presets.shared,{rules:[]});assert.equal(context.settings.activePreset,'local');assert.deepEqual(http.store.read(scope),before);
 http.host.binding=()=>({sessionId:'other-session',card:'other-card',sourceEntryId:'other-source',visibleEntryIds:['other-source']});source('other-source');context=await(await fetch(base+'/api/veridis-rewrite/context')).json();assert.deepEqual(context.settings.presets.shared,{rules:[{id:'shared-rule'}]});assert.notEqual(context.settings.activePreset,'shared');assert.deepEqual(http.store.read(http.host.binding()).state.extensionSettings,{});
 rmSync(path);symlinkSync(join(http.cwd,'missing'),path);assert.equal((await fetch(base+'/api/veridis-rewrite/context')).status,400);
}));
async function fixture(fn:(a:any)=>Promise<void>){const cwd=mkdtempSync(join(tmpdir(),'liyuan-veridis-http-'));let busy=false,source='synthetic-source';const scope=()=>({sessionId:'synthetic-session',card:'synthetic-card',sourceEntryId:source,visibleEntryIds:["synthetic-source",source]});const http=new VeridisRewriteHttp(cwd,{binding:scope,isBusy:()=>busy,model:()=>({provider:'new',id:'gemini-3.8-flash'}),branch:()=>[]},process.cwd());const server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{await fn({http,base:`http://127.0.0.1:${(server.address()as any).port}`,busy:(x:boolean)=>busy=x,source:(x:string)=>source=x});}finally{await http.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(cwd,{recursive:true,force:true});}}
test('rewrite status and settings are source/revision bound without author data',async()=>fixture(async({base})=>{const status=await(await fetch(base+'/api/veridis-rewrite/status')).json();assert.equal(status.model.id,'gemini-3.8-flash');assert.equal(status.installed,false);const payload={...status,settings:{rules:[],futureSetting:{enabled:true}}};const r=await fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify(payload)});assert.equal(r.status,200);const current=await r.json();assert.deepEqual(current.settings,payload.settings);assert.equal((await fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify(payload)})).status,409);}));
test('rewrite management refuses stale sources, secrets, busy and arbitrary generation',async()=>fixture(async({base,busy,source})=>{const ctx=await(await fetch(base+'/api/veridis-rewrite/status')).json();const send=(settings:any)=>fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify({...ctx,settings})});assert.equal((await send({apiKey:'never-send'})).status,400);busy(true);assert.equal((await send({rules:[]})).status,409);busy(false);source('other');assert.equal((await send({rules:[]})).status,409);assert.equal((await fetch(base+'/api/veridis-rewrite/generate',{method:'POST',body:'{}'})).status,404);}));
test('late runtime cannot overwrite concurrent settings with a newer revision',async()=>fixture(async({http})=>{
 const scope=http.host.binding();(http.sources as any).status=()=>({installed:true,enabled:true,autoUpdate:false});(http.sources as any).active=()=>({commit:'a'.repeat(40)});
 http.runtime.run=async()=>{const saved=http.store.read(scope),state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite={rules:['new-setting']};http.store.save(scope,saved.revision,state,()=>{});return{text:'原稿',changed:false,calls:0,errors:[],version:'3.5',commit:'a'.repeat(40),settings:{rules:['stale-setting']}};};
 await assert.rejects(http.run({scope,authorDraft:'原稿',narrative:'原稿',guard:()=>{},generate:async()=>''}),{statusCode:409});
 assert.deepEqual(http.store.read(scope).state.extensionSettings.veridis_rewrite,{rules:['new-setting']});
}));
test('credential-free settings projection round-trips empty original fields while keeping private values',async()=>fixture(async({base,http})=>{
 const scope=http.host.binding(),saved=http.store.read(scope),state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite={rules:[],aiRewrite:{apiKey:'synthetic-private-secret',model:'managed'},future:{token:'synthetic-token',flag:true}};http.store.save(scope,saved.revision,state,()=>{});
 const ctx=await(await fetch(base+'/api/veridis-rewrite/status')).json();assert.ok(!JSON.stringify(ctx).includes('synthetic-private-secret'));assert.ok(!JSON.stringify(ctx).includes('synthetic-token'));
 const settings={...ctx.settings,aiRewrite:{...ctx.settings.aiRewrite,apiKey:''}};const r=await fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify({...ctx,settings})});assert.equal(r.status,200);
 const value=http.store.read(scope).state.extensionSettings.veridis_rewrite as any;assert.equal(value.aiRewrite.apiKey,'synthetic-private-secret');assert.equal(value.future.token,'synthetic-token');
}));
test('rewrite cache tracks effective rules, upstream and narrative, preserving skipped reason',async()=>fixture(async({http})=>{
 const scope=http.host.binding();let count=0,commit='a'.repeat(40);(http.sources as any).status=()=>({installed:true,enabled:true,autoUpdate:false});(http.sources as any).active=()=>({commit});
 http.runtime.run=async()=>{count++;return{text:'原稿',changed:false,calls:0,errors:[],version:'3.5',commit,settings:{rules:[]},skipped:true,skipReason:'no-hit'};};
 const input={scope,authorDraft:'原稿',narrative:'原稿',guard:()=>{},generate:async()=>''};assert.equal((await http.run(input)).reason,'no-hit');assert.equal((await http.run(input)).reason,'no-hit');assert.equal(count,1);
 let saved=http.store.read(scope),state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite={rules:['changed']};http.store.save(scope,saved.revision,state,()=>{});await http.run(input);assert.equal(count,2);
 commit='b'.repeat(40);await http.run(input);assert.equal(count,3);await http.run({...input,narrative:'不同正文'});assert.equal(count,4);
}));
test('all management writes require captured binding and reject stale config without configure',async()=>fixture(async({base,http,source})=>{
 const ctx=await(await fetch(base+'/api/veridis-rewrite/status')).json();let configured=0;http.sources.configure=()=>{configured++;};source('changed');
 const r=await fetch(base+'/api/veridis-rewrite/config',{method:'PUT',body:JSON.stringify({...ctx,enabled:true})});assert.equal(r.status,409);assert.equal(configured,0);
 assert.equal((await fetch(base+'/api/veridis-rewrite/update',{method:'POST',body:'{}'})).status,409);
}));
test('hidden credentials follow stable array IDs, not reorder positions; ambiguous arrays are rejected',async()=>fixture(async({base,http})=>{
 const scope=http.host.binding();let saved=http.store.read(scope),state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite={endpoints:[{id:'a',apiKey:'secret-A',label:'A'},{id:'b',apiKey:'secret-B',label:'B'}]};http.store.save(scope,saved.revision,state,()=>{});
 const ctx=await(await fetch(base+'/api/veridis-rewrite/status')).json();ctx.settings.endpoints.reverse();let r=await fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify({...ctx,settings:ctx.settings})});assert.equal(r.status,200);let values=(http.store.read(scope).state.extensionSettings.veridis_rewrite as any).endpoints;assert.deepEqual(values.map((e:any)=>[e.id,e.apiKey]),[['b','secret-B'],['a','secret-A']]);
 saved=http.store.read(scope);state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite={endpoints:[{label:'A',apiKey:'secret-A'},{label:'B',apiKey:'secret-B'}]};http.store.save(scope,saved.revision,state,()=>{});const next=await(await fetch(base+'/api/veridis-rewrite/status')).json();next.settings.endpoints.reverse();r=await fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify({...next,settings:next.settings})});assert.equal(r.status,400);
}));
test('management lease refuses an ancestor source once a successor is current',async()=>fixture(async({base,http,source})=>{
 const ctx=await(await fetch(base+'/api/veridis-rewrite/status')).json();source('successor');let count=0;http.sources.configure=()=>{count++;};const r=await fetch(base+'/api/veridis-rewrite/config',{method:'PUT',body:JSON.stringify({...ctx,enabled:true})});assert.equal(r.status,409);assert.equal(count,0);
}));

test('original workbench bootstrap hides secrets and asset routes stay allowlisted with module MIME/CSP',async()=>fixture(async({http,base})=>{
 const scope=http.host.binding(),saved=http.store.read(scope),state=structuredClone(saved.state);state.extensionSettings.veridis_rewrite={rules:[],aiRewrite:{apiKey:'private-bootstrap-key'},unknown:{keep:true}};http.store.save(scope,saved.revision,state,()=>{});
 const candidate={commit:'a'.repeat(40),manifest:{version:'fixture',js:'index.js'}};(http.sources as any).active=()=>candidate;
 const boot=await(await fetch(base+'/api/veridis-rewrite/context')).json();assert.equal(boot.upstreamCommit,candidate.commit);assert.equal(boot.settings.unknown.keep,true);assert.ok(!JSON.stringify(boot).includes('private-bootstrap-key'));
 let r=await fetch(base+'/veridis-rewrite-host.html');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy')??'',/frame-ancestors 'self'/);
 assert.match(await r.text(),/原版工作台/);r=await fetch(base+'/veridis-rewrite/host.js');assert.match(r.headers.get('content-type')??'',/javascript/);
 assert.equal((await fetch(base+'/veridis-rewrite/scripts/extensions/third-party/Veridis-Rewrite/index.js')).status,404,'完整生命周期入口不在管理资产入口白名单');
 assert.equal((await fetch(base+'/veridis-rewrite/scripts/extensions/third-party/Veridis-Rewrite/%2e%2e%2fstate.json')).status,404);
}));
