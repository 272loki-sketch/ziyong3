import assert from "node:assert/strict";import test from"node:test";import{mkdtempSync,rmSync,statSync,readdirSync,writeFileSync}from"node:fs";import{tmpdir}from"node:os";import{join}from"node:path";import{RequestJournal,captureSdkCall}from"../src/stage/request-journal.ts";

for (const resultOnly of [false, true]) test(`terminal provider failures and empty replies are truthful in ${resultOnly ? "result" : "iterator"} journal receipts`, async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-terminal-failure-")), scope = { sessionId: "synthetic", card: "synthetic" };
 try {
  const tool = { type: "toolCall", id: "synthetic-call", name: "synthetic_tool", arguments: {} };
  const cases = [
   { stopReason: "stop", content: [{ type: "text", text: "Provider finish_reason: content_filter" }] },
   { stopReason: "stop", content: [{ type: "text", text: "[ProxySystem Error] PROHIBITED_CONTENT" }] },
   { stopReason: "stop", content: [{ type: "text", text: '{"error":{"message":"Synthetic upstream error","code":503}}' }] },
   { stopReason: "stop", content: [] },
   { stopReason: "toolUse", content: [tool] },
   { stopReason: "stop", content: [{ type: "text", text: 'Synthetic story about an error and safety.' }] },
  ];
  for (const [index, final] of cases.entries()) {
   let calls = 0;
   const source = captureSdkCall(cwd, scope, `source-${index}`, "database.before", { provider: "fixture", id: "fixture" }, {}, {}, () => {
    calls++; return { async *[Symbol.asyncIterator]() { yield { type: "done", message: final }; }, result: async () => final };
   });
   if (!resultOnly) for await (const event of source) assert.equal(event.message, final);
   assert.equal(await source.result(), final);
   const row = new RequestJournal(cwd).list(scope, new Set([`source-${index}`]))[0];
   assert.equal(calls, 1);
   assert.equal(row.status, index < 4 ? "failed" : "success");
   if (index < 2) { assert.equal(row.failure?.kind, "content-filter"); assert.equal(row.failure?.origin, "provider"); }
   assert.equal(row.usageSource, "missing"); assert.equal(row.usage, undefined);
  }
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("journal records a stream without a terminal receipt as failed", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-missing-terminal-")), scope = { sessionId: "synthetic", card: "synthetic" };
 try {
  const source = captureSdkCall(cwd, scope, "source", "writer", {}, {}, {}, () => ({ async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "partial" }; } }));
  for await (const event of source) void event;
  assert.equal(new RequestJournal(cwd).list(scope, new Set(["source"]))[0].status, "failed");
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("journal preserves explicit rejection on error events and real usage on failed replies", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-error-event-")), scope = { sessionId: "synthetic", card: "synthetic" };
 try {
  const final = { stopReason: "stop", content: [{ type: "text", text: "Provider finish_reason: content_filter" }], usage: { input: 7 } };
  const source = captureSdkCall(cwd, scope, "source", "database.before", {}, {}, {}, () => ({ async *[Symbol.asyncIterator]() { yield { type: "error", error: final }; }, result: async () => final }));
  for await (const event of source) assert.equal(event.error, final);
  assert.equal(await source.result(), final);
  const row = new RequestJournal(cwd).list(scope, new Set(["source"]))[0];
  assert.equal(row.status, "failed"); assert.equal(row.failure?.kind, "content-filter");
  assert.deepEqual(row.usage, { input: 7 }); assert.equal(row.usageSource, "provider-sdk");
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("请求查看器捕获最终载荷，保存真实usage/墙钟，无估算且不保存鉴权Header",async()=>{const cwd=mkdtempSync(join(tmpdir(),"liyuan-requests-"));try{const scope={sessionId:"synthetic",card:"card"},context={systemPrompt:"Original",messages:[{role:"user",content:[{type:"text",text:"Full original input"}]}]};const source=captureSdkCall(cwd,scope,"user","writer",{id:"faux",provider:"faux"},context,{onPayload:(p:any)=>({...p,temperature:.5})},(_m,_c,o)=>{const msg={role:"assistant",content:[{type:"text",text:"actual"}],usage:{input:127,output:23,cacheRead:18,cacheWrite:0,totalTokens:168},stopReason:"stop"};return{async *[Symbol.asyncIterator](){await o.onPayload({messages:[{role:"user",content:"Full original input"}],headers:{authorization:"FAKE_PRIVATE"},tools:[{parameters:{properties:{apiKey:{type:"string"}}}}]},_m);yield{type:"text_delta",delta:"actual"};yield{type:"done",message:msg};},result:async()=>msg};});for await(const _ of source){}await source.result();const journal=new RequestJournal(cwd),rows=journal.list(scope,new Set(["user"]));assert.equal(rows.length,1);assert.equal(rows[0].capture,"api-payload");assert.equal((rows[0].payload as any).temperature,.5);assert.equal((rows[0].payload as any).tools[0].parameters.properties.apiKey.type,"string");assert.doesNotMatch(JSON.stringify(rows),/FAKE_PRIVATE/);assert.equal(rows[0].usage?.totalTokens,168);assert.ok(rows[0].durationMs!==undefined);assert.ok(rows[0].firstTokenMs!==undefined);assert.deepEqual(journal.list({sessionId:"sibling",card:"card"},new Set(["user"])),[]);assert.deepEqual(journal.list(scope,new Set(["sibling"])),[]);}finally{rmSync(cwd,{recursive:true,force:true});}});
test("缺失usage不伪造为0或字符估计，分支绑定后原payload仍完整",()=>{const cwd=mkdtempSync(join(tmpdir(),"liyuan-request-empty-"));try{const scope={sessionId:"s",card:"c"},journal=new RequestJournal(cwd),call=journal.begin({scope,groupId:"round",sourceEntryId:"user",phase:"writer",provider:"test",model:"test"},{messages:[]});call.payload({messages:[{role:"user",content:"全文"}]});call.end("success",{input:0,output:0});journal.bindGroup(scope,"round","reply");assert.equal(journal.list(scope,new Set(["user"])).length,0);const row=journal.list(scope,new Set(["reply"]))[0];assert.equal(row.usageSource,"missing");assert.equal(row.usage,undefined);assert.equal((row.payload as any).messages[0].content,"全文");}finally{rmSync(cwd,{recursive:true,force:true});}});
test("database before requests bind only to their own turn, after requests retain their source",()=>{
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-request-database-"));
 try {const scope={sessionId:"s",card:"c"},journal=new RequestJournal(cwd);
 for(const [phase,sourceEntryId] of [["database.before","user"],["database.before","other-user"],["database.after","old-reply"]])journal.begin({scope,sourceEntryId,phase,provider:"test",model:"test"},{}).end("success");
 journal.bindGroup(scope,"turn","reply","user",0);
 assert.equal(journal.list(scope,new Set(["reply"]))[0].phase,"database.before");
 assert.equal(journal.list(scope,new Set(["reply"])).length,1);
 assert.equal(journal.list(scope,new Set(["old-reply"]))[0].groupId,undefined);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

for (const resultOnly of [false, true]) test(`timed-out ${resultOnly ? "result" : "iterator"} persists local cause even when provider ignores abort`, async () => {
 const { createRequestDeadline } = await import("../src/request-budget.ts");
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-request-deadline-")), scope = { sessionId: "synthetic", card: "synthetic-card" };
 const deadline = createRequestDeadline(undefined, 20, "plot-selection", "合成选材"); let calls = 0;
 try {
  const source = captureSdkCall(cwd, scope, "synthetic-source", "dailyPlot", { provider: "fixture", id: "fixture" }, {}, { signal: deadline.signal }, () => {
   calls++; return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), result: () => new Promise(() => {}) };
  });
  await assert.rejects(resultOnly ? source.result() : source[Symbol.asyncIterator]().next(), /合成选材超时/);
  const row = new RequestJournal(cwd).list(scope, new Set(["synthetic-source"]))[0];
  assert.equal(calls, 1); assert.equal(row.status, "failed"); assert.equal(row.failure?.origin, "local-timeout"); assert.equal(row.failure?.timeoutScope, "plot-selection"); assert.equal(row.usageSource, "missing");
 } finally { deadline.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
test("provider 524 is not recorded as user cancellation or local deadline and never retries", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-request-524-")), scope = { sessionId: "synthetic", card: "synthetic-card" }; let calls = 0;
 try {
  const final = { stopReason: "error", errorMessage: "HTTP 524: origin read timeout", usage: { input: 0, output: 0 } };
  const source = captureSdkCall(cwd, scope, "synthetic-source", "dailyPlot", { provider: "fixture", id: "fixture" }, {}, {}, () => { calls++; return { async *[Symbol.asyncIterator]() { yield { type: "error", error: final }; }, result: async () => final }; });
  for await (const event of source) void event; await source.result();
  const row = new RequestJournal(cwd).list(scope, new Set(["synthetic-source"]))[0]; assert.equal(calls, 1); assert.equal(row.status, "failed"); assert.equal(row.failure?.origin, "provider"); assert.equal(row.failure?.statusCode, 524); assert.equal(row.usageSource, "missing");
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("final message remains available after successful request cleanup aborts its child signal", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-request-complete-")), scope = { sessionId: "synthetic", card: "synthetic-card" }, controller = new AbortController();
 try {
  const final = { stopReason: "stop", content: [{ type: "text", text: "synthetic complete" }], usage: { input: 1, output: 2 } };
  const source = captureSdkCall(cwd, scope, "synthetic-source", "writer", { provider: "fixture", id: "fixture" }, {}, { signal: controller.signal }, () => ({ async *[Symbol.asyncIterator]() { yield { type: "done", message: final }; }, result: async () => final }));
  for await (const event of source) { assert.equal(event.message, final); controller.abort(); }
  assert.equal(await source.result(), final); assert.equal(new RequestJournal(cwd).list(scope, new Set(["synthetic-source"]))[0].status, "success");
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("known non-streaming SDK transport projection corrects only the captured payload, never the live object", async () => {
 const { requestPayloadSnapshot } = await import("../src/stage/request-journal.ts");
 const payload = { stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "synthetic" }] };
 const captured = requestPayloadSnapshot(payload, { api: "openai-completions", compat: { streaming: false } }) as any;
 assert.equal(captured.stream, false); assert.equal(captured.stream_options, undefined); assert.equal(payload.stream, true); assert.ok(payload.stream_options);
 assert.equal(requestPayloadSnapshot(payload, { api: "openai-completions" }), payload);
 assert.equal(requestPayloadSnapshot(payload, { api: "different-api", compat: { streaming: false } }), payload);
});

test("only explicit pre-story plot root receipts are visible across the same story's branches", () => {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-root-receipts-")), scope={sessionId:"synthetic",card:"synthetic-card"};
 try {
  const journal=new RequestJournal(cwd);for(const phase of ["dailyPlot","plot.embedding","writer"]){journal.begin({scope,sourceEntryId:"root",phase,provider:"fixture",model:"fixture"},{}).end("success");}
  journal.begin({scope,sourceEntryId:"sibling-source",phase:"dailyPlot",provider:"fixture",model:"fixture"},{}).end("success");
  const visible=journal.list(scope,new Set(["current-source"]));assert.deepEqual(visible.map(r=>r.phase).sort(),["dailyPlot","plot.embedding"]);
  assert.equal(journal.detail(scope,new Set(),visible[0].id)?.id,visible[0].id);
  assert.equal(journal.list({sessionId:"other-story",card:scope.card},new Set()).length,0);
  assert.equal(journal.list({sessionId:scope.sessionId,card:"other-card"},new Set()).length,0);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});


test('first-token receipt is immediately readable while a request is still running and cannot mutate a closed call', () => {
 const cwd = mkdtempSync(join(tmpdir(), 'liyuan-live-first-token-'));
 try {
  const scope = { sessionId: 'synthetic-live', card: 'synthetic-card' }, journal = new RequestJournal(cwd);
  const call = journal.begin({ scope, sourceEntryId: 'synthetic-user', phase: 'writer', provider: 'fixture', model: 'fixture' }, {});
  call.first();
  const live = journal.list(scope, new Set(['synthetic-user']), false)[0];
  assert.equal(live.status, 'running');
  assert.equal(typeof live.firstTokenMs, 'number');
  assert.equal(journal.detail(scope, new Set(['synthetic-user']), call.id)?.firstTokenMs, live.firstTokenMs);
  call.first();
  call.end('success', { input: 1, output: 2, totalTokens: 3 }, 'stop');
  assert.equal(journal.list(scope, new Set(['synthetic-user']), false)[0].firstTokenMs, live.firstTokenMs);
  const cancelled = journal.begin({ scope, sourceEntryId: 'synthetic-user', phase: 'database.before', provider: 'fixture', model: 'fixture' }, {});
  cancelled.end('aborted');
  cancelled.first();
  assert.equal(journal.detail(scope, new Set(['synthetic-user']), cancelled.id)?.firstTokenMs, undefined);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});


test('a failed first-token journal write cannot interrupt the live model request', () => {
 const cwd = mkdtempSync(join(tmpdir(), 'liyuan-first-token-write-failure-'));
 try {
  const journal = new RequestJournal(cwd), scope = { sessionId: 'synthetic', card: 'synthetic' };
  const call = journal.begin({ scope, sourceEntryId: 'synthetic-user', phase: 'writer', provider: 'fixture', model: 'fixture' }, {});
  rmSync(journal.root, { recursive: true });
  writeFileSync(journal.root, 'Synthetic non-directory');
  assert.doesNotThrow(() => call.first());
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});
