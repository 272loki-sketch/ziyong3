import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeJsonAtomicWithBackup } from "./atomic-json.ts";
import { parseImagePrompt, scanImagePromptBlocks } from "./image-prompts.ts";
import { dir } from "./paths.ts";
import { firstZipEntry } from "./ziplite.ts";
import { fetchNovelAi, novelAiEndpoint } from "./novelai-network.ts";
import { DEFAULT_NOVELAI_SETTINGS, type NovelAiImage, type NovelAiSettings } from "./novelai-types.ts";

export const MAX_NOVELAI_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024, MAX_CACHE_BYTES = 8 * 1024 * 1024;
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const normalize = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
function directory(path: string, create = false): boolean {
	if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
	try { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) throw fail("生图目录不允许符号链接或非目录"); return true; }
	catch (error) { if (missing(error)) return false; throw error; }
}
/** Reads never create files, alter permissions, or silently reset corrupt settings. */
function privateFile(path: string, limit: number): Buffer | null {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
	catch (error) { if (missing(error)) return null; throw fail("无法安全读取生图私有文件"); }
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1 || info.size > limit || (process.platform !== "win32" && (info.mode & 0o077))) throw fail("生图私有文件须为真实的 0600 文件，且不能超过大小上限");
		return readFileSync(fd);
	} finally { closeSync(fd); }
}
function object(bytes: Buffer | null): Record<string, unknown> {
	if (!bytes) return {};
	let value: unknown;
	try { value = JSON.parse(bytes.toString("utf8")); } catch { throw fail("生图文件 JSON 无效，未重置或覆盖已有文件"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("生图文件必须为 JSON 对象");
	return value as Record<string, unknown>;
}
export interface NovelAiConfigSnapshot { config: NovelAiSettings; apiKey: string; revision: string; legacySettings: boolean; raw: Record<string, unknown> }
function settings(raw: Record<string, unknown>, enabled: boolean): NovelAiSettings {
	const result = { ...DEFAULT_NOVELAI_SETTINGS };
	for (const key of ["baseUrl", "model", "sampler", "scheduler", "positivePrefix", "positiveSuffix", "negativePrompt"] as const) {
		const value = raw[key] ?? result[key];
		if (typeof value !== "string" || value.length > (key.startsWith("positive") || key === "negativePrompt" ? 100_000 : 2048)) throw fail("生图文本设置类型或长度无效");
		result[key] = value;
	}
	novelAiEndpoint(result.baseUrl);
	for (const key of ["model", "sampler", "scheduler"] as const) if (!result[key].trim() || /[\r\n\x00]/.test(result[key])) throw fail("生图模型、采样器和调度器不能为空或包含控制字符");
	for (const [key, min, max, integer] of [["steps", 1, 50, true], ["scale", 0, 20, false], ["cfgRescale", 0, 1, false], ["width", 64, 2048, true], ["height", 64, 2048, true]] as const) {
		const value = raw[key] ?? result[key];
		if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw fail(`生图参数 ${key} 超出范围`);
		result[key] = value;
	}
	if (result.width % 64 || result.height % 64) throw fail("生图宽高必须是 64 的整数倍");
	result.enabled = enabled;
	return result;
}
export function loadNovelAiConfig(cwd: string): NovelAiConfigSnapshot {
	const root = join(cwd, ".liyuan");
	if (!directory(root)) return { config: { ...DEFAULT_NOVELAI_SETTINGS }, apiKey: "", revision: digest("absent"), legacySettings: false, raw: {} };
	const fresh = privateFile(join(root, "novelai-generation.json"), MAX_CONFIG_BYTES);
	const bytes = fresh ?? privateFile(join(root, "novelai.json"), MAX_CONFIG_BYTES);
	const raw = object(bytes), legacySettings = !fresh && bytes !== null;
	if (fresh && raw.version !== 1) throw fail("生图设置版本无效，未覆盖已有设置");
	if (raw.apiKey !== undefined && (typeof raw.apiKey !== "string" || raw.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(raw.apiKey))) throw fail("生图 Key 格式无效");
	return { config: settings(raw, !!fresh && raw.enabled === true), apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "", revision: digest(bytes ? Buffer.concat([Buffer.from(fresh ? "new:" : "legacy:"), bytes]) : "absent"), legacySettings, raw };
}
export function updateNovelAiConfig(cwd: string, patch: unknown): NovelAiConfigSnapshot {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw fail("生图设置须为对象");
	const value = patch as Record<string, unknown>, current = loadNovelAiConfig(cwd);
	if (value.revision !== current.revision) throw fail("生图设置已变化，请刷新后重试", 409);
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw fail("启用状态须为布尔值");
	if (value.clearApiKey !== undefined && typeof value.clearApiKey !== "boolean") throw fail("清除 Key 状态无效");
	if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(value.apiKey))) throw fail("NovelAI API Key 格式无效");
	const config = settings({ ...current.config, ...Object.fromEntries(Object.keys(DEFAULT_NOVELAI_SETTINGS).filter(key => key in value).map(key => [key, value[key]])) }, value.enabled === undefined ? current.config.enabled : value.enabled === true);
	const apiKey = value.clearApiKey ? "" : (typeof value.apiKey === "string" && value.apiKey ? value.apiKey : current.apiKey);
	if (config.enabled && !apiKey) throw fail("启用生图前请先保存 API Key");
	const raw = { ...current.raw, ...config, apiKey, version: 1 };
	if (Buffer.byteLength(JSON.stringify(raw)) > MAX_CONFIG_BYTES) throw fail("生图设置超过存储上限");
	const root = join(cwd, ".liyuan"); directory(root, true);
	privateFile(join(root, "novelai-generation.json.bak"), MAX_CONFIG_BYTES);
	writeJsonAtomicWithBackup(join(root, "novelai-generation.json"), raw);
	return loadNovelAiConfig(cwd);
}
export interface NovelAiImageSource { scopeKey: string; entryId: string }
export interface NovelAiGenerateOptions {
	source: NovelAiImageSource;
	negativePrompt?: string;
	seed?: number;
	signal?: AbortSignal;
	assertCurrent?: () => void;
	/** Dependency seams for isolated, unbilled tests; never populated from HTTP input. */
	fetchFn?: typeof fetch;
	minStartGapMs?: number;
	timeoutMs?: number;
}
function validatePrompt(prompt: string, opts: Pick<NovelAiGenerateOptions, "negativePrompt" | "seed" | "source">): void {
	if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100_000) throw fail("图片提示词为空或超过 100000 字");
	if (opts.negativePrompt !== undefined && (typeof opts.negativePrompt !== "string" || opts.negativePrompt.length > 100_000)) throw fail("负面提示词过长或类型无效");
	if (opts.seed !== undefined && (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > 0xffffffff)) throw fail("种子须为 0 到 4294967295 的整数");
	if (!/^[a-f0-9]{64}$/.test(opts.source.scopeKey) || !opts.source.entryId || opts.source.entryId.length > 256) throw fail("图片来源无效");
	if (scanImagePromptBlocks(prompt).some(block => block.incomplete) || /image###/i.test(prompt.replace(/image###[\s\S]*?###/gi, ""))) throw fail("图片提示词协议未闭合，不能生成");
}
function cacheKey(config: NovelAiSettings, prompt: string, opts: Pick<NovelAiGenerateOptions, "negativePrompt" | "seed" | "source">): string {
	return digest(JSON.stringify([opts.source.scopeKey, opts.source.entryId, normalize(prompt), normalize(opts.negativePrompt ?? ""), opts.seed ?? null, { ...config, enabled: false }]));
}
const cachePath = (cwd: string) => join(cwd, ".liyuan", "novelai-image-cache-v2.json");
function readCache(cwd: string): Record<string, unknown> { return directory(join(cwd, ".liyuan")) ? object(privateFile(cachePath(cwd), MAX_CACHE_BYTES)) : {}; }
function media(cwd: string, value: unknown): NovelAiImage | null {
	if (!value || typeof value !== "object") return null;
	const { src, bytes } = value as NovelAiImage;
	const match = typeof src === "string" && /^\/media\/(nai-[a-f0-9]{64}\.(?:png|jpg|webp))$/.exec(src);
	if (!match || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_NOVELAI_IMAGE_BYTES || !directory(dir(cwd, "media"))) return null;
	try { const info = lstatSync(join(dir(cwd, "media"), match[1])); return info.isFile() && !info.isSymbolicLink() && info.size === bytes ? { src, bytes } : null; }
	catch (error) { if (missing(error)) return null; throw error; }
}
export function getCachedNovelAiImage(cwd: string, prompt: string, opts: Pick<NovelAiGenerateOptions, "source" | "negativePrompt" | "seed">): NovelAiImage | null {
	validatePrompt(prompt, opts);
	return media(cwd, readCache(cwd)[cacheKey(loadNovelAiConfig(cwd).config, prompt, opts)]);
}
export function buildNovelAiPayload(config: NovelAiSettings, rawPrompt: string, negativePrompt = "", seed?: number) {
	const prompt = parseImagePrompt(rawPrompt);
	if (!prompt.scene.trim()) throw fail("场景提示词为空");
	for (const character of prompt.characters) if (![character.center.x, character.center.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw fail("角色坐标须在 0 到 1 之间");
	const input = [config.positivePrefix, prompt.scene, config.positiveSuffix].filter(Boolean).join(", ");
	const negative = [config.negativePrompt, negativePrompt].filter(Boolean).join(", ");
	const useCoords = prompt.characters.some(c => c.center.x !== 0.5 || c.center.y !== 0.5);
	return { action: "generate", input, model: config.model, parameters: {
		params_version: 3, width: config.width, height: config.height, scale: config.scale,
		seed: seed ?? Math.floor(Math.random() * 0x100000000), sampler: config.sampler, noise_schedule: config.scheduler, steps: config.steps,
		n_samples: 1, ucPreset: 0, qualityToggle: true, autoSmea: false, cfg_rescale: config.cfgRescale, dynamic_thresholding: false,
		controlnet_strength: 1, legacy: false, legacy_v3_extend: false, use_coords: useCoords, legacy_uc: false,
		normalize_reference_strength_multiple: true, deliberate_euler_ancestral_bug: false, prefer_brownian: true,
		image_format: "png", skip_cfg_above_sigma: null,
		characterPrompts: prompt.characters.map(c => ({ prompt: c.prompt, uc: c.uc, center: c.center, enabled: true })),
		v4_prompt: { caption: { base_caption: input, char_captions: prompt.characters.map(c => ({ char_caption: c.prompt, centers: [c.center] })) }, use_coords: useCoords, use_order: true },
		v4_negative_prompt: { caption: { base_caption: negative, char_captions: prompt.characters.map(c => ({ char_caption: c.uc, centers: [c.center] })) }, legacy_uc: false }, negative_prompt: negative,
	} };
}
function imageFromResponse(buffer: Buffer, contentType: string, extracted = false): { data: Buffer; ext: string } {
	if (/zip/i.test(contentType) || (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50)) {
		if (extracted) throw fail("NovelAI 返回了嵌套压缩包而非图片", 502);
		let entry;
		try { entry = firstZipEntry(buffer, e => /\.(?:png|jpe?g|webp)$/i.test(e.name)); } catch { throw fail("NovelAI 图片压缩包损坏或超过大小上限", 502); }
		if (!entry) throw fail("NovelAI 压缩包中没有图片", 502);
		return imageFromResponse(entry.data, "image/*", true);
	}
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { data: buffer, ext: "png" };
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { data: buffer, ext: "jpg" };
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { data: buffer, ext: "webp" };
	throw fail("NovelAI 未返回支持的图片，未保存响应内容", 502);
}
async function responseBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
	if (!response.body || Number(response.headers.get("content-length")) > MAX_NOVELAI_IMAGE_BYTES) { await response.body?.cancel(); throw fail("NovelAI 图片为空或超过 64 MiB", 502); }
	const reader = response.body.getReader(), parts: Buffer[] = []; let size = 0;
	const aborted = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener("abort", aborted, { once: true });
	try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_NOVELAI_IMAGE_BYTES) throw fail("NovelAI 响应超过 64 MiB", 502); parts.push(Buffer.from(part.value)); } }
	finally { signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => {}); }
	signal.throwIfAborted(); return Buffer.concat(parts);
}
async function generate(cwd: string, prompt: string, snapshot: NovelAiConfigSnapshot, opts: NovelAiGenerateOptions): Promise<NovelAiImage> {
	opts.signal?.throwIfAborted(); opts.assertCurrent?.();
	const payload = buildNovelAiPayload(snapshot.config, prompt, opts.negativePrompt, opts.seed);
	let response: Response;
	try { response = await (opts.fetchFn ?? fetchNovelAi)(novelAiEndpoint(snapshot.config.baseUrl).href, {
		method: "POST", redirect: "error", headers: { authorization: `Bearer ${snapshot.apiKey}`, "content-type": "application/json", accept: "application/zip, image/*" }, body: JSON.stringify(payload), signal: opts.signal,
	}); } catch { opts.signal?.throwIfAborted(); throw fail("无法连接 NovelAI，请检查接口或专用代理；未自动重试，计费以供应商记录为准", 502); }
	if (!response.ok) {
		await response.body?.cancel();
		throw fail(({ 401: "NovelAI API Key 无效", 402: "NovelAI 额度不足", 403: "NovelAI 拒绝访问", 429: "NovelAI 限流，请稍后手动重试" } as Record<number, string>)[response.status] ?? `NovelAI 生图失败（HTTP ${response.status}）；未自动重试`, 502);
	}
	const image = imageFromResponse(await responseBytes(response, opts.signal!), response.headers.get("content-type") ?? "");
	opts.signal?.throwIfAborted(); opts.assertCurrent?.();
	const mediaDir = dir(cwd, "media"); directory(mediaDir, true);
	const name = `nai-${digest(image.data)}.${image.ext}`, path = join(mediaDir, name);
	let fd: number | undefined;
	try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, image.data); fsyncSync(fd); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") { if (fd !== undefined) { try { unlinkSync(path); } catch { /* Only this failed newly created file is removed. */ } } throw error; }
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink() || digest(readFileSync(path)) !== digest(image.data)) throw fail("生图媒体文件冲突，未覆盖已有文件");
	} finally { if (fd !== undefined) closeSync(fd); }
	return { src: `/media/${name}`, bytes: image.data.length };
}
interface Job { controller: AbortController; promise: Promise<NovelAiImage>; waiters: Set<symbol> }
const pending = new Map<string, Job>();
const queues = new Map<string, { tail: Promise<unknown>; lastStart: number }>();
function subscribe(job: Job, signal?: AbortSignal): Promise<NovelAiImage> {
	const id = Symbol(); job.waiters.add(id);
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (error?: unknown, result?: NovelAiImage) => {
			if (done) return; done = true; signal?.removeEventListener("abort", abort); job.waiters.delete(id);
			if (error !== undefined) reject(error); else resolve(result!);
		};
		const abort = () => { finish(signal?.reason ?? fail("生图已取消", 499)); if (!job.waiters.size) job.controller.abort(fail("所有生图请求均已取消；已发送的请求可能仍计费", 499)); };
		signal?.addEventListener("abort", abort, { once: true });
		job.promise.then(result => finish(undefined, result), error => finish(error));
		if (signal?.aborted) abort();
	});
}
/** Serial, persistent and source-bound. Mounting/GET never calls this function. */
export async function generateNovelAiImageCached(cwd: string, prompt: string, opts: NovelAiGenerateOptions): Promise<NovelAiImage> {
	validatePrompt(prompt, opts); opts.signal?.throwIfAborted(); opts.assertCurrent?.();
	const snapshot = loadNovelAiConfig(cwd), key = cacheKey(snapshot.config, prompt, opts);
	const cached = media(cwd, readCache(cwd)[key]); if (cached) return cached;
	if (!snapshot.config.enabled || !snapshot.apiKey) throw fail("NovelAI 生图未启用，请在设置中明确启用并保存");
	const root = resolve(cwd), pendingKey = `${root}:${key}`;
	const existing = pending.get(pendingKey); if (existing) return subscribe(existing, opts.signal);
	const queue = queues.get(root) ?? { tail: Promise.resolve(), lastStart: 0 }; queues.set(root, queue);
	const job: Job = { controller: new AbortController(), promise: Promise.resolve(null as unknown as NovelAiImage), waiters: new Set() };
	const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(opts.timeoutMs ?? 180_000)]);
	const assertCurrent = () => { signal.throwIfAborted(); opts.assertCurrent?.(); if (loadNovelAiConfig(cwd).revision !== snapshot.revision) throw fail("生图设置已变化，未采纳旧请求", 409); };
	job.promise = queue.tail.catch(() => {}).then(async () => {
		assertCurrent();
		const wait = Math.max(0, (opts.minStartGapMs ?? 10_000) - (Date.now() - queue.lastStart));
		if (wait) await delay(wait, undefined, { signal });
		assertCurrent();
		// Reject unsafe output/cache destinations before making a potentially paid request.
		directory(dir(cwd, "media")); privateFile(`${cachePath(cwd)}.bak`, MAX_CACHE_BYTES);
		queue.lastStart = Date.now();
		const result = await generate(cwd, prompt, snapshot, { ...opts, signal, assertCurrent });
		assertCurrent();
		const cache = readCache(cwd); cache[key] = result;
		if (Buffer.byteLength(JSON.stringify(cache)) > MAX_CACHE_BYTES) throw fail("生图缓存索引已满，未删除已有图片", 507);
		privateFile(`${cachePath(cwd)}.bak`, MAX_CACHE_BYTES);
		writeJsonAtomicWithBackup(cachePath(cwd), cache);
		return result;
	}).finally(() => { if (pending.get(pendingKey) === job) pending.delete(pendingKey); });
	queue.tail = job.promise.catch(() => {}); pending.set(pendingKey, job);
	return subscribe(job, opts.signal);
}
