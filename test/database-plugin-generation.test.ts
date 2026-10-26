import assert from 'node:assert/strict';import test from 'node:test';
import {createDatabasePluginGenerator} from '../server/database-plugin-generation.ts';
import { classifyModelFailure } from '../src/stage/model-failure.ts';
import { TurnPerformanceCollector } from '../src/stage/performance.ts';
const baseModel={id:'gemini-3.8-flash',provider:'enabled',api:'openai-completions',maxTokens:16384,compat:{supportsTools:true}};
function fakeDependencies(result:any={role:'assistant',content:[{type:'text',text:'synthetic response'}],usage:{input:3,output:4,totalTokens:7},stopReason:'stop'}){
 const calls:any[]=[];const deps={findModel:(ref:any)=>ref.provider==='enabled'&&ref.id===baseModel.id?baseModel:undefined,defaultModel:()=>baseModel,auth:async()=>({ok:true,apiKey:'SERVER_ONLY_KEY',headers:{}}),stream:((model:any,context:any,options:any)=>{calls.push({model,context,options});return {async *[Symbol.asyncIterator](){yield{type:'done',message:result}},async result(){return result}}}) as any};return{calls,deps};
}
test('database rejects explicit errors-as-text and empty terminals before success, with no retry or model switch', async () => {
 for (const text of ['Provider finish_reason: content_filter', '[ProxySystem Error] upstream PROHIBITED_CONTENT', '[ProxySystem Error] upstream SAFETY', '{"error":{"message":"Blocked","code":"SAFETY"}}', '{"error":{"message":"Synthetic failure","type":"api_error"}}', '', '   ']) {
  const f = fakeDependencies({ stopReason: 'stop', content: [{ type: 'text', text }] }), activity: string[] = [];
  await assert.rejects(createDatabasePluginGenerator({ ...f.deps, onActivity: detail => activity.push(detail) })([{ role: 'user', content: 'Synthetic input' }]), error => {
   assert.match(String(error), /没有完成/);
   if (/content_filter|PROHIBITED_CONTENT|SAFETY/.test(text)) { assert.equal(classifyModelFailure(error).kind, 'content-filter'); assert.equal(classifyModelFailure(error).retryable, false); }
   return true;
  });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, baseModel); assert.equal(f.calls[0].options.maxRetries, 0);
  assert.ok(!activity.some(detail => /请求完成/.test(detail)));
 }
});

test('database rejects stream error events even when their message looks successful', async () => {
 const f = fakeDependencies(), activity: string[] = [];
 const final = { stopReason: 'stop', content: [{ type: 'text', text: 'Synthetic partial text' }] };
 const generate = createDatabasePluginGenerator({ ...f.deps, onActivity: detail => activity.push(detail), stream: ((m:any,c:any,o:any) => {
  f.deps.stream(m,c,o);
  return { async *[Symbol.asyncIterator]() { yield { type: 'error', error: final }; }, result: async () => final };
 }) as any });
 await assert.rejects(generate([{ role: 'user', content: 'Synthetic input' }]), /Provider stream error/);
 assert.equal(f.calls.length, 1);
 assert.ok(!activity.some(detail => /请求完成/.test(detail)));
});

test('database accepts ordinary error prose and tool-only output without inventing missing usage', async () => {
 for (const content of [[{ type: 'text', text: 'The synthetic character made an error.' }], [{ type: 'toolCall', id: 'synthetic-call', name: 'table_edit', arguments: {} }]]) {
  for (const usage of [undefined, {}, { input: 0, output: 0, totalTokens: 0 }, { input: 3 }]) {
   const f = fakeDependencies({ stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', content, usage });
   const reply = await createDatabasePluginGenerator(f.deps)([{ role: 'user', content: 'Synthetic input' }]);
   assert.deepEqual(reply.usage, usage?.input ? { prompt_tokens: 3 } : undefined);
  }
 }
});
test('database generator resolves exact Flash 3.8 and keeps authentication out of reply',async()=>{const f=fakeDependencies();const generate=createDatabasePluginGenerator(f.deps);const reply=await generate([{role:'system',content:'synthetic instructions'},{role:'user',content:'synthetic context'}],undefined,{modelRef:{provider:'enabled',id:baseModel.id},payload:{max_tokens:8192,temperature:.5}});assert.equal(reply.model,baseModel.id);assert.equal(reply.choices[0].message.content,'synthetic response');assert.equal(f.calls[0].options.apiKey,'SERVER_ONLY_KEY');assert.equal(f.calls[0].options.maxTokens,8192);assert.equal(f.calls[0].options.reasoning,'off');assert.ok(!JSON.stringify(reply).includes('SERVER_ONLY_KEY'));});
test('database generator native tool calls round-trip into original OpenAI response schema',async()=>{const f=fakeDependencies({content:[{type:'toolCall',id:'tool-1',name:'table_edit',arguments:{commands:'insertRow(0,{"0":"synthetic"})'}}],usage:{input:1,output:2,totalTokens:3},stopReason:'toolUse'});const reply=await createDatabasePluginGenerator(f.deps)([{role:'user',content:'synthetic'}],undefined,{payload:{tools:[{type:'function',function:{name:'table_edit',parameters:{type:'object',properties:{commands:{type:'string'}}}}}]}});assert.equal(f.calls[0].context.tools[0].name,'table_edit');assert.equal(reply.choices[0].finish_reason,'tool_calls');assert.equal(JSON.parse(reply.choices[0].message.tool_calls![0].function.arguments).commands,'insertRow(0,{"0":"synthetic"})');});
test('database generator honors declared tools support, authentication, errors, and late binding before dispatch',async()=>{const f=fakeDependencies();const options={payload:{tools:[{type:'function',function:{name:'table_edit',parameters:{type:'object'}}}]}};const off={...f.deps,defaultModel:()=>({...baseModel,compat:{supportsTools:false}})};await assert.rejects(createDatabasePluginGenerator(off)([{role:'user',content:'synthetic'}],undefined,options),/不支持工具/);await assert.rejects(createDatabasePluginGenerator({...f.deps,auth:async()=>({ok:false})})([{role:'user',content:'synthetic'}]),/鉴权不可用/);await assert.rejects(createDatabasePluginGenerator(f.deps)([{role:'user',content:'synthetic'}],undefined,{validateBinding:()=>{throw new Error('stale source')}}),/stale source/);assert.equal(f.calls.length,0);const failed=fakeDependencies({stopReason:'error',content:[],usage:{}});await assert.rejects(createDatabasePluginGenerator(failed.deps)([{role:'user',content:'synthetic'}]),/没有完成/);});

test('managed database calls honor the current analysis budget instead of a hidden three-minute cap',async()=>{
 let minutes=10;const f=fakeDependencies();
 const generate=createDatabasePluginGenerator({...f.deps,analysisTimeoutMinutes:()=>minutes});
 await generate([{role:'user',content:'synthetic memory'}]);
 assert.equal(f.calls[0].options.timeoutMs,600000);assert.equal(f.calls[0].options.maxRetries,0);
 minutes=2;await generate([{role:'user',content:'synthetic second source'}]);
 assert.equal(f.calls[1].options.timeoutMs,120000);
});

test('a live managed request is not locally aborted after 180 seconds when the configured budget is ten minutes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(AbortSignal,'timeout',(ms:number)=>{const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('synthetic timeout','TimeoutError')),ms);return controller.signal;});
 const f=fakeDependencies();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const generate=createDatabasePluginGenerator({...f.deps,analysisTimeoutMinutes:()=>10,stream:((model:any,context:any,options:any)=>{
  const source=f.deps.stream(model,context,options);
  return{async *[Symbol.asyncIterator](){await gate;yield{type:'done',message:await source.result()};},result:()=>source.result()};
 })as any});
 const task=generate([{role:'user',content:'slow synthetic response'}]);
 try{
  for(let i=0;i<8&&!f.calls.length;i++)await Promise.resolve();assert.equal(f.calls.length,1);
  t.mock.timers.tick(180001);assert.equal(f.calls[0].options.signal.aborted,false);
  release();await task;
 }finally{release();await task.catch(()=>{});t.mock.timers.reset();t.mock.restoreAll();}
});

test('already-cancelled database work cannot authenticate or dispatch a new request',async()=>{
 const f=fakeDependencies(),abort=new AbortController();abort.abort(new Error('synthetic user stop'));
 await assert.rejects(createDatabasePluginGenerator(f.deps)([{role:'user',content:'synthetic'}],abort.signal),/synthetic user stop/);
 assert.equal(f.calls.length,0);
});

test('managed database local deadline is bounded, attributed as analysis timeout and ignores a late producer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fakeDependencies();let release!:(v:any)=>void;const pending=new Promise<any>(r=>release=r);
 const result={role:'assistant',content:[{type:'text',text:'late synthetic response'}],usage:{input:1,output:1,totalTokens:2},stopReason:'stop'};
 const generate=createDatabasePluginGenerator({...f.deps,analysisTimeoutMinutes:()=>1,stream:((model:any,context:any,options:any)=>{
  f.deps.stream(model,context,options);
  return{async *[Symbol.asyncIterator](){yield{type:'done',message:await pending};},result:()=>pending};
 })as any});
 const task=generate([{role:'user',content:'synthetic timeout'}]);
 const rejected=assert.rejects(task,(error:any)=>error.name==='LocalRequestTimeoutError'&&error.origin==='local-timeout'&&error.scope==='analysis'&&error.timeoutMs===60000);
 try{for(let i=0;i<8&&!f.calls.length;i++)await Promise.resolve();t.mock.timers.tick(60001);await rejected;assert.equal(f.calls[0].options.signal.aborted,true);}
 finally{release(result);await task.catch(()=>{});t.mock.timers.reset();}
});

test('completed database terminal receipt does not wait for an unresolved redundant result and clears its timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fakeDependencies();
 const generate=createDatabasePluginGenerator({...f.deps,analysisTimeoutMinutes:()=>1,stream:((model:any,context:any,options:any)=>{
  const source=f.deps.stream(model,context,options);
  return{[Symbol.asyncIterator]:()=>source[Symbol.asyncIterator](),result:()=>new Promise(()=>{})};
 })as any});
 try{const reply=await generate([{role:'user',content:'synthetic final receipt'}]);assert.equal(reply.choices[0].message.content,'synthetic response');t.mock.timers.tick(60001);assert.equal(f.calls[0].options.signal.aborted,false);}
 finally{t.mock.timers.reset();}
});

test('managed database cancellation during authentication prevents a late dispatch',async()=>{
 const f=fakeDependencies(),abort=new AbortController();const generate=createDatabasePluginGenerator({...f.deps,auth:async()=>{abort.abort(new Error('cancelled during synthetic auth'));return{ok:true,apiKey:'SERVER_ONLY_KEY'};}});
 await assert.rejects(generate([{role:'user',content:'synthetic'}],abort.signal),/cancelled during synthetic auth/);assert.equal(f.calls.length,0);
});


test('managed database preserves the actual sanitized upstream failure instead of a generic incomplete receipt', async () => {
 const f = fakeDependencies({ role: 'assistant', content: [], usage: {}, stopReason: 'error', errorMessage: '504 Gateway Time-out at https://upstream.invalid/v1 using SERVER_ONLY_KEY' });
 const activity: string[] = [];
 const generate = createDatabasePluginGenerator({ ...f.deps, onActivity: (detail: string) => activity.push(detail) });
 await assert.rejects(generate([{ role: 'user', content: 'Synthetic recall input' }], undefined, { purpose: 'recall' }), error => {
  assert.match(String(error), /504.*Gateway Time-out/);
  assert.doesNotMatch(String(error), /SERVER_ONLY_KEY|upstream\.invalid/);
  return true;
 });
 assert.equal(f.calls.length, 1, 'host must not add another paid retry');
 assert.ok(activity.some(detail => /召回.*请求/.test(detail)));
 assert.ok(activity.some(detail => /504/.test(detail)));
 assert.ok(!activity.some(detail => /请求完成/.test(detail)));
 assert.doesNotMatch(activity.join('\n'), /SERVER_ONLY_KEY|upstream\.invalid/);
});

test('managed database notifies each original attempt without changing its model, prompt or timeout', async () => {
 const f = fakeDependencies(), activity: string[] = [];
 const generate = createDatabasePluginGenerator({ ...f.deps, onActivity: (detail: string) => activity.push(detail) });
 const input = [{ role: 'user', content: 'Synthetic unchanged recall input' }];
 await generate(input, undefined, { purpose: 'recall' });
 await generate(input, undefined, { purpose: 'fill' });
 assert.equal(f.calls.length, 2);
 assert.ok(activity.some(detail => /召回.*请求完成/.test(detail)));
 assert.ok(activity.some(detail => /填表.*请求完成/.test(detail)));
 assert.equal(f.calls[0].context.messages[0].content[0].text, input[0].content);
 assert.equal(f.calls[0].options.timeoutMs, 600000);
 assert.equal(f.calls[1].options.maxRetries, 0);
});

test('analysis deadline includes a hung authentication and prevents dispatch after late credentials', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = fakeDependencies();
 let resolveAuth!: (value: any) => void, entered = false;
 const auth = new Promise<any>(resolve => { resolveAuth = resolve; });
 const generate = createDatabasePluginGenerator({ ...f.deps, analysisTimeoutMinutes: () => 1, auth: () => { entered = true; return auth; } });
 const task = generate([{ role: 'user', content: 'Synthetic authentication deadline' }]);
 const rejected = assert.rejects(task, (error: any) => error.name === 'LocalRequestTimeoutError' && error.scope === 'analysis' && error.timeoutMs === 60000);
 try {
  for (let i = 0; i < 12 && !entered; i++) await Promise.resolve();
  assert.ok(entered);
  t.mock.timers.tick(60001);
  // Release the producer even on the broken baseline; a real fix rejects before this release.
  resolveAuth({ ok: true, apiKey: 'SERVER_ONLY_KEY' });
  await rejected;
  assert.equal(f.calls.length, 0);
 } finally { resolveAuth({ ok: true }); await task.catch(() => {}); t.mock.timers.reset(); }
});


test('parent cancellation interrupts hung database authentication immediately without a paid request', { timeout: 2000 }, async () => {
 const f = fakeDependencies(), parent = new AbortController(), reason = new Error('Synthetic whole-turn cancellation');
 let resolveAuth!: (value: any) => void, entered!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const auth = new Promise<any>(resolve => { resolveAuth = resolve; });
 const generate = createDatabasePluginGenerator({ ...f.deps, auth: () => { entered(); return auth; } });
 const task = generate([{ role: 'user', content: 'Synthetic cancellation' }], parent.signal);
 const rejected = assert.rejects(task, error => error === reason);
 try { await started; parent.abort(reason); await rejected; assert.equal(f.calls.length, 0); }
 finally { resolveAuth({ ok: true, apiKey: 'SERVER_ONLY_KEY' }); await task.catch(() => {}); }
});

test('database activity observers cannot turn success into a failure or trigger a duplicate request', async () => {
 const f = fakeDependencies();
 const generate = createDatabasePluginGenerator({ ...f.deps, onActivity: () => { throw new Error('Synthetic disconnected viewer'); } });
 const reply = await generate([{ role: 'user', content: 'Synthetic complete recall' }]);
 assert.equal(reply.choices[0].message.content, 'synthetic response');
 assert.equal(f.calls.length, 1);
});


test('unified settings recall/plot model overrides stale native model refs without changing fill',async()=>{
 const f=fakeDependencies(),argon={...baseModel,provider:'primary',id:'gemini-4-argon'};let selected={provider:argon.provider,id:argon.id};
 const generate=createDatabasePluginGenerator({...f.deps,findModel:ref=>ref.provider===argon.provider&&ref.id===argon.id?argon:ref.id===baseModel.id?baseModel:undefined,recallModel:()=>selected});
 const recall=await generate([{role:'user',content:'synthetic recall plus direction'}],undefined,{purpose:'recall',modelRef:{provider:baseModel.provider,id:baseModel.id}});
 assert.equal(recall.model,argon.id);assert.equal(f.calls[0].model.provider,argon.provider);assert.equal(f.calls[0].model.id,argon.id);
 await generate([{role:'user',content:'synthetic fill'}],undefined,{purpose:'fill',modelRef:{provider:baseModel.provider,id:baseModel.id}});assert.equal(f.calls[1].model.id,baseModel.id);
 selected={provider:'missing',id:'unavailable'};await assert.rejects(generate([{role:'user',content:'no fallback'}],undefined,{purpose:'recall',modelRef:{provider:baseModel.provider,id:baseModel.id}}),/未配置/);assert.equal(f.calls.length,2);
});

test('native database attempts and available usage reach their originating phase, including failed terminals', async () => {
 for (const failed of [false, true]) {
  const collector=new TurnPerformanceCollector();
  const f=fakeDependencies({content:[{type:'text',text:'Synthetic result'}],usage:{input:3,cacheRead:2,output:4},stopReason:failed?'error':'stop',...(failed?{errorMessage:'Synthetic upstream failure'}:{})});
  const generate=createDatabasePluginGenerator({...f.deps,observation:()=>({collector,phase:'settlement.memory'})});
  const task=generate([{role:'user',content:'Synthetic frozen narrative'}]);
  if(failed)await assert.rejects(task,/没有完成/);else await task;
  const phase=collector.finish('synthetic-source').phases['settlement.memory']!;
  assert.equal(phase.calls,1);assert.equal(phase.inputTokens,5);assert.equal(phase.outputTokens,4);assert.equal(phase.usageCalls,1);assert.equal(phase.status,failed?'failed':'success');
 }
});

test('database observation binds before asynchronous authentication and counts dispatch failures without inventing usage', async () => {
 const first=new TurnPerformanceCollector(),second=new TurnPerformanceCollector();
 let current=first;
 const f=fakeDependencies();
 const generate=createDatabasePluginGenerator({...f.deps,observation:()=>({collector:current,phase:'prep.database'}),auth:async()=>{current=second;return{ok:true};},stream:(()=>{throw Error('Synthetic transport failure');}) as any});
 await assert.rejects(generate([{role:'user',content:'Synthetic recall'}]),/transport failure/);
 const phase=first.finish('first').phases['prep.database']!;
 assert.equal(phase.calls,1);assert.equal(phase.status,'failed');assert.equal(phase.inputTokens,undefined);assert.equal(phase.usageCalls,undefined);
 assert.deepEqual(second.finish('second').phases,{});
 const noDispatch=new TurnPerformanceCollector();
 await assert.rejects(createDatabasePluginGenerator({...f.deps,observation:()=>({collector:noDispatch,phase:'prep.database'}),auth:async()=>({ok:false})})([{role:'user',content:'Synthetic auth rejection'}]),/鉴权/);
 assert.deepEqual(noDispatch.finish('no-dispatch').phases,{});
});
