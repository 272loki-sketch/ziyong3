import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlotSemanticSearch, buildPlotSemanticQueries, semanticCardText, fusePlotRanks, type PlotEmbeddingProvider } from "../src/plot-options/semantic.ts";
import { plotCards, retrievePlotCards } from "../src/plot-options/library.ts";
const pattern = (i: number) => ({ docId: "doc-fixture", title: i === 79 ? "Repairing a bench" : `Conversation ${i}`, locator: `chunk-${i}`, setting: i === 79 ? "workshop" : "classroom", surfaceActivity: i === 79 ? "mending a broken chair together" : "talking", initiative: "voluntary", sweetBeat: "", friction: "", misunderstanding: "", microChange: "", escalationLimit: "no forced outcome", naturalStop: "finish", failureWarning: "only when appropriate" });
function fixture(maxBatches?: number) {
 const root = mkdtempSync(join(tmpdir(), "liyuan-plot-semantic-")); const cards = plotCards(Array.from({ length: 80 }, (_, i) => pattern(i)));
 let key = "synthetic-embedding-v1", fail = false, mode: "valid" | "nan" | "dimension" | "zero" = "valid"; let tokens: number | undefined = 17;
 const calls: string[][] = [];
 let callback: ((texts: string[], signal: AbortSignal) => Promise<{ vectors: number[][]; inputTokens?: number }>) | undefined;
 const provider = (): PlotEmbeddingProvider => ({ key, model: "synthetic-embedding", async embed(texts, signal) {
  calls.push(texts); if (callback) return callback(texts, signal); if (fail) throw Error("synthetic embedding HTTP failure");
  return { vectors: texts.map(t => mode === "nan" ? [NaN, 1] : mode === "zero" ? [0, 0] : mode === "dimension" ? [1, 0, 0] : t.startsWith("query") || t.includes("Repairing a bench") ? [1, 0] : [0, 1]), ...(tokens === undefined ? {} : { inputTokens: tokens }) };
 } });
 const service = new PlotSemanticSearch({ root, provider, maxBatches });
 return { root, service, cards, calls, provider, set key(k: string) { key = k; }, set fail(f: boolean) { fail = f; }, set mode(m: typeof mode) { mode = m; }, set tokens(n: number | undefined) { tokens = n; }, set callback(fn: typeof callback) { callback = fn; }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
const input = (f: ReturnType<typeof fixture>, patch: Record<string, unknown> = {}) => ({ cards: f.cards, queries: ["query: ease tension through cooperation", "query: a small activity to soften a difficult relationship"], keywordQuery: "classroom talking", scopeKey: "synthetic-story-a", signal: new AbortController().signal, retry: false, ...patch });
test("hybrid semantic recall includes a lexically unrelated mechanism outside keyword top24; cache is incremental and private", async () => {
 const f = fixture(); try {
  const target = f.cards[79]; assert.equal(retrievePlotCards(f.cards, "classroom talking", 24).some(c => c.id === target.id), false);
  const result = await f.service.retrieve(input(f));
  assert.equal(result.status.method, "hybrid"); assert.equal(result.status.indexed, 80); assert.equal(result.cards.length, 24); assert.ok(result.cards.some(c => c.id === target.id));
  assert.equal(new Set(result.cards.map(c => c.id)).size, 24); assert.equal(f.calls.length, 4); assert.equal(result.status.inputTokens, 68);
  const again = await f.service.retrieve(input(f)); assert.equal(f.calls.length, 4); assert.equal(again.status.requests, 0); assert.equal(again.status.inputTokens, null);
  const changed = { ...target, friction: "different opinions" }; f.cards[79] = changed;
  await f.service.retrieve(input(f)); assert.equal(f.calls.length, 5); assert.equal(f.calls[4].length, 1);
  const restart = new PlotSemanticSearch({ root: f.root, provider: f.provider }); await restart.retrieve(input(f)); assert.equal(f.calls.length, 5);
  const files = readdirSync(f.root).filter(p => p.endsWith(".json")); assert.equal(files.length, 1); assert.equal(statSync(join(f.root, files[0])).mode & 0o777, 0o600);
  const disk = readFileSync(join(f.root, files[0]), "utf8"); assert.ok(!disk.includes("ease tension")); assert.ok(!disk.includes("Repairing a bench"));
 } finally { f.cleanup(); }
});
test("request budgets show partial coverage and extend it on later batches, not a false full-index success", async () => {
 const f = fixture(1); try {
  const first = await f.service.retrieve(input(f)); assert.equal(first.status.indexed, 32); assert.match(first.status.message!, /32\/80/); assert.equal(first.status.method, "hybrid");
  const second = await f.service.retrieve(input(f, { scopeKey: "next-floor" })); assert.equal(second.status.indexed, 64);
  const third = await f.service.retrieve(input(f, { scopeKey: "later-floor" })); assert.equal(third.status.indexed, 80);
  assert.equal(f.calls.filter(c => c[0].startsWith("plot-semantic")).length, 3);
 } finally { f.cleanup(); }
});
test("embedding failure falls back without repeated charges; manual retry permits recovery; unknown usage remains unknown", async () => {
 const f = fixture(); try {
  f.fail = true; const first = await f.service.retrieve(input(f)); assert.equal(first.status.method, "keyword-fallback"); assert.equal(f.calls.length, 1);
  f.fail = false; const second = await f.service.retrieve(input(f)); assert.equal(second.status.method, "hybrid"); assert.equal(second.status.indexed, 48); assert.match(second.status.message!, /部分覆盖/);
  const calls = f.calls.length; await f.service.retrieve(input(f)); assert.equal(f.calls.length, calls, "blocked rows are not retried automatically");
  f.fail = false; f.tokens = undefined; const recovered = await f.service.retrieve(input(f, { retry: true })); assert.equal(recovered.status.indexed, 80); assert.equal(recovered.status.inputTokens, null);
 } finally { f.cleanup(); }
});
test("local-hash or absent embedding connection never masquerades as semantic search", async () => {
 const root = mkdtempSync(join(tmpdir(), "liyuan-plot-no-semantic-")); const cards = plotCards([pattern(1)]);
 try { const service = new PlotSemanticSearch({ root, provider: () => undefined }); const result = await service.retrieve({ cards, queries: ["q"], keywordQuery: "q", scopeKey: "scope", signal: new AbortController().signal, retry: false }); assert.equal(result.status.method, "keyword-fallback"); assert.equal(result.status.configured, false); assert.match(result.status.message!, /哈希/); assert.equal(readdirSync(root).length, 0); }
 finally { rmSync(root, { recursive: true, force: true }); }
});
test("endpoint/model fingerprints isolate indexes; dimension changes, invalid numeric vectors and stale config results are rejected", async () => {
 const f = fixture(); try {
  await f.service.retrieve(input(f)); const oldCalls = f.calls.length; f.key = "different-provider-model"; assert.equal(f.service.status(f.cards).indexed, 0);
  f.mode = "dimension"; const next = await f.service.retrieve(input(f)); assert.equal(next.status.indexed, 80); assert.ok(f.calls.length > oldCalls);
  f.mode = "valid"; const mismatch = await f.service.retrieve(input(f, { scopeKey: "new-query" })); assert.equal(mismatch.status.method, "keyword-fallback"); assert.match(mismatch.status.message!, /维度/);
  f.key = "nan-test"; f.mode = "nan"; const nan = await f.service.retrieve(input(f)); assert.equal(nan.status.indexed, 0); assert.equal(nan.status.method, "keyword-fallback");
  f.key = "zero-test"; f.mode = "zero"; const zero = await f.service.retrieve(input(f)); assert.equal(zero.status.indexed, 0); assert.match(zero.status.message!, /零/);
  f.key = "stale-test"; let release!: () => void; f.callback = async texts => { await new Promise<void>(r => { release = r; }); return { vectors: texts.map(() => [1, 0]) }; };
  const pending = f.service.retrieve(input(f)); await new Promise(r => setTimeout(r, 5)); f.key = "after-switch"; release();
  const stale = await pending; assert.equal(stale.status.method, "keyword-fallback"); assert.equal(f.service.status(f.cards).indexed, 0);
 } finally { f.cleanup(); }
});
test("cancelled request keeps a durable pending receipt; restarting cannot resubmit that batch automatically", async () => {
 const f = fixture(); let release!: () => void;
 try {
  f.callback = async texts => { await new Promise<void>(r => { release = r; }); return { vectors: texts.map(() => [1, 0]) }; };
  const controller = new AbortController(), pending = f.service.retrieve(input(f, { signal: controller.signal }));
  await new Promise(r => setTimeout(r, 5)); controller.abort(); release(); await pending; f.callback = undefined;
  const restarted = new PlotSemanticSearch({ root: f.root, provider: f.provider }); const result = await restarted.retrieve(input(f));
  assert.equal(result.status.indexed, 48); assert.match(result.status.message!, /部分覆盖/);
 } finally { f.cleanup(); }
});
test("semantic query projections include bounded arc/persona/context and RRF retains both lexical and semantic candidates", () => {
 const queries = buildPlotSemanticQueries({ state: { location: "classroom" }, persona: "reserved student", outline: { aim: "trust" }, history: Array.from({ length: 40 }, () => ({ text: "x".repeat(10000) })), summary: "old history" });
 assert.equal(queries.length, 2); assert.ok(queries.every(q => q.length <= 4400)); assert.match(queries[0], /reserved student/); assert.match(queries[0], /trust/);
 const cards = plotCards(Array.from({ length: 60 }, (_, i) => pattern(i)));
 const fused = fusePlotRanks(cards, cards.slice(0, 24), cards.slice(24, 48)); assert.equal(fused.length, 24); assert.ok(fused.some(c => c.id === cards[0].id)); assert.ok(fused.some(c => c.id === cards[24].id));
 assert.ok(semanticCardText(cards[0]).length < 2801);
});
test("semantic deadline falls back while preserving room for the independent plot model; configuration reset is explicit", async () => {
 const f = fixture(); try {
  const service = new PlotSemanticSearch({ root: f.root, provider: f.provider, timeoutMs: 20 });
  f.callback = async () => new Promise(() => {});
  const result = await service.retrieve(input(f)); assert.equal(result.status.method, "keyword-fallback"); assert.equal(result.status.requests, 1); assert.match(result.status.message!, /语义检索超时.*本地时限/);
  f.callback = undefined; service.reset(); const rebuiltService = new PlotSemanticSearch({ root: f.root, provider: f.provider }); const rebuilt = await rebuiltService.retrieve(input(f, { retry: true })); assert.equal(rebuilt.status.indexed, 80);
 } finally { f.cleanup(); }
});
test("query cache is story-scoped, removed cards are not reintroduced, and active outline focus survives long collections", async () => {
 const f = fixture(); try {
  await f.service.retrieve(input(f)); const before = f.calls.length;
  await f.service.retrieve(input(f, { scopeKey: "different-story" })); assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1)?.length, 2);
  const removed = f.cards.pop()!; const result = await f.service.retrieve(input(f)); assert.ok(!result.cards.some(c => c.id === removed.id)); assert.equal(result.status.indexed, 79);
  const queries = buildPlotSemanticQueries({ persona: "fixture", state: {}, history: [], outline: { premise: "old premise", currentFocus: ["focus"], collections: { constraints: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, title: `irrelevant${i}`, summary: "x".repeat(10000) })), threads: [{ id: "focus", title: "ACTUAL_FOCUS", summary: "repairing trust" }] } } });
  assert.match(queries[0], /ACTUAL_FOCUS/);
 } finally { f.cleanup(); }
});
test("explicit batch-size one supports single-input endpoints, including multi-query requests; no hidden fallback batch calls", async () => {
 const f = fixture(); try {
  f.cards.splice(4); f.callback = async texts => { if (texts.length !== 1) throw Error("duplicate response index"); return { vectors: [[1, 0]], inputTokens: 5 }; };
  const invalid = await f.service.retrieve(input(f)); assert.equal(invalid.status.method, "keyword-fallback"); assert.equal(f.calls.length, 1);
  const recovered = await f.service.retrieve(input(f, { retry: true, batchSize: 1 })); assert.equal(recovered.status.method, "hybrid"); assert.equal(recovered.status.indexed, 4); assert.equal(recovered.status.requests, 6); assert.ok(f.calls.slice(1).every(batch => batch.length === 1));
 } finally { f.cleanup(); }
});
