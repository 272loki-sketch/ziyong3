import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutlineEngine } from "../src/outline/engine.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

class DiscussionSession {
	entries: BranchEntryLike[] = [{ id: "story-root", type: "message", message: { role: "user", content: "Synthetic story fact" } }];
	getBranch() { return this.entries; }
	getLeafId() { return this.entries.at(-1)?.id ?? null; }
	getSessionId() { return "synthetic-discussion"; }
	appendCustomEntry(customType: string, data?: unknown) { const id = `custom-${this.entries.length}`; this.entries.push({ id, type: "custom", customType, data }); return id; }
	flush() {}
}
function fixture(run: (engine: OutlineEngine, sm: DiscussionSession, calls: any[]) => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-discussion-"));
	const sm = new DiscussionSession(), calls: any[] = [];
	const engine = new OutlineEngine({ cwd, getSessionManager: () => sm,
		loadMaterials: () => ({ config: { card: "fixture-card", userName: "Fixture" }, card: { name: "Fixture" }, skillFiles: [{ workflow: "outline-chat", body: "Synthetic JSON discussion contract" }] } as never),
		runSideModel: async (_step, _system, text, options) => { calls.push({ packet: JSON.parse(text), options }); return JSON.stringify({ answer: `Synthetic reply ${calls.length}`, options: [], proposal: null }); },
		getContext: () => ({ cardKey: "fixture-card", history: [{ role: "user", text: "Synthetic story fact" }] }),
	});
	return run(engine, sm, calls).finally(() => rmSync(cwd, { recursive: true, force: true }));
}
test("discussion streaming must not force a non-streaming provider call", () => fixture(async (engine, _sm, calls) => {
	await engine.chat("Synthetic question", { onDelta() {} });
	assert.equal(calls[0].options.forceNonStreaming, false);
}));
test("discussion continuation includes previous user and director replies separately from story history", () => fixture(async (engine, _sm, calls) => {
	await engine.chat("First synthetic question");
	await engine.chat("Continue the previous direction");
	assert.deepEqual(calls[1].packet.context.discussionHistory.map((r: any) => [r.role, r.text]), [["user", "First synthetic question"], ["assistant", "Synthetic reply 1"]]);
	assert.equal(calls[1].packet.context.history[0].text, "Synthetic story fact");
}));

test("only the eight most recent successful discussion rounds reach the next request", () => fixture(async (engine, _sm, calls) => {
	for (let i = 0; i < 12; i++) await engine.chat(`Question ${i}`);
	const history = calls.at(-1).packet.context.discussionHistory;
	assert.equal(history.length, 16);
	assert.equal(history[0].text, "Question 3");
	assert.equal(history.at(-2).text, "Question 10");
	assert.equal(engine.getView().chats.length, 12);
}));
test("delete one discussion round removes both sides from display and future context, not story or proposals", () => fixture(async (engine, sm, calls) => {
	await engine.chat("Delete this question"); await engine.chat("Keep this question");
	const first = engine.getView().chats[0];
	const before = structuredClone(sm.entries);
	engine.deleteChat(first.requestId, engine.getView().contextKey);
	assert.deepEqual(sm.entries.slice(0, before.length), before);
	assert.equal(sm.entries.at(-1)?.customType, "rp-outline-chat-delete");
	assert.deepEqual(engine.getView().chats.map(c => c.user), ["Keep this question"]);
	await engine.chat("Continue");
	assert.equal(JSON.stringify(calls.at(-1).packet.context.discussionHistory).includes("Delete this question"), false);
	assert.throws(() => engine.deleteChat(first.requestId), /不存在|已删除/);
}));
test("clear discussion empties continuation context and keeps existing branch entries", () => fixture(async (engine, sm, calls) => {
	await engine.chat("Discard discussion");
	const before = structuredClone(sm.entries);
	engine.clearChats();
	assert.deepEqual(sm.entries.slice(0, before.length), before);
	await engine.chat("Start again");
	assert.deepEqual(calls.at(-1).packet.context.discussionHistory, []);
	assert.equal(engine.getView().chats.length, 1);
}));
test("discussion view is bounded to the latest 80 rounds and remains readable on engine recreation", () => fixture(async (engine, sm) => {
	for (let i = 0; i < 82; i++) await engine.chat(`Persisted ${i}`);
	assert.equal(engine.getView().chats.length, 80);
	assert.equal(engine.getView().chats[0].user, "Persisted 2");
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-discussion-reopen-"));
	try {
		const reopened = new OutlineEngine({ cwd, getSessionManager: () => sm, loadMaterials: () => ({ config: { card: "fixture-card" } } as never), runSideModel: async () => "{}" });
		assert.deepEqual(reopened.getView().chats, engine.getView().chats);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
}));
test("stale room cannot clear, delete, or submit to a different story branch", () => fixture(async (engine, sm) => {
	await engine.chat("Saved question");
	const key = engine.getView().contextKey, id = engine.getView().chats[0].requestId;
	sm.entries.push({ id: "new-story", type: "message", message: { role: "assistant", content: "New synthetic story" } });
	assert.notEqual(engine.getView().contextKey, key);
	assert.throws(() => engine.clearChats(key), /分支已变化/);
	assert.throws(() => engine.deleteChat(id, key), /分支已变化/);
	await assert.rejects(engine.chat("Stale question", { contextKey: key }), /分支已变化/);
	assert.equal(engine.getView().chats.length, 1);
}));

test("cancel and simultaneous Enter requests cannot save late responses or hang on an uncancellable provider", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-discussion-abort-")), sm = new DiscussionSession();
	let called!: () => void;
	const started = new Promise<void>(resolve => { called = resolve; });
	let resolveLate!: (text: string) => void;
	const late = new Promise<string>(resolve => { resolveLate = resolve; });
	const engine = new OutlineEngine({ cwd, getSessionManager: () => sm, loadMaterials: () => ({ config: { card: "fixture-card" }, skillFiles: [{ workflow: "outline-chat", body: "fixture" }] } as never), runSideModel: async () => { called(); return late; } });
	try {
		const controller = new AbortController();
		const first = engine.chat("Pending", { signal: controller.signal });
		const outcome = assert.rejects(first, /cancel fixture/);
		await started;
		await assert.rejects(engine.chat("Double Enter"), /上一条讨论/);
		controller.abort(new Error("cancel fixture")); await outcome;
		resolveLate(JSON.stringify({ answer: "Late reply" }));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(engine.getView().chats.length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("empty answers are errors rather than phantom successful replies", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-discussion-empty-")), sm = new DiscussionSession();
	try {
		const engine = new OutlineEngine({ cwd, getSessionManager: () => sm, loadMaterials: () => ({ config: { card: "fixture" }, skillFiles: [{ workflow: "outline-chat", body: "fixture" }] } as never), runSideModel: async () => '{"answer":""}' });
		await assert.rejects(engine.chat("Question"), /有效回答/);
		assert.equal(engine.getView().chats.length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("deleting a discussion does not invalidate its independently stored outline proposal", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-discussion-proposal-")), sm = new DiscussionSession();
	let engine: OutlineEngine;
	try {
		engine = new OutlineEngine({ cwd, getSessionManager: () => sm,
			loadMaterials: () => ({ config: { card: "fixture" }, skillFiles: [{ workflow: "outline-chat", body: "fixture" }] } as never),
			runSideModel: async (_step, _system, text) => {
				const packet = JSON.parse(text);
				return JSON.stringify({ answer: "Synthetic candidate", proposal: { version: 1, id: "kept-proposal", mode: "manual", kind: "chat", baseRevision: packet.request.baseRevision, baseHash: packet.request.baseHash, baseLeafId: packet.context.baseLeafId, rationale: "Synthetic proposal", researchInspirationIds: [], patch: { premise: "Independent synthetic outline" } } });
			},
		});
		const reply = await engine.chat("Create a candidate");
		engine.deleteChat(reply.requestId);
		assert.equal(engine.getView().chats.length, 0);
		assert.equal(engine.getView().pending.length, 1);
		await engine.confirm("kept-proposal", reply.proposalHash!);
		assert.equal(engine.getView().state.premise, "Independent synthetic outline");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("同剧情多个独立导演对谈：新建不删除，切回续聊只携带本对谈历史，重启保留选中与改名",()=>fixture(async(engine,sm,calls)=>{
 await engine.chat("Original subject");const original=engine.getView().chats[0];
 const created=engine.createDiscussion("Character topic",engine.getView().contextKey),id=created.discussionId;
 assert.equal(created.chats.length,0);assert.equal(created.discussions.find(t=>t.id==="default")?.rounds,1);
 await engine.chat("Character question",{discussionId:id});assert.deepEqual(calls.at(-1).packet.context.discussionHistory,[]);
 const second=engine.createDiscussion("Plot topic",engine.getView().contextKey).discussionId;await engine.chat("Plot question",{discussionId:second});assert.deepEqual(calls.at(-1).packet.context.discussionHistory,[]);
 engine.selectDiscussion(id,engine.getView().contextKey);await engine.chat("Continue character",{discussionId:id});assert.equal(calls.at(-1).packet.context.discussionHistory[0].text,"Character question");assert.doesNotMatch(JSON.stringify(calls.at(-1).packet.context.discussionHistory),/Plot question|Original subject/);
 engine.renameDiscussion(id,"Character inspiration",engine.getView().contextKey);assert.equal(engine.getView().discussions.find(t=>t.id===id)?.title,"Character inspiration");
 engine.clearChats(engine.getView().contextKey,id);assert.equal(engine.getView().chats.length,0);engine.selectDiscussion("default");assert.equal(engine.getView().chats[0].requestId,original.requestId);
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-discussion-reload-"));try{const reload=new OutlineEngine({cwd,getSessionManager:()=>sm,loadMaterials:()=>({config:{card:"fixture-card"}}as never),runSideModel:async()=>"{}"});assert.deepEqual(reload.getView().discussions,engine.getView().discussions);assert.equal(reload.getView().discussionId,"default");}finally{rmSync(cwd,{recursive:true,force:true});}
}));
test("长对谈不删除旧轮次：80轮分页读取，模型续聊仍只8轮",()=>fixture(async(engine,_sm,calls)=>{
 for(let i=0;i<83;i++)await engine.chat(`Earlier round ${i}`);
 const view=engine.getView();assert.equal(view.discussionTotalRounds,83);const page=engine.discussionPage("default",view.chats[0].requestId,view.contextKey);assert.equal(page.chats.length,3);assert.equal(page.chats[0].user,"Earlier round 0");assert.equal(page.hasMore,false);assert.equal(calls.at(-1).packet.context.discussionHistory.length,16);
 assert.throws(()=>engine.selectDiscussion("not-owned"),/不属于|不存在/);assert.throws(()=>engine.renameDiscussion("default","  "),/标题/);
}));
