import assert from "node:assert/strict";
import test from "node:test";
import { databasePluginModelRevision } from "../server/database-plugin-models.ts";
import { DatabasePluginRuntime } from "../server/database-plugin-runtime.ts";
import { TurnPerformanceCollector } from "../src/stage/performance.ts";
import { createDatabasePluginGenerator } from "../server/database-plugin-generation.ts";

test("database observation labels follow runtime boundaries, and always clear on failure", async () => {
 const http = { assertBinding() {}, boundSourceEntryId: undefined } as any;
 const runtime = new DatabasePluginRuntime(http, () => "http://synthetic.invalid");
 const phases: unknown[] = [];
 let fail = false;
 (runtime as any).ensure = async () => ({ evaluate: async () => {
  phases.push([runtime.requestPhase, http.boundSourceEntryId]);
  if (fail) throw new Error("synthetic failure");
  return { sourceEntryId: "user", userInput: "synthetic", errors: [] };
 } });
 await runtime.before("synthetic");
 assert.equal(runtime.requestPhase, undefined);
 await runtime.after("reply");
 assert.equal(runtime.requestPhase, undefined);
 assert.equal(http.boundSourceEntryId, undefined);
 assert.deepEqual(phases, [["database.before", undefined], ["database.after", "reply"]]);
 fail = true;
 await assert.rejects(runtime.before("synthetic"), /synthetic failure/);
 assert.equal(runtime.requestPhase, undefined);
 await assert.rejects(runtime.after("reply"), /synthetic failure/);
 assert.equal(runtime.requestPhase, undefined);
  assert.equal(http.boundSourceEntryId, undefined);
});

test('runtime observation is task-local and clears after success and failure',async()=>{
 const runtime=new DatabasePluginRuntime({assertBinding(){}} as any,()=> 'http://synthetic.invalid');
 const collector=new TurnPerformanceCollector();
 const before={collector,phase:'prep.database' as const},after={collector,phase:'settlement.memory' as const};
 let fail=false;const seen:unknown[]=[];
 (runtime as any).ensure=async()=>({evaluate:async()=>{seen.push(runtime.requestObservation);if(fail)throw Error('Synthetic native failure');return{sourceEntryId:'synthetic'};}});
 await Promise.all([runtime.before('synthetic',undefined,undefined,before),runtime.after('synthetic',undefined,after)]);
 assert.deepEqual(seen,[before,after]);assert.equal(runtime.requestObservation,undefined);
 fail=true;await assert.rejects(runtime.after('synthetic',undefined,after),/native failure/);assert.equal(runtime.requestObservation,undefined);
 await assert.rejects(runtime.before('synthetic',undefined,undefined,before),/native failure/);assert.equal(runtime.requestObservation,undefined);
});


test('same-source cached native browser is discarded after the shared model changes',async()=>{
 let model='synthetic-old',evaluations=0,closes=0;
 const presets=()=>[{name:model,purpose:'recall' as const,provider:'fixture',model,url:'/api/database-plugin/connections/recall/fixture/v1',maxTokens:8192}];
 const http={currentContext:()=>({sourceEntryId:'same-source'}),scopeKey:()=> 'same-scope',managedPresets:presets,sources:{readCurrentPinnedJS(){throw Error('new native binding required');}}} as any;
 const runtime=new DatabasePluginRuntime(http,()=> 'http://synthetic.invalid');
 Object.assign(runtime,{page:{evaluate:async()=>{evaluations++;return true;}},scope:'same-scope',source:'same-source',modelRevision:databasePluginModelRevision(presets()),browser:{close:async()=>{closes++;}}});
 await runtime.rpc('getUpdateConfigParams');assert.equal(evaluations,1);
 model='synthetic-new';await assert.rejects(runtime.rpc('getUpdateConfigParams'),/new native binding required/);assert.equal(closes,1);assert.equal(evaluations,1);assert.equal(runtime.status().connected,false);
});

for(const status of [524,401])test(`native after preserves sanitized managed ${status} despite a generic browser failure`,async()=>{
 const runtime=new DatabasePluginRuntime({assertBinding(){}} as any,()=> 'http://synthetic.invalid');
 const model={provider:'synthetic',id:'synthetic',maxTokens:1024};
 let failed=true;
 const generate=createDatabasePluginGenerator({findModel:()=>model,defaultModel:()=>model,auth:async()=>({ok:true,apiKey:'SYNTHETIC_SECRET'}),failureObserver:()=>runtime.requestFailureObserver,
  stream:(()=>{const result={stopReason:failed?'error':'stop',content:[{type:'text',text:'Synthetic table'}],errorMessage:`HTTP ${status} ${status===524?'Proxy Read Timeout':'unauthorized'} https://private.invalid/v1 SYNTHETIC_SECRET`};return{async *[Symbol.asyncIterator](){yield{type:'done',message:result};},result:async()=>result};}) as any});
 (runtime as any).ensure=async()=>({evaluate:async()=>{try{await generate([{role:'user',content:'Synthetic frozen narrative'}]);}catch{throw Error('原插件自动分组填表失败，保留待恢复状态');}return{success:true};}});
 await assert.rejects(runtime.after('synthetic-source'),(error:any)=>{
  assert.equal(error.failure.statusCode,status);assert.equal(error.failure.origin,'provider');assert.equal(error.failure.kind,status===524?'timeout':'auth');
  assert.match(error.message,new RegExp(String(status)));assert.doesNotMatch(JSON.stringify(error)+error.message,/SYNTHETIC_SECRET|private\.invalid/);return true;
 });
 assert.equal(runtime.requestFailureObserver,undefined);
 failed=false;await runtime.after('synthetic-source');assert.equal(runtime.requestFailureObserver,undefined);
});
