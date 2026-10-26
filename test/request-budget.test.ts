import assert from "node:assert/strict";
import test from "node:test";
import { abortable, abortableEvents } from "../src/async-abort.ts";
import { analysisRequestTimeoutMs, createRequestDeadline, LocalRequestTimeoutError, requestAbortError } from "../src/request-budget.ts";
import { requestFailure } from "../src/stage/request-failure.ts";
import { modelDiagnosticsView } from "../src/stage/model-failure.ts";

test("analysis budgets use current configuration, bounded defaults and invalid-value handling", () => {
 assert.equal(analysisRequestTimeoutMs({}), 600_000);
 assert.equal(analysisRequestTimeoutMs({ analysisTimeoutMinutes: 5 }), 300_000);
 assert.equal(analysisRequestTimeoutMs({ analysisTimeoutMinutes: 0 }), 60_000);
 assert.equal(analysisRequestTimeoutMs({ analysisTimeoutMinutes: 99 }), 1800_000);
 assert.equal(analysisRequestTimeoutMs({ analysisTimeoutMinutes: NaN }), 600_000);
});
test("local deadline is typed and independent of parent cancellation; disposal stops its timer", async () => {
 const parent = new AbortController(), deadline = createRequestDeadline(parent.signal, 15, "analysis", "合成场记");
 try {
  await assert.rejects(abortable(new Promise(() => {}), deadline.signal), e => e instanceof LocalRequestTimeoutError && e.scope === "analysis");
  assert.equal(parent.signal.aborted, false);
  assert.deepEqual(requestFailure(Error("SDK generic abort"), deadline.signal), { origin: "local-timeout", kind: "timeout", reason: "合成场记超时（本地时限 15ms）", timeoutScope: "analysis", timeoutMs: 15 });
 } finally { deadline.dispose(); }
 const stopped = createRequestDeadline(undefined, 10, "analysis", "不应触发"); stopped.dispose();
 await new Promise(r => setTimeout(r, 20)); assert.equal(stopped.signal.aborted, false);
 assert.throws(() => createRequestDeadline(undefined, NaN, "analysis", "无效"), /时限/);
});
test("parent generation timeout is preserved, while plain user cancellation is not called an API failure", () => {
 const parent = new AbortController(), cause = new LocalRequestTimeoutError("generation", 60_000, "整拍总体预算"); parent.abort(cause);
 const deadline = createRequestDeadline(parent.signal, 100, "analysis", "场记");
 try { assert.equal(requestAbortError(deadline.signal), cause); assert.equal(requestFailure(Error("abort"), deadline.signal).timeoutScope, "generation"); }
 finally { deadline.dispose(); }
 const user = new AbortController(); user.abort(); assert.match(requestAbortError(user.signal).message, /取消/);
 assert.equal(requestFailure(Error("abort"), user.signal).origin, "cancelled");
 const gateway = requestFailure(Error("HTTP 524: proxy read timeout")); assert.equal(gateway.origin, "provider"); assert.equal(gateway.statusCode, 524); assert.equal(gateway.kind, "timeout");
});
test("abortable event iteration exits an uncooperative producer and consumes late rejection", async () => {
 const controller = new AbortController(); let reject!: (e: Error) => void, closed = 0;
 const source = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<number>>((_, r) => { reject = r; }), return: () => { closed++; return new Promise<IteratorResult<number>>(() => {}); } }) };
 const iterator = abortableEvents(source, controller.signal), next = iterator.next(); controller.abort(Error("合成主动取消"));
 await assert.rejects(next, /主动取消/); assert.equal(closed, 1); reject(Error("late synthetic failure")); await new Promise(r => setImmediate(r));
});
test("diagnostic projection retains bounded local timeout metadata and rejects unknown scope", () => {
 const base = { phase: "prep", step: "literaryDirector", provider: "fixture", model: "fixture", attempt: 1, status: "failed", kind: "timeout", durationMs: 10, origin: "local-timeout", timeoutScope: "analysis", timeoutMs: 600_000 };
 assert.equal(modelDiagnosticsView([base])?.[0].timeoutScope, "analysis");
 assert.equal(modelDiagnosticsView([{ ...base, timeoutScope: "private unknown field" }])?.[0].timeoutScope, undefined);
});

test("failure reason redacts the actual configured credential even without a vendor-specific prefix", () => {
 const credential = "fixture-private-credential-not-a-real-key";
 const failure = requestFailure(Error(`HTTP 401: invalid key ${credential}`), undefined, credential);
 assert.equal(failure.statusCode, 401); assert.doesNotMatch(failure.reason, /fixture-private-credential/);
 assert.match(failure.reason, /redacted/);
 const native = new AbortController(); native.abort(new DOMException("Local deadline reached", "TimeoutError"));
 assert.equal(requestFailure(Error("generic abort"), native.signal).origin, "local-timeout");
});

test("fetch transport codes survive diagnostics without copying endpoint, socket or SDK internals", () => {
 const error=new TypeError("fetch failed", {cause:{code:"UND_ERR_SOCKET",address:"private fixture host",headers:{authorization:"fixture-private"}}});
 const failure=requestFailure(error);assert.equal(failure.origin,"sdk");assert.equal(failure.transportCode,"UND_ERR_SOCKET");assert.match(failure.reason,/UND_ERR_SOCKET/);assert.doesNotMatch(JSON.stringify(failure),/private fixture host|fixture-private/);
 assert.equal(requestFailure(new TypeError("fetch failed", {cause:{code:"UNKNOWN_PRIVATE_CODE"}})).transportCode,undefined);
});
