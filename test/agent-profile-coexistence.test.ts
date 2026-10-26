import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AuthStorage, ModelRegistry } from "@liyuan/agent-runtime";
import { enableProfile, loadAgentConfig, loadProfile, mergeEnabledAgentProfile, migrateActiveConfigIntoProfiles, normalizeAgentConfig, saveAgentConfig, saveProfile, syncAgentConfigToRuntime } from "../src/agent-config.ts";
import { configuredModels } from "../src/configured-models.ts";
import { resolveStepModel } from "../src/model-routing.ts";
import { handleApiRequest, type RestHost } from "../server/rest.ts";

const api=(id:string)=>({baseUrl:"http://127.0.0.1:9/v1",api:"openai-completions",apiKey:"SYNTHETIC-NOT-A-REAL-KEY",models:[{id,compat:{supportsTools:false,fixtureUnknown:true}}],fixtureProvider:{keep:true}});
const base=()=>normalizeAgentConfig({version:1,defaultProvider:"old",defaultModel:"flash",defaultThinkingLevel:"off",fixtureUnknown:{retain:42},providers:{old:api("flash"),sibling:api("sibling-model")}});
const selected=()=>normalizeAgentConfig({version:1,defaultProvider:"main",defaultModel:"writer",providers:{main:api("writer")}});
function fixture(){const cwd=mkdtempSync(join(tmpdir(),"liyuan-profile-coexist-")),agentDir=join(cwd,"agent");return{cwd,agentDir,cleanup:()=>rmSync(cwd,{recursive:true,force:true})}}
async function request(host:RestHost,method:string,url:string,payload?:unknown){const req=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]) as Readable & {method:string;url:string};req.method=method;req.url=url;let status=0,text="";const res={writeHead:(code:number)=>{status=code},end:(v="")=>{text+=v}};assert.equal(await handleApiRequest(req as never,res as never,host),true);return{status,body:JSON.parse(text)}}

test("profile activation and refresh retain enabled side-role APIs without activating unrelated warehouse profiles",()=>{
 const f=fixture();try{
  const original=base();saveAgentConfig(f.cwd,original);saveProfile(f.cwd,"main","主用合成配置",selected());saveProfile(f.cwd,"unused","未启用合成仓库",normalizeAgentConfig({version:1,providers:{unused:api("must-not-run")}}));
  const stage={stepModels:{worldProfile:{provider:"old",id:"flash"},scribe:{provider:"old",id:"flash"}},unknownStage:{preserve:true}};
  writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(stage));
  const stageBytes=readFileSync(join(f.cwd,"liyuan.config.json"));
  for(let i=0;i<2;i++){
   const enabled=enableProfile(f.cwd,f.agentDir,"main");assert.equal(enabled.defaultProvider,"main");assert.equal(enabled.defaultModel,"writer");assert.deepEqual(enabled.providers.old,original.providers.old);assert.deepEqual(enabled.providers.sibling,original.providers.sibling);assert.deepEqual((enabled as any).fixtureUnknown,original.fixtureUnknown);
   const registry=ModelRegistry.create(AuthStorage.inMemory(),join(f.agentDir,"models.json"));assert.equal(registry.getError(),undefined);
   const available=configuredModels(registry.getAvailable(),enabled);assert.ok(available.some(m=>m.provider==="main"&&m.id==="writer"));assert.ok(available.some(m=>m.provider==="old"&&m.id==="flash"));assert.equal(available.some(m=>m.provider==="unused"),false);
   assert.equal(resolveStepModel("worldProfile",stage.stepModels,registry.find("main","writer"),(p,id)=>available.find(m=>m.provider===p&&m.id===id)).model?.provider,"old");
   assert.ok(readFileSync(join(f.cwd,"liyuan.config.json")).equals(stageBytes));
  }
  assert.deepEqual(Object.keys(loadProfile(f.cwd,"main")!.config.providers),["main"],"activation does not silently rewrite warehouse snapshots");
 }finally{f.cleanup()}
});

test("first warehouse migration does not destructively replace a multi-provider live configuration",()=>{
 const f=fixture();try{const original=base();saveAgentConfig(f.cwd,original);const before=readFileSync(join(f.cwd,"liyuan.agent.json"));const result=migrateActiveConfigIntoProfiles(f.cwd);assert.equal(result.migrated,true);assert.ok(readFileSync(join(f.cwd,"liyuan.agent.json")).equals(before));assert.deepEqual(loadAgentConfig(f.cwd).config,original);assert.deepEqual(result.ids.sort(),["old","sibling"]);}finally{f.cleanup()}
});

test("selected provider is authoritative for deliberate model removal; other enabled providers and undefined defaults are retained",()=>{
 const original=base();const updated=mergeEnabledAgentProfile(original,normalizeAgentConfig({version:1,providers:{old:{...api("replacement"),apiKey:"SYNTHETIC-UPDATED-KEY"}}}));
 assert.equal(updated.defaultProvider,"old");assert.equal(updated.defaultModel,"flash");assert.deepEqual(updated.providers.old.models?.map(m=>m.id),["replacement"]);assert.deepEqual(updated.providers.sibling,original.providers.sibling);assert.equal(original.providers.old.models?.[0].id,"flash");
});

test("editing an active single-provider profile preserves the full live base; explicit live config removal is still respected",async()=>{
 const f=fixture();try{
  saveAgentConfig(f.cwd,base());saveProfile(f.cwd,"main","主用合成配置",selected());enableProfile(f.cwd,f.agentDir,"main");
  let current={provider:"main",id:"writer",name:"合成主演",thinkingLevel:"off",availableLevels:["off"]};
  const host={cwd:f.cwd,agentDir:()=>f.agentDir,isStreaming:()=>false,refreshModels:()=>{},notify:()=>{},listModels:()=>({current,models:[]}),selectModel:async(provider:string,id:string)=>{current={...current,provider,id};return current}} as unknown as RestHost;
  const update=selected();update.providers.main.models![0].maxTokens=4321;
  const result=await request(host,"PUT","/api/agent-profiles",{id:"main",config:update});assert.equal(result.status,200);assert.equal(loadAgentConfig(f.cwd).config.providers.main.models?.[0].maxTokens,4321);assert.ok(loadAgentConfig(f.cwd).config.providers.old);assert.ok(loadAgentConfig(f.cwd).config.providers.sibling);
  const removed={...loadAgentConfig(f.cwd).config,providers:{main:update.providers.main}};
  assert.equal((await request(host,"PUT","/api/agent-config",{config:removed})).status,200);assert.equal(loadAgentConfig(f.cwd).config.providers.old,undefined,"full live-config edits can explicitly disconnect a channel");
 }finally{f.cleanup()}
});

test("saving the active profile from the full live config does not copy other profiles' channels into its warehouse snapshot",async()=>{
 const f=fixture();try{
  const other=normalizeAgentConfig({version:1,defaultProvider:"side",defaultModel:"side-a",providers:{side:{...api("side-a"),models:[{id:"side-a"},{id:"side-old"}]}}});
  saveProfile(f.cwd,"side","合成旁路",other);enableProfile(f.cwd,f.agentDir,"side");
  saveProfile(f.cwd,"main","合成主用",selected());enableProfile(f.cwd,f.agentDir,"main");
  let current={provider:"main",id:"writer",name:"合成主演",thinkingLevel:"off",availableLevels:["off"]};
  const host={cwd:f.cwd,agentDir:()=>f.agentDir,isStreaming:()=>false,refreshModels:()=>{},notify:()=>{},listModels:()=>({current,models:[]}),selectModel:async(provider:string,id:string)=>{current={...current,provider,id};return current}} as unknown as RestHost;
  // The UI submits the whole live config (main + side + a newly added channel) as the active profile.
  const live=loadAgentConfig(f.cwd).config;
  const submitted={...live,providers:{...live.providers,fresh:api("fresh-model")}};
  assert.equal((await request(host,"PUT","/api/agent-profiles",{id:"main",config:submitted})).status,200);
  assert.deepEqual(Object.keys(loadProfile(f.cwd,"main")!.config.providers).sort(),["fresh","main"]);
  assert.ok(loadAgentConfig(f.cwd).config.providers.side,"other enabled channels stay in the live config");
  // The side profile later drops a model; re-enabling main must not resurrect it from a stale copy.
  saveProfile(f.cwd,"side","合成旁路",normalizeAgentConfig({...other,providers:{side:{...api("side-a"),models:[{id:"side-a"}]}}}));enableProfile(f.cwd,f.agentDir,"side");
  enableProfile(f.cwd,f.agentDir,"main");
  assert.deepEqual(loadAgentConfig(f.cwd).config.providers.side.models?.map(m=>m.id),["side-a"]);
 }finally{f.cleanup()}
});

test("enabling a profile ignores stale copies of channels owned by their same-named profile; live channel edits sync back to the owner",async()=>{
 const f=fixture();try{
  // Polluted warehouse: profile "main" carries an old copy of channel "side" with an extra model.
  saveProfile(f.cwd,"side","合成旁路",normalizeAgentConfig({version:1,providers:{side:{...api("side-a"),models:[{id:"side-a"}]}}}));
  saveProfile(f.cwd,"main","合成主用",normalizeAgentConfig({version:1,defaultProvider:"main",defaultModel:"writer",providers:{main:api("writer"),side:{...api("side-a"),models:[{id:"side-a"},{id:"side-stale"}]}}}));
  enableProfile(f.cwd,f.agentDir,"side");enableProfile(f.cwd,f.agentDir,"main");
  const live=loadAgentConfig(f.cwd).config;
  assert.deepEqual(Object.keys(live.providers).sort(),["main","side"],"both channels stay enabled together");
  assert.deepEqual(live.providers.side.models?.map(m=>m.id),["side-a"],"stale copy does not resurrect removed models");
  let current={provider:"main",id:"writer",name:"合成主演",thinkingLevel:"off",availableLevels:["off"]};
  const host={cwd:f.cwd,agentDir:()=>f.agentDir,isStreaming:()=>false,refreshModels:()=>{},notify:()=>{},listModels:()=>({current,models:[]}),selectModel:async(provider:string,id:string)=>{current={...current,provider,id};return current}} as unknown as RestHost;
  const edited={...live,providers:{...live.providers,side:{...live.providers.side,models:[{id:"side-a",contextWindow:4096}]}}};
  assert.equal((await request(host,"PUT","/api/agent-config",{config:edited})).status,200);
  assert.equal(loadProfile(f.cwd,"side")!.config.providers.side.models?.[0].contextWindow,4096,"owner profile follows live edit");
  enableProfile(f.cwd,f.agentDir,"main");
  assert.equal(loadAgentConfig(f.cwd).config.providers.side.models?.[0].contextWindow,4096,"re-enabling another profile keeps the edit");
 }finally{f.cleanup()}
});
