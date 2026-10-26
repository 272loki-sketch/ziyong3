/** Fish-only native HTTPS. No global dispatcher/proxy/DNS mutation and no paid retries. */
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import type { FishTtsNetworkMode } from "../src/fish-tts.ts";

const API_HOST = "api.fish.audio";
const RESOLVER = "https://doh.pub/resolve?name=fish.audio&type=A";
export interface FishNetworkRoute { mode: FishTtsNetworkMode; source: "environment" | "settings" }
export type FishHttpsRequest = typeof https.request;
const networkFailure = (message: string, code: string) => Object.assign(new Error(message), { code });
export function fishNetworkRoute(mode: FishTtsNetworkMode, env: NodeJS.ProcessEnv = process.env): FishNetworkRoute {
	const configured = env.LIYUAN_FISH_AUDIO_NETWORK_MODE;
	if (configured !== undefined && configured !== "system" && configured !== "compatible") throw networkFailure("Fish 网络模式无效；只支持 system 或 compatible", "FISH_NETWORK_CONFIG");
	return { mode: configured ?? mode, source: configured === undefined ? "settings" : "environment" };
}
function publicV4(value: string): boolean {
	if (isIP(value) !== 4) return false;
	const [a, b] = value.split(".").map(Number);
	return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
		&& !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 2, 168].includes(b)) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
}
export function fishDnsAnswer(data: unknown, now = Date.now()): { address: string; expiresAt: number } {
	const value = data as { Status?: unknown; Answer?: { type?: unknown; data?: unknown; TTL?: unknown }[] };
	if (!value || value.Status !== 0 || !Array.isArray(value.Answer)) throw networkFailure("Fish HTTPS DNS 返回无效结果", "FISH_DNS_FAILED");
	const answer = value.Answer.find(row => row.type === 1 && typeof row.data === "string" && publicV4(row.data));
	if (!answer || typeof answer.data !== "string") throw networkFailure("Fish HTTPS DNS 未返回可用公网地址", "FISH_DNS_FAILED");
	const ttl = typeof answer.TTL === "number" && Number.isFinite(answer.TTL) ? answer.TTL : 30;
	return { address: answer.data, expiresAt: now + Math.max(1, Math.min(300, ttl)) * 1000 };
}
/** Error names/codes only: never reflect provider bodies, URLs, Key or proxy credentials. */
export function fishNetworkError(error: unknown, synthesis = true): string {
	let current = error as { code?: unknown; cause?: unknown; name?: unknown } | undefined;
	const codes: string[] = [];
	for (let depth = 0; current && depth < 5; depth++, current = current.cause as typeof current) { if (typeof current.code === "string") codes.push(current.code); if (current.name === "TimeoutError") codes.unshift("ETIMEDOUT"); }
	const code = codes.find(code => /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) ?? "FISH_NETWORK_FAILED";
	const detail = codes.some(code => ["ENOTFOUND", "EAI_AGAIN", "ESERVFAIL", "FISH_DNS_FAILED"].includes(code)) ? "DNS 解析失败"
		: codes.some(code => /CERT|TLS|SSL/.test(code)) ? "TLS 握手或证书校验失败（未关闭校验）"
		: codes.some(code => ["ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(code)) ? "连接被重置或拒绝"
		: codes.some(code => /TIMEOUT|TIMEDOUT/.test(code)) ? "连接超时" : code === "FISH_NETWORK_CONFIG" ? "网络模式配置无效" : "网络连接失败";
	return `无法连接 Fish Audio：${detail}（${code}）。可在插件中选择兼容直连并先运行免费连接检查。${synthesis ? "未自动重试，本次计费以 Fish 记录为准。" : "未发送 Key 或文字，未请求合成。"}`;
}
export class FishAudioNetwork {
	private cachedDns?: { address: string; expiresAt: number };
	private readonly request: FishHttpsRequest;
	constructor(options: { request?: FishHttpsRequest } = {}) { this.request = options.request ?? https.request; }
	private async resolve(signal: AbortSignal): Promise<string> {
		if (this.cachedDns && this.cachedDns.expiresAt > Date.now()) return this.cachedDns.address;
		const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
		const response = await this.native(RESOLVER, { method: "GET", signal: dnsSignal }, {});
		if (response.status !== 200) { await response.body?.cancel(); throw networkFailure("Fish HTTPS DNS 不可用", "FISH_DNS_FAILED"); }
		const reader = response.body?.getReader(); if (!reader) throw networkFailure("Fish HTTPS DNS 返回空响应", "FISH_DNS_FAILED");
		const parts: Uint8Array[] = []; let size = 0;
		try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 32_768) throw networkFailure("Fish HTTPS DNS 响应过大", "FISH_DNS_FAILED"); parts.push(part.value); } }
		finally { await reader.cancel().catch(() => {}); }
		try { this.cachedDns = fishDnsAnswer(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
		catch { throw networkFailure("Fish HTTPS DNS 无可用结果", "FISH_DNS_FAILED"); }
		return this.cachedDns.address;
	}
	private native(url: string, init: RequestInit, extra: https.RequestOptions): Promise<Response> {
		return new Promise((resolve, reject) => {
			const request = this.request(url, { method: init.method, headers: { ...(init.headers as Record<string, string>), ...(typeof init.body === "string" ? { "content-length": String(Buffer.byteLength(init.body)) } : {}) }, agent: false, rejectUnauthorized: true, signal: init.signal ?? undefined, ...extra }, response => {
				const status = response.statusCode ?? 502;
				if (status >= 300 && status < 400) { response.destroy(); reject(networkFailure("Fish 不允许重定向", "FISH_REDIRECT_REFUSED")); return; }
				const headers = new Headers();
				for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
				const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
				resolve(new Response([101, 204, 205, 304].includes(status) || init.method === "HEAD" ? null : stream, { status, headers }));
			});
			request.once("error", reject);
			if (init.body !== undefined && init.body !== null && typeof init.body !== "string") { request.destroy(); reject(networkFailure("Fish 请求体必须为 JSON 文本", "FISH_REQUEST_INVALID")); return; }
			request.end(init.body ?? undefined);
		});
	}
	async fetch(url: string, init: RequestInit, mode: FishTtsNetworkMode): Promise<Response> {
		if (!(url === `https://${API_HOST}/v1/tts` && init.method === "POST") && !(url === `https://${API_HOST}/model?page_size=1` && init.method === "GET")) throw networkFailure("拒绝非 Fish 固定接口", "FISH_REQUEST_INVALID");
		const signal = init.signal ?? AbortSignal.timeout(180_000); signal.throwIfAborted();
		if (mode === "system") return this.native(url, { ...init, signal }, {});
		if (mode !== "compatible") throw networkFailure("Fish 网络模式无效", "FISH_NETWORK_CONFIG");
		const address = await this.resolve(signal); signal.throwIfAborted();
		return this.native(url, { ...init, signal }, {
			// Fish's own apex DNS/TLS route avoids broken API-name DNS/SNI. HTTP Host stays api.fish.audio.
			// Always verify the *official API* identity, not the routing SNI and never an IP cert.
			servername: "fish.audio.", checkServerIdentity: (_servername, certificate) => checkServerIdentity(API_HOST, certificate),
			lookup: (_hostname, options, callback) => { if (options.all) callback(null, [{ address, family: 4 }]); else callback(null, address, 4); },
		});
	}
}
