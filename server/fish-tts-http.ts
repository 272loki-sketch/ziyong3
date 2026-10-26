import { FishAudioNetwork, fishNetworkError, fishNetworkRoute } from "./fish-tts-network.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildSpeakerRequest, MULTI_SPEAKER_MODELS } from "../packages/fish-audio/upstream/lib.js";
import { buildTtsRequest, MAX_SPEAKERS } from "../packages/fish-audio/upstream/validate.js";
import { displayAssistantText } from "../src/postprocess.ts";
import { planFishSpeech, type FishTtsBinding, type FishTtsPreview, type FishTtsStatus } from "../src/fish-tts.ts";
import { tavernPluginScope, type TavernPluginBinding } from "./tavern-plugin-store.ts";
import { FISH_AUDIO_MAX_BYTES, FishTtsStore, fishDigest, publicFishConfig } from "./fish-tts-store.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, any>> {
	const parts: Buffer[] = []; let size = 0;
	for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; if (size > 256 * 1024) throw fail("配音请求过大", 413); parts.push(bytes); }
	const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
	if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw fail("配音请求必须为对象");
	const validateJson = (value: unknown, depth = 0): void => {
		if (depth > 40) throw fail("配音请求嵌套过深");
		if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
			if (["__proto__", "constructor", "prototype"].includes(key)) throw fail("配音请求包含禁止字段");
			validateJson(child, depth + 1);
		}
	};
	validateJson(data);
	return data;
}
export class FishTtsHttp {
	readonly store: FishTtsStore;
	private active?: AbortController;
	private readonly network = new FishAudioNetwork();
	private readonly audioToken = randomBytes(32);
	readonly host: { binding(): TavernPluginBinding };
	private options: { fetch?: Fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number };
	constructor(cwd: string, host: { binding(): TavernPluginBinding }, options: { fetch?: Fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
		this.store = new FishTtsStore(cwd); this.host = host; this.options = options;
	}
	private audioSignature(key: string, binding: FishTtsBinding, revision: number): string {
		return createHmac("sha256", this.audioToken).update(JSON.stringify([key, binding.scopeKey, binding.sourceEntryId, revision])).digest("hex");
	}
	private binding(): FishTtsBinding { const b = this.host.binding(); return { scopeKey: tavernPluginScope(b), sourceEntryId: b.sourceEntryId }; }
	private key(saved = this.store.read()): { value: string; source: FishTtsStatus["keySource"] } {
		const value = saved.apiKey || (this.options.env ?? process.env).LIYUAN_FISH_AUDIO_API_KEY?.trim() || (this.options.env ?? process.env).FISH_AUDIO_API_KEY?.trim() || "";
		return { value, source: saved.apiKey ? "saved" : value ? "environment" : "none" };
	}
	status(): FishTtsStatus {
		const saved = this.store.read(), key = this.key(saved);
		return { binding: this.binding(), revision: saved.revision, config: publicFishConfig(saved.config), network: fishNetworkRoute(saved.config.networkMode, this.options.env ?? process.env), keyConfigured: !!key.value, keySource: key.source, busy: !!this.active };
	}
	private assert(binding: FishTtsBinding, revision?: number, entryId?: unknown, entryScope?: unknown): void {
		const current = this.binding(), host = this.host.binding();
		if (binding?.scopeKey !== current.scopeKey || binding?.sourceEntryId !== current.sourceEntryId || (revision !== undefined && revision !== this.store.read().revision)
			|| (entryId !== undefined && (typeof entryId !== "string" || !host.visibleEntryIds.includes(entryId))) || (entryScope !== undefined && entryScope !== current.scopeKey)) throw fail("配音所属会话、角色卡、分支或设置已变化，请重新预览", 409);
	}
	private preview(data: Record<string, any>): FishTtsPreview {
		for (const field of ["entryId", "entryScope"] as const) if (field in data && (typeof data[field] !== "string" || !data[field] || data[field].length > 256)) throw fail("配音条目来源无效");
		const status = this.status(); this.assert(data.binding ?? status.binding, data.revision, data.entryId, data.entryScope);
		if (typeof data.text !== "string" || data.text.length > 16_000) throw fail("配音选段须为不超过 16000 字的文本，未截断正文");
		if (data.voiceId !== undefined && typeof data.voiceId !== "string") throw fail("所选音色无效");
		return { ...status, ...planFishSpeech(displayAssistantText(data.text), status.config, data.voiceId) };
	}
	async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith("/api/fish-tts/")) return false;
		try {
			if (req.method === "GET" && url.pathname === "/api/fish-tts/status") { json(res, 200, this.status()); return true; }
			const audio = /^\/api\/fish-tts\/audio\/([a-f0-9]{64})\.mp3$/.exec(url.pathname);
			if ((req.method === "GET" || req.method === "HEAD") && audio) {
				const binding = { scopeKey: url.searchParams.get("scopeKey") ?? "", sourceEntryId: url.searchParams.get("sourceEntryId") ?? "" };
				const revision = Number(url.searchParams.get("revision")), token = url.searchParams.get("token") ?? "";
				this.assert(binding, revision);
				if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(this.audioSignature(audio[1], binding, revision), "hex"))) throw fail("音频不属于本次配音预览；请重新生成或读取缓存", 403);
				const bytes = this.store.cache(audio[1]); if (!bytes) throw fail("音频缓存不存在，请重新配音", 404);
				res.writeHead(200, { "content-type": "audio/mpeg", "content-length": bytes.length, "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); res.end(req.method === "HEAD" ? undefined : bytes); return true;
			}
			if (!["POST", "PUT"].includes(req.method ?? "")) { json(res, 405, { error: "不支持的配音操作" }); return true; }
			const captured = this.binding(), data = await body(req);
			this.assert(captured); if (req.aborted || res.destroyed) return true;
			if (req.method === "PUT" && url.pathname === "/api/fish-tts/config") {
				this.assert(data.binding, data.revision);
				this.store.save(data.revision, data.config, data.apiKey, () => this.assert(data.binding, data.revision)); json(res, 200, this.status()); return true;
			}
			if (req.method === "POST" && url.pathname === "/api/fish-tts/connection-check") {
				this.assert(data.binding, data.revision); if (this.active) throw fail("正在配音，请稍后再检查连接", 409);
				const status = this.status(), controller = new AbortController(); this.active = controller;
				const disconnect = () => controller.abort(); req.once("aborted", disconnect); res.once("close", disconnect);
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
				try {
					const route = status.network!, started = Date.now();
					// Public voice metadata only. Deliberately no Authorization, text, model header or TTS POST.
					const response = this.options.fetch ? await this.options.fetch("https://api.fish.audio/model?page_size=1", { method: "GET", redirect: "error", signal }) : await this.network.fetch("https://api.fish.audio/model?page_size=1", { method: "GET", redirect: "error", signal }, route.mode);
					await response.body?.cancel(); this.assert(data.binding, data.revision);
					if (![200, 401, 403].includes(response.status)) throw fail(`Fish 连接检查返回 HTTP ${response.status}；未执行合成`, 502);
					json(res, 200, { reachable: true, httpStatus: response.status, network: route, elapsedMs: Date.now() - started, synthesisRequested: false, keyChecked: false });
				} catch (error) { if ((error as any)?.status) throw error; throw fail(fishNetworkError(error, false), 502); }
				finally { req.off("aborted", disconnect); res.off("close", disconnect); if (this.active === controller) this.active = undefined; }
				return true;
			}
			if (req.method === "POST" && url.pathname === "/api/fish-tts/preview") { json(res, 200, this.preview(data)); return true; }
			if (req.method !== "POST" || url.pathname !== "/api/fish-tts/synthesize") { json(res, 404, { error: "未知配音接口" }); return true; }
			if (!data.binding || !Number.isSafeInteger(data.revision)) throw fail("请先预览并确认配音来源");
			const preview = this.preview(data), { config, binding, revision } = preview;
			if (!config.enabled) throw fail("请先在插件中心显式启用并保存 Fish Audio 角色配音");
			const key = this.key().value; if (!key) throw fail("尚未保存 Fish Audio API Key");
			if (!preview.segments.length) throw fail("没有已绑定音色的对白，请先检查识别预览");
			const request = buildSpeakerRequest(preview.segments.map(segment => ({ speaker: segment.voiceId, text: segment.text })), name => config.voices.find(voice => voice.id === name)?.referenceId ?? null, config.voices.find(voice => voice.id === preview.segments[0].voiceId)!.referenceId);
			if (request.voices.length > MAX_SPEAKERS) throw fail(`Fish 单次最多支持 ${MAX_SPEAKERS} 种声线，请分段配音`);
			if (request.voices.length > 1 && !MULTI_SPEAKER_MODELS.includes(config.model)) throw fail("当前模型不支持一段中的多个声线；请改用 S2 系列或分段试听");
			const fish = buildTtsRequest({ model: config.model, text: request.text, reference_id: request.voices.length === 1 ? request.voices[0] : request.voices, latency: "balanced", prosody: { speed: config.speed, normalize_loudness: true } });
			const cacheKey = fishDigest(JSON.stringify([fishDigest(key), fish.model, fish.body]));
			const finish = (cached: boolean, bytes: number) => {
				this.assert(binding, revision, data.entryId, data.entryScope);
				const query = new URLSearchParams({ ...binding, revision: String(revision), token: this.audioSignature(cacheKey, binding, revision) });
				json(res, 200, { src: `/api/fish-tts/audio/${cacheKey}.mp3?${query}`, cached, bytes, speakers: request.voices.length });
			};
			const cached = this.store.cache(cacheKey); if (cached) { finish(true, cached.length); return true; }
			if (this.active) throw fail("已有配音请求进行中，请稍后再试；未重复调用 Fish", 409);
			this.store.assertCacheCapacity();
			const controller = new AbortController(); this.active = controller;
			const disconnected = () => controller.abort(fail("配音请求已取消", 499));
			req.once("aborted", disconnected); res.once("close", disconnected);
			const timer = setTimeout(() => controller.abort(fail("Fish 配音请求超时，未自动重试；本次是否计费请以 Fish 记录为准", 504)), this.options.timeoutMs ?? 180_000);
			const sourceTimer = setInterval(() => { try { this.assert(binding, revision, data.entryId, data.entryScope); } catch (error) { controller.abort(error); } }, 150);
			try {
				const request: RequestInit = { method: "POST", redirect: "error", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", model: fish.model }, body: JSON.stringify(fish.body), signal: controller.signal };
				const response = this.options.fetch ? await this.options.fetch("https://api.fish.audio/v1/tts", request) : await this.network.fetch("https://api.fish.audio/v1/tts", request, this.status().network!.mode);
				if (!response.ok) { await response.body?.cancel(); throw fail(({ 401: "Fish API Key 无效", 402: "Fish API 额度不足", 403: "Fish 拒绝访问此音色", 404: "Fish 音色不存在或不可访问", 429: "Fish 请求限流，请稍后再试" } as Record<number, string>)[response.status] ?? `Fish 配音失败（HTTP ${response.status}）`, 502); }
				if (!/^(audio\/|application\/octet-stream)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw fail("Fish 未返回可播放音频，未保存响应内容", 502); }
				if (!response.body || Number(response.headers.get("content-length")) > FISH_AUDIO_MAX_BYTES) { await response.body?.cancel(); throw fail("Fish 音频响应过大或为空", 502); }
				const parts: Buffer[] = []; let size = 0;
				const reader = response.body.getReader();
				try { while (true) { controller.signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > FISH_AUDIO_MAX_BYTES) throw fail("Fish 音频超过单次大小上限", 502); parts.push(Buffer.from(part.value)); } }
				finally { await reader.cancel().catch(() => {}); }
				controller.signal.throwIfAborted(); this.assert(binding, revision, data.entryId, data.entryScope);
				if (!size) throw fail("Fish 返回空音频", 502);
				this.store.putAudio(cacheKey, Buffer.concat(parts), () => this.assert(binding, revision, data.entryId, data.entryScope)); finish(false, size);
			} catch (error) { if (controller.signal.aborted) throw controller.signal.reason; if ((error as any)?.status) throw error; throw fail(fishNetworkError(error), 502); }
			finally { clearTimeout(timer); clearInterval(sourceTimer); req.off("aborted", disconnected); res.off("close", disconnected); if (this.active === controller) this.active = undefined; }
			return true;
		} catch (error) { if (!res.destroyed && !res.headersSent) json(res, (error as any)?.status ?? 400, { error: error instanceof Error ? error.message : "配音操作失败" }); return true; }
	}
	close(): void { this.active?.abort(fail("服务即将关闭，配音已取消", 503)); }
}
