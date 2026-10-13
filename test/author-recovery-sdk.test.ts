import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { streamSimple } from "@liyuan/ai/compat";
import { runAgentTurn } from "../src/stage/agent-turn.ts";

test("real compiled SDK continuation honors projected context, captures the actual output cap, and preserves original suffix bytes", async()=>{
 const requests:any[]=[];
 const server=createServer((req,res)=>{void(async()=>{
  let body="";for await(const part of req)body+=part;const payload=JSON.parse(body);requests.push(payload);
  const first=requests.length===1;
   const content=first?'他们准备好碗筷，饭还在锅里':requests.length===2?'{"suffix":':'<rule_check>合成原卡格式</rule_check><content>{"suffix":"。随后他们坐下一起吃完了饭。"}</content>';
  res.writeHead(200,{"content-type":"text/event-stream"});
  const base={id:"synthetic-stream",object:"chat.completion.chunk",model:"synthetic-author"};
  res.end(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:first?"length":"stop"}],usage:{prompt_tokens:123999,completion_tokens:20,total_tokens:124019}})}\n\ndata: [DONE]\n\n`);
 })().catch(error=>{res.writeHead(500);res.end(error.message)});});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const model={api:"openai-completions",provider:"synthetic-author",id:"synthetic-author",name:"Synthetic",baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,contextWindow:128000,maxTokens:16384,reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const result=await runAgentTurn({mode:"direct",systemPrompt:"合成测试系统材料",messages:[{role:"user",content:[{type:"text",text:"准备晚饭后一起吃"}],timestamp:0}],directorPrompt:"",readTools:[],read:async()=>({text:""}),experts:async()=>[],isCurrent:()=>true,outputRecoveryPrompt:'同一原作者续完本拍，只交JSON {"suffix":"接续片段"}',
   stream:(context,signal)=>{
    const requestBudget:{requestedMaxTokens:number;actualMaxTokens?:number}={requestedMaxTokens:16384};
    const source=streamSimple(model as never,context as never,{apiKey:"SYNTHETIC_NO_CLOUD_KEY",signal,maxTokens:16384,onPayload:(payload:any)=>{requestBudget.actualMaxTokens=payload.max_tokens;}} as never);
    return{requestBudget,[Symbol.asyncIterator]:()=>source[Symbol.asyncIterator](),result:()=>source.result()} as never;
   }});
  assert.equal(result.aborted,false,result.error);assert.equal(result.narrative,"他们准备好碗筷，饭还在锅里。随后他们坐下一起吃完了饭。");
   assert.equal(requests.length,3);assert.equal(requests[1].max_tokens,16384);assert.equal(result.workflow.writerCalls?.[1].actualMaxTokens,16384);
   assert.equal(requests[2].max_tokens,16384);
   assert.ok(requests[2].messages.some((m:any)=>m.role==="assistant"&&m.content==='{"suffix":'));
   assert.match(JSON.stringify(requests[2].messages),/validation_errors/);
   assert.match(JSON.stringify(requests[2].messages.at(-1).content),/优先于原格式输出合同/);
  assert.match(JSON.stringify(requests[1].messages),/准备晚饭后一起吃/);
  assert.equal(requests[1].messages.some((m:any)=>m.role==="tool"),false);assert.ok(requests[1].messages.some((m:any)=>m.role==="assistant"&&m.content.includes("饭还在锅里")));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
