import { syntheticPlotGrounding } from "./fixtures/plot-grounding.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { memoryConfigPath } from "../src/memory/config.ts";
import { join, resolve, dirname } from "node:path";
import WebSocket from "ws";
const root = resolve(new URL("..", import.meta.url).pathname);
async function listen(server: ReturnType<typeof createServer>): Promise<number> { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return (server.address() as { port: number }).port; }
async function until(fn: () => boolean | Promise<boolean>, label: string, timeoutMs = 10000): Promise<void> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 40)); } throw Error(`timeout: ${label}`); }
test("real host: daily backend, editable bound submission/replay, source validation and slow planning never blocks direct RP (synthetic local models)", { timeout: 90000 }, async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-plot-host-"));
 let child: ReturnType<typeof spawn> | undefined, ws: WebSocket | undefined, release: (() => void) | undefined;
 const requests: any[] = [], frames: any[] = []; let delay = false, brokenDaily = false, dailyHttpFailure = false, output = "合成正文：她提到图书馆正在清点旧书。", logs = "";
 const model = createServer((req, res) => { void (async () => {
  let raw = ""; for await (const part of req) raw += part; const payload = JSON.parse(raw); requests.push(payload);
  if (req.url?.endsWith("/embeddings")) {
   const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
   res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: inputs.map((_x: string, index: number) => ({ index, embedding: [1, 0.25] })), usage: { prompt_tokens: 9 } })); return;
  }
  let content = "{}";
  if (payload.model === "daily") {
   if (dailyHttpFailure) { res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: { message: "合成筹备供应商暂时不可用", type: "server_error" } })); return; }
   if (delay) await new Promise<void>(r => { release = r; });
   const source = payload.messages.find((m: any) => m.role === "user").content;
   const data = JSON.parse(typeof source === "string" ? source : source.map((p: any) => p.text ?? "").join(""));
   content = JSON.stringify({ options: [{ ...syntheticPlotGrounding(data), cardId: data.candidates[0].id, title: "合成一起整理旧书", experience: "共同做事了解彼此", whyNow: "可自然接入", draft: "我问她最近有没有需要帮忙的事情。", setup: ["先提及清点工作"], development: ["共同清点时处理分歧"], boundaries: ["不预定关系"], prerequisites: ["双方愿意"], entryCondition: "真实邀请后进入" }], ...(data.selectedDirection ? { progress: {
    status: "engaged", note: "已保存的互动可承接当前方向", nextSetup: ["先明确书架的分工"], nextEntryCondition: "双方确认当前分工后自然展开",
    evidence: data.recentHistory.filter((h: any) => h.role === "assistant").slice(-1).map((h: any) => ({ entryId: h.id, quote: h.text })),
   } } : {}) });
  } else if (payload.model === "director") content = JSON.stringify({ scenePressure: "眼前谈话", characterInitiatives: [], candidateBeats: [] });
  else if (payload.model === "writer") content = output;
  else if (payload.model === "scribe") content = JSON.stringify({ patch: { location: "合成图书馆" } });
  if (payload.model === "daily" && brokenDaily) content = "{";
  if (payload.stream) {
   res.setHeader("content-type", "text/event-stream");
   res.end("data: " + JSON.stringify({ id: `synthetic-${requests.length}`, object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) + "\n\ndata: [DONE]\n\n");
  } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: `synthetic-${requests.length}`, object: "chat.completion", created: 1, model: payload.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })); }
 })().catch(e => { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }); });
 try {
  const modelPort = await listen(model);
  mkdirSync(join(cwd, ".liyuan")); mkdirSync(join(cwd, "web/dist"), { recursive: true }); writeFileSync(join(cwd, "web/dist/index.html"), "synthetic fixture");
  for (const name of ["src", "skills", "node_modules"]) symlinkSync(join(root, name), join(cwd, name), "dir");
  symlinkSync(join(root, ".liyuan/extensions"), join(cwd, ".liyuan/extensions"), "dir");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "synthetic-plot-host", version: "1.8.16", type: "module" }));
  writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "合成卡", description: "合成日常", first_mes: "合成开场" } }));
  writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "合成玩家", greeting: false, generationMode: "direct", literaryWorldEnabled: false, literaryEcologyEnabled: false, novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false }, stepModels: Object.fromEntries([["dailyPlot", "daily"], ["literaryDirector", "director"], ["scribe", "scribe"]].map(([k, id]) => [k, { provider: "fixture", id }])) }));
  writeFileSync(join(cwd, "liyuan.agent.json"), JSON.stringify({ version: 1, defaultProvider: "fixture", defaultModel: "writer", providers: { fixture: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "synthetic-only", compat: { streaming: false, supportsTools: false }, models: ["writer", "director", "scribe", "daily"].map(id => ({ id, contextWindow: 128000, maxTokens: 12000, ...(id === "daily" ? { compat: { streaming: true } } : {}) })) } } }));
  const embeddingConfig = memoryConfigPath(cwd); mkdirSync(dirname(embeddingConfig), { recursive: true });
  writeFileSync(embeddingConfig, JSON.stringify({ version: 1, enabled: false, embedMode: "cloud", cloudEmbed: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "synthetic-only", model: "synthetic-embedding" } }));
  const corpus = join(cwd, ".liyuan/outline/research/corpus"); mkdirSync(join(corpus, "digests"), { recursive: true });
  writeFileSync(join(corpus, "documents.json"), JSON.stringify([{ id: "doc-synthetic", status: "ready" }]));
  writeFileSync(join(corpus, "digests/doc-synthetic.json"), JSON.stringify({ dailyPatterns: [{ title: "合成旧书清点", surfaceActivity: "整理旧书", setting: "图书馆", locator: "chunk-synthetic", initiative: "自愿帮忙", sweetBeat: "发现习惯", friction: "意见不同", misunderstanding: "", microChange: "了解", escalationLimit: "不预定关系", naturalStop: "收工", failureWarning: "先建立动机" }] }));
  const portServer = createServer(); const port = await listen(portServer); await new Promise<void>(r => portServer.close(() => r())); const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server/main.ts"), "--new"], { cwd, env: { ...process.env, HOME: join(cwd, "home"), LIYUAN_CODING_AGENT_DIR: join(cwd, "agent"), HOST: "127.0.0.1", PORT: String(port), LIYUAN_PLAY_SLOT_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", x => { logs += x; }); child.stderr?.on("data", x => { logs += x; });
  await until(async () => { if (child?.exitCode != null) throw Error(logs.slice(-3000)); try { return (await fetch(base + "/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "host startup", 30000).catch(error => { throw Error(`${error.message}\n${logs.slice(-3000)}`); });
  const get = async () => await (await fetch(base + "/api/plot-options")).json() as any;
  const post = async (path: string, body: unknown, method = "POST") => { const response = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
  let v = await get(); assert.equal(v.enabled, false); assert.equal(v.libraryCount, 1); assert.equal(v.modelConfigured, true);
  const enabled = await post("/api/plot-options/settings", { contextKey: v.contextKey, controlKey: v.controlKey, enabled: true }, "PUT"); assert.equal(enabled.status, 200);
  await until(async () => !(await get()).running, "initial planning"); v = await get(); assert.equal(v.options.length, 1, JSON.stringify(v));
  assert.equal(requests.find(r => r.model === "daily")?.stream, true, "background planning honors the configured streaming model without a forced transport workaround");
  const initialRequests = await (await fetch(base + "/api/request-inspector")).json() as any;
  assert.ok(initialRequests.requests.some((r: any) => r.phase === "dailyPlot"), "initial planning before the first user message must remain visible in the source-scoped inspector");
  const semantic = await post("/api/plot-options/settings", { contextKey: v.contextKey, controlKey: v.controlKey, semantic: true }, "PUT"); assert.equal(semantic.status, 200);
  await until(async () => !(await get()).running, "semantic planning"); v = await get(); assert.equal(v.semantic, true); assert.equal(v.lastRetrieval.method, "hybrid"); assert.equal(v.retrieval.indexed, 1); assert.equal(v.lastRetrieval.requests, 2);
  const semanticRequests = await (await fetch(base + "/api/request-inspector")).json() as any;
  assert.equal(semanticRequests.requests.filter((r: any) => r.phase === "plot.embedding").length, 2, "pre-story embedding receipts retain explicit root scope");
  const embedsBefore = requests.filter(r => r.model === "synthetic-embedding").length;
  await post("/api/plot-options/refresh", { contextKey: v.contextKey, controlKey: v.controlKey }); await until(async () => !(await get()).running, "cached semantic planning"); v = await get();
  assert.equal(requests.filter(r => r.model === "synthetic-embedding").length, embedsBefore, "unchanged card and query reuse embeddings");
  ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { origin: base }); ws.on("error", () => {}); ws.on("message", raw => frames.push(JSON.parse(raw.toString()))); await until(() => frames.some(f => f.type === "hello"), "hello");
  const hello = frames.find(f => f.type === "hello"); const plotChoice = { contextKey: v.contextKey, optionId: v.options[0].id };
  const input = { type: "prompt", text: "我自己修改的实际输入。", generationMode: "direct", sessionId: hello.sessionId, messageId: "plot-msg-1", plotChoice };
  ws.send(JSON.stringify(input)); await until(() => frames.some(f => f.type === "prompt_ack" && f.messageId === input.messageId && f.status === "accepted"), "accepted input");
  await until(() => frames.some(f => f.type === "agent" && f.state === "end"), "first turn");
  v = await get(); assert.equal(v.active.option.id, plotChoice.optionId);
  const inspected = await (await fetch(base + "/api/request-inspector")).json() as any;
  const scribeRecord = inspected.requests.find((r: any) => r.model === "scribe"); assert.ok(scribeRecord);
  const scribeDetail = await (await fetch(base + "/api/request-inspector?id=" + encodeURIComponent(scribeRecord.id))).json() as any;
  assert.equal(scribeDetail.payload.stream, false, "captured non-streaming transport matches the actual local HTTP request");
  assert.equal(scribeDetail.payload.stream_options, undefined);
  const writerCalls = requests.filter(r => r.model === "writer").length;
  assert.ok(requests.filter(r => r.model === "writer").some(r => JSON.stringify(r.messages).includes("user-selected-plot-direction-not-fact")));
  assert.ok(requests.filter(r => r.model === "director").some(r => JSON.stringify(r.messages).includes("user-selected-plot-direction-not-fact")), "the normal director receives only the selected direction, not the plot library");
  ws.send(JSON.stringify({ ...input, messageId: "stale-choice", plotChoice: { ...plotChoice, optionId: "missing-synthetic-option" } }));
  await until(() => frames.some(f => f.type === "prompt_ack" && f.messageId === "stale-choice"), "expired choice rejection");
  const staleAck = frames.find(f => f.type === "prompt_ack" && f.messageId === "stale-choice");
  assert.equal(staleAck.status, "rejected"); assert.match(staleAck.reason, /过期|失效/); assert.equal(frames.filter(f => f.type === "prompt_ack" && f.messageId === "stale-choice").length, 1, "pre-persistence rejection produces one precise ACK, not a later generic rejection"); assert.equal(requests.filter(r => r.model === "writer").length, writerCalls);
  const acknowledgements = frames.filter(f => f.type === "prompt_ack").length; ws.send(JSON.stringify(input)); await until(() => frames.filter(f => f.type === "prompt_ack").length > acknowledgements, "replay ACK");
  assert.equal(requests.filter(r => r.model === "writer").length, writerCalls);
  ws.send(JSON.stringify({ ...input, plotChoice: undefined })); await until(() => frames.some(f => f.type === "prompt_ack" && f.status === "rejected"), "changed-intent rejection");
  delay = true; const refreshed = await post("/api/plot-options/refresh", { contextKey: v.contextKey, controlKey: v.controlKey }); assert.equal(refreshed.status, 200);
  await until(() => !!release, "slow background model"); const ends = frames.filter(f => f.type === "agent" && f.state === "end").length;
  output = "第二楼合成正文仍正常交付。"; ws.send(JSON.stringify({ ...input, text: "继续正常RP。", messageId: "plot-msg-2", plotChoice: undefined }));
  await until(() => frames.filter(f => f.type === "agent" && f.state === "end").length > ends, "normal RP while planning pending");
  assert.equal((await get()).running, true); release(); await until(async () => !(await get()).running, "background completed");
  v = await get(); assert.equal(v.active.progress.status, "engaged"); assert.ok(v.active.progress.evidence.length);
  assert.equal(v.active.progress.nextSetup[0], "先明确书架的分工");
  const directedWriter = requests.filter(r => r.model === "writer").at(-1); assert.match(JSON.stringify(directedWriter.messages), /user-selected-plot-direction-not-fact/, "direction remains active across ordinary floors");
  const cancelled = await post("/api/plot-options/cancel", { contextKey: v.contextKey, controlKey: v.controlKey }); assert.equal(cancelled.status, 200); assert.equal(cancelled.body.active, null);
  delay = false; const afterCancelEnds = frames.filter(f => f.type === "agent" && f.state === "end").length;
  output = "结束引导后的合成普通对话。"; ws.send(JSON.stringify({ ...input, text: "我先不整理了，问她几点闭馆。", messageId: "plot-msg-3", plotChoice: undefined }));
  await until(() => frames.filter(f => f.type === "agent" && f.state === "end").length > afterCancelEnds, "ordinary RP after cancelling direction");
  assert.doesNotMatch(JSON.stringify(requests.filter(r => r.model === "writer").at(-1).messages), /user-selected-plot-direction-not-fact/, "cancelled direction must not be sent to the writer again");
  assert.doesNotMatch(JSON.stringify(requests.filter(r => r.model === "director").at(-1).messages), /user-selected-plot-direction-not-fact/, "cancelled direction must not be sent to the director again");
  assert.equal((await get()).active, null);
  brokenDaily = true; v = await get(); const attempts = requests.filter(r => r.model === "daily").length;
  await post("/api/plot-options/refresh", { contextKey: v.contextKey, controlKey: v.controlKey }); await until(async () => !(await get()).running, "broken planning ends without fallback retry");
  assert.equal(requests.filter(r => r.model === "daily").length, attempts + 1, "one-character model failure must not trigger hidden fallback calls");
  assert.ok((await get()).error);
  brokenDaily = false; dailyHttpFailure = true; v = await get(); const failedAttempts = requests.filter(r => r.model === "daily").length;
  await post("/api/plot-options/refresh", { contextKey: v.contextKey, controlKey: v.controlKey }); await until(async () => !(await get()).running, "provider failure is visible without hidden retries");
  assert.equal(requests.filter(r => r.model === "daily").length, failedAttempts + 1);
  assert.match((await get()).error, /合成筹备供应商暂时不可用/, "the provider failure must not be hidden behind an unrelated JSON parser error");
  const helloCount = frames.filter(f => f.type === "hello").length;
  ws.send(JSON.stringify({ type: "prompt", text: "/rewind 1" }));
  await until(() => frames.filter(f => f.type === "hello").length > helloCount, "rewind before restart");
  const sourceBeforeRestart = (await get()).sourceId;
  assert.ok(sourceBeforeRestart);
  // A real host restart while a paid optional request is pending must not duplicate it.
  dailyHttpFailure = false; delay = true; release = undefined; v = await get();
  await post("/api/plot-options/refresh", { contextKey: v.contextKey, controlKey: v.controlKey }); await until(() => !!release, "pending planner before restart");
  const paidBeforeRestart = requests.filter(r => r.model === "daily").length;
  ws.close(); child.kill("SIGTERM"); await new Promise<void>(r => child!.once("exit", () => r()));
  child = spawn(process.execPath, [join(root, "server/main.ts"), "--continue"], { cwd, env: { ...process.env, HOME: join(cwd, "home"), LIYUAN_CODING_AGENT_DIR: join(cwd, "agent"), HOST: "127.0.0.1", PORT: String(port), LIYUAN_PLAY_SLOT_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", x => { logs += x; }); child.stderr?.on("data", x => { logs += x; });
  await until(async () => { if (child?.exitCode != null) throw Error(logs.slice(-3000)); try { return (await fetch(base + "/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "host restart", 30000);
  await new Promise(r => setTimeout(r, 5500));
  assert.equal(requests.filter(r => r.model === "daily").length, paidBeforeRestart, "automatic tick must honor the persisted pending-attempt receipt after a process restart");
  assert.match((await get()).error, /未完成|失效|尚未完成/);
  const restartedFrames: any[] = []; ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { origin: base }); ws.on("error", () => {}); ws.on("message", raw => restartedFrames.push(JSON.parse(raw.toString())));
  await until(() => restartedFrames.some(f => f.type === "hello"), "restarted hello"); assert.equal(restartedFrames.find(f => f.type === "hello").sessionId, hello.sessionId);
  assert.equal((await get()).sourceId, sourceBeforeRestart, "restart must retain the selected branch, not the last serialized reply from an abandoned branch");
  const writersBeforeReplay = requests.filter(r => r.model === "writer").length;
  ws.send(JSON.stringify({ ...input, text: "我先不整理了，问她几点闭馆。", messageId: "plot-msg-3", plotChoice: undefined }));
  await until(() => restartedFrames.some(f => f.type === "prompt_ack" && f.messageId === "plot-msg-3" && f.status === "accepted"), "persisted replay after restart");
  assert.equal(requests.filter(r => r.model === "writer").length, writersBeforeReplay);

 } finally {
  release?.(); ws?.close(); if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(r => child!.once("exit", r)), new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
  await new Promise<void>(r => model.close(() => r())); rmSync(cwd, { recursive: true, force: true });
 }
});
