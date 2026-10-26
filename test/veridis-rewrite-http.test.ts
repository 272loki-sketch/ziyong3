import assert from'node:assert/strict';import test from'node:test';import{mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{createServer}from'node:http';
import{VeridisRewriteHttp}from'../server/veridis-rewrite-http.ts';
test('status retains source-bound failure reason without returning author or projection text',async()=>fixture(async({http,base,source})=>{
 http.host.branch=()=>[{customType:'rp-veridis-rewrite',data:{version:1,sourceEntryId:'synthetic-source',status:'failed',changed:false,calls:1,error:'受管改写 HTTP 429 限流',text:'synthetic-private-projection'}}];
 const response=await fetch(base+'/api/veridis-rewrite/status'),status=await response.json();
 assert.equal(status.receipt.error,'受管改写 HTTP 429 限流');assert.equal(status.receipt.calls,1);assert.equal(status.receipt.text,undefined);
 source('other-source');assert.equal((await(await fetch(base+'/api/veridis-rewrite/status')).json()).receipt,undefined);
}));
for(const local of [{rules:[{id:'local-rule'}],aiRewrite:{temperature:0.2,enabled:true,autoTriggerEnabled:true}},{rules:[]},[{id:'local-array-rule'}],[]])test(`global default uses same-name local override (${JSON.stringify(local)})`,async()=>fixture(async({http,base})=>{
 const path=join(http.cwd,'.liyuan-veridis-rewrite','global-presets.json');writeFileSync(path,JSON.stringify({version:1,defaultPreset:'shared',presets:{shared:{rules:[{id:'global-rule'}],aiRewrite:{temperature:0.9}}}}),{mode:0o600});
 const scope=http.host.binding(),saved=http.store.read(scope),state=structuredClone(saved.state),settings={rules:[],activePreset:'',presets:{shared:local},aiRewrite:{enabled:true,autoTriggerEnabled:false,temperature:0.6}};state.extensionSettings.veridis_rewrite=settings;http.store.save(scope,saved.revision,state,()=>{});
 const before=http.store.read(scope),effective=http.effectiveSettings(settings);assert.deepEqual(effective.presets.shared,local);assert.deepEqual(effective.rules,Array.isArray(local)?local:local.rules);assert.equal(effective.activePreset,'shared');assert.equal(effective.defaultPreset,'shared');assert.deepEqual(effective.aiRewrite,{enabled:true,autoTriggerEnabled:false,temperature:!Array.isArray(local)&&local.aiRewrite?0.2:0.6});assert.deepEqual(settings.rules,[]);
 const response=await fetch(base+'/api/veridis-rewrite/status');assert.equal(response.status,200);assert.deepEqual((await response.json()).settings,effective);assert.deepEqual(http.store.read(scope),before);
 (http.sources as any).status=()=>({installed:true,enabled:true});(http.sources as any).active=()=>({commit:'a'.repeat(40)});
 http.runtime.run=async(input:any)=>{assert.deepEqual(input.settings,effective);return{text:'synthetic draft',changed:false,calls:0,errors:[],version:'fixture',commit:'a'.repeat(40),settings:input.settings};};
 // Enable automatic execution only in the synthetic source to inspect runtime input.
 state.extensionSettings.veridis_rewrite={...settings,aiRewrite:{...settings.aiRewrite,autoTriggerEnabled:true}};http.store.save(scope,before.revision,state,()=>{});effective.aiRewrite.autoTriggerEnabled=true;
 await http.run({scope,authorDraft:'synthetic draft',narrative:'synthetic draft',guard:()=>{},generate:async()=>{throw Error('Unexpected model request');}});
}));
test('global preset status masks URL and header credentials without mutating the private library',async()=>fixture(async({base,http})=>{
 const path=join(http.cwd,'.liyuan-veridis-rewrite','global-presets.json'),user=['synthetic','-user'].join(''),password=['synthetic','-password'].join(''),queryKey=['synthetic','-query-key'].join(''),queryToken=['synthetic','-query-token'].join(''),headerToken=['synthetic','-header-token'].join('');
 const endpoint=['https://',user,':',password,'@example.invalid/rewrite?api_key=',queryKey,'&token=',queryToken,'&mode=managed'].join(''),header=['Authorization: Bearer ',headerToken].join('');
 writeFileSync(path,JSON.stringify({version:1,defaultPreset:'shared',presets:{shared:{rules:[{id:'safe-rule'}],endpoint,customHeaders:header}}}),{mode:0o600});
 const response=await fetch(base+'/api/veridis-rewrite/status');assert.equal(response.status,200);const status=await response.json(),serialized=JSON.stringify(status.settings);
 for(const secret of ['synthetic-user','synthetic-password','synthetic-query-key','synthetic-query-token','synthetic-header-token'])assert.ok(!serialized.includes(secret),`public preset settings leaked ${secret}`);
 assert.equal(status.settings.presets.shared.endpoint,'https://example.invalid/rewrite?api_key=host-managed&token=host-managed&mode=managed');
 assert.equal(status.settings.presets.shared.customHeaders,'Authorization: host-managed');
 assert.equal(JSON.parse(readFileSync(path,'utf8')).presets.shared.endpoint,endpoint,'redaction must not rewrite the private source file');
}));
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

/** Credentials exist only in this synthetic fixture; never use a complete credential URL literal. */
function syntheticEmbeddedCredentials(id:string){
 return {
  endpoint:['https://','synthetic-',id,'-user',':','synthetic-',id,'-password','@',id,'.example.invalid/v1?api_key=','synthetic-',id,'-query','&mode=original'].join(''),
  customHeaders:['  Authorization: Bearer ','synthetic-',id,'-header','\r\nX-Trace: trace-',id,'\nCookie: session=','synthetic-',id,'-cookie'].join(''),
 };
}
function seedRewriteSettings(http:VeridisRewriteHttp,settings:any){
 const scope=http.host.binding(),saved=http.store.read(scope),state=structuredClone(saved.state);
 state.extensionSettings.veridis_rewrite=settings;http.store.save(scope,saved.revision,state,()=>{});return scope;
}
async function putPublicRewriteSettings(base:string,context:any){
 return fetch(base+'/api/veridis-rewrite/settings',{method:'PUT',body:JSON.stringify({...context,settings:context.settings})});
}

test('same-source public URL/header roundtrip preserves private string bytes and disabled switches',async()=>fixture(async({base,http})=>{
 const settings={rules:[],enabled:false,...syntheticEmbeddedCredentials('roundtrip'),future:{nested:syntheticEmbeddedCredentials('nested')},aiRewrite:{enabled:false,autoTriggerEnabled:false,apiKey:'synthetic-independent-private-key'}},scope=seedRewriteSettings(http,settings),model=structuredClone(http.host.model());
 const context=await(await fetch(base+'/api/veridis-rewrite/status')).json(),visible=JSON.stringify(context.settings);
 for(const secret of ['roundtrip-user','roundtrip-password','roundtrip-query','roundtrip-header','roundtrip-cookie','nested-password','synthetic-independent-private-key'])assert.ok(!visible.includes(secret));
 const response=await putPublicRewriteSettings(base,context);assert.equal(response.status,200);
 assert.deepEqual(http.store.read(scope).state.extensionSettings.veridis_rewrite,settings);
 assert.deepEqual(http.host.model(),model,'private settings roundtrip must not change the independent model reference');
}));

test('stable array IDs retain each private URL/header after reorder and unrelated edits',async()=>fixture(async({base,http})=>{
 const rows=[{id:'a',label:'A',...syntheticEmbeddedCredentials('a')},{id:'b',label:'B',...syntheticEmbeddedCredentials('b')}],scope=seedRewriteSettings(http,{rules:[],endpoints:rows});
 const context=await(await fetch(base+'/api/veridis-rewrite/status')).json();context.settings.endpoints.reverse();context.settings.endpoints[0].label='B renamed';
 const response=await putPublicRewriteSettings(base,context);assert.equal(response.status,200);
 const stored=(http.store.read(scope).state.extensionSettings.veridis_rewrite as any).endpoints;
 assert.deepEqual(stored,[{...rows[1],label:'B renamed'},rows[0]]);
}));

for(const identity of ['missing','duplicate'] as const)test(`embedded-secret array ${identity} IDs reject uncertain reorder but accept unchanged projection`,async()=>fixture(async({base,http})=>{
 const rows=[{label:'A',...syntheticEmbeddedCredentials('a')},{label:'B',...syntheticEmbeddedCredentials('b')}].map(row=>identity==='duplicate'?{...row,id:'same'}:row),scope=seedRewriteSettings(http,{rules:[],endpoints:rows});
 let context=await(await fetch(base+'/api/veridis-rewrite/status')).json();assert.equal((await putPublicRewriteSettings(base,context)).status,200);
 assert.deepEqual((http.store.read(scope).state.extensionSettings.veridis_rewrite as any).endpoints,rows);
 const before=http.store.read(scope);context=await(await fetch(base+'/api/veridis-rewrite/status')).json();context.settings.endpoints.reverse();
 const response=await putPublicRewriteSettings(base,context);assert.equal(response.status,400);assert.deepEqual(http.store.read(scope),before);
}));

for(const edit of ['delete-url','delete-header','delete-subtree','null-url','replace-subtree','delete-row'] as const)test(`hidden private credential deletion ${edit} fails closed without losing data`,async()=>fixture(async({base,http})=>{
 const scope=seedRewriteSettings(http,{rules:[],...syntheticEmbeddedCredentials('root'),privateContainer:{endpoints:[{id:'a',...syntheticEmbeddedCredentials('a'),apiKey:'synthetic-named-private-key'}]}}),before=http.store.read(scope),context=await(await fetch(base+'/api/veridis-rewrite/status')).json();
 if(edit==='delete-url')delete context.settings.endpoint;
 if(edit==='delete-header')delete context.settings.customHeaders;
 if(edit==='delete-subtree')delete context.settings.privateContainer;
 if(edit==='null-url')context.settings.endpoint=null;
 if(edit==='replace-subtree')context.settings.privateContainer='replacement';
 if(edit==='delete-row')context.settings.privateContainer.endpoints=[];
 const response=await putPublicRewriteSettings(base,context);assert.equal(response.status,400);assert.deepEqual(http.store.read(scope),before);
}));

test('edited URL/header strings never inherit old endpoint credentials, even when public placeholders remain',async()=>fixture(async({base,http})=>{
 const old=syntheticEmbeddedCredentials('old'),scope=seedRewriteSettings(http,{rules:[],...old,aiRewrite:{apiKey:'synthetic-independent-private-key',enabled:false}}),context=await(await fetch(base+'/api/veridis-rewrite/status')).json();
 context.settings.endpoint=context.settings.endpoint.replace('old.example.invalid','new.example.invalid').replace('mode=original','mode=changed');
 context.settings.customHeaders=context.settings.customHeaders.replace('trace-old','trace-new');
 const proposed=structuredClone(context.settings),response=await putPublicRewriteSettings(base,context);assert.equal(response.status,200);
 const stored=http.store.read(scope).state.extensionSettings.veridis_rewrite as any;
 assert.equal(stored.endpoint,proposed.endpoint);assert.equal(stored.customHeaders,proposed.customHeaders);
 for(const secret of ['old-user','old-password','old-query','old-header','old-cookie'])assert.ok(!JSON.stringify({endpoint:stored.endpoint,customHeaders:stored.customHeaders}).includes(secret));
 assert.equal(stored.aiRewrite.apiKey,'synthetic-independent-private-key');assert.equal(stored.aiRewrite.enabled,false);
}));


test('global library stays private internally while status roundtrip and runtime persistence retain raw embedded strings',async()=>fixture(async({base,http})=>{
 const privateFields=syntheticEmbeddedCredentials('global'),path=join(http.cwd,'.liyuan-veridis-rewrite','global-presets.json'),library={version:1,defaultPreset:'shared',presets:{shared:{rules:[{id:'global-rule'}],...privateFields,aiRewrite:{temperature:0.4}}}};
 writeFileSync(path,JSON.stringify(library),{mode:0o600});const privateBytes=readFileSync(path),model=structuredClone(http.host.model());
 assert.deepEqual(http.globalPresetLibrary().presets.shared,library.presets.shared);
 const context=await(await fetch(base+'/api/veridis-rewrite/status')).json();assert.ok(!JSON.stringify(context.settings).includes('global-password'));
 assert.equal((await putPublicRewriteSettings(base,context)).status,200);
 const scope=http.host.binding(),stored=http.store.read(scope).state.extensionSettings.veridis_rewrite as any;assert.deepEqual(stored.presets.shared,library.presets.shared);
 (http.sources as any).status=()=>({installed:true,enabled:true});(http.sources as any).active=()=>({commit:'a'.repeat(40)});let runs=0;
 http.runtime.run=async(input:any)=>{runs++;assert.deepEqual(input.settings.presets.shared,library.presets.shared);return{text:'synthetic draft',changed:false,calls:0,errors:[],version:'fixture',commit:'a'.repeat(40),settings:input.settings};};
 await http.run({scope,authorDraft:'synthetic draft',narrative:'synthetic draft',guard:()=>{},generate:async()=>{throw Error('Independent model must not be called by this settings test');}});
 assert.equal(runs,1);assert.deepEqual((http.store.read(scope).state.extensionSettings.veridis_rewrite as any).presets.shared,library.presets.shared);assert.deepEqual(readFileSync(path),privateBytes);assert.deepEqual(http.host.model(),model);
}));
