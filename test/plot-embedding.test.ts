import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { memoryConfigPath } from "../src/memory/config.ts";
import { embedTextsCloud } from "../src/memory/embed.ts";
import { plotEmbeddingProvider } from "../src/plot-options/embedding.ts";
import { RequestJournal } from "../src/stage/request-journal.ts";
async function fixture() {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-plot-embedding-"));
 let response: "valid" | "duplicate" | "mixed" | "dimension" | "string" | "empty" | "slow" | "error" | "length" = "valid", calls = 0;
 const payloads: any[] = [];
 const server = createServer((req, res) => { void (async () => {
  let raw = ""; for await (const b of req) raw += b; calls++; const payload = JSON.parse(raw); payloads.push(payload);
  if (response === "slow") { res.on("close", () => {}); return; }
  if (response === "error") { res.statusCode = 429; res.end("synthetic limited"); return; }
  if (response === "length") { res.end("x".repeat(10000)); return; }
  const texts = Array.isArray(payload.input) ? payload.input : [payload.input];
  const data = texts.map((_text: string, index: number) => ({ index: response === "duplicate" ? 0 : index, embedding: response === "string" ? ["1", 0] : response === "dimension" && index ? [1, 0, 0] : [1, index] }));
  if (response === "mixed" && data[1]) delete data[1].index;
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: response === "empty" ? [] : data.reverse(), usage: { prompt_tokens: 8, total_tokens: 8 } }));
 })().catch(() => { res.statusCode = 500; res.end(); }); });
 await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
 const cloud = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "synthetic-fixture-key", model: "synthetic-embedding" };
 const path = memoryConfigPath(cwd); mkdirSync(dirname(path), { recursive: true });
 const config = { version: 1, enabled: false, embedMode: "cloud", cloudEmbed: cloud };
 writeFileSync(path, JSON.stringify(config));
 return { cwd, path, cloud, config, payloads, get calls() { return calls; }, set response(mode: typeof response) { response = mode; },
  async cleanup() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(cwd, { recursive: true, force: true }); } };
}
test("plot embeddings use existing dedicated cloud connection without enabling memory; actual usage/journal remain source-scoped and credential-free", async () => {
 const f = await fixture(); try {
  const before = readFileSync(f.path, "utf8"), provider = plotEmbeddingProvider(f.cwd)!;
  const result = await provider.embed(["synthetic text one", "synthetic text two"], new AbortController().signal, { sessionId: "synthetic-session", card: "synthetic-card", sourceEntryId: "source-entry" });
  assert.equal(result.inputTokens, 8); assert.equal(result.vectors.length, 2); assert.deepEqual(result.vectors[0], [1, 0]); assert.equal(f.calls, 1);
  assert.equal(readFileSync(f.path, "utf8"), before); assert.ok(!provider.key.includes(f.cloud.apiKey));
  const journal = new RequestJournal(f.cwd); const rows = journal.list({ sessionId: "synthetic-session", card: "synthetic-card" }, new Set(["source-entry"]));
  assert.equal(rows.length, 1); assert.equal(rows[0].phase, "plot.embedding"); assert.equal(rows[0].status, "success"); assert.equal(rows[0].usage?.input, 8); assert.ok(!JSON.stringify(rows).includes(f.cloud.apiKey));
  assert.equal(journal.list({ sessionId: "synthetic-session", card: "synthetic-card" }, new Set(["other-branch"])).length, 0);
  writeFileSync(f.path, JSON.stringify({ ...f.config, embedMode: "local" })); assert.equal(plotEmbeddingProvider(f.cwd), undefined);
 } finally { await f.cleanup(); }
});
test("strict plot transport rejects corrupt indices/dimensions/numeric strings and body budget; legacy embedding remains compatible", async () => {
 const f = await fixture(); try {
  for (const mode of ["duplicate", "mixed", "dimension", "string", "empty"] as const) {
   f.response = mode; await assert.rejects(() => embedTextsCloud(["one", "two"], f.cloud, { strict: true }), /embedding/);
  }
  f.response = "length"; await assert.rejects(() => embedTextsCloud(["one"], f.cloud, { strict: true, maxResponseBytes: 1000 }), /安全预算/);
  f.response = "valid"; assert.equal((await embedTextsCloud(["legacy"], f.cloud)).length, 1);
  f.response = "error"; const calls = f.calls; await assert.rejects(() => embedTextsCloud(["one"], f.cloud, { strict: true }), /429/); assert.equal(f.calls, calls + 1, "no implicit retry");
 } finally { await f.cleanup(); }
});
test("external cancellation interrupts the actual embedding transport, rather than only hiding a late result", async () => {
 const f = await fixture(); try {
  f.response = "slow"; const controller = new AbortController(); const pending = embedTextsCloud(["cancel-me"], f.cloud, { strict: true, signal: controller.signal });
  for (let i = 0; i < 100 && !f.calls; i++) await new Promise(r => setTimeout(r, 3)); controller.abort();
  await assert.rejects(() => pending, /abort/i); assert.equal(f.calls, 1);
 } finally { await f.cleanup(); }
});
