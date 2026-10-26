import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FishTtsHttp } from "../server/fish-tts-http.ts";
import { FishTtsStore } from "../server/fish-tts-store.ts";
import { defaultFishTtsConfig } from "../src/fish-tts.ts";

const config = () => ({ ...defaultFishTtsConfig(), enabled: true, voices: [
	{ id: "a", name: "角色甲", aliases: ["甲"], referenceId: "1".repeat(32), enabled: true },
	{ id: "b", name: "角色乙", aliases: ["乙"], referenceId: "2".repeat(32), enabled: true },
] });
async function fixture(fn: (ctx: any) => Promise<void>, options: { timeoutMs?: number; pending?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-fish-http-")); let source = "story-a", session = "session-a", card = "card-a", calls = 0;
	let response = () => new Response(Buffer.from("synthetic-audio"), { headers: { "content-type": "audio/mpeg" } });
	let captured: { url: string; init: RequestInit } | undefined, aborted = false;
	const api = new FishTtsHttp(cwd, { binding: () => ({ sessionId: session, card, sourceEntryId: source, visibleEntryIds: ["story-a", source] }) }, {
		env: {}, timeoutMs: options.timeoutMs,
		fetch: async (url, init) => {
			calls++; captured = { url, init };
			if (options.pending) await new Promise((_, reject) => { const stop = () => { aborted = true; reject(init.signal?.reason); }; if (init.signal?.aborted) stop(); else init.signal?.addEventListener("abort", stop, { once: true }); });
			return response();
		},
	});
	const server = createServer(async (req, res) => { if (!await api.handle(req, res)) { res.writeHead(404); res.end(); } });
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as any).port}`;
	const request = async (path: string, payload?: unknown, method = "POST") => { const res = await fetch(base + "/api/fish-tts/" + path, payload === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: res.status, data: await res.json() }; };
	const configure = async () => { const before = api.status(); const saved = await request("config", { ...before, config: config(), apiKey: "synthetic-key" }, "PUT"); assert.equal(saved.status, 200); return saved.data; };
	try { await fn({ cwd, api, base, request, configure, calls: () => calls, captured: () => captured, aborted: () => aborted, setSource: (s: string) => source = s, setSession: (s: string) => session = s, setCard: (s: string) => card = s, setResponse: (r: () => Response) => response = r }); }
	finally { api.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(cwd, { recursive: true, force: true }); }
}
test("status is read-only/default-off; config keys stay server-side and save uses source/revision CAS", async () => fixture(async ({ api, cwd, request, configure, calls, setSource }: any) => {
	const initial = await request("status"); assert.equal(initial.data.config.enabled, false); assert.equal(existsSync(join(cwd, ".liyuan-fish-tts")), false);
	const first = await configure(); assert.equal(first.keyConfigured, true); assert.equal(first.keySource, "saved"); assert.doesNotMatch(JSON.stringify(first), /synthetic-key|apiKey/);
	assert.equal((await request("config", { ...first, revision: 0, config: config() }, "PUT")).status, 409);
	const second = await request("config", { ...first, config: { ...config(), speed: 1.2 } }, "PUT"); assert.equal(second.status, 200); assert.equal(api.store.read().apiKey, "synthetic-key");
	setSource("story-b"); assert.equal((await request("config", { ...second.data, config: config() }, "PUT")).status, 409);
	assert.equal(calls(), 0);
	if (process.platform !== "win32") { assert.equal(lstatSync(join(cwd, ".liyuan-fish-tts")).mode & 0o777, 0o700); for (const name of ["config.json", "config.json.bak"]) assert.equal(lstatSync(join(cwd, ".liyuan-fish-tts", name)).mode & 0o777, 0o600); }
}));
test("preview never calls Fish or creates story state; unknown voices and stale sources fail", async () => fixture(async ({ request, configure, calls, setSource }: any) => {
	const status = await configure();
	const plan = await request("preview", { text: "甲：“早。”\n乙：“好。”", entryId: "story-a", entryScope: status.binding.scopeKey });
	assert.equal(plan.status, 200); assert.deepEqual(plan.data.segments.map((s: any) => s.voiceId), ["a", "b"]); assert.equal(calls(), 0);
	assert.equal((await request("preview", { text: "正文", entryScope: "other" })).status, 409);
	assert.equal((await request("preview", { text: "正文", entryId: "sibling" })).status, 409);
	assert.equal((await request("preview", { text: "正文", voiceId: "missing" })).status, 400);
	setSource("story-b"); assert.equal((await request("synthesize", { ...status, text: "甲：你好。" })).status, 409);
}));
test("synthesis uses original native multivoice body, fixed HTTPS host, binary private cache and no replay charges", async () => fixture(async ({ api, cwd, request, configure, calls, captured, base, setSource }: any) => {
	const status = await configure(), payload = { binding: status.binding, revision: status.revision, text: "甲：“早。”\n乙：“好。”", entryId: "story-a" };
	const result = await request("synthesize", payload); assert.equal(result.status, 200); assert.equal(result.data.cached, false); assert.equal(calls(), 1);
	assert.equal(captured().url, "https://api.fish.audio/v1/tts"); assert.equal(captured().init.redirect, "error");
	assert.deepEqual(JSON.parse(captured().init.body).reference_id, ["1".repeat(32), "2".repeat(32)]);
	assert.equal(JSON.parse(captured().init.body).text, "<|speaker:0|>早。<|speaker:1|>好。");
	assert.equal(captured().init.headers.model, "s2-pro"); assert.equal(captured().init.headers.authorization, "Bearer synthetic-key");
	assert.doesNotMatch(JSON.stringify(result.data), /synthetic-key/);
	const replay = await request("synthesize", payload); assert.equal(replay.data.cached, true); assert.equal(calls(), 1);
	const audio = await fetch(base + result.data.src); assert.equal(audio.status, 200); assert.equal(await audio.text(), "synthetic-audio"); assert.match(audio.headers.get("cache-control")!, /no-store/);
	const filename = readdirSync(join(cwd, ".liyuan-fish-tts/audio"))[0]; assert.match(filename, /^[a-f0-9]{64}\.mp3$/); assert.equal(readFileSync(join(cwd, ".liyuan-fish-tts/audio", filename)).toString(), "synthetic-audio");
	if (process.platform !== "win32") assert.equal(lstatSync(join(cwd, ".liyuan-fish-tts/audio", filename)).mode & 0o777, 0o600);
	setSource("story-b"); assert.equal((await fetch(base + result.data.src)).status, 409); assert.equal(api.status().busy, false);
}));
test("disabled plugin, missing key, invalid model and S1 multivoice cannot invoke Fish", async () => fixture(async ({ api, request, calls }: any) => {
	let status = api.status();
	assert.equal((await request("synthesize", { ...status, text: "甲：你好。" })).status, 400);
	const missing = await request("config", { ...status, config: config() }, "PUT"); status = missing.data;
	assert.equal((await request("synthesize", { ...status, text: "甲：你好。" })).status, 400);
	assert.equal((await request("config", { ...status, config: { ...config(), model: "unknown-paid-model" } }, "PUT")).status, 400);
	const s1 = await request("config", { ...status, config: { ...config(), model: "s1" }, apiKey: "synthetic-key" }, "PUT");
	assert.equal((await request("synthesize", { ...s1.data, text: "甲：早。\n乙：好。" })).status, 400); assert.equal(calls(), 0);
}));
test("an active request is not duplicated, and changing branches aborts without writing audio", async () => fixture(async ({ api, cwd, request, configure, calls, setSource, aborted }: any) => {
	const status = await configure(), payload = { ...status, text: "甲：你好。" };
	const first = request("synthesize", payload);
	while (!calls()) await new Promise(r => setTimeout(r, 10));
	assert.equal((await request("synthesize", payload)).status, 409);
	setSource("story-b"); const result = await first;
	assert.equal(result.status, 409); assert.equal(aborted(), true); assert.equal(calls(), 1); assert.equal(api.status().busy, false); assert.equal(existsSync(join(cwd, ".liyuan-fish-tts/audio")), false);
}, { pending: true }));
test("timeouts are cancelled once, never retried, and external error bodies/credentials are not reflected", async () => {
	await fixture(async ({ request, configure, calls, aborted }: any) => { const status = await configure(); const result = await request("synthesize", { ...status, text: "甲：你好。" }); assert.equal(result.status, 504); assert.match(result.data.error, /未自动重试/); assert.equal(calls(), 1); assert.equal(aborted(), true); }, { pending: true, timeoutMs: 30 });
	await fixture(async ({ request, configure, setResponse, calls }: any) => { const status = await configure(); setResponse(() => new Response("upstream synthetic-key", { status: 401 })); const result = await request("synthesize", { ...status, text: "甲：你好。" }); assert.equal(result.status, 502); assert.doesNotMatch(result.data.error, /synthetic-key/); assert.equal(calls(), 1); });
});
test("non-audio and oversized upstream bodies are rejected before cache commit", async () => fixture(async ({ request, configure, setResponse, cwd }: any) => {
	const status = await configure();
	for (const headers of [{ "content-type": "application/json" }, { "content-type": "audio/mpeg", "content-length": String(25 * 1024 * 1024) }]) {
		setResponse(() => new Response("not-audio", { headers }));
		assert.equal((await request("synthesize", { ...status, text: "甲：你好。" })).status, 502);
	}
	assert.equal(existsSync(join(cwd, ".liyuan-fish-tts/audio")), false);
}));
test("future private settings are retained but not returned; removing a key is explicit", async () => fixture(async ({ api, request, configure }: any) => {
	const first = await configure(); const stored = api.store.read(); stored.config.futureCredential = "synthetic-private-value"; stored.config.voices[0].futureCredential = "synthetic-private-value";
	api.store.save(first.revision, stored.config, undefined, () => {});
	let status = api.status(); assert.doesNotMatch(JSON.stringify(status), /futureCredential|synthetic-private-value/);
	const next = await request("config", { ...status, config: status.config }, "PUT"); assert.equal(next.status, 200); assert.equal(api.store.read().config.futureCredential, "synthetic-private-value"); assert.equal(api.store.read().config.voices[0].futureCredential, "synthetic-private-value");
	status = next.data; const removed = await request("config", { ...status, config: status.config, apiKey: "" }, "PUT"); assert.equal(removed.data.keyConfigured, false);
}));
test("private store refuses symlinks instead of touching their target", { skip: process.platform === "win32" }, () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-fish-symlink-"));
	try {
		const sentinel = join(cwd, "sentinel"); writeFileSync(sentinel, "untouched", { mode: 0o600 });
		const store = new FishTtsStore(cwd); store.save(0, config(), "synthetic-key", () => {});
		rmSync(join(store.root, "config.json")); symlinkSync(sentinel, join(store.root, "config.json"));
		assert.throws(() => store.read()); assert.equal(readFileSync(sentinel, "utf8"), "untouched");
		rmSync(join(store.root, "config.json")); writeFileSync(join(store.root, "config.json"), "{}", { mode: 0o644 }); chmodSync(join(store.root, "config.json"), 0o644); assert.throws(() => store.read(), /权限/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("audio URLs cannot be transplanted into a different source or replayed after host restart", async () => fixture(async ({ cwd, api, base, request, configure, setSource }: any) => {
	const status = await configure(), result = await request("synthesize", { ...status, text: "甲：测试来源。" });
	assert.equal(result.status, 200);
	const url = new URL(base + result.data.src); url.searchParams.set("token", "0".repeat(64)); assert.equal((await fetch(url)).status, 403);
	const moved = new URL(base + result.data.src); setSource("story-b"); moved.searchParams.set("sourceEntryId", "story-b"); assert.equal((await fetch(moved)).status, 403);
	assert.equal(api.store.read().config.enabled, true);
	const restarted = new FishTtsHttp(cwd, { binding: () => ({ sessionId: "session-a", card: "card-a", sourceEntryId: "story-a", visibleEntryIds: ["story-a"] }) }, { env: {} });
	const server = createServer(async (req, res) => { await restarted.handle(req, res); });
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
	try { const origin = `http://127.0.0.1:${(server.address() as any).port}`; assert.equal((await fetch(origin + result.data.src)).status, 403); }
	finally { restarted.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}));

test("near-full cache rejects new paid synthesis before calling Fish, while existing audio still replays", async () => fixture(async ({ cwd, request, configure, calls }: any) => {
	const status = await configure(), payload = { ...status, text: "甲：已有的缓存。" };
	assert.equal((await request("synthesize", payload)).status, 200);
	const directory = join(cwd, ".liyuan-fish-tts/audio");
	for (let index = 0; index < 10; index++) {
		const file = join(directory, index.toString(16).repeat(64) + ".mp3"); writeFileSync(file, "", { mode: 0o600 }); truncateSync(file, 24 * 1024 * 1024);
	}
	assert.equal((await request("synthesize", { ...payload, text: "甲：新的付费选段。" })).status, 507);
	assert.equal((await request("synthesize", payload)).data.cached, true); assert.equal(calls(), 1);
}));

test("free connection check works while disabled/no Key; only fixed public metadata GET, no text/auth or settings writes", async () => fixture(async ({ api, cwd, request, captured, calls, setSource }: any) => {
	const status = api.status(); assert.equal(status.config.enabled, false); assert.equal(status.keyConfigured, false);
	const result = await request("connection-check", { binding: status.binding, revision: status.revision });
	assert.equal(result.status, 200); assert.equal(result.data.reachable, true); assert.equal(result.data.synthesisRequested, false); assert.equal(result.data.keyChecked, false);
	assert.equal(captured().url, "https://api.fish.audio/model?page_size=1"); assert.equal(captured().init.method, "GET"); assert.equal(captured().init.body, undefined); assert.equal(captured().init.headers, undefined);
	assert.equal(existsSync(join(cwd, ".liyuan-fish-tts")), false); assert.equal(api.status().revision, 0);
	setSource("changed"); assert.equal((await request("connection-check", status)).status, 409); assert.equal(calls(), 1);
}));
test("network error reports cause category/code without reflecting nested credentials or retrying", async () => fixture(async ({ request, configure, setResponse, calls }: any) => {
	const status = await configure(); setResponse(() => { throw Object.assign(new Error("must-not-reflect synthetic-key private-proxy-credential synthetic-key"), { cause: Object.assign(new Error("hidden"), { code: "ECONNRESET" }) }); });
	const result = await request("synthesize", { ...status, text: "甲：你好。" }); assert.equal(result.status, 502); assert.match(result.data.error, /ECONNRESET/); assert.match(result.data.error, /兼容直连/); assert.doesNotMatch(result.data.error, /synthetic-key|must-not-reflect|user:pass/); assert.equal(calls(), 1);
}));
