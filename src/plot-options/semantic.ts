import { abortable } from "../async-abort.ts";
import { createRequestDeadline, requestAbortError } from "../request-budget.ts";
import type { PlotRetrievalStatus } from "./types.ts";
export type { PlotRetrievalStatus } from "./types.ts";
import { PlotOptionsStore } from "./store.ts";
import { plotHash, retrievePlotCards, type PlotCard } from "./library.ts";
export interface PlotEmbeddingRequestScope {
    sessionId: string;
    card: string;
    sourceEntryId: string;
}
export interface PlotEmbeddingProvider {
    /** Fingerprint includes endpoint/model/config revision, never a raw credential. */
    key: string;
    model: string;
    embed(texts: string[], signal: AbortSignal, scope?: PlotEmbeddingRequestScope): Promise<{
        vectors: number[][];
        inputTokens?: number;
    }>;
}
interface CachedVector {
    hash: string;
    packed: string;
}
interface SemanticIndex {
    version: 1;
    dimension: number;
    entries: Record<string, CachedVector>;
    queries: Record<string, string>;
    blocked: Record<string, string>;
    queryBlocked: string[];
}
const emptyIndex = (): SemanticIndex => ({ version: 1, dimension: 0, entries: {}, queries: {}, blocked: {}, queryBlocked: [] });
const clipped = (value: unknown, max: number): string => (value == null ? "" : typeof value === "string" ? value : JSON.stringify(value)).slice(0, max);
const safeError = (value: unknown): string => (value instanceof Error ? value.message : String(value))
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b(api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 250);
/** Stable, bounded mechanism text, not just the title/location. Bump format when changing it. */
export function semanticCardText(card: PlotCard): string {
    return ["plot-semantic-v1", `主题：${card.title}`, `情境：${card.setting}`, `活动：${card.surfaceActivity}`,
        `发起动机：${card.initiative}`, `互动趣味：${card.sweetBeat}`, `摩擦：${card.friction}`,
        `误会：${card.misunderstanding}`, `关系变化：${card.microChange}`, `边界：${card.escalationLimit}`,
        `停点：${card.naturalStop}`, `不适用：${card.failureWarning}`].map(t => t.slice(0, 260)).join("\n").slice(0, 2800);
}
function outlineQueryText(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return clipped(value, 1400);
    const outline = value as Record<string, unknown>;
    const focus = new Set(Array.isArray(outline.currentFocus) ? outline.currentFocus : []);
    const collections = outline.collections && typeof outline.collections === "object" ? Object.values(outline.collections) : [];
    const nodes = collections.flatMap(rows => Array.isArray(rows) ? rows : []).filter(row => row && typeof row === "object") as Array<Record<string, unknown>>;
    const prioritized = nodes.sort((a, b) => Number(focus.has(b.id)) - Number(focus.has(a.id)) || Number(b.status === "active") - Number(a.status === "active"));
    return [clipped(outline.premise, 180), ...prioritized.slice(0, 6).map(row => `${clipped(row.title, 80)}：${clipped(row.summary, 180)}`)].join("\n").slice(0, 1400) || clipped(outline, 1400);
}
export function buildPlotSemanticQueries(input: {
    state: unknown;
    outline: unknown;
    persona: string;
    history: Array<{
        text: string;
    }>;
    summary?: unknown;
}): string[] {
    const recent = input.history.slice(-4).reverse().map(h => h.text.slice(-1000)).join("\n");
    return [
        `最近原文（最新在前）：${recent}\n玩家设定：${clipped(input.persona, 500)}\n大纲候选：${outlineQueryText(input.outline)}`,
        `当前互动末段：${input.history.at(-1)?.text.slice(-1600) ?? ""}\n前情参考：${clipped(input.summary, 700)}\n账本参考（可能滞后）：${clipped(input.state, 1000)}`,
    ].map(t => t.slice(0, 4400));
}
function normalized(vector: unknown, dimension = 0): number[] {
    if (!Array.isArray(vector) || vector.length < 2 || vector.length > 16384 || (dimension && vector.length !== dimension) || vector.some(x => typeof x !== "number" || !Number.isFinite(x)))
        throw Error("嵌入向量维度或数值无效，未混用旧索引");
    const norm = Math.sqrt(vector.reduce((sum: number, x: number) => sum + x * x, 0));
    if (!Number.isFinite(norm) || norm <= 0)
        throw Error("嵌入向量为零或溢出");
    return vector.map(x => x / norm);
}
function pack(vector: number[]): string {
    const bytes = Buffer.alloc(vector.length * 4);
    vector.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
    return bytes.toString("base64");
}
function unpack(value: string, dimension: number): number[] {
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
        throw Error("语义索引向量损坏");
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== dimension * 4)
        throw Error("语义索引维度不匹配");
    return normalized(Array.from({ length: dimension }, (_, i) => bytes.readFloatLE(i * 4)), dimension);
}
/** RRF plus reserved slots: a purely semantic hit must not lose every slot to lexical overlap. */
export function fusePlotRanks(cards: PlotCard[], keyword: PlotCard[], semantic: PlotCard[], limit = 24, avoid: string[] = []): PlotCard[] {
    const byId = new Map(cards.map(c => [c.id, c])), scores = new Map<string, number>(), ignored = new Set(avoid);
    for (const list of [keyword, semantic])
        list.forEach((c, i) => scores.set(c.id, (scores.get(c.id) ?? 0) + 1 / (60 + i + 1)));
    const chosen: PlotCard[] = [], seen = new Set<string>();
    const add = (c: PlotCard) => { if (chosen.length < limit && !seen.has(c.id)) {
        seen.add(c.id);
        chosen.push(c);
    } };
    const reserve = Math.floor(limit / 3);
    const variedSemantic = [...semantic].sort((a, b) => Number(ignored.has(a.id)) - Number(ignored.has(b.id)));
    variedSemantic.slice(0, reserve).forEach(add);
    keyword.slice(0, reserve).forEach(add);
    [...scores].sort((a, b) => (b[1] - (ignored.has(b[0]) ? 0.008 : 0)) - (a[1] - (ignored.has(a[0]) ? 0.008 : 0)) || a[0].localeCompare(b[0])).forEach(([id]) => { const c = byId.get(id); if (c)
        add(c); });
    return chosen;
}
/** Only card embeddings are shared. Query cache keys include the current story scope/source. */
export class PlotSemanticSearch {
    private readonly store: PlotOptionsStore;
    private readonly provider: () => PlotEmbeddingProvider | undefined;
    private readonly maxBatches: number;
    private live: PlotRetrievalStatus | undefined;
    private busy = false;
    private activeProviderKey = "";
    private readonly timeoutMs: number;
    constructor(deps: {
        root: string;
        provider(): PlotEmbeddingProvider | undefined;
        maxBatches?: number;
        timeoutMs?: number;
    }) {
        this.store = new PlotOptionsStore(deps.root);
        this.provider = deps.provider;
        this.maxBatches = deps.maxBatches ?? 8;
        this.timeoutMs = deps.timeoutMs ?? 45000;
    }
    private name(p: PlotEmbeddingProvider): string { return `semantic-${plotHash(["plot-semantic-v1", p.key])}`; }
    private load(p: PlotEmbeddingProvider): SemanticIndex {
        const raw = this.store.cache(this.name(p)) as SemanticIndex | undefined;
        if (raw === undefined)
            return emptyIndex();
        const map = (v: unknown) => v && typeof v === "object" && !Array.isArray(v);
        if (!raw || raw.version !== 1 || !Number.isInteger(raw.dimension) || raw.dimension < 0 || raw.dimension > 16384 || !map(raw.entries) || !map(raw.queries) || !map(raw.blocked) || !Array.isArray(raw.queryBlocked) || (!raw.dimension && Object.keys(raw.entries).length))
            throw Error("语义索引损坏，请检查私有缓存；已回退关键词");
        return raw;
    }
    reset(): void {
        if (this.busy)
            throw Error("语义索引正在使用，请稍候");
        const p = this.provider();
        if (!p)
            throw Error("请先配置独立云端嵌入连接");
        this.store.cache(this.name(p), emptyIndex());
    }
    status(cards: PlotCard[]): PlotRetrievalStatus {
        const p = this.provider();
        const base: PlotRetrievalStatus = { method: "keyword-fallback", phase: "idle", indexed: 0, total: cards.length, configured: !!p, ...(p ? { model: p.model } : {}), requests: 0, inputTokens: null };
        if (!p)
            return { ...base, message: "云端嵌入模式未启用或连接不完整；本地字符哈希不作为语义检索" };
        try {
            const index = this.load(p), indexed = cards.filter(c => index.entries[c.id]?.hash === plotHash(semanticCardText(c))).length;
            if (this.busy && this.live && this.activeProviderKey === p.key)
                return { ...this.live, indexed, total: cards.length };
            return { ...base, method: indexed ? "hybrid" : "keyword-fallback", phase: indexed ? "ready" : "idle", indexed };
        }
        catch (e) {
            return { ...base, phase: "fallback", message: safeError(e) };
        }
    }
    async retrieve(input: {
        cards: PlotCard[];
        queries: string[];
        keywordQuery: string;
        scopeKey: string;
        signal: AbortSignal;
        retry: boolean;
        batchSize?: number;
        avoid?: string[];
        requestScope?: PlotEmbeddingRequestScope;
    }): Promise<{
        cards: PlotCard[];
        status: PlotRetrievalStatus;
    }> {
        const { cards } = input, keyword = retrievePlotCards(cards, input.keywordQuery, 48, input.avoid), p = this.provider();
        const report = this.status(cards);
        report.requests = 0;
        report.inputTokens = null;
        const fallback = (message: string) => ({ cards: keyword.slice(0, 24), status: { ...report, method: "keyword-fallback" as const, phase: "fallback" as const, message: safeError(message) } });
        if (!p)
            return fallback(report.message!);
        if (input.signal.aborted)
            return fallback("语义查询已取消");
        if (this.busy)
            return fallback("语义索引正在使用，暂用关键词，不并发重复请求");
        const deadline = createRequestDeadline(input.signal, this.timeoutMs, "plot-semantic", "日常剧情语义检索");
        const signal = deadline.signal;
        this.busy = true;
        this.live = report;
        this.activeProviderKey = p.key;
        let index: SemanticIndex | undefined, knownTokens = 0, allUsageKnown = true;
        const guard = () => { signal.throwIfAborted(); if (this.provider()?.key !== p.key)
            throw Error("嵌入配置已改变，拒绝旧结果"); };
        const call = async (texts: string[]) => {
            guard();
            report.requests++;
            report.inputTokens = null;
            const response = await abortable(p.embed(texts, signal, input.requestScope), signal);
            guard();
            if (response.vectors.length !== texts.length)
                throw Error("嵌入条数不匹配");
            const vectors = response.vectors.map(v => normalized(v, index!.dimension));
            const dimension = vectors[0]?.length ?? 0;
            if (!vectors.every(v => v.length === dimension))
                throw Error("同批向量维度不一致");
            if (!index!.dimension)
                index!.dimension = dimension;
            if (typeof response.inputTokens === "number" && Number.isFinite(response.inputTokens) && response.inputTokens >= 0)
                knownTokens += response.inputTokens;
            else
                allUsageKnown = false;
            report.inputTokens = allUsageKnown ? knownTokens : null;
            return vectors;
        };
        try {
            if (!input.queries.length || input.queries.length > 3 || input.queries.some(q => !q.trim() || q.length > 6000))
                throw Error("语义查询为空或超过预算");
            guard();
            index = this.load(p);
            const visible = new Set(cards.map(c => c.id));
            for (const id of Object.keys(index.entries))
                if (!visible.has(id))
                    delete index.entries[id];
            for (const id of Object.keys(index.blocked))
                if (!visible.has(id))
                    delete index.blocked[id];
            const missing = cards.filter(c => index!.entries[c.id]?.hash !== plotHash(semanticCardText(c)));
            const eligible = missing.filter(c => input.retry || index!.blocked[c.id] !== plotHash(semanticCardText(c)));
            const batchSize = [1, 8, 16, 32].includes(input.batchSize ?? 32) ? input.batchSize ?? 32 : 32;
            const batches = Math.min(Math.ceil(eligible.length / batchSize), this.maxBatches);
            report.phase = "indexing";
            for (let i = 0; i < batches; i++) {
                guard();
                const batch = eligible.slice(i * batchSize, (i + 1) * batchSize), texts = batch.map(semanticCardText);
                batch.forEach((c, n) => { index!.blocked[c.id] = plotHash(texts[n]); });
                // Pending is persisted before charging; auto refresh cannot duplicate an interrupted batch.
                this.store.cache(this.name(p), index);
                const vectors = await call(texts);
                batch.forEach((c, n) => { index!.entries[c.id] = { hash: plotHash(texts[n]), packed: pack(vectors[n]) }; delete index!.blocked[c.id]; });
                this.store.cache(this.name(p), index);
                report.indexed = cards.filter(c => index!.entries[c.id]?.hash === plotHash(semanticCardText(c))).length;
            }
            report.indexed = cards.filter(c => index!.entries[c.id]?.hash === plotHash(semanticCardText(c))).length;
            if (!report.indexed)
                return fallback("没有有效语义向量；上次失败批次需手动重新筹备后重试");
            report.phase = "querying";
            const queryKey = plotHash([input.scopeKey, input.queries]), cached = index.queries[queryKey];
            let queryVectors: number[][];
            if (cached)
                queryVectors = JSON.parse(cached).map((v: string) => unpack(v, index!.dimension));
            else {
                if (!input.retry && index.queryBlocked.includes(queryKey))
                    return fallback("此语义查询上次未完成，需手动重新筹备以免重复收费");
                index.queryBlocked = [...index.queryBlocked.filter(k => k !== queryKey), queryKey].slice(-64);
                this.store.cache(this.name(p), index);
                queryVectors = [];
                for (let q = 0; q < input.queries.length; q += batchSize) queryVectors.push(...await call(input.queries.slice(q, q + batchSize)));
                index.queries[queryKey] = JSON.stringify(queryVectors.map(pack));
                index.queryBlocked = index.queryBlocked.filter(k => k !== queryKey);
                const keys = Object.keys(index.queries);
                keys.slice(0, Math.max(0, keys.length - 64)).forEach(k => delete index!.queries[k]);
                this.store.cache(this.name(p), index);
            }
            const semantic = cards.flatMap(card => {
                const row = index!.entries[card.id];
                if (row?.hash !== plotHash(semanticCardText(card)))
                    return [];
                const vector = unpack(row.packed, index!.dimension);
                const score = Math.max(...queryVectors.map(q => vector.reduce((sum, x, n) => sum + x * q[n], 0)));
                return Number.isFinite(score) ? [{ card, score }] : [];
            }).sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id)).slice(0, 48).map(r => r.card);
            guard();
            report.phase = "ready";
            report.method = "hybrid";
            if (report.indexed < cards.length)
                report.message = `语义索引部分覆盖 ${report.indexed}/${cards.length}；关键词仍检索全库。后续筹备增量补齐，失败批次需手动重试。`;
            return { cards: fusePlotRanks(cards, keyword, semantic, 24, input.avoid), status: { ...report } };
        }
        catch (e) {
            if (index)
                report.indexed = cards.filter(c => index!.entries[c.id]?.hash === plotHash(semanticCardText(c))).length;
            return fallback(safeError(signal.aborted ? requestAbortError(signal, "语义检索已取消") : e));
        }
        finally {
            deadline.dispose();
            this.busy = false;
            this.live = undefined;
            this.activeProviderKey = "";
        }
    }
}
