/** Turn-local, read-only capabilities. No story writes or cross-branch authorization. */
import { createHash } from "node:crypto";
import { selectResearchExcerpt } from "./research-text.ts";
import type { ResearchEvidenceCache, ResearchCacheScope } from "./research-cache.ts";
import type { GenerationMode } from "../stage/generation-mode.ts";
import type { WebResearchItem } from "./web-research.ts";

export interface SourceOpenReceipt { url: string; excerpt?: string; rejected?: string; documentText?: string; retrievedAt?: string; reused?: boolean; sourceFingerprint?: string; locator?: { start: number; end: number; unit: "utf16-clean-text" } }
export type WebSearchProvider = (queries: string[], maxResults: number, signal?: AbortSignal, refresh?: boolean) => Promise<WebResearchItem[]>;
export type WebOpenProvider = (url: string, focus: string, signal?: AbortSignal, refresh?: boolean) => Promise<SourceOpenReceipt>;
const boundedSearchRow = (row: WebResearchItem, query: string): WebResearchItem => ({ query,
    ...(row.error ? { error: String(row.error).slice(0, 500) } : {}), ...(row.rejected ? { rejected: String(row.rejected).slice(0, 500) } : {}),
    ...(Array.isArray(row.results) ? { results: row.results.slice(0, 5).filter(result => typeof result?.url === "string" && result.url.length <= 2048 && /^https:\/\//i.test(result.url)).map(result => ({
        url: result.url, title: typeof result.title === "string" ? result.title.slice(0, 200) : "", snippet: typeof result.snippet === "string" ? result.snippet.slice(0, 450) : "" })) } : {}),
});
const normalize = (query: string) => query.normalize("NFKC").replace(/\s+/gu, " ").trim();

/** Race non-cooperating providers too; observing a late rejection must not leak it. */
async function guarded<T>(work: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return fallback;
	let abort!: () => void;
	const cancelled = new Promise<T>(resolve => { abort = () => resolve(fallback); signal.addEventListener("abort", abort, { once: true }); });
	try { const value = await Promise.race([work, cancelled]); return signal.aborted ? fallback : value; }
	finally { signal.removeEventListener("abort", abort); }
}

export function createResearchTurnScope(mode: GenerationMode, search?: WebSearchProvider, open?: WebOpenProvider, signal?: AbortSignal, isCurrent = () => true, reuse?: { cache: ResearchEvidenceCache; scope: ResearchCacheScope | (() => ResearchCacheScope) }, userSourceUrls: string[] = []): {
	webResearch?: (queries: string[], maxResults: number, signal?: AbortSignal, refresh?: boolean) => Promise<WebResearchItem[]>;
	webOpen?: (url: string, focus: string, signal?: AbortSignal, refresh?: boolean) => Promise<SourceOpenReceipt>;
    /** Host-only expert bridge; only explicit, authorized URLs and current ancestry. */
    cachedResearchSources: () => SourceOpenReceipt[];
} {
	const queryLimit = mode === "director" ? 9 : 3, openLimit = mode === "director" ? 6 : 1;
	const returnedUrls = new Set<string>(userSourceUrls.filter(url => typeof url === "string" && url.length <= 2048).slice(0, 10));
	const searched = new Map<string, Promise<WebResearchItem>>();
	const attempts = new Map<string, number>();
	const opened = new Map<string, Promise<SourceOpenReceipt>>();
	const documents = new Map<string, Promise<SourceOpenReceipt>>();
    const ownQueries = new Set<string>(), ownDocuments = new Set<string>();
    const inFlightQueries = new Set<string>(), inFlightDocuments = new Set<string>();
    const projectDocument = (row: SourceOpenReceipt, focus: string): SourceOpenReceipt => {
        if (!row.documentText) return { url: row.url, ...(row.excerpt ? { excerpt: row.excerpt.slice(0, 4000) } : {}), ...(row.rejected ? { rejected: row.rejected } : {}), retrievedAt: row.retrievedAt, reused: row.reused === true };
        const excerpt = selectResearchExcerpt(row.documentText, focus), start = row.documentText.indexOf(excerpt);
        return { url: row.url, excerpt, retrievedAt: row.retrievedAt, reused: row.reused === true,
            sourceFingerprint: createHash("sha256").update(row.documentText, "utf8").digest("hex"),
            locator: { start, end: start + excerpt.length, unit: "utf16-clean-text" } };
    };
    let readAttempts = 0;
	const invalid = () => signal?.aborted || !isCurrent();
    let cacheScope: ResearchCacheScope | undefined;
    const getScope = () => cacheScope ??= typeof reuse!.scope === "function" ? reuse!.scope() : reuse!.scope;
    const cacheKey = (kind: string, key: string) => JSON.stringify([reuse ? getScope().contextKey : "", kind, key]);
	const cancelled: WebResearchItem = { query: "", rejected: "本拍已取消或分支改变，丢弃迟到来源" };
	const combine = (child?: AbortSignal) => signal && child ? AbortSignal.any([signal, child]) : signal ?? child;
	return {
        cachedResearchSources: () => {
            if (!reuse || invalid()) return [];
            return [...returnedUrls].slice(0, 10).flatMap(url => {
                const row = reuse.cache.get<SourceOpenReceipt>(cacheKey("document", url), getScope());
                return row?.url === url && row.documentText && !row.rejected ? [projectDocument({ ...row, reused: true }, "")] : [];
            });
        },
		...(search ? { webResearch: async (queries: string[], maxResults: number, child?: AbortSignal, refresh = false) => {
			const requestSignal = combine(child);
			if (invalid() || requestSignal?.aborted) return [cancelled];
			const unique = [...new Set(queries.filter(x => typeof x === "string").map(normalize))].filter(q => q.length >= 1 && q.length <= 160).slice(0, 3);
			if (refresh) for (const query of unique) if (!inFlightQueries.has(query)) searched.delete(query);
            for (const query of unique) if (!searched.has(query) && reuse && !refresh && !ownQueries.has(query)) {
                const row = reuse.cache.get<WebResearchItem>(cacheKey("search", query), getScope());
                if (row && !row.error && !row.rejected) searched.set(query, Promise.resolve({ ...row, reused: true }));
            }
            const fresh = unique.filter(q => !searched.has(q) && (attempts.has(q) || attempts.size < queryLimit) && (attempts.get(q) ?? 0) < 2);
			// Reserve before calling a provider, including synchronous throws/reentry.
			let resolve!: (rows: WebResearchItem[]) => void;
			const batch = new Promise<WebResearchItem[]>(r => { resolve = r; });
			const accepted: string[] = [];
			for (const query of fresh) {
				if (!attempts.has(query) && attempts.size >= queryLimit) continue;
				attempts.set(query, (attempts.get(query) ?? 0) + 1); accepted.push(query); ownQueries.add(query); inFlightQueries.add(query);
				const pending: Promise<WebResearchItem> = batch.then(rows => requestSignal?.aborted || invalid()
                    ? { query, rejected: "来源请求已取消，丢弃迟到结果" }
                    : { ...boundedSearchRow((Array.isArray(rows) ? rows : []).find(row => row && typeof row.query === "string" && normalize(row.query) === query) ?? { query, error: "搜索源未返回该查询的结果" }, query), retrievedAt: new Date().toISOString(), reused: false });
				searched.set(query, pending);
				void pending.then(row => {
                    inFlightQueries.delete(query);
                    if (row.error || row.rejected) { searched.delete(query); if (row.rejected && !requestSignal?.aborted && !invalid()) attempts.delete(query); }
                    else if (reuse && !invalid() && !requestSignal?.aborted) reuse.cache.put(cacheKey("search", query), getScope(), row);
                });
			}
			if (accepted.length) {
				// Fetch the complete tool-visible candidate set once. Smaller callers only slice.
				try { void search(accepted, 5, requestSignal).then(resolve,
					() => resolve(accepted.map(query => ({ query, error: "搜索源请求失败" })))); }
				catch { resolve(accepted.map(query => ({ query, error: "搜索源请求失败" }))); }
			}
			const pending = Promise.all(unique.map(query => searched.get(query) ?? Promise.resolve<WebResearchItem>({ query, rejected: "本拍联网查询额度已用完" })));
			const rows = await guarded(pending, requestSignal, [cancelled]);
			if (invalid() || requestSignal?.aborted) return [cancelled];
			const cap = Math.max(1, Math.min(5, Number.isFinite(maxResults) ? Math.trunc(maxResults) : 3));
			return rows.map(row => {
				const results = row.results?.slice(0, cap);
				if (!row.error && !row.rejected) for (const result of results ?? []) returnedUrls.add(result.url);
				return { ...row, reused: !accepted.includes(row.query) || row.reused === true, ...(results ? { results } : {}) };
			});
		} } : {}),
		...(open && (search || returnedUrls.size) ? { webOpen: async (url: string, focus: string, child?: AbortSignal, refresh = false) => {
			const requestSignal = combine(child); const rejected: SourceOpenReceipt = { url, rejected: "本拍已取消或分支改变，丢弃迟到网页" };
			if (invalid() || requestSignal?.aborted) return rejected;
			if (!returnedUrls.has(url)) return { url, rejected: "只能打开本拍搜索候选或用户明确提供的网址" };
            const key = JSON.stringify([url, normalize(focus)]);
            const withoutDocument = (row: SourceOpenReceipt): SourceOpenReceipt => projectDocument(row, focus);
            if (refresh && !inFlightDocuments.has(url)) {
                documents.delete(url);
                for (const cachedKey of opened.keys()) if (JSON.parse(cachedKey)[0] === url) opened.delete(cachedKey);
            }
            if (!documents.has(url) && reuse && !refresh && !ownDocuments.has(url)) {
                const cached = reuse.cache.get<SourceOpenReceipt>(cacheKey("document", url), getScope());
                if (cached?.documentText) documents.set(url, Promise.resolve({ ...cached, reused: true }));
            }
            if (documents.has(url)) {
                const row = await guarded(documents.get(url)!, requestSignal, rejected);
                if (invalid() || requestSignal?.aborted) return rejected;
                if (row.documentText) return projectDocument({ ...row, reused: true }, focus);
            }
            if (!opened.has(key) && reuse && !refresh && !ownDocuments.has(url)) {
                const cached = reuse.cache.get<SourceOpenReceipt>(cacheKey("open", key), getScope());
                if (cached) opened.set(key, Promise.resolve({ ...cached, reused: true }));
            }
            if (!opened.has(key)) {
                if (readAttempts >= openLimit) return { url, rejected: "本拍网页阅读额度已用完" };
                readAttempts++; ownDocuments.add(url); inFlightDocuments.add(url);
                const pending: Promise<SourceOpenReceipt> = Promise.resolve().then(() => open(url, focus, requestSignal))
                    .then(row => requestSignal?.aborted || invalid() ? rejected : row.url !== url ? { url, rejected: "网页回执出处与请求URL不一致" } : row.rejected ? { url, rejected: row.rejected } : ({ ...row, retrievedAt: new Date().toISOString(), reused: false, ...(row.documentText ? { documentText: row.documentText.slice(0, 160_000) } : {}) }))
                    .catch(() => ({ url, rejected: "网页来源请求失败" }));
                opened.set(key, pending); documents.set(url, pending);
                void pending.then(row => {
                    inFlightDocuments.delete(url);
                    if (!row.excerpt && !row.documentText) { opened.delete(key); documents.delete(url); }
                    else if (reuse && !invalid() && !requestSignal?.aborted) {
                        reuse.cache.put(cacheKey("open", key), getScope(), withoutDocument(row));
                        if (row.documentText) reuse.cache.put(cacheKey("document", url), getScope(), row);
                    }
                });
            }
            const row = await guarded(opened.get(key)!, requestSignal, rejected);
            return invalid() || requestSignal?.aborted ? rejected : withoutDocument(row);
		} } : {}),
	};
}
