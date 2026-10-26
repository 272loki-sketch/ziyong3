import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { FishAudioNetwork, fishDnsAnswer, fishNetworkError, fishNetworkRoute } from "../server/fish-tts-network.ts";

function fixture(reply: (url: string, options: any, body: string | undefined, index: number) => { status?: number; headers?: Record<string, string>; body?: string; error?: Error }) {
	const calls: { url: string; options: any; body?: string }[] = [];
	const request = ((url: string, options: any, callback: (response: any) => void) => {
		const req: any = new EventEmitter(); req.destroy = () => {};
		req.end = (body?: string) => {
			calls.push({ url, options, body });
			queueMicrotask(() => {
				const result = reply(url, options, body, calls.length - 1);
				if (result.error) { req.emit("error", result.error); return; }
				const response: any = Readable.from([Buffer.from(result.body ?? "audio")]); response.statusCode = result.status ?? 200; response.headers = result.headers ?? { "content-type": "audio/mpeg" }; callback(response);
			});
		};
		return req;
	}) as any;
	return { network: new FishAudioNetwork({ request }), calls };
}
test("Fish route isolation: own environment override only; no shared proxy/model/research routing borrowed", () => {
	assert.deepEqual(fishNetworkRoute("compatible", { HTTPS_PROXY: "http://127.0.0.1:9", LIYUAN_WEB_RESEARCH_PROXY: "http://127.0.0.1:8" }), { mode: "compatible", source: "settings" });
	assert.deepEqual(fishNetworkRoute("system", { LIYUAN_FISH_AUDIO_NETWORK_MODE: "compatible" }), { mode: "compatible", source: "environment" });
	assert.deepEqual(fishNetworkRoute("compatible", { LIYUAN_FISH_AUDIO_NETWORK_MODE: "system" }), { mode: "system", source: "environment" });
	assert.throws(() => fishNetworkRoute("system", { LIYUAN_FISH_AUDIO_NETWORK_MODE: "typo" }), /网络模式/);
});
test("HTTPS DNS answers accept only public IPv4 with bounded TTL; never use local/rebound results", () => {
	assert.equal(fishDnsAnswer({ Status: 0, Answer: [{ type: 1, data: "1.1.1.1", TTL: 9999 }] }, 0).expiresAt, 300000);
	for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "224.0.0.1"]) assert.throws(() => fishDnsAnswer({ Status: 0, Answer: [{ type: 1, data: address }] }));
	for (const answer of [null, { Status: 2 }, { Status: 0, Answer: [] }]) assert.throws(() => fishDnsAnswer(answer));
});
test("compatible TLS uses official HTTP host/certificate, HTTPS DNS gets no Key/text; no global fetch or retries", async () => {
	const key = "synthetic-key", text = "合成测试，不是真实故事", oldFetch = globalThis.fetch;
	const f = fixture((url, options, body) => url.startsWith("https://doh.pub/") ? { body: JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "1.1.1.1", TTL: 60 }] }), headers: { "content-type": "application/json" } } : { body: "synthetic-mp3" });
	const request: RequestInit = { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ text }), signal: new AbortController().signal };
	const response = await f.network.fetch("https://api.fish.audio/v1/tts", request, "compatible"); assert.equal(await response.text(), "synthetic-mp3"); assert.equal(f.calls.length, 2);
	assert.equal(f.calls[0].options.method, "GET"); assert.equal(f.calls[0].options.headers.authorization, undefined); assert.equal(f.calls[0].body, undefined); assert.doesNotMatch(f.calls[0].url, /synthetic-key|合成测试/);
	const api = f.calls[1]; assert.equal(api.url, "https://api.fish.audio/v1/tts"); assert.equal(api.options.headers.authorization, "Bearer synthetic-key"); assert.equal(api.options.headers["content-length"], String(Buffer.byteLength(request.body as string)));
	assert.equal(api.options.servername, "fish.audio."); assert.equal(api.options.rejectUnauthorized, true); assert.equal(api.options.agent, false);
	assert.equal(api.options.checkServerIdentity("fish.audio.", { subjectaltname: "DNS:api.fish.audio" }), undefined);
	assert.equal(api.options.checkServerIdentity("fish.audio.", { subjectaltname: "DNS:fish.audio" }).code, "ERR_TLS_CERT_ALTNAME_INVALID");
	api.options.lookup("api.fish.audio", { all: true }, (error: unknown, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "1.1.1.1", family: 4 }]); });
	assert.equal(globalThis.fetch, oldFetch);
	const again = await f.network.fetch("https://api.fish.audio/v1/tts", request, "compatible"); await again.body?.cancel(); assert.equal(f.calls.length, 3, "repeat uses TTL DNS but still exactly one explicit synthesis call");
});
test("system mode never inherits a global SDK fetch/proxy override and never resolves custom DNS", async () => {
	const f = fixture(() => ({ body: "ok" })); const response = await f.network.fetch("https://api.fish.audio/model?page_size=1", { method: "GET" }, "system"); assert.equal(await response.text(), "ok"); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.lookup, undefined); assert.equal(f.calls[0].options.rejectUnauthorized, true);
});
test("redirects, bad certificates, invalid fixed routes and cancellations fail closed without retry", async () => {
	const redirected = fixture(() => ({ status: 302, headers: { location: "https://example.invalid/" } }));
	await assert.rejects(redirected.network.fetch("https://api.fish.audio/model?page_size=1", { method: "GET" }, "system"), /重定向/); assert.equal(redirected.calls.length, 1);
	const cert = fixture(() => ({ error: Object.assign(new Error("hidden"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }) })); await assert.rejects(cert.network.fetch("https://api.fish.audio/model?page_size=1", { method: "GET" }, "system")); assert.equal(cert.calls.length, 1);
	await assert.rejects(cert.network.fetch("https://example.invalid/tts", { method: "POST" }, "compatible")); assert.equal(cert.calls.length, 1);
	const controller = new AbortController(); controller.abort(); await assert.rejects(cert.network.fetch("https://api.fish.audio/model?page_size=1", { method: "GET", signal: controller.signal }, "compatible")); assert.equal(cert.calls.length, 1);
});
test("network failures retain actionable code/category but never leak endpoint bodies or credentials", () => {
	for (const [code, category] of [["EAI_AGAIN", "DNS"], ["ECONNRESET", "连接被重置"], ["ERR_TLS_CERT_ALTNAME_INVALID", "证书"], ["ETIMEDOUT", "超时"]]) {
		const result = fishNetworkError(Object.assign(new Error("Bearer synthetic-key"), { cause: Object.assign(new Error("private-proxy-credential synthetic-key"), { code }) }));
		assert.ok(result.includes(category)); assert.ok(result.includes(code)); assert.doesNotMatch(result, /synthetic-key|user:pass|example\.invalid/);
	}
});
