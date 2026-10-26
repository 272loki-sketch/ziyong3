import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildNovelAiPayload, generateNovelAiImageCached, getCachedNovelAiImage, loadNovelAiConfig, updateNovelAiConfig } from "../src/novelai.ts";
import { DEFAULT_NOVELAI_SETTINGS } from "../src/novelai-types.ts";
import { novelAiEndpoint, novelAiProxy } from "../src/novelai-network.ts";
import { findHistoricalImage } from "../src/historical-images.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const source = { scopeKey: "a".repeat(64), entryId: "story-a" };
const imageResponse = () => new Response(PNG, { headers: { "content-type": "image/png" } });
function fixture(t: { after(fn: () => void): void }) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-nai-restored-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}
function enable(cwd: string, patch = {}) { return updateNovelAiConfig(cwd, { revision: loadNovelAiConfig(cwd).revision, enabled: true, apiKey: "synthetic-key", ...patch }); }

test("new defaults and legacy enabled configs are read-only and disabled until explicit save", t => {
	const cwd = fixture(t);
	assert.equal(loadNovelAiConfig(cwd).config.enabled, false);
	assert.deepEqual(readdirSync(cwd), []);
	mkdirSync(join(cwd, ".liyuan"), { mode: 0o700 });
	const path = join(cwd, ".liyuan/novelai.json");
	const before = JSON.stringify({ ...DEFAULT_NOVELAI_SETTINGS, enabled: true, apiKey: "synthetic-legacy-key", unknownPrivate: { preserve: true } });
	writeFileSync(path, before, { mode: 0o600 });
	const old = loadNovelAiConfig(cwd);
	assert.equal(old.legacySettings, true); assert.equal(old.config.enabled, false);
	const next = updateNovelAiConfig(cwd, { revision: old.revision, enabled: true });
	assert.equal(next.config.enabled, true); assert.equal(next.apiKey, "synthetic-legacy-key");
	assert.deepEqual(next.raw.unknownPrivate, { preserve: true });
	assert.equal(readFileSync(path, "utf8"), before);
	if (process.platform !== "win32") assert.equal(statSync(join(cwd, ".liyuan/novelai-generation.json")).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(join(cwd, ".liyuan")).sort(), ["novelai-generation.json", "novelai.json"]);
});

test("settings CAS, blank Key preservation, explicit clearing, atomic backup and whitelist", t => {
	const cwd = fixture(t), initial = enable(cwd);
	const changed = updateNovelAiConfig(cwd, { revision: initial.revision, apiKey: "", steps: 30, injectedSecret: "must-not-save" });
	assert.equal(changed.apiKey, "synthetic-key"); assert.equal(changed.config.steps, 30);
	assert.equal(changed.raw.injectedSecret, undefined);
	assert.equal(JSON.parse(readFileSync(join(cwd, ".liyuan/novelai-generation.json.bak"), "utf8")).steps, initial.config.steps);
	assert.throws(() => updateNovelAiConfig(cwd, { revision: initial.revision, steps: 20 }), /已变化/);
	assert.throws(() => updateNovelAiConfig(cwd, { revision: changed.revision, clearApiKey: true }), /API Key/);
	const cleared = updateNovelAiConfig(cwd, { revision: changed.revision, enabled: false, clearApiKey: true });
	assert.equal(cleared.apiKey, ""); assert.equal(cleared.config.enabled, false);
});

test("invalid settings and corrupt or linked private files are not overwritten", t => {
	const cwd = fixture(t), initial = enable(cwd);
	const path = join(cwd, ".liyuan/novelai-generation.json"), before = readFileSync(path);
	const credentialUrl = new URL("https://fixture.invalid"); credentialUrl.username = "synthetic-user"; credentialUrl.password = "synthetic-password";
	for (const patch of [{ width: 1001 }, { steps: 999 }, { scale: "7" }, { enabled: "true" }, { apiKey: "key\nheader" }, { baseUrl: "http://remote.invalid" }, { baseUrl: "ftp://localhost" }, { baseUrl: credentialUrl.href }, { baseUrl: "https://fixture.invalid/?secret=1" }]) {
		assert.throws(() => updateNovelAiConfig(cwd, { revision: initial.revision, ...patch })); assert.deepEqual(readFileSync(path), before);
	}
	writeFileSync(path, "not json", { mode: 0o600 });
	assert.throws(() => loadNovelAiConfig(cwd), /JSON/); assert.equal(readFileSync(path, "utf8"), "not json");
	if (process.platform !== "win32") {
		rmSync(path); const other = join(cwd, "other.json"); writeFileSync(other, before, { mode: 0o600 }); symlinkSync(other, path);
		assert.throws(() => loadNovelAiConfig(cwd)); assert.deepEqual(readFileSync(other), before);
	}
});

test("V4.5 payload reuses the current multiline scene/character parser and all configured parameters", () => {
	const payload = buildNovelAiPayload({ ...DEFAULT_NOVELAI_SETTINGS, positivePrefix: "prefix", positiveSuffix: "suffix", negativePrompt: "fixed negative" }, "image###Scene Composition: tree,\ncloud; Character 1 Prompt: blue coat|centers:0.3,0.7; Character 1 UC: blur; Character 2 Prompt: red coat;###", "request negative", 123);
	assert.equal(payload.input, "prefix, tree,\ncloud;, suffix");
	assert.equal(payload.parameters.seed, 123); assert.equal(payload.parameters.n_samples, 1);
	assert.equal(payload.parameters.noise_schedule, "karras");
	assert.equal(payload.parameters.v4_prompt.caption.char_captions.length, 2);
	assert.deepEqual(payload.parameters.v4_prompt.caption.char_captions[0].centers, [{ x: 0.3, y: 0.7 }]);
	assert.equal(payload.parameters.negative_prompt, "fixed negative, request negative");
	assert.throws(() => buildNovelAiPayload(DEFAULT_NOVELAI_SETTINGS, "image###Scene Composition: tree; Character 1 Prompt: coat|centers:2,0.7;###"), /坐标/);
});

test("network routes are explicit, redirect-free, HTTPS or loopback only, and do not inherit research proxy", () => {
	assert.equal(novelAiEndpoint("https://fixture.invalid/prefix/").href, "https://fixture.invalid/prefix/ai/generate-image");
	assert.equal(novelAiEndpoint("http://127.0.0.1:8123/ai/generate-image").href, "http://127.0.0.1:8123/ai/generate-image");
	assert.equal(novelAiProxy({ LIYUAN_WEB_RESEARCH_PROXY: "http://must-not-use.invalid" }), null);
	assert.equal(novelAiProxy({ LIYUAN_NOVELAI_PROXY: "direct" }), null);
	assert.equal(novelAiProxy({ LIYUAN_NOVELAI_PROXY: "http://localhost:7890" })?.hostname, "localhost");
	assert.throws(() => novelAiProxy({ LIYUAN_NOVELAI_PROXY: "socks5://localhost:7890" }));
});

test("persistent scoped cache and duplicate subscribers generate only once; disk/GET never generate", async t => {
	const cwd = fixture(t); enable(cwd);
	let calls = 0;
	const fetchFn = (async (_url, init) => { calls++; assert.equal(init?.redirect, "error"); await new Promise(resolve => setTimeout(resolve, 15)); return imageResponse(); }) as typeof fetch;
	const opts = { source, fetchFn, minStartGapMs: 0 };
	assert.equal(getCachedNovelAiImage(cwd, "tree", opts), null);
	const [first, second] = await Promise.all([generateNovelAiImageCached(cwd, "tree", opts), generateNovelAiImageCached(cwd, " tree ", opts)]);
	assert.deepEqual(first, second); assert.equal(calls, 1);
	assert.match(first.src, /^\/media\/nai-[a-f0-9]{64}\.png$/);
	assert.deepEqual(readFileSync(join(cwd, ".liyuan-media", first.src.split("/").at(-1)!)), PNG);
	assert.deepEqual(getCachedNovelAiImage(cwd, "tree", opts), first);
	assert.deepEqual(await generateNovelAiImageCached(cwd, "tree", opts), first); assert.equal(calls, 1);
	assert.equal(getCachedNovelAiImage(cwd, "tree", { source: { ...source, entryId: "sibling" } }), null);
	assert.equal(getCachedNovelAiImage(cwd, "tree", { source: { ...source, scopeKey: "b".repeat(64) } }), null);
	assert.equal(findHistoricalImage(cwd, "tree"), null, "new writes do not repurpose the historical index");
	const changed = updateNovelAiConfig(cwd, { revision: loadNovelAiConfig(cwd).revision, steps: 29 });
	assert.equal(changed.config.steps, 29); assert.equal(getCachedNovelAiImage(cwd, "tree", opts), null);
	if (process.platform !== "win32") assert.equal(statSync(join(cwd, ".liyuan/novelai-image-cache-v2.json")).mode & 0o777, 0o600);
});

test("disabled, incomplete and invalid requests never call a paid endpoint", async t => {
	const cwd = fixture(t); let calls = 0;
	const fetchFn = (async () => { calls++; return imageResponse(); }) as typeof fetch;
	await assert.rejects(generateNovelAiImageCached(cwd, "tree", { source, fetchFn }), /未启用/);
	enable(cwd);
	for (const prompt of ["", "<image>tree", "image###tree", "x".repeat(100001)]) await assert.rejects(generateNovelAiImageCached(cwd, prompt, { source, fetchFn }));
	await assert.rejects(generateNovelAiImageCached(cwd, "tree", { source, seed: -1, fetchFn }));
	await assert.rejects(generateNovelAiImageCached(cwd, "tree", { source, negativePrompt: 12 as never, fetchFn }));
	assert.equal(calls, 0);
});

test("failures do not echo provider bodies or Key, save bogus images, or auto-retry", async t => {
	const cwd = fixture(t); enable(cwd); let calls = 0;
	for (const response of [() => new Response('synthetic-key private provider error', { status: 401 }), () => new Response('<html>synthetic-key</html>'), () => new Response(Buffer.from('PK\x03\x04broken'), { headers: { 'content-type': 'application/zip' } })]) {
		await assert.rejects(generateNovelAiImageCached(cwd, "tree", { source, minStartGapMs: 0, fetchFn: (async () => { calls++; return response(); }) as typeof fetch }), error => !String(error).includes("synthetic-key"));
	}
	assert.equal(calls, 3); assert.equal(getCachedNovelAiImage(cwd, "tree", { source }), null);
	assert.deepEqual(readdirSync(cwd), [".liyuan"]);
});

test("queue is serial and checks changed settings before issuing the next paid call", async t => {
	const cwd = fixture(t); enable(cwd);
	let release!: () => void, started!: () => void, calls = 0;
	const entered = new Promise<void>(r => { started = r; }), blocked = new Promise<void>(r => { release = r; });
	const fetchFn = (async () => { calls++; started(); await blocked; return imageResponse(); }) as typeof fetch;
	const first = generateNovelAiImageCached(cwd, "one", { source, fetchFn, minStartGapMs: 0 });
	const queued = generateNovelAiImageCached(cwd, "two", { source, fetchFn, minStartGapMs: 0 });
	const results = Promise.allSettled([first, queued]);
	await entered; assert.equal(calls, 1);
	updateNovelAiConfig(cwd, { revision: loadNovelAiConfig(cwd).revision, enabled: false }); release();
	const settled = await results;
	assert.ok(settled.every(result => result.status === "rejected")); assert.equal(calls, 1);
	assert.equal(getCachedNovelAiImage(cwd, "one", { source }), null);
});

test("cancelling one duplicate does not cancel the other; cancelling all saves no image", async t => {
	const cwd = fixture(t); enable(cwd);
	let release!: () => void, started!: () => void;
	const entered = new Promise<void>(r => { started = r; }), blocked = new Promise<void>(r => { release = r; });
	const fetchFn = (async () => { started(); await blocked; return imageResponse(); }) as typeof fetch;
	const cancel = new AbortController();
	const one = generateNovelAiImageCached(cwd, "tree", { source, fetchFn, signal: cancel.signal, minStartGapMs: 0 });
	const two = generateNovelAiImageCached(cwd, "tree", { source, fetchFn, minStartGapMs: 0 });
	await entered; const rejected = assert.rejects(one); cancel.abort(); release(); await rejected;
	assert.ok((await two).src);
	const all = new AbortController(); let reached!: () => void, finish!: () => void;
	const reachedPromise = new Promise<void>(r => { reached = r; }), finishPromise = new Promise<void>(r => { finish = r; });
	const aborted = generateNovelAiImageCached(cwd, "other", { source, signal: all.signal, minStartGapMs: 0, fetchFn: (async () => { reached(); await finishPromise; return imageResponse(); }) as typeof fetch });
	await reachedPromise; const abortCheck = assert.rejects(aborted); all.abort(); finish(); await abortCheck;
	await new Promise(r => setTimeout(r, 10));
	assert.equal(getCachedNovelAiImage(cwd, "other", { source }), null);
});

function imageZip(data: Buffer): Buffer {
	const name = Buffer.from("image.png"), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
	local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
	central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
	return Buffer.concat([local, name, data, central, name, end]);
}

test("NovelAI ZIP image responses are decoded; nested archives, oversize responses and fake image bytes are rejected", async t => {
	const cwd = fixture(t); enable(cwd);
	const image = await generateNovelAiImageCached(cwd, "zip image", { source, minStartGapMs: 0, fetchFn: (async () => new Response(imageZip(PNG), { headers: { "content-type": "application/zip" } })) as typeof fetch });
	assert.deepEqual(readFileSync(join(cwd, ".liyuan-media", image.src.split("/").at(-1)!)), PNG);
	for (const [prompt, response] of [
		["nested zip", new Response(imageZip(imageZip(PNG)), { headers: { "content-type": "application/zip" } })],
		["oversized", new Response(PNG, { headers: { "content-length": String(65 * 1024 * 1024) } })],
		["fake image", new Response(imageZip(Buffer.from("not a PNG")), { headers: { "content-type": "application/zip" } })],
	] as const) {
		await assert.rejects(generateNovelAiImageCached(cwd, prompt, { source, minStartGapMs: 0, fetchFn: (async () => response) as typeof fetch }));
		assert.equal(getCachedNovelAiImage(cwd, prompt, { source }), null);
	}
});

test("timeout cancels a stalled response body without persistence or automatic retries", async t => {
	const cwd = fixture(t); enable(cwd); let calls = 0, cancelled = 0;
	const fetchFn = (async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled++; } })); }) as typeof fetch;
	const keepAlive = setTimeout(() => {}, 2000);
	try {
		await assert.rejects(generateNovelAiImageCached(cwd, "timeout tree", { source, minStartGapMs: 0, timeoutMs: 20, fetchFn }), error => (error as Error).name === "TimeoutError");
		assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(getCachedNovelAiImage(cwd, "timeout tree", { source }), null);
		assert.deepEqual(readdirSync(cwd), [".liyuan"]);
	} finally { clearTimeout(keepAlive); }
});
