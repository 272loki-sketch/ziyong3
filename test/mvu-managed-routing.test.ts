import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createTavernPluginGenerator,resolveManagedMvuModel,tavernSampler,type TavernGenerationOptions} from "../server/tavern-plugin-http.ts";
import {normalizeStepModels,resolveStepModel} from "../src/model-routing.ts";
import {setMvuEnabled} from "../server/mvu-assets.ts";
import {estimateContextTokens} from "../packages/ai/src/utils/estimate.ts";
import {streamSimple} from "@liyuan/ai/compat";
const writer={provider:"writer",id:"writer-model",baseUrl:"https://writer.invalid/v1",maxTokens:16384};
const parser={provider:"new",id:"gemini-3.8-flash",baseUrl:"https://parser.invalid/v1",maxTokens:16384};
const payload={model:parser.id,reverse_proxy:parser.baseUrl,chat_completion_source:"custom",stream:false,max_tokens:99999,temperature:0.3};
function fixture(){
 let calls=0,claims=0,live=true,authOk=true,authCalls=0,duringAuth=()=>{};const seen:any[]=[];const controller=new AbortController();
 const options:TavernGenerationOptions={purpose:"mvu.parse",payload,scope:{sessionId:"original-session",card:"original-card"},sourceEntryId:"original-source",validateBinding:()=>{if(!live||controller.signal.aborted)throw Error("stale scope");},claimRequest:()=>{if(claims>=8)throw Error("eight limit");claims++;}};
 let models=[writer,parser],ref:any={provider:"new",id:parser.id};
 const generate=createTavernPluginGenerator({models:()=>models,mvuRef:()=>ref,writer:()=>writer,auth:async(model)=>{authCalls++;assert.equal(model.id,options.purpose==="mvu.parse"?parser.id:writer.id);await Promise.resolve();duringAuth();return {ok:authOk,apiKey:"synthetic-credential",headers:{"x-synthetic":"only"}};},stream:(model,context,opts,binding)=>{calls++;seen.push({model,context,opts,binding});return {async *[Symbol.asyncIterator](){yield {type:"done"};},async result(){return {stopReason:"stop",content:[{type:"text",text:"synthetic patch"}]};}};}});
 return {generate,options,controller,seen,get calls(){return calls;},get claims(){return claims;},get authCalls(){return authCalls;},set live(value:boolean){live=value;},set authOk(value:boolean){authOk=value;},set duringAuth(value:()=>void){duringAuth=value;},set models(value:typeof models){models=value;},set ref(value:any){ref=value;}};
}
const messages=[{role:"system",content:"synthetic rule"},{role:"user",content:"synthetic full author delivery"}];
test("MVU assistant history has valid SDK usage metadata before token estimation",async()=>{
 const f=fixture(),history=[...messages,{role:"assistant",content:"synthetic prior story"},{role:"user",content:"synthetic current turn"}];
 assert.throws(()=>estimateContextTokens({messages:[{role:"assistant",content:[{type:"text",text:"synthetic"}],timestamp:0}] as any}),/totalTokens/);
 await f.generate(history,f.controller.signal,f.options);
 const context=f.seen[0].context,assistant=context.messages.find((m:any)=>m.role==="assistant");
 assert.equal(assistant.provider,parser.provider);assert.equal(assistant.model,parser.id);assert.equal(assistant.stopReason,"stop");
 assert.equal(assistant.usage.totalTokens,0);assert.ok(estimateContextTokens(context).tokens>0);
 assert.deepEqual(context.messages.map((m:any)=>m.content[0].text),history.filter(m=>m.role!=="system").map(m=>m.content));
});
test("MVU SDK errors preserve the concrete reason and redact credentials",async()=>{
 const controller=new AbortController();
 const generate=createTavernPluginGenerator({models:()=>[parser],mvuRef:()=>({provider:parser.provider,id:parser.id}),writer:()=>parser,auth:async()=>({ok:true,apiKey:"synthetic-secret"}),stream:()=>({async *[Symbol.asyncIterator](){yield {type:"error",error:{errorMessage:"Invalid SDK history synthetic-secret"}};},async result(){throw Error("must not hide error event");}})});
 await assert.rejects(()=>generate(messages,controller.signal,{purpose:"mvu.parse",payload,scope:{sessionId:"synthetic",card:"synthetic"},sourceEntryId:"synthetic",validateBinding:()=>{},claimRequest:()=>{}}),/Invalid SDK history \[redacted\]/);
});
test("real SDK reaches payload with synthetic assistant history without sending network requests",async()=>{
 const model={...parser,api:"openai-completions",name:"synthetic",reasoning:false,input:["text"],contextWindow:128000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 let captured=false;
 const generate=createTavernPluginGenerator({models:()=>[model],mvuRef:()=>({provider:model.provider,id:model.id}),writer:()=>model,auth:async()=>({ok:true,apiKey:"synthetic-secret"}),stream:(m,context,options)=>streamSimple(m as any,context,{...options,onPayload:(body:any)=>{captured=true;assert.ok(body.messages.some((message:any)=>message.role==="assistant"&&message.content==="synthetic history"));throw Error("synthetic stop before network");}})});
 await assert.rejects(()=>generate([...messages,{role:"assistant",content:"synthetic history"}],undefined,{purpose:"mvu.parse",payload,scope:{sessionId:"synthetic",card:"synthetic"},sourceEntryId:"synthetic",validateBinding:()=>{},claimRequest:()=>{}}),/synthetic stop before network/);
 assert.equal(captured,true);
});
test("actual shared generator selects exact 3.8 parser, capped sampler and captured journal binding; default stays writer",async()=>{
 const f=fixture();assert.equal(await f.generate(messages,f.controller.signal,f.options),"synthetic patch");assert.equal(f.seen[0].model.id,parser.id);assert.equal(f.seen[0].opts.maxTokens,8192);assert.equal(f.seen[0].opts.temperature,0.3);assert.equal(f.seen[0].binding.sourceEntryId,"original-source");assert.equal(f.claims,1);
 f.options.purpose="tavern-helper";f.options.payload={};await f.generate(messages,f.controller.signal,f.options);assert.equal(f.seen[1].model.id,writer.id);
});
test("wrong endpoint/model/provider, missing ref and custom auth never reach auth or paid stub",async()=>{
 for(const change of [()=>({reverse_proxy:writer.baseUrl}),()=>({model:writer.id}),()=>({custom_include_headers:"Authorization: forged"}),()=>({response_format:{type:"json_schema"}})]){
  const f=fixture();f.options.payload={...payload,...change()};await assert.rejects(()=>f.generate(messages,f.controller.signal,f.options));assert.equal(f.calls,0);assert.equal(f.claims,0);assert.equal(f.authCalls,0);
 }
 for(const ref of [undefined,{provider:"removed",id:parser.id}]){const f=fixture();f.ref=ref;await assert.rejects(()=>f.generate(messages,f.controller.signal,f.options));assert.equal(f.authCalls,0);}
 assert.throws(()=>resolveManagedMvuModel({provider:"new",id:parser.id},{...payload,reverse_proxy:"https://user:pass@parser.invalid/v1"},[parser]));
});
for(const reason of ["scope","cancel","auth","endpoint"]){test(`guard after awaited auth blocks ${reason} without claiming or billing`,async()=>{
 const f=fixture();f.duringAuth=()=>{if(reason==="scope")f.live=false;if(reason==="cancel")f.controller.abort();if(reason==="auth")f.authOk=false;if(reason==="endpoint")f.models=[{...parser,baseUrl:writer.baseUrl}];};
 await assert.rejects(()=>f.generate(messages,f.controller.signal,f.options));assert.equal(f.calls,0);assert.equal(f.claims,0);
});}
test("persistent budget callback blocks ninth send after auth",async()=>{const f=fixture();for(let n=0;n<8;n++)await f.generate(messages,f.controller.signal,f.options);await assert.rejects(()=>f.generate(messages,f.controller.signal,f.options),/eight limit/);assert.equal(f.calls,8);assert.equal(f.claims,8);});
test("unsupported stream/schema/include/exclude/samplers cannot be silently discarded",()=>{for(const extra of [{stream:true},{response_format:{}},{custom_include_body:"{}"},{custom_exclude_body:"temperature"},{top_p:0.5},{temperature:NaN},{max_tokens:"4096"}])assert.throws(()=>tavernSampler({...payload,...extra},8192));});
test("routing normalization preserves all other roles and MVU toggle preserves unknown config",()=>{
 assert.equal(resolveStepModel("mvuParse",undefined,writer,()=>undefined).model,undefined);
 assert.equal(resolveStepModel("mvuParse",{mvuParse:{provider:"missing",id:parser.id}},writer,()=>undefined,()=>parser).model,undefined);
 assert.deepEqual(normalizeStepModels({writer:{provider:"writer",id:writer.id},mvuParse:{provider:"new",id:parser.id},memoryEvents:{provider:"db",id:"db-model"}}),{writer:{provider:"writer",id:writer.id},mvuParse:{provider:"new",id:parser.id},memoryEvents:{provider:"db",id:"db-model"}});
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-mvu-routing-"));try{const root=join(cwd,".liyuan-tavern-plugins/mvu");mkdirSync(root,{recursive:true});const file=join(root,"config.json");writeFileSync(file,JSON.stringify({version:1,enabled:true,modelRef:{provider:"new",id:parser.id},future:{keep:true}}));setMvuEnabled(cwd,false);assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),{version:1,enabled:false,modelRef:{provider:"new",id:parser.id},future:{keep:true}});}finally{rmSync(cwd,{recursive:true,force:true});}
});
