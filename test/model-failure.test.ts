import assert from "node:assert/strict";
import test from "node:test";
import { classifyModelFailure, explicitProviderFailure, isProviderContentRejection, modelResponseFailure } from "../src/stage/model-failure.ts";
import { settlementFailureRetryable } from "../src/stage/settlement-retry.ts";

test("network error codes remain retryable through supplementary diagnostic wrappers", () => {
 for (const code of ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
  const kind = /TIME(?:D)?OUT/.test(code) ? "timeout" : "transport";
  for (const raw of [code, `supplementary: faux/writer [unknown] ${code}`]) {
   assert.equal(classifyModelFailure(raw).kind, kind, raw);
   assert.equal(settlementFailureRetryable(raw), true, raw);
  }
  for (const raw of [`HTTP 401 ${code}`, `insufficient_quota ${code}`, `model not found ${code}`])
   assert.equal(settlementFailureRetryable(raw), false, raw);
 }
});

test("explicit SDK and proxy safety refusals are nonretryable content filters", () => {
 for (const text of ["Provider finish_reason: content_filter", "[ProxySystem Error] upstream rejected: PROHIBITED_CONTENT", "finish_reason: SAFETY", '{"error":{"message":"Blocked","code":"PROHIBITED_CONTENT"}}']) {
  assert.equal(explicitProviderFailure(text), text);
  assert.equal(classifyModelFailure(text).kind, "content-filter");
  assert.equal(classifyModelFailure(text).retryable, false);
 }
 assert.equal(isProviderContentRejection("Provider finish_reason: content_filter"), true);
});

test("only complete provider error envelopes are rejected, not ordinary prose or JSON fields", () => {
 for (const text of ['{"error":{"message":"Synthetic upstream failure"}}', '{"error":{"type":"api_error","message":"Synthetic failure"}}', '{"error":"Unavailable","status":503}', '[ProxySystem Error] Synthetic unavailable']) assert.equal(explicitProviderFailure(text), text);
 for (const text of ["The story discusses PROHIBITED_CONTENT and safety.", 'He read: Provider finish_reason: content_filter', '{"error":"a character made a mistake"}', '{"error":{"message":"a character made a mistake"},"story":"Continued"}', '{"error":{"message":"dialogue","character":"synthetic"}}', '```json\n{"error":{"message":"example"}}\n```', '{"error":{"message":"incomplete"}']) assert.equal(explicitProviderFailure(text), undefined, text);
});

test("terminal output checks require visible text or valid toolUse calls, and refusals win over tools", () => {
 const tool = { type: "toolCall", id: "synthetic-call", name: "synthetic_tool", arguments: {} };
 assert.equal(modelResponseFailure({ stopReason: "toolUse", content: [tool] }), undefined);
 assert.equal(modelResponseFailure({ stopReason: "stop", content: [{ type: "text", text: "Synthetic story" }] }), undefined);
 for (const value of [undefined, { stopReason: "stop", content: [] }, { stopReason: "stop", content: [tool] }, { stopReason: "toolUse", content: [{ ...tool, name: "" }] }, { stopReason: "stop", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "  " }] }]) assert.match(modelResponseFailure(value)!, /No text/);
  assert.equal(modelResponseFailure({ stopReason: "toolUse", content: [tool, { type: "text", text: "Provider finish_reason: content_filter" }] }), "Provider finish_reason: content_filter");
});

test("content-filter classification requires an explicit receipt, not a quoted story mention", () => {
 for (const text of ['He read: Provider finish_reason: content_filter', 'The log says finish_reason: SAFETY.', 'Provider finish_reason: content_filter was written on the screen.', '{"error":"story","code":"SAFETY","story":"continued"}']) {
  assert.equal(explicitProviderFailure(text), undefined);
  assert.notEqual(classifyModelFailure(text).kind, "content-filter");
 }
 for (const text of ['[ProxySystem Error] Request rejected: SAFETY', '{"message":"Blocked","type":"content_filter"}', '{"error":{"message":"Blocked","code":"SAFETY"}}']) {
  assert.equal(explicitProviderFailure(text), text);
  assert.equal(classifyModelFailure(text).kind, "content-filter");
  assert.equal(classifyModelFailure(new Error("Sanitized database failure", { cause: new Error(text) })).retryable, false);
  assert.equal(classifyModelFailure(new Error("Sanitized database failure", { cause: new Error(text) })).kind, "content-filter");
 }
});

test("side truncation is retryable format failure without changing author terminal validation", () => {
 for (const content of [[], [{ type: "text", text: "Synthetic apparently complete output." }]]) {
  const terminal = { stopReason: "length", content };
  const failure = modelResponseFailure(terminal, true)!;
  assert.match(failure, /截断结果不采用/);
  assert.equal(classifyModelFailure(failure).kind, "format");
  assert.equal(classifyModelFailure(failure).retryable, true);
 }
 assert.equal(modelResponseFailure({ stopReason: "length", content: [{ type: "text", text: "Synthetic author output." }] }), undefined);
 assert.equal(modelResponseFailure({ stopReason: "stop", content: [{ type: "text", text: "Synthetic side output." }] }, true), undefined);
});

test("explicit model_not_found codes override HTTP 503 transport failures", () => {
 const envelope = JSON.stringify({ error: { message: "No available channel for configured model", type: "api_error", code: "model_not_found" } });
 for (const text of [envelope, `HTTP 503 ${envelope}`, `Provider HTTP 503: ${envelope}`, `503: ${envelope}`, 'HTTP 503 {"message":"No available channel","code":"model_not_found"}', "Provider HTTP 503 model_not_found: no available channel for configured model"]) {
  const failure = classifyModelFailure(text);
  assert.equal(failure.kind, "model", text);
  assert.equal(failure.retryable, false, text);
  if (text.includes("503")) assert.equal(failure.statusCode, 503);
 }
 assert.equal(classifyModelFailure(new Error("Provider request failed", { cause: new Error(`HTTP 503 ${envelope}`) })).kind, "model");
});

test("generic 503 and unavailable networks remain transient without matching model names in prose", () => {
 for (const text of ['HTTP 503 Service unavailable', 'HTTP 503 {"error":{"message":"No available channel","code":"service_unavailable"}}', 'HTTP 503 model request failed: network unavailable', 'model request failed: network unavailable']) {
  assert.equal(classifyModelFailure(text).kind, "transport", text);
  assert.equal(classifyModelFailure(text).retryable, true, text);
 }
 for (const text of ['The character named model_not_found entered the story.', 'He read: Provider HTTP 503 model_not_found: no available channel', '{"story":"continued","error":{"message":"No channel","code":"model_not_found"}}', '```json\n{"error":{"message":"No channel","code":"model_not_found"}}\n```', JSON.stringify({ error: { message: 'A character wrote "code":"model_not_found"', code: "service_unavailable" } })]) {
  assert.notEqual(classifyModelFailure(text).kind, "model", text);
 }
});

test("content refusal, authentication and quota take precedence over model_not_found", () => {
 for (const [text, kind] of [
  ['HTTP 503 {"error":{"message":"Blocked","type":"content_filter","code":"model_not_found"}}', "content-filter"],
  ['HTTP 401 {"error":{"message":"Invalid API key","code":"model_not_found"}}', "auth"],
  ['HTTP 503 {"error":{"message":"insufficient_quota","code":"model_not_found"}}', "quota"],
 ]) {
  assert.equal(classifyModelFailure(text).kind, kind, text);
  assert.equal(classifyModelFailure(text).retryable, false, text);
 }
});

test("malformed tool-only terminals fail even alongside a valid call", () => {
 const tool = { type: "toolCall", id: "synthetic", name: "table_edit", arguments: {} };
 for (const invalid of [{ ...tool, id: " " }, { ...tool, name: "" }, { ...tool, arguments: null }, { ...tool, arguments: [] }, { ...tool, arguments: "{}" }]) {
  assert.match(modelResponseFailure({ stopReason: "toolUse", content: [tool, invalid] })!, /No text/);
 }
 assert.equal(modelResponseFailure({ stopReason: "error", content: [{ type: "text", text: "Provider finish_reason: content_filter" }] }), "Provider finish_reason: content_filter");
});

test('a gateway session limit is retryable rate limiting even when transported as HTTP 403',async()=>{
 const {npcFailureReason}=await import('../src/stage/npc-parallel.ts');
 const {settlementFailureRetryable}=await import('../src/stage/settlement-retry.ts');
 const raw='403: {"message":"All 1 linked account(s) are at their session limit (reset: later); the gateway will retry them automatically in ~10 min.","type":"portail_error","code":403}';
 assert.equal(classifyModelFailure(raw).kind,'rate-limit');
 assert.equal(classifyModelFailure(raw).retryable,true);
 assert.equal(npcFailureReason(raw),'HTTP 403 rate limit');
 const {modelDiagnosticsView}=await import('../src/stage/model-failure.ts');
 assert.equal(modelDiagnosticsView([{phase:'settlement.ecology',step:'npcParallel',status:'failed',kind:'auth',reason:raw}])?.[0].kind,'rate-limit');
 assert.equal(classifyModelFailure(npcFailureReason(raw)).kind,'rate-limit');
 assert.equal(settlementFailureRetryable(npcFailureReason(raw)),true);
 for(const text of ['403: permission denied','401: invalid API key','403: account blocked']){assert.equal(classifyModelFailure(text).kind,'auth');assert.equal(settlementFailureRetryable(text),false);}
});
