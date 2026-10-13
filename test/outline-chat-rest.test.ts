import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { handleApiRequest, type RestHost } from "../server/rest.ts";

async function request(method: string, url: string, payload?: unknown) {
	const calls: unknown[][] = [];
	const host = { cwd: "/tmp/synthetic-outline-rest-never-created", isStreaming: () => false, outline: {
		deleteChat: (...args: unknown[]) => calls.push(["delete", ...args]),
		clearChats: (...args: unknown[]) => calls.push(["clear", ...args]),
		getView: () => ({ chats: [{ requestId: "kept-fixture" }], state: { privateFieldsMustNotBeReturned: true } }),
		chat: async (...args: unknown[]) => { calls.push(["chat", ...args]); return { requestId: "fixture", reply: "Saved reply", warnings: [] }; },
	} } as unknown as RestHost;
	const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as Readable & { method: string; url: string };
	req.method = method; req.url = url;
	let status = 0, text = "";
	const res = { writeHead(code: number) { status = code; }, end(value = "") { text += value; } };
	assert.equal(await handleApiRequest(req as never, res as never, host), true);
	return { status, body: JSON.parse(text), calls };
}
test("REST single-round deletion forwards scoped identity and returns only settled discussion history", async () => {
	const result = await request("DELETE", "/api/outline/chats/fixture-id?contextKey=scope-fixture");
	assert.equal(result.status, 200);
	assert.deepEqual(result.calls, [["delete", "fixture-id", "scope-fixture",undefined]]);
	assert.deepEqual(result.body, { ok: true, chats: [{ requestId: "kept-fixture" }] });
});
test("REST discussion clear forwards context binding", async () => {
	const result = await request("DELETE", "/api/outline/chats?contextKey=scope-fixture");
	assert.deepEqual(result.calls, [["clear", "scope-fixture",undefined]]);
	assert.deepEqual(result.body, { ok: true, chats: [] });
});
test("REST validates bad discussion messages before sending 200 SSE headers", async () => {
	for (const message of ["", 42, "a".repeat(4001)]) {
		const result = await request("POST", "/api/outline/chat/stream", { message });
		assert.equal(result.status, 400); assert.equal(result.calls.length, 0);
	}
});
test("REST ordinary chat supports daily focus and context binding", async () => {
	const result = await request("POST", "/api/outline/chat", { message: "Question", focus: "daily", contextKey: "scope-fixture",discussionId:undefined });
	assert.equal(result.status, 200);
	assert.deepEqual(result.calls[0], ["chat", "Question", { research: false, focus: "daily", contextKey: "scope-fixture",discussionId:undefined }]);
});

test("director mutation cannot append discussion metadata into an active story generation",async()=>{
 const req=Readable.from([Buffer.from(JSON.stringify({title:"Concurrent topic",message:"Concurrent question"}))])as any;req.method="POST";req.url="/api/outline/discussions";let code=0,text="",calls=0;const res={writeHead(c:number){code=c;},end(t:string){text+=t;}};const host={cwd:"synthetic",isStreaming:()=>true,outline:{createDiscussion:()=>{calls++;}}}as unknown as RestHost;await handleApiRequest(req,res as never,host);assert.equal(code,409);assert.equal(calls,0);assert.match(JSON.parse(text).error,/生成|流式|结束|停止/);
});
