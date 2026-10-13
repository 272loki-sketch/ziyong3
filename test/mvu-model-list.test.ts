import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TavernPluginHttp} from "../server/tavern-plugin-http.ts";
import {syntheticTavernPluginContext} from "../server/tavern-plugin-runtime.ts";
import {MVU_COMMIT} from "../server/mvu-assets.ts";

test("MVU original status shape: bound read-only managed discovery, no credentials or model calls",async()=>{
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-mvu-model-list-")),folder=join(cwd,".liyuan-tavern-plugins/mvu");
 mkdirSync(folder,{recursive:true});const bundle="SYNTHETIC_NOT_EXECUTED";
 writeFileSync(join(folder,"bundle.js"),bundle);
 writeFileSync(join(folder,"manifest.json"),JSON.stringify({version:1,commit:MVU_COMMIT,bundleSha256:createHash("sha256").update(bundle).digest("hex"),assets:{}}));
 writeFileSync(join(folder,"config.json"),JSON.stringify({enabled:true}));
 const context=syntheticTavernPluginContext(),model={provider:"synthetic",id:"parser",managedEndpoint:"https://managed.invalid/v1"};context.mvu={model};
 let calls=0,lists=0,helper=true;
 const api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>true,generate:async()=>{calls++;throw Error("NO_PAID_CALL");}});
 // Installation status is synthetic; no original runtime or production state is loaded.
 api.sources.status=()=>({plugins:[{id:"helper",enabled:helper,installed:helper}]} as any);
 const server=createServer((req,res)=>{void api.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 try{
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const binding=api.binding(),headers={"content-type":"application/json","x-liyuan-tavern-scope":binding.scopeKey,"x-liyuan-tavern-source":binding.sourceEntryId};
  const payload={chat_completion_source:"custom",custom_url:model.managedEndpoint,custom_include_headers:JSON.stringify({Authorization:"Bearer "}),model:model.id};
  const send=(data:unknown=payload,h:Record<string,string>=headers,path="/api/tavern-plugins/mvu/models")=>fetch(base+path,{method:"POST",headers:h,body:JSON.stringify(data)});
  const snapshot=JSON.stringify(context),config=readFileSync(join(folder,"config.json"),"utf8"),before=JSON.stringify(api.store.read(context));
  for(const h of [{},{...headers,"x-liyuan-tavern-source":"stale"},{...headers,"x-liyuan-tavern-scope":"stale"}])assert.equal((await send(payload,h)).status,409);
  let result=await send();assert.equal(result.status,200);assert.equal(result.headers.get("cache-control"),"no-store");assert.deepEqual(await result.json(),{data:[{id:"parser"}]});
  api.host.managedMvuModels=()=>{lists++;return [model,{...model,id:"second",apiKey:"SYNTHETIC_SECRET"},{...model,id:"second"},{...model,provider:"other",id:"wrong-provider"},{...model,managedEndpoint:"https://other.invalid/v1",id:"wrong-endpoint"}];};
  result=await send();assert.equal(result.status,200);const raw=await result.text();assert.deepEqual(JSON.parse(raw),{data:[{id:"parser"},{id:"second"}]});assert.doesNotMatch(raw,/SYNTHETIC_SECRET|managed\.invalid|provider|chat|mes/);
  assert.equal((await send({...payload,custom_url:undefined,reverse_proxy:model.managedEndpoint+"/",custom_include_headers:"{}"})).status,200);
  for(const extra of [{model:"writer"},{custom_url:"https://arbitrary.invalid/v1"},{custom_url:"https://user:password@managed.invalid/v1"},{custom_url:model.managedEndpoint+"?key=secret"},{chat_completion_source:"openai"},{custom_include_headers:JSON.stringify({Authorization:"Bearer SYNTHETIC_SECRET"})},{custom_include_headers:JSON.stringify({"x-api-key":"SYNTHETIC_SECRET"})},{proxy_password:"SYNTHETIC_SECRET"},{messages:[]},{apiKey:"SYNTHETIC_SECRET"}]){
   result=await send({...payload,...extra});assert.equal(result.status,400);assert.doesNotMatch(await result.text(),/SYNTHETIC_SECRET/);
  }
  assert.equal((await send(null)).status,400);
  helper=false;assert.equal((await send()).status,400);helper=true;
  context.mvu={};assert.equal((await send()).status,400);context.mvu={model};
  api.host.managedMvuModels=()=>[];assert.equal((await send()).status,400);
  api.host.managedMvuModels=()=>{context.mvu={model:{...model,id:"replacement"}};return [model];};assert.equal((await send()).status,409);context.mvu={model};
  // The legacy generic route is deliberately not broadened into a network proxy.
  assert.equal((await send(payload,headers,"/api/tavern-plugins/legacy/backends/chat-completions/status")).status,400);
  assert.equal(JSON.stringify(context),snapshot);assert.equal(JSON.stringify(api.store.read(context)),before);assert.equal(readFileSync(join(folder,"config.json"),"utf8"),config);assert.equal(readFileSync(join(folder,"bundle.js"),"utf8"),bundle);assert.equal(calls,0);assert.equal(lists,2);
 }finally{api.sources.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(cwd,{recursive:true,force:true});}
});
