import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer,request} from "node:http";
import {createHash} from "node:crypto";
import {TavernPluginHttp} from "../server/tavern-plugin-http.ts";
import {syntheticTavernPluginContext} from "../server/tavern-plugin-runtime.ts";
import {MVU_COMMIT,mvuStatus} from "../server/mvu-assets.ts";

test("MVU管理HTTP：只读来源状态、启停等待重载、忙碌冲突与慢请求重查",{timeout:20000},async()=>{
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-mvu-http-")),folder=join(cwd,".liyuan-tavern-plugins/mvu");let server:any,api:TavernPluginHttp|undefined;
 try{
  mkdirSync(folder,{recursive:true});const bundle="SYNTHETIC_ASSET_NOT_EXECUTED";writeFileSync(join(folder,"bundle.js"),bundle);writeFileSync(join(folder,"manifest.json"),JSON.stringify({version:1,commit:MVU_COMMIT,bundleSha256:createHash("sha256").update(bundle).digest("hex"),assets:{}}));
  const context=syntheticTavernPluginContext();let streaming=false,busy=false,models=0,changed=0,started:((req:any)=>void)|undefined;
  api=new TavernPluginHttp(cwd,{context:()=>structuredClone(context),isStreaming:()=>streaming,mvuBusy:()=>busy,generate:async()=>{models++;throw Error("NO_MODEL_CALL_ALLOWED");}});
  const saved=api.store.read(context);saved.state.messages[context.sourceEntryId]={variables:[{stat_data:{root:"PRIVATE_SYNTHETIC_VALUE"}}]};api.store.save(context,saved.revision,saved.state,()=>{});const before=JSON.stringify(api.store.read(context));
  server=createServer((req,res)=>{void api!.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});started?.(req);});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const base=`http://127.0.0.1:${server.address().port}`;
  const view=await(await fetch(base+"/api/tavern-plugins/mvu/view")).json();assert.deepEqual(view.binding,{scopeKey:api.binding().scopeKey,sourceEntryId:context.sourceEntryId});assert.equal(view.variables.rootCount,1);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_SYNTHETIC_VALUE/);assert.equal(JSON.stringify(api.store.read(context)),before);assert.equal(models,0);
  let release!:()=>void;const reload=new Promise<void>(resolve=>{release=resolve;});api.onMvuChanged=async()=>{changed++;await reload;};let finished=false;
  const pending=fetch(base+"/api/tavern-plugins/mvu",{method:"PUT",body:JSON.stringify({enabled:true})}).then(async response=>{finished=true;return response.json();});while(!changed)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(finished,false,"response must await real runtime close/reload");release();assert.equal((await pending).enabled,true);
  const config=readFileSync(join(folder,"config.json"),"utf8");for(const mode of ["streaming","busy"]){streaming=mode==="streaming";busy=mode==="busy";const response=await fetch(base+"/api/tavern-plugins/mvu",{method:"PUT",body:'{"enabled":false}'});assert.equal(response.status,409);assert.match((await response.json()).error,/请稍后/);assert.equal(readFileSync(join(folder,"config.json"),"utf8"),config);}streaming=false;busy=false;
  // Generation may start while the request body is arriving: check again immediately before writing.
  let ready!:()=>void;const began=new Promise<void>(resolve=>{ready=resolve;});started=req=>{if(req.method==="PUT")ready();};const response=new Promise<{status:number;body:any}>((resolve,reject)=>{
   const req=request(base+"/api/tavern-plugins/mvu",{method:"PUT",headers:{"content-type":"application/json","transfer-encoding":"chunked"}},res=>{let raw="";res.on("data",chunk=>raw+=chunk);res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(raw)}));});req.on("error",reject);req.flushHeaders();req.write('{"enabled":');void began.then(()=>{busy=true;req.end('false}');});
  });assert.equal((await response).status,409);assert.equal(readFileSync(join(folder,"config.json"),"utf8"),config);busy=false;started=undefined;
  api.onMvuChanged=async()=>{throw Error("synthetic runtime close failure");};const failed=await fetch(base+"/api/tavern-plugins/mvu",{method:"PUT",body:'{"enabled":false}'});assert.equal(failed.status,500);assert.match((await failed.json()).error,/开关已保存.*刷新状态核对/);assert.equal(mvuStatus(cwd).enabled,false,"partial success must remain visible, no fake rollback");assert.equal(JSON.stringify(api.store.read(context)),before);assert.equal(models,0);
 }finally{api?.sources.close();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(resolve));}rmSync(cwd,{recursive:true,force:true});}
});
