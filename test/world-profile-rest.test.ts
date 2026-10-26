import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { handleApiRequest, type RestHost } from "../server/rest.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { defaultCardWorldProfile, loadCardWorldProfile, manifestFromProfile, saveCardWorldProfile, worldProfileFingerprint, worldProfilePath } from "../src/stage/literary-world-profile.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

function fixture() {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-world-rest-"));
 writeFileSync(join(cwd,"card.json"), JSON.stringify({data:{name:"合成卡",description:"初始设定"}}));
 writeFileSync(join(cwd,"liyuan.config.json"),JSON.stringify({card:"card.json",literaryWorldEnabled:true}));
 cpSync(new URL("../skills/", import.meta.url),join(cwd,"skills"),{recursive:true});
 const branch:BranchEntryLike[]=[{id:"binding",type:"custom",customType:"rp-card",data:{card:"card.json"}},{id:"user",type:"message",message:{role:"user",content:"继续合成场景"}},{id:"author",type:"message",message:{role:"assistant",details:{rpNarrative:"合成故事已保存。"},content:"合成故事已保存。"}}];
 let busy=false,sessionId="session-a",calls=0;
 const host={cwd,isStreaming:()=>busy,worldProfileContext:()=>({sessionId,card:"card.json",leafId:branch.at(-1)?.id??null,branch}),runSideText:async()=>{calls++;return JSON.stringify({digest:"合成世界适配",modules:[]});},appendWorldManifest:(data:unknown)=>branch.push({id:"manifest-"+branch.length,type:"custom",customType:"rp-world-manifest",data})} as unknown as RestHost;
 return {cwd,host,branch,setBusy:(v:boolean)=>{busy=v},setSession:(v:string)=>{sessionId=v},calls:()=>calls,cleanup:()=>rmSync(cwd,{recursive:true,force:true})};
}
async function request(host:RestHost,method:string,url:string,payload?:unknown){
 const req=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]) as Readable &{method:string;url:string};req.method=method;req.url=url;
 let status=0,text="";const headers:Record<string,string>={};
 const res={setHeader:(k:string,v:string)=>{headers[k]=v},writeHead:(c:number)=>{status=c},end:(v="")=>{text+=v}};
 assert.equal(await handleApiRequest(req as never,res as never,host),true);return {status,body:JSON.parse(text),headers};
}
test("world profile REST：建立、读取、重分析和笔记保存使用实际拍数，旧素材变化不被笔记保存抹掉",async()=>{
 const f=fixture();try{
  const result=await request(f.host,"POST","/api/world-profile/analyze",{});assert.equal(result.status,200);assert.equal(result.body.profile.analyzedTurns,1);assert.equal(result.body.manifestApplied,true);
  const first=await request(f.host,"GET","/api/world-profile");assert.equal(first.body.profile.digest,"合成世界适配");assert.equal(first.body.materialsChanged,false);
  writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify({card:"card.json",literaryWorldEnabled:true,greetingIndex:1}));
  assert.equal((await request(f.host,"GET","/api/world-profile")).body.materialsChanged,true);
  assert.equal((await request(f.host,"PUT","/api/world-profile",{userRequirements:["长期要求"]})).status,200);
  assert.equal((await request(f.host,"GET","/api/world-profile")).body.materialsChanged,true);
  const again=await request(f.host,"POST","/api/world-profile/analyze",{});assert.equal(again.status,200);assert.deepEqual(again.body.profile.userRequirements,["长期要求"]);
  assert.equal((await request(f.host,"GET","/api/world-profile")).body.materialsChanged,false);
 }finally{f.cleanup()}
});
test("world profile REST：一次分析只能运行一个，模型/思考元数据不伪装切支",async()=>{
 const f=fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r});
 try{f.host.runSideText=async()=>{await gate;return JSON.stringify({digest:"完整画像",modules:[]})};
  const running=request(f.host,"POST","/api/world-profile/analyze",{});await new Promise(r=>setImmediate(r));
  assert.equal((await request(f.host,"GET","/api/world-profile")).body.analyzing,true);
  assert.equal((await request(f.host,"POST","/api/world-profile/analyze",{})).status,409);
  assert.equal((await request(f.host,"PUT","/api/world-profile",{status:"stable"})).status,409);
  f.branch.push({id:"model-meta",type:"model_change"});release();assert.equal((await running).status,200);
 }finally{release?.();f.cleanup()}
});
for(const kind of ["session","branch","material","retry"] as const)test(`world profile REST：${kind}漂移必须拒绝，非流式重试后也重新核验来源`,async()=>{
 const f=fixture();let calls=0;try{
  f.host.runSideText=async()=>{
   calls++;
   if(kind==="retry"&&calls===1)return "```";
   if(kind==="session")f.setSession("session-b");
   if(kind==="branch"||kind==="retry")f.branch.push({id:"another-user",type:"message",message:{role:"user",content:"新输入"}});
   if(kind==="material")writeFileSync(join(f.cwd,"card.json"),JSON.stringify({name:"合成卡",description:"途中修改"}));
   return JSON.stringify({digest:"过期候选",modules:[]});
  };
  const result=await request(f.host,"POST","/api/world-profile/analyze",{});assert.equal(result.status,400);assert.match(result.body.error,/变化/);
  assert.equal(f.branch.some(e=>e.customType==="rp-world-manifest"),false);
  const m=loadStageMaterials(f.cwd);assert.equal(existsSync(worldProfilePath(f.cwd,m.config.card,m.card)),false);
 }finally{f.cleanup()}
});
test("world profile REST：同卡旧画像可见且重分析维持原世界身份，不丢历史用户要求",async()=>{
 const f=fixture();try{
  const old=loadStageMaterials(f.cwd),fingerprint=worldProfileFingerprint(old),profile=defaultCardWorldProfile(f.cwd,"card.json",old.card.name,fingerprint,old.card);
  profile.userRequirements=["保留原要求"];profile.revision=3;saveCardWorldProfile(f.cwd,"card.json",profile,old.card);
  f.branch.push({id:"old-manifest",type:"custom",customType:"rp-world-manifest",data:manifestFromProfile(profile)});
  writeFileSync(join(f.cwd,"card.json"),JSON.stringify({name:"合成卡",description:"修订后内容"}));
  const current=await request(f.host,"GET","/api/world-profile");assert.equal(current.body.profile.cardKey,profile.cardKey);assert.equal(current.body.materialsChanged,true);
  const again=await request(f.host,"POST","/api/world-profile/analyze",{});assert.equal(again.status,200);assert.equal(again.body.profile.cardKey,profile.cardKey);assert.deepEqual(again.body.profile.userRequirements,profile.userRequirements);assert.equal(again.body.profile.revision,4);
  assert.equal((await request(f.host,"GET","/api/world-profile")).body.materialsChanged,false);
 }finally{f.cleanup()}
});

test("world profile REST：模型失败保留旧画像和当前分支，不用默认空画像冒充分析成功",async()=>{
 const f=fixture();try{
  await request(f.host,"POST","/api/world-profile/analyze",{});
  const m=loadStageMaterials(f.cwd),file=worldProfilePath(f.cwd,"card.json",m.card),before=readFileSync(file,"utf8"),count=f.branch.length;
  f.host.runSideText=async()=>({error:"合成403额度不足"});
  const result=await request(f.host,"POST","/api/world-profile/analyze",{});assert.equal(result.status,400);assert.match(result.body.error,/403/);
  assert.equal(readFileSync(file,"utf8"),before);assert.equal(f.branch.length,count);assert.equal((await request(f.host,"GET","/api/world-profile")).body.analyzing,false);
  f.host.runSideText=async()=>"{}";assert.equal((await request(f.host,"POST","/api/world-profile/analyze",{})).status,400);assert.equal(readFileSync(file,"utf8"),before);
 }finally{f.cleanup()}
});

test("world profile REST：手动清空笔记有效，但保存设置不能创建未分析的默认画像",async()=>{
 const f=fixture();try{
  assert.equal((await request(f.host,"PUT","/api/world-profile",{status:"stable"})).status,400);
  await request(f.host,"POST","/api/world-profile/analyze",{});
  await request(f.host,"PUT","/api/world-profile",{userRequirements:["测试要求"],optimizationNotes:["测试笔记"]});
  const result=await request(f.host,"PUT","/api/world-profile",{userRequirements:[],optimizationNotes:[]});assert.equal(result.status,200);assert.deepEqual(result.body.profile.userRequirements,[]);assert.deepEqual(result.body.profile.optimizationNotes,[]);
 }finally{f.cleanup()}
});

test("world profile REST：显式卡字段编辑继承世界身份，新会话仍读到画像而素材需复核",async()=>{
 const f=fixture();try{
  await request(f.host,"POST","/api/world-profile/analyze",{});const old=(await request(f.host,"GET","/api/world-profile")).body.profile;
  f.host.softRefreshConfig=async()=>{};
  const edit=await request(f.host,"PUT","/api/card",{description:"通过原有管理接口修订"});assert.equal(edit.status,200);
  const after=await request(f.host,"GET","/api/world-profile");assert.equal(after.body.profile.cardKey,old.cardKey);assert.equal(after.body.materialsChanged,true);
  const m=loadStageMaterials(f.cwd);assert.equal(loadCardWorldProfile(f.cwd,"card.json",m.card.name,"",m.card)?.cardKey,old.cardKey,"new session needs no old branch");
 }finally{f.cleanup()}
});
