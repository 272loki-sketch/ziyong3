import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { BranchEntryLike } from "../src/stage/assemble.ts";
import { handleNovelAiRequest } from "../server/novelai-http.ts";
import { handleApiRequest, type RestHost } from "../server/rest.ts";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
function fixture(t: { after(fn: () => void): void }) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-nai-rest-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
	let context: {sessionId: string; card: string; leafId: string; branch: BranchEntryLike[]} = { sessionId: "session-a", card: "synthetic.png", leafId: "story-a", branch: [{ id: "story-a", type: "message", message: { role: "assistant", content: "synthetic narrative", stopReason: "stop" } }] };
	const host = { cwd, worldProfileContext: () => context };
	let calls = 0;
	let fetchFn = (async () => { calls++; return new Response(PNG, { headers: { "content-type": "image/png" } }); }) as typeof fetch;
	async function call(method: string, url: string, data?: unknown, viaRest = false) {
		const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]) as any; req.method = method; req.url = url;
		let code = 0, value = "", headers = {};
		const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false,
			writeHead(status: number, h: any) { code = status; headers = h; this.headersSent = true; }, end(body = "") { value += body; this.writableEnded = true; } });
		const handled = viaRest ? await handleApiRequest(req, res as never, host as RestHost) : await handleNovelAiRequest(req, res as never, host, { fetchFn, minStartGapMs: 0 });
		return { handled, code, data: value ? JSON.parse(value) : null, headers };
	}
	return { cwd, host, call, get calls() { return calls; }, get context() { return context; }, set context(value) { context = value; }, set fetchFn(fn: typeof fetch) { fetchFn = fn; } };
}
async function enable(f: ReturnType<typeof fixture>) {
	const status = (await f.call("GET", "/api/novelai")).data;
	const result = await f.call("PUT", "/api/novelai", { ...status.config, binding: status.binding, revision: status.revision, apiKey: "synthetic-never-return", enabled: true });
	assert.equal(result.code, 200); return result.data;
}
function input(status: any) { return { prompt: "tree", binding: status.binding, revision: status.revision, entryId: "story-a", entryScope: status.binding.scopeKey }; }

test("restored /api routes are wired, status is no-store and credential-free, GET is read-only", async t => {
	const f = fixture(t);
	const result = await f.call("GET", "/api/novelai", undefined, true);
	assert.equal(result.handled, true); assert.equal(result.code, 200); assert.equal(result.data.config.enabled, false);
	assert.equal(result.data.apiKeyConfigured, false); assert.equal(result.data.config.apiKey, undefined);
	assert.equal((result.headers as any)["cache-control"], "private, no-store");
	assert.deepEqual(readdirSync(f.cwd), []); assert.equal(f.calls, 0);
	const saved = await enable(f); assert.equal(saved.apiKeyConfigured, true); assert.doesNotMatch(JSON.stringify(saved), /synthetic-never-return/);
	assert.equal((await f.call("PUT", "/api/novelai", { revision: saved.revision, enabled: false, binding: { scopeKey: "bad" } })).code, 409);
	assert.equal((await f.call("POST", "/api/novelai/generate", { prompt: "tree" })).code, 409);
	assert.equal(f.calls, 0);
});

test("manual generation/cache enforce saved entry, current session/card, revision and legal branch", async t => {
	const f = fixture(t), status = await enable(f), request = input(status);
	for (const patch of [{ entryId: "sibling" }, { entryScope: "x" }, { revision: "old" }]) assert.equal((await f.call("POST", "/api/novelai/generate", { ...request, ...patch })).code, 409);
	for (const [id, role, stopReason] of [["user-entry", "user", "stop"], ["unfinished", "assistant", "aborted"], ["failed", "assistant", "error"], ["truncated", "assistant", "length"]]) {
		f.context = { ...f.context, branch: [...f.context.branch, { id, type: "message", message: { role, stopReason, content: "synthetic non-final text" } }] };
		assert.equal((await f.call("POST", "/api/novelai/generate", { ...request, entryId: id })).code, 409);
	}
	assert.equal(f.calls, 0);
	const generated = await f.call("POST", "/api/novelai/generate", request);
	assert.equal(generated.code, 200); assert.equal(f.calls, 1);
	const q = new URLSearchParams({ prompt: "tree", entryId: request.entryId, entryScope: request.entryScope });
	assert.deepEqual((await f.call("GET", `/api/novelai/cached?${q}`)).data, generated.data); assert.equal(f.calls, 1);
	f.context = { ...f.context, sessionId: "session-b" };
	assert.equal((await f.call("POST", "/api/novelai/generate", request)).code, 409);
	assert.equal((await f.call("GET", `/api/novelai/cached?${q}`)).code, 409);
	assert.equal(f.calls, 1);
});

test("late response after a branch switch cannot write media or cache, and no retry occurs", async t => {
	const f = fixture(t), status = await enable(f);
	let release!: () => void, started!: () => void;
	const blocked = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
	f.fetchFn = (async () => { started(); await blocked; return new Response(PNG); }) as typeof fetch;
	const pending = f.call("POST", "/api/novelai/generate", input(status));
	await entered;
	f.context = { ...f.context, leafId: "sibling", branch: [{ id: "sibling", type: "message", message: { role: "assistant", content: "synthetic sibling", stopReason: "stop" } }] };
	release();
	assert.equal((await pending).code, 409);
	assert.deepEqual(readdirSync(f.cwd), [".liyuan"]);
	assert.deepEqual(readdirSync(join(f.cwd, ".liyuan")), ["novelai-generation.json"]);
});

test("a real branch switch rejects late media even when the image source remains a shared ancestor", async t => {
	const f = fixture(t);
	f.context = { ...f.context, leafId: "metadata-a", branch: [...f.context.branch, { id: "metadata-a", type: "custom" }] };
	const status = await enable(f);
	let release!: () => void, started!: () => void;
	const blocked = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
	f.fetchFn = (async () => { started(); await blocked; return new Response(PNG); }) as typeof fetch;
	const pending = f.call("POST", "/api/novelai/generate", input(status));
	await entered;
	f.context = { ...f.context, leafId: "metadata-b", branch: [f.context.branch[0], { id: "metadata-b", type: "custom" }] };
	release();
	assert.equal((await pending).code, 409); assert.deepEqual(readdirSync(f.cwd), [".liyuan"]);
});

test("background metadata appends preserve the legal branch anchor while an image is generated", async t => {
	const f = fixture(t), status = await enable(f);
	let release!: () => void, started!: () => void;
	const blocked = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
	f.fetchFn = (async () => { started(); await blocked; return new Response(PNG); }) as typeof fetch;
	const pending = f.call("POST", "/api/novelai/generate", input(status));
	await entered;
	f.context = { ...f.context, leafId: "metadata", branch: [...f.context.branch, { id: "metadata", type: "custom" }] };
	release(); assert.equal((await pending).code, 200);
});
