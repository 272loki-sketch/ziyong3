import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { handleApiRequest, type RestHost } from "../server/rest.ts";
async function request(method: string, url: string, body?: unknown) {
 const calls: unknown[][] = [], headers: Record<string, string> = {};
 const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any; req.method = method; req.url = url;
 let status = 0, raw = "";
 const res = { setHeader(k: string, v: string) { headers[k] = v; }, writeHead(code: number) { status = code; }, end(text = "") { raw += text; } };
 const host = { cwd: "/tmp/synthetic-not-created", isStreaming: () => true, plotOptions: {
  controlKey: () => "control", view: () => ({ options: [], running: true }), library: (...args: unknown[]) => { calls.push(["library", ...args]); return { total: 80, cards: [] }; },
  settings: (...args: unknown[]) => { calls.push(["settings", ...args]); return { enabled: true }; },
  rebuildSemantic: (...args: unknown[]) => { calls.push(["reindex", ...args]); return { running: true }; },
  refresh: (...args: unknown[]) => { calls.push(["refresh", ...args]); return { running: true }; },
  cancelDirection: (...args: unknown[]) => { calls.push(["cancel", ...args]); return { active: null }; },
 } } as unknown as RestHost;
 assert.equal(await handleApiRequest(req, res as never, host), true);
 return { status, body: JSON.parse(raw), calls, headers };
}
test("plot sidecar REST stays independent of story busy, forwards context, and does not cache private responses", async () => {
 const v = await request("GET", "/api/plot-options"); assert.equal(v.status, 200); assert.equal(v.headers["cache-control"], "no-store");
 const r = await request("POST", "/api/plot-options/refresh", { contextKey: "key", controlKey: "control", cardId: "chosen" }); assert.deepEqual(r.calls, [["refresh", "key", "chosen"]]);
 const s = await request("PUT", "/api/plot-options/settings", { contextKey: "key", controlKey: "control", enabled: true, interval: 10 }); assert.deepEqual(s.calls, [["settings", { enabled: true, interval: 10 }, "key"]]);
 const l = await request("GET", "/api/plot-options/library?q=%E6%97%A7%E4%B9%A6&offset=60"); assert.deepEqual(l.calls, [["library", "旧书", 60]]);
 const stale = await request("POST", "/api/plot-options/cancel", { contextKey: "key", controlKey: "old" }); assert.equal(stale.status, 409); assert.equal(stale.calls.length, 0);
 const reindex = await request("POST", "/api/plot-options/reindex", { contextKey: "key", controlKey: "control" }); assert.deepEqual(reindex.calls, [["reindex", "key"]]);
 const semantic = await request("PUT", "/api/plot-options/settings", { contextKey: "key", controlKey: "control", semantic: true }); assert.deepEqual(semantic.calls, [["settings", { semantic: true }, "key"]]);
 const batch = await request("PUT", "/api/plot-options/settings", { contextKey: "key", controlKey: "control", embeddingBatchSize: 1 }); assert.deepEqual(batch.calls, [["settings", { embeddingBatchSize: 1 }, "key"]]);
 const bad = await request("POST", "/api/plot-options/refresh", {}); assert.equal(bad.status, 400); assert.equal(bad.calls.length, 0);
});
