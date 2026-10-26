import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@liyuan/ai/compat";
import { createDatabasePluginGenerator } from "../server/database-plugin-generation.ts";
import { captureSdkCall, RequestJournal } from "../src/stage/request-journal.ts";

test("managed database connect timeout stays a transport failure after a sibling completes, without aborting the parent or retrying", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-database-connect-timeout-"));
 const parent = new AbortController(), scope = { sessionId: "synthetic-connect", card: "synthetic-card" };
 const signals: AbortSignal[] = [], budgets: number[] = [];
 let requests = 0, release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const model: any = { id: "synthetic", provider: "synthetic", api: "openai-completions", baseUrl: "https://synthetic.invalid/v1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { streaming: false, supportsDeveloperRole: false, supportsReasoningEffort: false } };
 t.mock.method(globalThis, "fetch", async (input: any, init: RequestInit) => {
  assert.equal(String(input), "https://synthetic.invalid/v1/chat/completions");
  requests++;
  const payload = JSON.parse(String(init.body));
  const content = payload.messages.at(-1).content;
  if ((typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("")) === "Synthetic failing connection") {
   await gate;
   const cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
   throw new TypeError("fetch failed", { cause });
  }
  return new Response(JSON.stringify({ id: "synthetic-reply", object: "chat.completion", model: "synthetic", choices: [{ index: 0, message: { role: "assistant", content: "Synthetic complete table" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }), { headers: { "content-type": "application/json" } });
 });
 const generate = createDatabasePluginGenerator({ findModel: () => model, defaultModel: () => model, analysisTimeoutMinutes: () => 10, auth: async () => ({ ok: true, apiKey: "SYNTHETIC_LOCAL_ONLY_KEY" }), stream: (m, context, options) => {
  signals.push(options.signal!); budgets.push(options.timeoutMs!);
  return captureSdkCall(cwd, scope, "synthetic-author", "database.after", m, context, options, streamSimple as any);
 } });
 const failed = generate([{ role: "user", content: "Synthetic failing connection" }], parent.signal);
 const rejected = assert.rejects(failed, /Request timed out/);
 try {
  await generate([{ role: "user", content: "Synthetic sibling" }], parent.signal);
  assert.equal(parent.signal.aborted, false);
  assert.ok(signals.every(signal => !signal.aborted), "terminal cleanup must not abort a sibling or the shared parent");
  release(); await rejected;
  const rows = new RequestJournal(cwd).list(scope, new Set(["synthetic-author"]), false);
  const failure = rows.find(row => row.status === "failed")!;
  assert.equal(failure.failure?.origin, "sdk"); assert.equal(failure.failure?.kind, "timeout");
  assert.deepEqual(failure.transport?.map(event => [event.type, event.errorCode]), [["transportStarted", undefined], ["transportError", "UND_ERR_CONNECT_TIMEOUT"]]);
  assert.equal(failure.usageSource, "missing"); assert.equal(failure.firstTokenMs, undefined);
  assert.equal(parent.signal.aborted, false); assert.ok(signals.every(signal => !signal.aborted));
  assert.deepEqual(budgets, [600000, 600000]); assert.equal(requests, 2, "no hidden timeout retry");
 } finally { release(); await failed.catch(() => {}); t.mock.restoreAll(); rmSync(cwd, { recursive: true, force: true }); }
});

// Synthetic localhost only: never send production stories, credentials or plugin material.
test("managed database HTTP 504 is visible immediately; a subsequent native attempt can stream and record first token before completion", { timeout: 5000 }, async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-database-http-stall-"));
 const scope = { sessionId: "synthetic-stall", card: "synthetic-card" }, visible = new Set(["synthetic-user"]);
 const journal = new RequestJournal(cwd), activity: string[] = [];
 let requests = 0, finish: (() => void) | undefined;
 const parent = new AbortController(), requestErrors: unknown[] = [];
 const server = createServer((req, res) => { void (async () => {
  requests++;
  assert.equal(req.headers.authorization, "Bearer SYNTHETIC_LOCAL_ONLY_KEY");
  let raw = ""; for await (const part of req) raw += part;
  const payload = JSON.parse(raw);
  const content = payload.messages.at(-1).content;
  assert.equal(Array.isArray(content) ? content.map((part: any) => part.text ?? "").join("") : content, "Synthetic unchanged recall");
  if (requests === 1) {
   res.writeHead(504, { "content-type": "text/html" });
   res.end("<html><title>504 Gateway Time-out</title><p>nginx synthetic fixture</p></html>");
   return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (choices: any[], usage?: object) => `data: ${JSON.stringify({ id: "synthetic-stream", object: "chat.completion.chunk", model: "synthetic", choices, ...(usage ? { usage } : {}) })}\n\n`;
  res.write(chunk([{ index: 0, delta: { role: "assistant", content: "Synthetic recall result" }, finish_reason: null }]));
  finish = () => {
   if (res.writableEnded || res.destroyed) return;
   res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
   res.write(chunk([], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }));
   res.end("data: [DONE]\n\n");
  };
 })().catch(error => { requestErrors.push(error); res.writeHead(500); res.end("Synthetic fixture failure"); }); });
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 const model: any = {
  id: "synthetic", provider: "synthetic", api: "openai-completions",
  baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
  reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
 };
 const generate = createDatabasePluginGenerator({
  findModel: () => model, defaultModel: () => model,
  auth: async () => ({ ok: true, apiKey: "SYNTHETIC_LOCAL_ONLY_KEY" }),
  onActivity: detail => activity.push(detail),
  stream: (m, context, options) => captureSdkCall(cwd, scope, "synthetic-user", "database.before", m, context, options, streamSimple as any),
 });
 let pending: ReturnType<typeof generate> | undefined;
 try {
  const prompts = [{ role: "user", content: "Synthetic unchanged recall" }];
  await assert.rejects(generate(prompts, parent.signal, { purpose: "recall" }), /504.*Gateway Time-out/);
  assert.equal(requests, 1, "the adapter must not add its own hidden retry layer");
  const failed = journal.list(scope, visible, false)[0];
  assert.equal(failed.failure?.origin, "provider");
  assert.equal(failed.failure?.statusCode, 504);
  assert.ok(activity.some(detail => /失败.*504/.test(detail)));
  // Simulate the unchanged plugin making its next attempt after seeing the failure.
  pending = generate(prompts, parent.signal, { purpose: "recall" });
  for (let i = 0; i < 200; i++) {
   if (journal.list(scope, visible, false).some(row => row.status === "running" && row.firstTokenMs !== undefined)) break;
   await new Promise(resolve => setTimeout(resolve, 5));
  }
  const live = journal.list(scope, visible, false).find(row => row.status === "running");
  assert.equal(typeof live?.firstTokenMs, "number");
  assert.equal(live?.usageSource, "missing", "do not invent usage before the provider receipt");
  assert.equal(requests, 2);
  assert.ok(finish); finish();
  const reply = await pending;
  assert.equal(reply.choices[0].message.content, "Synthetic recall result");
  const success = journal.list(scope, visible, false).find(row => row.status === "success");
  assert.equal(success?.firstTokenMs, live?.firstTokenMs);
  assert.equal(success?.usageSource, "provider-sdk");
  assert.equal(success?.usage?.totalTokens, 14);
  assert.equal(activity.filter(detail => /请求完成/.test(detail)).length, 1);
  assert.deepEqual(requestErrors, []);
  assert.doesNotMatch(JSON.stringify(journal.list(scope, visible)) + activity.join("\n"), /SYNTHETIC_LOCAL_ONLY_KEY/);
 } finally {
  parent.abort(new Error("Synthetic fixture cleanup")); finish?.(); server.closeAllConnections();
  await pending?.catch(() => {});
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
 }
});
