/** Manual NovelAI generation, behind the existing authenticated /api/workspace gateway. */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { committedNarrativeText } from "../src/memory/narrative-window.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";
import { generateNovelAiImageCached, getCachedNovelAiImage, loadNovelAiConfig, updateNovelAiConfig, type NovelAiGenerateOptions } from "../src/novelai.ts";
import type { NovelAiBinding, NovelAiStatus } from "../src/novelai-types.ts";

interface Host { cwd: string; worldProfileContext(): { sessionId?: string; card: string; leafId: string | null; branch?: BranchEntryLike[] } }
type Options = Pick<NovelAiGenerateOptions, "fetchFn" | "minStartGapMs" | "timeoutMs">;
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function json(res: ServerResponse, code: number, value: unknown): void {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []; let size = 0;
	for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; if (size > 512 * 1024) throw fail("生图请求超过大小上限", 413); chunks.push(bytes); }
	let value: unknown;
	try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("生图请求 JSON 无效"); }
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw fail("生图请求须为普通对象");
	return value as Record<string, unknown>;
}
export async function handleNovelAiRequest(req: IncomingMessage, res: ServerResponse, host: Host, options: Options = {}): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname !== "/api/novelai" && !url.pathname.startsWith("/api/novelai/")) return false;
	const binding = (): NovelAiBinding => {
		const source = host.worldProfileContext();
		if (!source.sessionId || !source.card) throw fail("当前会话或角色卡来源不可用", 409);
		return { scopeKey: createHash("sha256").update(JSON.stringify([source.sessionId, source.card])).digest("hex") };
	};
	const assert = (expected: unknown, entryId?: unknown, entryScope?: unknown): void => {
		const scope = binding().scopeKey;
		if (!expected || typeof expected !== "object" || (expected as NovelAiBinding).scopeKey !== scope) throw fail("生图所属会话或角色卡已变化，请刷新后重试", 409);
		if (entryId !== undefined || entryScope !== undefined) {
			const entry = host.worldProfileContext().branch?.find(entry => entry.id === entryId);
			const details = entry?.message?.details as Record<string, unknown> | undefined;
			const finished = entry?.message?.stopReason === undefined || entry.message.stopReason === "stop";
			const greeting = entry?.type === "message" && entry.message?.role === "assistant" && details?.rpGreeting && finished && details.rpIncomplete !== true;
			const legacy = entry?.type === "custom_message" && ["rp-greeting", "rp-edited-reply"].includes(entry.customType ?? "");
			if (typeof entryId !== "string" || !entryId || entryId.length > 256 || entryScope !== scope || !entry || !((finished && committedNarrativeText(entry).trim()) || greeting || legacy)) throw fail("图片来源不是当前分支已保存的完整回复，请刷新后重试", 409);
		}
	};
	const status = (): NovelAiStatus => {
		const saved = loadNovelAiConfig(host.cwd);
		return { config: saved.config, revision: saved.revision, apiKeyConfigured: !!saved.apiKey, legacySettings: saved.legacySettings, binding: binding() };
	};
	try {
		if (req.method === "GET" && url.pathname === "/api/novelai") { json(res, 200, status()); return true; }
		if (req.method === "GET" && url.pathname === "/api/novelai/cached") {
			const entryId = url.searchParams.get("entryId"), entryScope = url.searchParams.get("entryScope");
			if (!entryId || !entryScope) throw fail("读取图片缓存须提供来源条目与作用域");
			assert({ scopeKey: entryScope }, entryId, entryScope);
			const image = getCachedNovelAiImage(host.cwd, url.searchParams.get("prompt") ?? "", { source: { scopeKey: entryScope, entryId } });
			json(res, 200, image ?? { src: null }); return true;
		}
		if (!((req.method === "PUT" && url.pathname === "/api/novelai") || (req.method === "POST" && url.pathname === "/api/novelai/generate"))) { json(res, 404, { error: "未知生图接口" }); return true; }
		const captured = binding(), data = await body(req);
		assert(captured);
		if (req.aborted || res.destroyed) return true;
		assert(data.binding);
		if (req.method === "PUT") {
			updateNovelAiConfig(host.cwd, data);
			json(res, 200, status()); return true;
		}
		if (typeof data.entryId !== "string" || typeof data.entryScope !== "string") throw fail("生图须绑定已保存的来源条目");
		const entryId = data.entryId, entryScope = data.entryScope;
		const branchAnchor = host.worldProfileContext().leafId;
		const guard = () => {
			assert(captured, entryId, entryScope);
			if (branchAnchor && !host.worldProfileContext().branch?.some(entry => entry.id === branchAnchor)) throw fail("生图期间已切换分支，未采纳旧请求", 409);
			if (data.revision !== loadNovelAiConfig(host.cwd).revision) throw fail("生图设置已变化，请刷新后重新点击", 409);
		};
		guard();
		const controller = new AbortController();
		const disconnected = () => { if (!res.writableEnded) controller.abort(fail("生图请求已取消；已发送的请求可能仍计费", 499)); };
		req.once("aborted", disconnected); res.once("close", disconnected);
		const sourceTimer = setInterval(() => { try { guard(); } catch (error) { controller.abort(error); } }, 100);
		sourceTimer.unref();
		try {
			const result = await generateNovelAiImageCached(host.cwd, data.prompt as string, {
				...options, source: { scopeKey: entryScope, entryId }, negativePrompt: data.negativePrompt as string | undefined, seed: data.seed as number | undefined,
				signal: controller.signal, assertCurrent: guard,
			});
			guard(); controller.signal.throwIfAborted();
			if (!res.destroyed) json(res, 200, result);
		} finally { clearInterval(sourceTimer); req.off("aborted", disconnected); res.off("close", disconnected); }
		return true;
	} catch (error) {
		const e = error as { statusCode?: number; code?: string; name?: string };
		const storage = e.code === "ENOSPC" || e.code === "EDQUOT";
		const code = storage ? 507 : e.name === "TimeoutError" ? 504 : e.statusCode ?? 400;
		const message = storage ? "存储空间不足，本次生图未完成；不要重复点击，已发送的请求可能计费"
			: e.name === "TimeoutError" ? "生图等待超时，未自动重试；已发送的请求可能仍计费"
			: e.statusCode ? (error as Error).message : "生图操作失败，请检查私有文件权限、连接和可用存储；未自动重试";
		if (!res.destroyed && !res.headersSent) json(res, code, { error: message });
		return true;
	}
}
