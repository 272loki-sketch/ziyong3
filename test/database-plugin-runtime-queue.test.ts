import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabasePluginRuntime } from "../server/database-plugin-runtime.ts";
import type { DatabasePluginHttp } from "../server/database-plugin-http.ts";

test("database RPC shares the settlement queue and a failed RPC does not poison it", async () => {
 const http = { boundSourceEntryId: undefined } as unknown as DatabasePluginHttp;
 const runtime = new DatabasePluginRuntime(http, () => "http://127.0.0.1:1");
 let release!: () => void;
 const settlement = new Promise<void>(resolve => { release = resolve; });
 const calls: string[] = [];
 let ensures = 0;
 const page = {
  async evaluate(_fn: unknown, packet?: { method: string }) {
   if (!packet) { calls.push("after"); await settlement; return "settled"; }
   calls.push(packet.method);
   if (packet.method === "fail") throw new Error("synthetic RPC failure");
   return packet.method;
  },
 };
 // No browser, private state, upstream assets or model transport is used.
 Object.assign(runtime, { ensure: async () => { ensures++; return page; } });
 const after = runtime.after("synthetic-author");
 const rpc = runtime.rpc("getUpdateConfigParams");
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(ensures, 1, "RPC must not initialize a second realm during settlement");
 assert.deepEqual(calls, ["after"]);
 assert.equal(http.boundSourceEntryId, "synthetic-author");
 release();
 assert.equal(await after, "settled");
 assert.equal(await rpc, "getUpdateConfigParams");
 assert.equal(http.boundSourceEntryId, undefined);
 assert.deepEqual(calls, ["after", "getUpdateConfigParams"]);
 await assert.rejects(runtime.rpc("fail"), /synthetic RPC failure/);
 assert.equal(await runtime.rpc("exportTableAsJson"), "exportTableAsJson");
});

test("cancelled queued database work neither closes its running predecessor nor leaks its source to the next job", async () => {
 const http = { boundSourceEntryId: undefined, assertBinding() {} } as unknown as DatabasePluginHttp;
 const runtime = new DatabasePluginRuntime(http, () => "http://127.0.0.1:1");
 const first = new AbortController(), queued = new AbortController();
 let release!: () => void, closes = 0;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const sources: Array<string | undefined> = [];
 Object.assign(runtime, { close: async () => { closes++; }, ensure: async () => ({ evaluate: async () => {
  sources.push(http.boundSourceEntryId);
  if (sources.length === 1) await gate;
  return { sourceEntryId: "synthetic-next" };
 } }) });
 const running = runtime.after("synthetic-first", first.signal);
 const cancelled = runtime.after("synthetic-cancelled", queued.signal);
 const rejected = assert.rejects(cancelled, /已取消/);
 try {
  await new Promise(resolve => setImmediate(resolve));
  queued.abort();
  assert.equal(closes, 0); assert.equal(first.signal.aborted, false);
  assert.equal(http.boundSourceEntryId, "synthetic-first");
  release(); await running; await rejected;
  first.abort();
  assert.equal(closes, 0, "completed jobs must detach their parent abort listener");
  await runtime.after("synthetic-next");
  assert.deepEqual(sources, ["synthetic-first", "synthetic-next"]);
  assert.equal(http.boundSourceEntryId, undefined); assert.equal(runtime.requestPhase, undefined);
 } finally { release(); await running.catch(() => {}); await cancelled.catch(() => {}); }
});
