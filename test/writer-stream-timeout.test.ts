import assert from "node:assert/strict";
import test from "node:test";
import { streamWithTimeout, type StageStreamEvent } from "../src/stage/engine.ts";

function stalledStream() {
 let reads = 0, returns = 0;
 const source: AsyncIterable<StageStreamEvent> = {
  [Symbol.asyncIterator]() {
   return {
    next: async () => ++reads === 1
     ? { done: false as const, value: { type: "text_delta" as const, delta: "partial" } }
     : await new Promise<IteratorResult<StageStreamEvent>>(() => {}),
    return: () => { returns++; return new Promise<IteratorResult<StageStreamEvent>>(() => {}); },
   };
  },
 };
 return { source, returns: () => returns };
}

test("writer absolute deadline preserves partial, aborts child, and never waits for producer return", { timeout: 2000 }, async () => {
 const parent = new AbortController(), child = new AbortController(), f = stalledStream();
 const iterator = streamWithTimeout(f.source, 30, parent.signal, child);
 assert.equal((await iterator.next()).value?.delta, "partial");
 await assert.rejects(iterator.next(), /30ms/);
 assert.equal(child.signal.aborted, true);
 assert.equal(parent.signal.aborted, false);
 assert.equal(f.returns(), 1);
});

test("writer deadline is absolute even while events continue", { timeout: 2000 }, async () => {
 const parent = new AbortController(), child = new AbortController();
 const source: AsyncIterable<StageStreamEvent> = { async *[Symbol.asyncIterator]() {
  while (true) { await new Promise(resolve => setTimeout(resolve, 5)); yield { type: "text_delta", delta: "x" }; }
 } };
 let partial = "";
 await assert.rejects(async () => {
  for await (const event of streamWithTimeout(source, 40, parent.signal, child)) partial += event.delta ?? "";
 }, /40ms/);
 assert.ok(partial.length > 0);
 assert.equal(child.signal.aborted, true);
 assert.equal(parent.signal.aborted, false);
});

test("parent cancellation aborts child and rejects a stalled read", { timeout: 2000 }, async () => {
 const parent = new AbortController(), child = new AbortController(), f = stalledStream();
 const iterator = streamWithTimeout(f.source, 1000, parent.signal, child);
 await iterator.next();
 const pending = iterator.next();
 parent.abort();
 assert.equal(child.signal.aborted, true);
 await assert.rejects(pending, /已取消/);
});

test("consumer return aborts child before waiting for a pending next", { timeout: 2000 }, async () => {
 const parent = new AbortController(), child = new AbortController(), f = stalledStream();
 const iterator = streamWithTimeout(f.source, 1000, parent.signal, child);
 await iterator.next();
 const pending = iterator.next();
 const closed = iterator.return();
 assert.equal(child.signal.aborted, true);
 assert.equal(parent.signal.aborted, false);
 await assert.rejects(pending, /已取消/);
 assert.equal((await closed).done, true);
});

test("terminal events retain their message, result, and usage while aborting only child", async () => {
 for (const type of ["done", "error"] as const) {
  const parent = new AbortController(), child = new AbortController();
  const message = { role: "assistant", content: [{ type: "text", text: "complete" }], stopReason: type === "done" ? "stop" : "error", usage: { input: 12, output: 34 } };
  const event: StageStreamEvent = type === "done" ? { type, message } : { type, error: message };
  const source = { async *[Symbol.asyncIterator]() { yield event; }, result: async () => message };
  const iterator = streamWithTimeout(source, 1000, parent.signal, child);
  assert.equal((await iterator.next()).value, event);
  assert.equal(child.signal.aborted, true);
  assert.equal(parent.signal.aborted, false);
  assert.equal(await source.result(), message);
  assert.equal((await iterator.next()).done, true);
 }
});

test("producer throw and clean EOF abort child without cancelling parent", async () => {
 for (const fails of [false, true]) {
  const parent = new AbortController(), child = new AbortController();
  const source: AsyncIterable<StageStreamEvent> = { async *[Symbol.asyncIterator]() { if (fails) throw new Error("synthetic failure"); } };
  const iterator = streamWithTimeout(source, 1000, parent.signal, child);
  if (fails) await assert.rejects(iterator.next(), /synthetic failure/);
  else assert.equal((await iterator.next()).done, true);
  assert.equal(child.signal.aborted, true);
  assert.equal(parent.signal.aborted, false);
 }
});

test("cancelled pending read never delivers late text and a fresh request can use the same parent", async () => {
 const parent = new AbortController(), child = new AbortController();
 let deliver!: (value: IteratorResult<StageStreamEvent>) => void;
 const source: AsyncIterable<StageStreamEvent> = { [Symbol.asyncIterator]: () => ({
  next: () => new Promise(resolve => { deliver = resolve; }),
 }) };
 const iterator = streamWithTimeout(source, 1000, parent.signal, child);
 const pending = iterator.next();
 const closed = iterator.return();
 deliver({ done: false, value: { type: "text_delta", delta: "late" } });
 await assert.rejects(pending, /已取消/);
 await closed;
 assert.equal((await iterator.next()).done, true);
 assert.equal(parent.signal.aborted, false);
 const nextChild = new AbortController();
 const nextSource: AsyncIterable<StageStreamEvent> = { async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "fresh" }; } };
 const nextIterator = streamWithTimeout(nextSource, 1000, parent.signal, nextChild);
 assert.equal((await nextIterator.next()).value?.delta, "fresh");
 await nextIterator.return();
 assert.equal(nextChild.signal.aborted, true);
 assert.equal(parent.signal.aborted, false);
});

for (const scope of ["analysis", "generation"] as const) test(`parent ${scope} deadline retains its cause instead of becoming writer cancellation`, async () => {
 const { LocalRequestTimeoutError } = await import("../src/request-budget.ts");
 const { classifyModelFailure } = await import("../src/stage/model-failure.ts");
 const parent = new AbortController(), child = new AbortController(), f = stalledStream();
 const iterator = streamWithTimeout(f.source, 1000, parent.signal, child); await iterator.next(); const pending = iterator.next();
 const cause = new LocalRequestTimeoutError(scope, 20, scope === "analysis" ? "合成导演" : "整拍总体预算"); parent.abort(cause);
 await assert.rejects(pending, e => e === cause); assert.equal(child.signal.reason, cause);
 assert.equal(classifyModelFailure(cause).kind, "timeout");
});
