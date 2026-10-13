import https from "node:https";
import { parseSearchHtml } from "./web-search-parser.ts";
import net from "node:net";
import tls from "node:tls";

import { privateQueryReason, containsPrivateSearchMaterial, type ResearchPrivacyContext } from "../src/tools/research-privacy.ts";
import type { CharacterCard } from "../src/types.ts";
import type { WebResearchItem, WebResearchResult } from "../src/tools/web-research.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SEARCH_RESPONSE_BYTES = 1_500_000;
const SEARCH_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 LiyuanResearch/1.0";

/** Bound search-engine and configured-API payloads before decoding/parsing them. */
export async function boundedFetchText(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (!Number.isFinite(declared) || declared < 0 || declared > MAX_SEARCH_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error("联网搜索响应超过大小限制");
    }
	const reader = response.body?.getReader();
	if (!reader) return "";
	let size = 0, text = "";
	const decoder = new TextDecoder();
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > MAX_SEARCH_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("联网搜索响应超过大小限制");
			}
			text += decoder.decode(part.value, { stream: true });
		}
		return text + decoder.decode();
	} finally { reader.releaseLock(); }
}

let duckChallengeUntil = 0;

/** 每次外部网页请求都必须有上限；搜索调度传入的 signal 本身不会自动超时。 */
function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]);
}

export function resolveWebResearchProxy(env = process.env): URL | null {
	const raw = env.LIYUAN_WEB_RESEARCH_PROXY
		?? env.HTTPS_PROXY ?? env.https_proxy
		?? env.HTTP_PROXY ?? env.http_proxy
		?? "";
	if (!raw || raw.trim().toLowerCase() === "direct") return null;
	const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
	if (proxy.protocol !== "http:") throw new Error(`不支持的联网代理协议：${proxy.protocol}`);
	return proxy;
}

export function hostUsesWebResearchProxy(hostname: string, proxy: URL | null, env = process.env): boolean {
	if (!proxy) return false;
	const host = hostname.toLowerCase();
	const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "")
		.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
	return !noProxy.some((raw) => {
		const entry = raw.startsWith(".") ? raw.slice(1) : raw;
		return entry === "*" || host === entry || host.endsWith(`.${entry}`);
	});
}

export function tunnel(url: URL, proxy: URL, signal: AbortSignal, pinnedIp?: string): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason ?? new Error("联网查证已取消")); return; }
		if (url.protocol !== "https:" || proxy.protocol !== "http:") { reject(new Error("不支持的代理目标协议")); return; }
		let auth: string | undefined;
		try { if (proxy.username) auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64"); }
		catch { reject(new Error("代理认证编码无效")); return; }
		const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) });
		let secureSocket: tls.TLSSocket | undefined, settled = false, buffer = Buffer.alloc(0);
		const cleanup = () => {
			clearTimeout(timer); signal.removeEventListener("abort", abort);
			socket.off("data", onData); socket.off("end", onEnd); socket.off("close", onEnd);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true; cleanup(); secureSocket?.destroy(); socket.destroy();
			reject(error instanceof Error ? error : new Error("代理连接失败"));
		};
		const abort = () => fail(signal.reason ?? new Error("联网查证已取消"));
		const onEnd = () => fail(new Error("代理连接提前关闭"));
		const timer = setTimeout(() => fail(new Error("代理连接/TLS握手超时")), DEFAULT_TIMEOUT_MS);
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if ((end < 0 ? buffer.length : end) > 16_384) { fail(new Error("代理响应头过大")); return; }
			if (end < 0) return;
			if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(buffer.toString("latin1", 0, end))) { fail(new Error("代理 CONNECT 失败")); return; }
			socket.off("data", onData); socket.off("end", onEnd); socket.off("close", onEnd);
			if (buffer.length > end + 4) socket.unshift(buffer.subarray(end + 4));
			secureSocket = tls.connect({ socket, servername: url.hostname, rejectUnauthorized: true });
			secureSocket.on("error", fail);
			secureSocket.once("end", onEnd); secureSocket.once("close", onEnd);
			secureSocket.once("secureConnect", () => {
				if (settled || signal.aborted) { abort(); return; }
				settled = true; cleanup();
				secureSocket!.off("end", onEnd); secureSocket!.off("close", onEnd);
				resolve(secureSocket!);
			});
		};
		signal.addEventListener("abort", abort, { once: true });
		socket.on("error", fail); socket.once("end", onEnd); socket.once("close", onEnd); socket.on("data", onData);
		socket.once("connect", () => {
			const authority = `${pinnedIp ?? url.hostname}:${Number(url.port || 443)}`;
			const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
			if (auth) headers.push(`Proxy-Authorization: Basic ${auth}`);
			socket.write(`${headers.join("\r\n")}\r\n\r\n`);
		});
	});
}

export function trustedSearchRedirect(from: URL, value: string, hopsLeft: number): URL | null {
    try {
        const next = new URL(value, from);
        const bing = new Set(["www.bing.com", "cn.bing.com", "bing.com"]);
        const sameEngine = (bing.has(from.hostname) && bing.has(next.hostname)) || (from.hostname === "html.duckduckgo.com" && next.hostname === from.hostname);
        return hopsLeft > 0 && sameEngine && next.protocol === "https:" && !next.username && !next.password && (!next.port || next.port === "443") ? next : null;
    } catch { return null; }
}
export async function requestText(url: URL, signal: AbortSignal, hopsLeft = 2, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	signal = requestSignal(signal);
	const proxy = resolveWebResearchProxy(env);
	if (url.protocol !== "https:") throw new Error("联网来源仅支持HTTPS");
    // Native per-request HTTPS avoids the SDK's global fetch proxy dispatcher.
    // A research-only direct override must not change (or inherit) model routing.
    const socket = hostUsesWebResearchProxy(url.hostname, proxy, env) ? await tunnel(url, proxy!, signal) : undefined;
	return new Promise((resolve, reject) => {
		let settled = false;
		const done = (error?: Error, body = "") => {
			if (settled) return; settled = true; signal.removeEventListener("abort", abort);
			socket?.destroy(); if (error) reject(error); else resolve(body);
		};
		const abort = () => { req.destroy(); done(new Error("联网请求已取消")); };
		const req = https.request(url, { signal, rejectUnauthorized: true, headers: { "user-agent": SEARCH_USER_AGENT, accept: "text/html", "accept-encoding": "identity" },
            ...(socket ? { createConnection: () => socket } : { agent: false }) }, response => {
			if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
                const next = trustedSearchRedirect(url, response.headers.location ?? "", hopsLeft);
                response.destroy(); socket?.destroy(); signal.removeEventListener("abort", abort); settled = true;
                if (!next) reject(new Error("搜索源重定向目标不受信任或次数超限"));
                else requestText(next, signal, hopsLeft - 1, env).then(resolve, reject);
                return;
            }
            const declared = Number(response.headers["content-length"] ?? 0);
            if (response.statusCode !== 200 || ![undefined, "identity"].includes(response.headers["content-encoding"])
                || !Number.isFinite(declared) || declared < 0 || declared > MAX_SEARCH_RESPONSE_BYTES) {
				response.destroy(); done(new Error(`HTTP ${response.statusCode} 或不支持的编码`)); return;
			}
			const chunks: Buffer[] = []; let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_SEARCH_RESPONSE_BYTES) { req.destroy(); done(new Error("联网搜索响应超过大小限制")); }
				else chunks.push(chunk);
			});
			response.once("error", () => done(new Error("搜索响应读取失败")));
			response.once("aborted", () => done(new Error("搜索响应提前终止")));
			response.once("end", () => done(undefined, Buffer.concat(chunks).toString("utf8")));
			response.once("close", () => { if (!response.complete) done(new Error("搜索响应不完整")); });
		});
		req.once("error", () => done(new Error("联网请求失败")));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort(); else req.end();
	});
}

export function parseDuckDuckGo(html: string): WebResearchResult[] { return parseSearchHtml(html, "duck"); }

/** Keep the fallback engine in the query's language instead of always forcing a Chinese locale. */
export function fallbackSearchLocale(query: string): { language: string; market: string; country: string } {
	if (/[\u3040-\u30ff]/u.test(query)) return { language: "ja", market: "ja-JP", country: "JP" };
	if (/[\u3400-\u9fff]/u.test(query)) return { language: "zh-Hans", market: "zh-CN", country: "CN" };
	return { language: "en", market: "en-US", country: "US" };
}

/** Preserve query-language hints without forcing an alternative search-result view. */
export function bingSearchUrl(query: string): URL {
    const url = new URL("https://www.bing.com/search"), locale = fallbackSearchLocale(query);
    url.searchParams.set("q", query);
    url.searchParams.set("setlang", locale.language);
    url.searchParams.set("mkt", locale.market);
    url.searchParams.set("cc", locale.country);
    return url;
}
export function isSearchChallenge(html: string): boolean {
	return /complete the following challenge|confirm this search was made by a human|captcha|unusual traffic/i.test(html);
}

/** Bing HTML 兜底。链接可能是 Bing 跳转页，但标题/摘要仍可作为旁路研究来源。 */
export function parseBing(html: string): WebResearchResult[] { return parseSearchHtml(html, "bing"); }

export function canonicalSearchUrl(input: string): string | null {
    try {
        let url = new URL(input);
        if (["www.bing.com", "cn.bing.com", "bing.com"].includes(url.hostname)) {
            const encoded = url.searchParams.get("u");
            if (url.pathname === "/ck/a" && encoded?.startsWith("a1")) url = new URL(Buffer.from(encoded.slice(2), "base64url").toString("utf8"));
        }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return null;
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_")) url.searchParams.delete(key);
        return url.href;
    } catch { return null; }
}

export function rankWebResearchResults(query: string, rows: WebResearchResult[], limit = 3): WebResearchResult[] {
    const generic = new Set(["叙事", "故事", "结构", "选择", "后果", "书评", "影评", "节奏", "失败原因", "可复用", "负面案例"]);
    const groups = [...new Set(query.normalize("NFKC").toLowerCase().replace(/["'“”‘’()[\]{}<>，。！？、：；/\\|]/g, " ").split(/\s+/))]
        .filter(term => term.length >= 2 && !generic.has(term) && !term.startsWith("site:"))
        .map(term => ({ term,
            // Latin query terms match whole tokens: "or" must not match "for",
            // and "Mars" must not match "Marsden". CJK phrase/n-gram behavior remains unchanged.
            token: /^[\p{Script=Latin}\p{N}_-]+$/u.test(term)
                ? new RegExp(`(^|[^\\p{L}\\p{N}_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, "u")
                : undefined,
            fragments: /[\u3400-\u9fff]{2,}/u.test(term) ? [...new Set(Array.from({ length: Math.max(0, term.length - 1) }, (_,i) => term.slice(i, i + 2)))] : [] }));
    const targets = [...query.matchAll(/(?:^|\s)site:([a-z0-9.-]+)/gi)].map(match => match[1].toLowerCase());
	const seen = new Set<string>();
	const ranked = rows.flatMap((row, index) => {
		const normalizedUrl = canonicalSearchUrl(row.url);
		if (!normalizedUrl || seen.has(normalizedUrl)) return [];
		seen.add(normalizedUrl);
        const title = row.title.normalize("NFKC").toLowerCase(), snippet = row.snippet.normalize("NFKC").toLowerCase();
        const matched = groups.flatMap(({ term, token, fragments }) => {
            if (token ? token.test(title) : title.includes(term)) return [{ term, weight: 3 }];
            if (token ? token.test(snippet) : snippet.includes(term)) return [{ term, weight: 1 }];
            // Overlapping n-grams of a single name are one concept, not several
            // independent questions. Require broad coverage of a compound token.
            const coverage = fragments.filter(part => title.includes(part) || snippet.includes(part)).length;
            return fragments.length > 1 && coverage >= Math.ceil(fragments.length * 0.75) ? [{ term, weight: 1 }] : [];
        });
        const host = new URL(normalizedUrl).hostname.toLowerCase();
        if (targets.length && !targets.some(target => host === target || host.endsWith("." + target))) return [];
        const score = matched.reduce((sum, row) => sum + row.weight, 0);
        return [{ ...row, url: normalizedUrl, score, matched: matched.length, index }];
	});
    // Lexical coverage is a rejection gate, not a source-quality ranking. Re-sorting
    // by repeated query words can put a derivative copy before the engine's original
    // source (e.g. a mirror containing the acronym that the primary title expands).
    // Preserve provider rank for eligible candidates; site: remains a strict scope.
	// 相关性不足时返回空集合，绝不把搜索源的原始导航/推荐结果写进素材库。
	const minMatched = groups.length >= 2 ? 2 : 1;
	return ranked.filter((row) => row.score > 0 && row.matched >= minMatched).slice(0, limit).map(({ score: _score, matched: _matched, index: _index, ...row }) => row);
}

function protectedNames(card: CharacterCard): string[] {
	// A free-form franchise tag is not proof that this card's name is public canon.
	return [card.name].filter(name => name.trim().length >= 2);
}

function redactLiteral(value: string, secret: string): string {
	const needle = secret.trim();
	if (!needle) return value;
	return value.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
}

/** 最终发网闸门：即使规划模型重新写入用户名，也会在 HTTP 请求前剔除。 */
export function sanitizeWebResearchQuery(query: string, userName?: string): string {
	return redactLiteral(query, userName ?? "").replace(/\s+/g, " ").trim();
}

/** Backward-compatible shared egress guard, also enforced before Stage providers. */
export { containsPrivateSearchMaterial } from "../src/tools/research-privacy.ts";

function rejectReason(query: string, card: CharacterCard): string | undefined {
	if (query.length > 160 || containsPrivateSearchMaterial(query) || /(?:以下是用户|本轮输入|系统提示|<\/?(?:character|persona|world|user)>)/i.test(query)) {
		return "查询包含提示词包装或过长的私人上下文";
	}
	if (protectedNames(card).some((name) => query.toLowerCase().includes(name.toLowerCase()))) {
		return "查询包含没有公开作品出处的私人角色名；请改查年代、地点、职业、技术或社会规则";
	}
	return undefined;
}

export async function webResearchBatch(
	queries: string[],
	maxResults: number,
	options: { card: CharacterCard; userName?: string; signal?: AbortSignal; privacy?: ResearchPrivacyContext; publicTerms?: string[]; env?: NodeJS.ProcessEnv },
): Promise<WebResearchItem[]> {
    const env = options.env ?? process.env;
	return Promise.all(queries.slice(0, 3).map(async (rawQuery) => {
		const query = rawQuery.normalize("NFKC").replace(/\s+/gu, " ").trim();
        const privateReason = privateQueryReason(query, { ...options.privacy, publicTerms: options.publicTerms ?? [], privateTerms: [options.userName ?? "", ...protectedNames(options.card), ...(options.privacy?.privateTerms ?? [])] });
        if (privateReason) return { query, rejected: privateReason };
		if (query.length < 2) return { query, rejected: "查询脱敏后没有足够的公开主题" };
		const rejected = rejectReason(query, { ...options.card, name: options.publicTerms?.some(term => term.normalize("NFKC").toLowerCase() === options.card.name.normalize("NFKC").toLowerCase()) ? "" : options.card.name });
		if (rejected) return { query, rejected };
		try {
			const configuredTimeout = Number.parseInt(env.LIYUAN_WEB_RESEARCH_TIMEOUT_MS ?? "", 10);
            const timeout = Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(30_000, configuredTimeout)) : DEFAULT_TIMEOUT_MS;
			const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
			const searchUrl = env.LIYUAN_WEB_RESEARCH_URL;
			if (searchUrl) {
				const response = await fetch(searchUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ query, max_results: 8 }),
					redirect: "error",
					signal,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = JSON.parse(await boundedFetchText(response)) as { results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown; content?: unknown }> };
				const rows = (Array.isArray(payload.results) ? payload.results : []).slice(0, 50).flatMap(row => {
                    if (!row || typeof row.title !== "string" || typeof row.url !== "string") return [];
                    const snippet = typeof row.snippet === "string" ? row.snippet : typeof row.content === "string" ? row.content : "";
                    if (privateQueryReason(row.url, { publicTerms: options.publicTerms, privateTerms: [options.userName ?? "", options.card.name] }) || containsPrivateSearchMaterial(row.url)) return [];
                    return [{ title: row.title.slice(0, 300), url: row.url, snippet: snippet.slice(0, 1200) }];
                });
				return { query, results: rankWebResearchResults(query, rows, maxResults) };
			}
			let duckHtml = "";
			let duckRows: WebResearchResult[] = [];
			if (Date.now() >= duckChallengeUntil) {
				const duck = new URL("https://html.duckduckgo.com/html/");
				duck.searchParams.set("q", query);
				try {
					// Do not spend the entire shared 15s deadline on a stalled primary source.
					duckHtml = await requestText(duck, AbortSignal.any([signal, AbortSignal.timeout(6000)]), 2, env);
					if (isSearchChallenge(duckHtml)) duckChallengeUntil = Date.now() + 30 * 60_000;
					else duckRows = parseDuckDuckGo(duckHtml);
				} catch (error) {
					// Primary-source timeout is not a successful empty search; try Bing while
					// the outer budget permits. Parent cancellation must still terminate.
					if (signal.aborted) throw error;
				}
			}
			if (duckRows.length) {
				const relevant = rankWebResearchResults(query, duckRows, maxResults);
				if (relevant.length) return { query, results: relevant };
				// A page of unrelated search results is NOT a successful retrieval.
				// Try the secondary engine before claiming nothing useful exists.
			}

			// DuckDuckGo 经常对服务器 IP 返回人机验证页。自动改用 Bing，而不是把 0 结果
			// 伪装成搜索成功，让生态全局池永久为空。
			const bing = bingSearchUrl(query);
            const bingHtml = await requestText(bing, signal, 2, env);
            if (isSearchChallenge(bingHtml)) throw new Error("Bing 搜索源要求人机验证；未将挑战页当作来源");
            const bingRows = parseBing(bingHtml);
			if (!bingRows.length) throw new Error((duckHtml && isSearchChallenge(duckHtml)) || Date.now() < duckChallengeUntil ? "搜索源返回人机验证，Bing 兜底也无结果" : "搜索源均无可解析结果");
			return { query, results: rankWebResearchResults(query, bingRows, maxResults) };
		} catch (error) {
			return { query, error: error instanceof Error ? error.message : String(error) };
		}
	}));
}
