import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabasePluginRuntime } from "../server/database-plugin-runtime.ts";

test("private database runtime binds its server adapter despite a stale static host", { timeout: 15000, skip: !process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE }, async () => {
 const director = { systemPrompt: "SYNTHETIC_DIRECTOR", userText: "SYNTHETIC_REFERENCE" };
 const candidate = '{"candidateBeats":[]}';
 let staleRequests = 0, modelRequests = 0;
 const context = { scopeKey: "synthetic", sourceEntryId: "synthetic-user", revision: 0, scope: { sessionId: "synthetic" }, chat: [], chatMetadata: {}, extensionSettings: {}, worldbooks: { Synthetic: { entries: [] } }, primaryBook: "Synthetic", character: { name: "Synthetic" }, userName: "User" };
 const server = createServer((req, res) => { void (async () => {
  const path = new URL(req.url!, "http://localhost").pathname;
  res.setHeader("content-type", "application/json");
  if (path === "/database-plugin-host.html") {
   res.setHeader("content-type", "text/html");res.end(readFileSync(new URL("../web/public/database-plugin-host.html", import.meta.url)));return;
  }
  if (path === "/database-plugin-host.js") { staleRequests++;res.setHeader("content-type", "application/javascript");res.end("throw Error('stale static adapter');");return; }
  if (path.endsWith("jquery.min.js")) { res.setHeader("content-type", "application/javascript");res.end("");return; }
  if (path.endsWith("source/index.js")) {
   res.setHeader("content-type", "application/javascript");
   res.end(`const ctx=window.SillyTavern.getContext();
    window.AutoCardUpdaterAPI={triggerUpdate:async()=>{},refreshDataAndWorldbook:async()=>{}};
    window.AutoCardUpdaterV2API={};
    ctx.eventSource.on('CHAT_CHANGED',()=>window.setTimeout(async()=>{},1200));
    const capture=window.TavernHelper.generate;
    window.TavernHelper.generate=async params=>{const reply=await window.TavernHelper.generateRaw({ordered_prompts:[{role:'user',content:'SYNTHETIC_NATIVE'}]});if(reply!=='<recall>AM0001</recall>')throw Error('native reply corrupted');return capture({...params,user_input:params.user_input+reply,_qrf_processed_by_hook:true});};`);return;
  }
  if (path.endsWith("/context")) { res.end(JSON.stringify(context));return; }
  if (path.endsWith("/generate")) {
   let raw="";for await (const chunk of req) raw+=chunk;
   const body=JSON.parse(raw);modelRequests++;
   assert.equal(body.purpose,"recall");assert.equal(body.prompts.length,3);
   assert.equal(body.prompts[1].content,director.systemPrompt);
   assert.ok(body.prompts[2].content.includes(director.userText));
   res.end(JSON.stringify({text:'<recall>AM0001</recall><liyuan_literary_direction>'+candidate+'</liyuan_literary_direction>'}));return;
  }
  res.statusCode=404;res.end("{}");
 })().catch(error=>{res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}); });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const http={root:"/synthetic-not-a-cache",internalToken:"synthetic",currentContext:()=>context,scopeKey:()=>context.scopeKey,managedPresets:()=>[],sources:{readCurrentPinnedJS(){}},assertBinding(){}};
 const runtime=new DatabasePluginRuntime(http as any,()=>`http://127.0.0.1:${(server.address() as any).port}`);
 try {
  const prepared=await runtime.before("Synthetic input",undefined,director);
  assert.equal(prepared.literaryDirectorHandled,true);assert.equal(prepared.literaryDirection,candidate);
  assert.equal(prepared.userInput,"Synthetic input<recall>AM0001</recall>");
  assert.equal(modelRequests,1);assert.equal(staleRequests,0);
 } finally { await runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
