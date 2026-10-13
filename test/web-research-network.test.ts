import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { researchNetworkEnvironment } from "../server/web-research-network.ts";
import { resolveWebResearchProxy } from "../server/web-research.ts";
import { sourceReaderTransport } from "../server/web-source-reader.ts";

function fixture(run: (cwd:string,file:string)=>void){const cwd=mkdtempSync(join(tmpdir(),"research-network-"));mkdirSync(join(cwd,".liyuan-research"));try{run(cwd,join(cwd,".liyuan-research","network.json"));}finally{rmSync(cwd,{recursive:true,force:true});}}
test("no local route configuration preserves the explicit environment proxy and model settings",()=>fixture((cwd)=>{
 const env={LIYUAN_WEB_RESEARCH_PROXY:"http://127.0.0.1:7890",HTTPS_PROXY:"http://model.test:9000",MODEL_KEY:"synthetic-no-network"};
 assert.equal(researchNetworkEnvironment(cwd,env),env);
}));
test("authorized direct route overrides research only without mutating environment or model proxy",()=>fixture((cwd,file)=>{
 const env={LIYUAN_WEB_RESEARCH_PROXY:"http://127.0.0.1:7890",HTTPS_PROXY:"http://model.test:9000",MODEL_KEY:"synthetic-no-network"},before=JSON.stringify(env);
 writeFileSync(file,JSON.stringify({version:1,route:"direct"}));const selected=researchNetworkEnvironment(cwd,env);
 assert.equal(resolveWebResearchProxy(selected),null);assert.equal(sourceReaderTransport(selected).proxy(),null);
 assert.equal(selected.HTTPS_PROXY,env.HTTPS_PROXY);assert.equal(selected.MODEL_KEY,env.MODEL_KEY);assert.equal(JSON.stringify(env),before);
}));
test("explicit environment route preserves proxy authentication and does not silently fall back",()=>fixture((cwd,file)=>{
 const env={LIYUAN_WEB_RESEARCH_PROXY:"http://synthetic:credential@proxy.test:7890"};writeFileSync(file,JSON.stringify({version:1,route:"environment"}));
 const selected=researchNetworkEnvironment(cwd,env);assert.equal(selected,env);assert.equal(sourceReaderTransport(selected).proxy()?.hostname,"proxy.test");
}));
test("malformed or untrusted network files fail closed instead of changing routes",()=>fixture((cwd,file)=>{
 for(const value of ["{",JSON.stringify({version:1,route:"automatic"}),JSON.stringify({version:1,route:"direct",apiKey:"synthetic"}),JSON.stringify(["direct"]),"x".repeat(4097)]){
  writeFileSync(file,value);assert.throws(()=>researchNetworkEnvironment(cwd));
 }
 rmSync(file);const outside=join(cwd,"outside.json");writeFileSync(outside,JSON.stringify({version:1,route:"direct"}));symlinkSync(outside,file);assert.throws(()=>researchNetworkEnvironment(cwd),/来源无效/);
}));

test("research direct requests use a fresh native HTTPS connection and preserve the route on redirects",async t=>{
 const https=(await import("node:https")).default,{EventEmitter}=await import("node:events"),{requestText}=await import("../server/web-research.ts");
 const calls:Array<{url:string;agent:unknown;verify:unknown}>=[];
 t.mock.method(https,"request",(url:URL,options:any,callback:(response:any)=>void)=>{
  calls.push({url:url.href,agent:options.agent,verify:options.rejectUnauthorized});const req=new EventEmitter()as any;
  req.destroy=()=>{};req.end=()=>{queueMicrotask(()=>{
   const response=new EventEmitter()as any;response.complete=true;response.destroy=()=>{};
   response.statusCode=calls.length===1?302:200;response.headers=calls.length===1?{location:"https://cn.bing.com/search?q=public"}:{};
   callback(response);if(response.statusCode===200){response.emit("data",Buffer.from("synthetic direct result"));response.emit("end");}
  });};return req;
 });
 const env={LIYUAN_WEB_RESEARCH_PROXY:"direct",HTTPS_PROXY:"http://unreachable-model.test:9000"};
 assert.equal(await requestText(new URL("https://www.bing.com/search?q=public"),AbortSignal.timeout(2000),2,env),"synthetic direct result");
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.agent===false&&c.verify===true));assert.equal(env.HTTPS_PROXY,"http://unreachable-model.test:9000");
});


test("source-reader NO_PROXY follows the same scoped environment as its proxy resolver",()=>{
 const selected=sourceReaderTransport({LIYUAN_WEB_RESEARCH_PROXY:"http://proxy.test:7890",NO_PROXY:".primary.test"});
 assert.equal(selected.useProxy!("docs.primary.test",selected.proxy()!),false);
 assert.equal(selected.useProxy!("other.test",selected.proxy()!),true);
});
