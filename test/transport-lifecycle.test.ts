import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@liyuan/ai/api/openai-completions";
import { RequestJournal, captureSdkCall } from "../src/stage/request-journal.ts";

test("actual HTTP receipts distinguish pre-fetch failure, inferred status, headers, bytes and effective deltas", {timeout:15000}, async () => {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-transport-")),scope={sessionId:"synthetic",card:"synthetic"};let received=0;
 const server=createServer((req,res)=>{void(async()=>{
  let body="";for await(const chunk of req)body+=chunk;received++;const payload=JSON.parse(body);
  assert.equal(req.headers["x-client-request-id"],undefined);
  if(payload.model==="524"){res.writeHead(524,{"x-request-id":"synthetic:524","set-cookie":"DO_NOT_RECORD"});res.end('{"error":{"message":"Synthetic failure"}}');return;}
  if(!payload.stream){res.writeHead(200,{"content-type":"application/json"});res.flushHeaders();await new Promise(resolve=>setTimeout(resolve,40));res.end(JSON.stringify({id:"synthetic",choices:[{index:0,message:{role:"assistant",content:"Synthetic JSON"},finish_reason:"stop"}]}));return;}
  await new Promise(resolve=>setTimeout(resolve,30));
  res.writeHead(200,{"content-type":"text/event-stream","x-request-id":"synthetic-ok"});res.flushHeaders();
  const send=(delta:unknown,finish_reason:string|null=null)=>res.write(`data: ${JSON.stringify({id:"synthetic",choices:[{index:0,delta,finish_reason}]})}\n\n`);
  send({role:"assistant",content:""});
  if(payload.model==="hold")return;
  await new Promise(resolve=>setTimeout(resolve,60));send({content:"Synthetic reply"},"stop");res.end("data: [DONE]\n\n");
 })().catch(error=>res.destroy(error));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const model={api:"openai-completions" as const,provider:"synthetic",id:"ok",name:"Synthetic",baseUrl:`http://127.0.0.1:${address.port}/v1`,reasoning:false,input:["text" as const],contextWindow:128000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const context={messages:[{role:"user" as const,content:"Synthetic input",timestamp:0}]};
 const run=async(id:string,options:Record<string,unknown>={})=>{const source=captureSdkCall(cwd,scope,id,"writer",{...model,id},context,{apiKey:"synthetic",maxRetries:0,signal:AbortSignal.timeout(2000),...options},streamSimple);for await(const event of source)void event;return source.result();};
 const row=(id:string)=>new RequestJournal(cwd).list(scope,new Set([id]),false)[0];
 try{
  await run("guard",{onPayload:()=>{throw Error("HTTP 524: pre-send synthetic");}});
  assert.equal(received,0);assert.equal(row("guard").failure?.statusCode,524);assert.equal(row("guard").transport,undefined);
  await run("524");assert.equal(received,1);assert.equal(row("524").transport?.find(e=>e.type==="responseHeaders")?.status,524);
  await run("ok",{onTransport:()=>{throw Error("Diagnostic consumer failure");}});
  assert.equal(received,2);const receipts=row("ok").transport!;
  for(const type of ["transportStarted","responseHeaders","firstByte","firstEffectiveDelta","bodyEnd"])assert.equal(receipts.filter(e=>e.type===type).length,1);
  assert.equal(new Set(receipts.map(e=>e.traceId)).size,1);
  assert.ok(receipts.find(e=>e.type==="firstEffectiveDelta")!.elapsedMs-receipts.find(e=>e.type==="firstByte")!.elapsedMs>=30);
  assert.doesNotMatch(JSON.stringify(row("524")),/DO_NOT_RECORD|127\.0\.0\.1|Bearer/);
  const jsonSource=captureSdkCall(cwd,scope,"json","writer",{...model,compat:{streaming:false}},context,{apiKey:"synthetic",maxRetries:0},streamSimple);
  assert.equal((await jsonSource.result()).stopReason,"stop");
  const jsonReceipts=row("json").transport!;assert.ok(jsonReceipts.find(e=>e.type==="firstByte")!.elapsedMs-jsonReceipts.find(e=>e.type==="responseHeaders")!.elapsedMs>=20);
  const controller=new AbortController();const held=run("hold",{signal:controller.signal});
  while(!row("hold")?.transport?.some(e=>e.type==="firstByte"))await new Promise(resolve=>setTimeout(resolve,10));
  controller.abort();await assert.rejects(held);assert.equal(received,4);assert.equal(row("hold").transport?.some(e=>e.type==="firstEffectiveDelta"),false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(cwd,{recursive:true,force:true});}
 });

test("SDK consumes content after a finish chunk and preserves an unclosed format tail byte-for-byte", async () => {
 const chunks = ["<content>Complete synthetic story.</content>\n", "<options>\n1. Choice.", "\n2. Another choice."];
 const server = createServer(async (req, res) => {
  for await (const _ of req) void _;
  res.writeHead(200, {"content-type":"text/event-stream"});
  for (const [i, content] of chunks.entries()) res.write(`data: ${JSON.stringify({id:"synthetic",choices:[{index:0,delta:{content},finish_reason:i===0?"stop":null}]})}\n\n`);
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
 const address = server.address(); assert.ok(address && typeof address !== "string");
 try {
  const source = streamSimple({api:"openai-completions",provider:"synthetic",id:"synthetic",name:"Synthetic",baseUrl:`http://127.0.0.1:${address.port}/v1`,reasoning:false,input:["text"],contextWindow:128000,maxTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}, {messages:[{role:"user",content:"Synthetic input",timestamp:0}]}, {apiKey:"synthetic",maxTokens:16384,signal:AbortSignal.timeout(5000)});
  let deltas = "";
  for await (const event of source) if(event.type === "text_delta") deltas += event.delta;
  const result = await source.result();
  assert.equal(result.stopReason,"stop");
  assert.equal(deltas,chunks.join(""));
  assert.equal(result.content.filter(c=>c.type==="text").map(c=>c.text).join(""),deltas);
 } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
