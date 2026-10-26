import { syntheticPlotGrounding } from "./fixtures/plot-grounding.ts";
import { PlotSemanticSearch } from "../src/plot-options/semantic.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlotOptionsEngine, completedPlotRounds, plotHistory, plotContextKey, type PlotContext } from "../src/plot-options/engine.ts";
import { plotCards, retrievePlotCards } from "../src/plot-options/library.ts";
import { createPlotLibraryLoader } from "../src/plot-options/loader.ts";
import { resolveStepModel } from "../src/model-routing.ts";
import { PromptOutbox, type ReliablePrompt } from "../web/src/ws-lifecycle.ts";
import { findPersistedSubmission, plotSubmissionKey, PromptDeliveryLedger } from "../server/prompt-delivery.ts";
import type { PlotSelection } from "../src/plot-options/types.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";
const pattern = (title = "合成旧书清点") => ({ docId: "doc-synthetic", title, locator: title, setting: "合成图书馆", surfaceActivity: "共同整理旧书", initiative: "角色自愿帮忙", sweetBeat: "发现做事习惯", friction: "分类意见", misunderstanding: "", microChange: "了解彼此", escalationLimit: "不预定关系", naturalStop: "完成一架书", failureWarning: "没有活动时先建立条件" });
const narrative = (id: string, text = "两人在教室里讨论图书馆旧书清点。") => ({ id, type: "message", message: { role: "assistant", content: text, details: { rpNarrative: text }, stopReason: "stop" } });
const wait = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw Error("synthetic task did not settle"); };
function fixture(run?: (sp: string, user: string, signal: AbortSignal, timeoutMs?: number) => Promise<string | { error: string }>, timeoutMs?: number | (() => number), semanticSearch?: PlotSemanticSearch) {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-plot-fixture-"));
 let ctx: PlotContext = { sessionId: "synthetic-session", cardIdentity: "card-v1", sourceId: "a0", branch: [narrative("a0")], card: { name: "合成卡" }, persona: "合成玩家", state: { location: "教室" }, outline: {}, outlineHash: "outline-v1", modelKey: "synthetic-model", skill: "synthetic skill" };
 let busy = false, calls = 0, outputProgress: unknown;
 const library = Array.from({ length: 80 }, (_, i) => pattern(i === 79 ? "合成旧书清点" : `合成海边活动${i}`));
 library.forEach((x, i) => { if (i !== 79) { x.setting = "海边"; x.surfaceActivity = "冲浪"; } });
 const engine = new PlotOptionsEngine({ cwd, context: () => ctx, busy: () => busy, library: () => library,
  run: async (sp, user, signal, timeoutMs) => { calls++; if (run) return run(sp, user, signal, timeoutMs); const payload = JSON.parse(user); return JSON.stringify({ options: [{ ...syntheticPlotGrounding(payload), cardId: payload.candidates[0].id, title: "合成一起清点", experience: "通过帮忙了解彼此", whyNow: "当前谈及图书馆", draft: "我问她有没有需要帮忙的地方。", prerequisites: ["角色愿意参与"], setup: ["先提到清点工作"], development: ["共同清点时发现彼此习惯"], boundaries: ["不预定关系"], entryCondition: "真实约定以后" }], progress: outputProgress }); },
  semanticSearch, appendControl: data => { ctx.branch.push({ id: `cancel${ctx.branch.length}`, type: "custom", customType: "rp-plot-direction", data }); }, timeoutMs });
 return { engine, cwd, library, get ctx() { return ctx; }, set ctx(c: PlotContext) { ctx = c; }, get calls() { return calls; }, set busy(x: boolean) { busy = x; }, set progress(x: unknown) { outputProgress = x; },
  async enable() { engine.settings({ enabled: true }, plotContextKey(ctx)); await wait(() => !engine.view().running); },
  cleanup() { engine.close(); rmSync(cwd, { recursive: true, force: true }); } };
}
test("full-library retrieval finds relevant daily cards beyond the first 16; browse has all pages", async () => {
 const f = fixture(); try {
  const ranked = retrievePlotCards(plotCards(f.library), "图书馆旧书清点", 3); assert.equal(ranked[0].title, "合成旧书清点");
  assert.equal(retrievePlotCards(plotCards(f.library), "", 100).length, 80);
  assert.equal(f.engine.library("", 60).cards.length, 20);
  await f.enable(); assert.equal(f.calls, 1); assert.equal(f.engine.view().options.length, 1); assert.equal(f.engine.view().libraryCount, 80);
  if (process.platform !== "win32") {
   assert.equal(statSync(join(f.cwd, ".liyuan/plot-options")).mode & 0o777, 0o700);
   assert.equal(statSync(join(f.cwd, ".liyuan/plot-options/settings.json")).mode & 0o777, 0o600);
  }
 } finally { f.cleanup(); }
});
test("draft resolution has no story side effects; only persisted selection guides later floors; cancel and restart", async () => {
 const f = fixture(); try {
  await f.enable(); const v = f.engine.view(), choice = { contextKey: v.contextKey, optionId: v.options[0].id };
  const selection = f.engine.resolve(choice); assert.equal(f.ctx.branch.length, 1); assert.equal(f.engine.reference(), undefined);
  f.ctx.branch.push({ id: "u1", type: "message", message: { role: "user", content: "我修改后的真正输入", details: { rpPlotSelection: selection, rpClientMessageId: "msg1" } } });
  assert.match(f.engine.reference()!, /user-selected-plot-direction-not-fact/);
  f.ctx.branch.push(narrative("a1")); f.ctx.sourceId = "a1";
  assert.match(f.engine.reference()!, /先提到清点工作/);
  const receipt = findPersistedSubmission(f.ctx.branch, "msg1")!; assert.deepEqual(receipt.plotChoice, choice);
  assert.equal(receipt.text, "我修改后的真正输入");
  f.engine.cancelDirection(choice.contextKey); assert.equal(f.engine.reference(), undefined);
  const restored = new PlotOptionsEngine({ cwd: f.cwd, context: () => f.ctx, busy: () => false, library: () => f.library, run: async () => "{}", appendControl: () => {} });
  assert.equal(restored.view().active, null); assert.equal(restored.view().options[0].id, v.options[0].id); restored.close();
 } finally { f.cleanup(); }
});
test("five/ten-floor cadence ignores half drafts and does not reset a selected direction", async () => {
 const f = fixture(); try {
  await f.enable(); const v = f.engine.view(), selection = f.engine.resolve({ contextKey: v.contextKey, optionId: v.options[0].id });
  f.ctx.branch.push({ id: "u", type: "message", message: { role: "user", content: "合成实际参与输入", details: { rpPlotSelection: selection } } });
  for (let i = 1; i <= 4; i++) f.ctx.branch.push(narrative(`n${i}`));
  f.ctx.branch.push(narrative("half"), { type: "custom", customType: "rp-turn-settlement", data: { narrativeEntryId: "half", authorComplete: false } });
  assert.equal(plotHistory(f.ctx.branch).some(h => h.id === "half"), false);
  assert.equal(completedPlotRounds(f.ctx.branch), 5); f.engine.tick(); assert.equal(f.calls, 1);
  f.ctx.branch.push(narrative("n5")); f.engine.tick(); await wait(() => !f.engine.view().running); assert.equal(f.calls, 2);
  assert.equal(f.engine.view().active?.entryId, "u");
  f.engine.settings({ interval: 10 }, v.contextKey);
  for (let i = 0; i < 9; i++) f.ctx.branch.push(narrative(`extra${i}`)); f.engine.tick(); assert.equal(f.calls, 2);
  f.ctx.branch.push(narrative("extra9")); f.engine.tick(); await wait(() => !f.engine.view().running); assert.equal(f.calls, 3);
 } finally { f.cleanup(); }
});
test("late background results are rejected after branch/card/outline changes; single worker and timeout", async () => {
 for (const change of ["branch", "card", "outline", "disable", "selection"] as const) {
  let release!: (x: string) => void;
  const f = fixture(async () => new Promise<string>(r => { release = r; }));
  try {
   const key = plotContextKey(f.ctx); f.engine.settings({ enabled: true }, key); assert.equal(f.engine.view().running, true);
   assert.throws(() => f.engine.refresh(key), /正在运行/);
   if (change === "branch") f.ctx = { ...f.ctx, sourceId: "brother", branch: [narrative("brother")] };
   if (change === "card") f.ctx = { ...f.ctx, cardIdentity: "other" };
   if (change === "outline") f.ctx = { ...f.ctx, outlineHash: "other" };
   if (change === "disable") f.engine.settings({ enabled: false }, key);
   if (change === "selection") f.ctx.branch.push({ id: "user-new-direction", message: { role: "user", details: { rpPlotSelection: { version: 1, contextKey: key, option: { id: "new" } } } } });
   release('{"options":[]}'); await new Promise(r => setTimeout(r, 10));
   assert.equal(f.engine.store.batches(key).length, 1);
   assert.equal(f.engine.store.batches(key)[0].options.length, 0);
   assert.match(f.engine.store.batches(key)[0].error!, /未完成|失效/);
  } finally { f.cleanup(); }
 }
 const f = fixture(async () => new Promise(() => {}), 20);
 try { await f.enable(); assert.match(f.engine.view().error!, /超时/); f.engine.tick(); assert.equal(f.calls, 1); }
 finally { f.cleanup(); }
});
test("no paid auto-retry; failures leave story untouched and missing independent model never borrows writer", async () => {
 const f = fixture(async () => ({ error: "synthetic provider error" }));
 try { await f.enable(); assert.match(f.engine.view().error!, /synthetic/); f.engine.tick(); assert.equal(f.calls, 1); assert.equal(f.ctx.branch.length, 1); }
 finally { f.cleanup(); }
 const primary = { id: "writer" }; assert.equal(resolveStepModel("dailyPlot", undefined, primary, () => undefined).model, undefined);
 assert.equal(resolveStepModel("dailyPlot", { dailyPlot: { provider: "missing", id: "gone" } }, primary, () => undefined).fallback, false);
});
test("source validation, fabricated candidates/progress, and sibling branches cannot manufacture story facts", async () => {
 const f = fixture(); try {
  await f.enable(); const v = f.engine.view(); const choice = { contextKey: v.contextKey, optionId: v.options[0].id };
  const selection = f.engine.resolve(choice);
  f.ctx.branch.push({ id: "u1", message: { role: "user", content: "合成实际参与输入", details: { rpPlotSelection: selection } } });
  f.progress = { status: "completed", note: "fake completion", evidence: [{ entryId: "a0", quote: "不存在的原句" }] };
  f.engine.refresh(v.contextKey); await wait(() => !f.engine.view().running);
  assert.equal(f.engine.view().active?.progress, undefined); assert.ok(f.engine.reference());
  f.ctx.branch.push(narrative("a1", "她主动提到图书馆旧书清点需要帮忙。"));
  f.progress = { status: "seeded", note: "只确认真实线索", evidence: [{ entryId: "a1", quote: "图书馆旧书清点需要帮忙" }], nextSetup: ["下一步再讨论时间"], nextEntryCondition: "双方时间合适" };
  f.engine.refresh(v.contextKey); await wait(() => !f.engine.view().running);
  assert.equal(f.engine.view().active?.progress?.status, "seeded");
  assert.match(f.engine.reference()!, /下一步再讨论时间/);
  f.library[79].surfaceActivity = "changed source"; assert.equal(f.engine.reference(), undefined); assert.equal(f.engine.view().active?.sourceAvailable, false); assert.throws(() => f.engine.resolve(choice), /过期/);
  f.ctx = { ...f.ctx, branch: [narrative("sibling")], sourceId: "sibling" };
  assert.equal(f.engine.view().options.length, 0); assert.equal(f.engine.reference(), undefined);
  assert.throws(() => f.engine.resolve(choice), /过期/);
 } finally { f.cleanup(); }
});
test("plot progress requires completed narrative after selection, including when reading saved receipts", async () => {
 const f = fixture(); try {
  await f.enable(); const view = f.engine.view(), selection = f.engine.resolve({ contextKey: view.contextKey, optionId: view.options[0].id });
  f.ctx.branch.push({ id: "selected-user", message: { role: "user", content: "我希望完成这次旧书清点。", details: { rpPlotSelection: selection } } });
  f.ctx.branch.push({ id: "later-user", message: { role: "user", content: "请让旧书清点顺利完成。" } });
  f.ctx.branch.push(narrative("half-progress", "我们已经完成所有旧书清点。"), { type: "custom", customType: "rp-turn-settlement", data: { narrativeEntryId: "half-progress", authorComplete: false } });
  for (const evidence of [
   { entryId: "selected-user", quote: "完成这次旧书清点" },
   { entryId: "later-user", quote: "旧书清点顺利完成" },
   { entryId: "a0", quote: "图书馆旧书清点" },
   { entryId: "half-progress", quote: "完成所有旧书清点" },
  ]) {
   f.progress = { status: "completed", note: "不能用计划或半稿完成方向", evidence: [evidence] };
   f.engine.refresh(view.contextKey); await wait(() => !f.engine.view().running);
   assert.equal(f.engine.view().active?.progress, undefined);
   assert.ok(f.engine.reference(), "unproven completion must not suppress the selected direction");
  }
  const batch = f.engine.store.batches(view.contextKey).at(-1)!;
  f.engine.store.save({ ...batch, progress: { selectionEntryId: "selected-user", status: "completed", note: "legacy intent-only receipt", evidence: [{ entryId: "selected-user", quote: "完成这次旧书清点" }] } });
  assert.equal(f.engine.view().active?.progress, undefined);
  assert.ok(f.engine.reference(), "saved intent-only progress must also be rejected on read");
  f.ctx.branch.push(narrative("completed-story", "两人终于完成了这次旧书清点。"));
  f.ctx.sourceId = "completed-story";
  f.progress = { status: "completed", note: "已保存完整正文", evidence: [{ entryId: "completed-story", quote: "完成了这次旧书清点" }] };
  f.engine.refresh(view.contextKey); await wait(() => !f.engine.view().running);
  assert.equal(f.engine.view().active?.progress?.status, "completed");
  assert.equal(f.engine.reference(), undefined);
 } finally { f.cleanup(); }
});
test("plot intent survives reliable outbox restart and rejects same-id different intent", () => {
 const map = new Map<string, string>(); const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
 const frame: ReliablePrompt = { type: "prompt", text: "edited text", sessionId: "session", messageId: "m1", generationMode: "direct", plotChoice: { contextKey: "a".repeat(64), optionId: "option1" } };
 const box = new PromptOutbox(storage); assert.equal(box.enqueue(frame, true).accepted, true);
 const restored = new PromptOutbox(storage); assert.deepEqual(restored.items[0].frame, frame);
 assert.equal(restored.enqueue({ ...frame, plotChoice: { ...frame.plotChoice!, optionId: "other" } }, true).accepted, false);
 const ledger = new PromptDeliveryLedger(), identity = { sessionId: "session", messageId: "m1" };
 assert.equal(ledger.begin("story", identity, plotSubmissionKey(frame.text, frame.plotChoice)), "new");
 assert.equal(ledger.begin("story", identity, plotSubmissionKey(frame.text)), "conflict");
 assert.equal(box.enqueue({ ...frame, text: "/new", messageId: "cmd" }, true).accepted, false);
});

test("ready-only library loader notices source changes, ignores traversal/symlinks and never reads original novels", () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-plot-loader-"));
 try {
  const dir = join(cwd, ".liyuan/outline/research/corpus"); mkdirSync(join(dir, "digests"), { recursive: true });
  writeFileSync(join(dir, "documents.json"), JSON.stringify([{ id: "doc-a", status: "ready" }, { id: "doc-not-ready", status: "running" }, { id: "../outside", status: "ready" }, { id: "doc-linked", status: "ready" }]));
  writeFileSync(join(dir, "digests/doc-a.json"), JSON.stringify({ dailyPatterns: [pattern(), null, { title: 42 }], originalText: "not part of returned material" }));
  writeFileSync(join(cwd, "outside.json"), JSON.stringify({ dailyPatterns: [pattern("outside")] })); if (process.platform !== "win32") symlinkSync(join(cwd, "outside.json"), join(dir, "digests/doc-linked.json"));
  const load = createPlotLibraryLoader(cwd); assert.equal(load().length, 1); assert.ok(!JSON.stringify(load()).includes("originalText"));
  writeFileSync(join(dir, "digests/doc-a.json"), JSON.stringify({ dailyPatterns: [pattern("updated title")] })); assert.equal(load()[0].title, "updated title");
  writeFileSync(join(dir, "documents.json"), "[]"); assert.equal(load().length, 0);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("an in-flight paid-attempt receipt survives restart without automatic duplicate billing", async () => {
 let release!: (value: string) => void;
 const f = fixture(async () => new Promise<string>(r => { release = r; }));
 try {
  const key = plotContextKey(f.ctx); f.engine.settings({ enabled: true }, key); assert.equal(f.calls, 1);
  let duplicateCalls = 0;
  const restarted = new PlotOptionsEngine({ cwd: f.cwd, context: () => f.ctx, busy: () => false, library: () => f.library, run: async () => { duplicateCalls++; return '{"options":[]}'; }, appendControl: () => {} });
  restarted.tick(); assert.equal(duplicateCalls, 0); assert.match(restarted.view().error!, /未完成|失效/); restarted.close();
  f.engine.cancel(); release('{"options":[]}'); await new Promise(r => setTimeout(r, 5));
 } finally { f.cleanup(); }
});

test("embedding batch-size is explicit and validated; old settings default to 32 without activating any feature", () => {
 const f = fixture(); try {
  assert.equal(f.engine.view().embeddingBatchSize, 32); assert.equal(f.engine.view().enabled, false); assert.equal(f.engine.view().semantic, false);
  f.engine.settings({ embeddingBatchSize: 1 }, plotContextKey(f.ctx)); assert.equal(f.engine.view().embeddingBatchSize, 1); assert.equal(f.calls, 0);
  assert.throws(() => f.engine.settings({ embeddingBatchSize: 2 as never }, plotContextKey(f.ctx)), /嵌入批量/);
 } finally { f.cleanup(); }
});

test("slow semantic retrieval does not spend the independent configured selection budget", async () => {
 const root = mkdtempSync(join(tmpdir(), "liyuan-plot-budget-"));
 let entered!: () => void, release!: () => void, embeddingCalls = 0, selectionSignal: AbortSignal | undefined, selectionBudget: number | undefined;
 const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
 const semantic = new PlotSemanticSearch({ root, provider: () => ({ key: "synthetic", model: "synthetic", async embed(texts) { if (++embeddingCalls === 1) { entered(); await gate; } return { vectors: texts.map(() => [1, 0]) }; } }) });
 const f = fixture(async (_sp, _user, signal, timeoutMs) => { selectionSignal = signal; selectionBudget = timeoutMs; return '{"options":[]}'; }, () => 20, semantic);
 try {
  const key = plotContextKey(f.ctx); f.engine.settings({ enabled: true, semantic: true }, key); await ready;
  await new Promise(r => setTimeout(r, 60)); assert.equal(f.calls, 0); assert.equal(f.engine.view().running, true);
  release(); await wait(() => !f.engine.view().running);
  assert.equal(f.calls, 1); assert.equal(f.engine.view().error, undefined); assert.equal(selectionSignal?.aborted, false); assert.equal(selectionBudget, 20); assert.equal(f.engine.view().lastRetrieval?.method, "hybrid");
 } finally { release(); f.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
test("selected model timeout, explicit cancellation and provider 524 retain different causes", async () => {
 const deadline = fixture(async () => new Promise(() => {}), 15);
 try { await deadline.enable(); assert.match(deadline.engine.view().error!, /选材超时.*本地时限 15ms/); assert.doesNotMatch(deadline.engine.view().error!, /已取消/); }
 finally { deadline.cleanup(); }
 const cancelled = fixture(async () => new Promise(() => {}), 1000);
 try { const key = plotContextKey(cancelled.ctx); cancelled.engine.settings({ enabled: true }, key); cancelled.engine.cancel(); await wait(() => !cancelled.engine.view().running); assert.match(cancelled.engine.view().error!, /未完成|失效/); assert.equal(cancelled.calls, 1); }
 finally { cancelled.cleanup(); }
 const provider = fixture(async () => ({ error: "HTTP 524: origin proxy read timeout" }));
 try { await provider.enable(); assert.match(provider.engine.view().error!, /HTTP 524/); assert.doesNotMatch(provider.engine.view().error!, /本地时限|已取消/); provider.engine.tick(); assert.equal(provider.calls, 1); }
 finally { provider.cleanup(); }
});

test("completed progress and newly prepared options never leak between reroll siblings sharing the selected user input", async () => {
 const f = fixture();
 try {
  await f.enable(); const base = [...f.ctx.branch], first = f.engine.view(), selection = f.engine.resolve({contextKey:first.contextKey,optionId:first.options[0].id});
  const user = { id:"selected-input", message:{role:"user",content:"我提出帮忙。",details:{rpPlotSelection:selection}} };
  f.ctx = {...f.ctx,branch:[...base,user,narrative("original-reply","她和我完成了这一架旧书的清点。")],sourceId:"original-reply"};
  f.progress = {status:"completed",note:"只引用本变体已保存事实",evidence:[{entryId:"original-reply",quote:"完成了这一架旧书的清点"}]};
  f.engine.refresh(first.contextKey);await wait(()=>!f.engine.view().running);const originalChoice=f.engine.view().options[0];assert.equal(f.engine.reference(),undefined);
  f.ctx = {...f.ctx,branch:[...base,user,narrative("rerolled-reply","她让我先等一下，还没有开始清点。")],sourceId:"rerolled-reply"};
  assert.equal(f.engine.view().active?.entryId,user.id);assert.equal(f.engine.view().active?.progress,undefined);assert.ok(f.engine.reference());
  assert.throws(()=>f.engine.resolve({contextKey:first.contextKey,optionId:originalChoice.id}),/过期/);
  const originalSession=f.ctx.sessionId;f.ctx={...f.ctx,sessionId:"other-session"};assert.equal(f.engine.reference(),undefined);assert.equal(f.engine.view().options.length,0);
  f.ctx={...f.ctx,sessionId:originalSession};assert.equal(f.engine.view().active?.entryId,user.id);
 }finally{f.cleanup();}
});

test('explicit model binding resumes an unpaid missing-model block once, clears stale configuration hint and preserves paid-failure no-retry', async () => {
 const f=fixture();try{
  f.ctx={...f.ctx,modelKey:''};await f.enable();assert.equal(f.calls,0);assert.match(f.engine.view().error??'',/配置独立/);
  assert.equal(f.engine.store.batches(plotContextKey(f.ctx)).at(-1)?.blockedBy,'model');
  f.ctx={...f.ctx,modelKey:'explicit-daily-model'};assert.equal(f.engine.view().error,undefined,'a saved model must immediately clear the stale missing-config hint');
  f.engine.tick();await wait(()=>!f.engine.view().running);assert.equal(f.calls,1);assert.equal(f.engine.view().options.length,1);
  f.engine.tick();await wait(()=>!f.engine.view().running);assert.equal(f.calls,1,'resume must not repeatedly call the configured model');
 }finally{f.cleanup();}
 const failed=fixture(async()=>({error:'synthetic paid provider failure'}));try{
  await failed.enable();assert.equal(failed.calls,1);assert.match(failed.engine.view().error??'',/provider failure/);
  failed.ctx={...failed.ctx,modelKey:'another-explicit-model'};failed.engine.tick();await wait(()=>!failed.engine.view().running);assert.equal(failed.calls,1,'a real failed request must still require an explicit retry');
 }finally{failed.cleanup();}
});

test('exact legacy missing-model receipt is recoverable without deleting history or reviving arbitrary old errors', async () => {
 const f=fixture();try{
  f.engine.store.settings({enabled:true});const key=plotContextKey(f.ctx);
  const legacy={contextKey:key,sourceId:f.ctx.sourceId,outlineHash:f.ctx.outlineHash,sourceHash:'legacy-synthetic',libraryHash:'legacy-synthetic',rounds:completedPlotRounds(f.ctx.branch),selectionEntryId:null,options:[],createdAt:'2026-01-01T00:00:00.000Z',error:'请在设置 → 模型插头配置独立的“日常剧情筹备”岗位；不会借用导演模型'};
  f.engine.store.save(legacy);assert.equal(f.engine.view().error,undefined);f.engine.tick();await wait(()=>!f.engine.view().running);assert.equal(f.calls,1);assert.equal(f.engine.view().options.length,1);
  assert.deepEqual(f.engine.store.batches(key)[0],legacy,'historical diagnostic must remain untouched');
  f.engine.tick();await wait(()=>!f.engine.view().running);assert.equal(f.calls,1);
 }finally{f.cleanup();}
});
