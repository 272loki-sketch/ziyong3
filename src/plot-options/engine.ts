import type { LorebookEntry } from "../types.ts";
import { planningHistory, planningLore, plotMaterialKey, PLOT_RELEVANCE_VERSION, validatePlotGrounding, normalizePlanText } from "./relevance.ts";
import { abortable } from "../async-abort.ts";
import { analysisRequestTimeoutMs, createRequestDeadline, requestAbortError } from "../request-budget.ts";
import { buildPlotSemanticQueries, type PlotSemanticSearch } from "./semantic.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BranchEntryLike } from "../stage/assemble.ts";
import { plotCards, plotHash, retrievePlotCards, type PlotCard } from "./library.ts";
import { PlotOptionsStore, type PlotBatch } from "./store.ts";
import { validPlotChoice, type PlotChoiceInput, type PlotEvidence, type PlotOptionsView, type PlotProgress, type PlotRecommendation, type PlotSelection, type PlotSettings } from "./types.ts";
import type { CorpusDailyPattern } from "../outline/corpus.ts";
export interface PlotContext {
    worldLore?: LorebookEntry[];
    sessionId: string;
    cardPath?: string;
    cardIdentity: string;
    sourceId: string;
    branch: BranchEntryLike[];
    card: unknown;
    persona: string;
    state: unknown;
    outline: unknown;
    outlineHash: string;
    modelKey: string;
    skill: string;
}
export interface PlotOptionsDeps {
    semanticSearch?: PlotSemanticSearch;
    cwd: string;
    context(): PlotContext;
    busy(): boolean;
    library(): Array<CorpusDailyPattern & {
        docId: string;
    }>;
    run(system: string, user: string, signal: AbortSignal, timeoutMs: number): Promise<string | {
        error: string;
    }>;
    appendControl(data: {
        version: 1;
        cancel: true;
    }): void;
    /** Selection-only budget; retrieval has its own deadline. Read once per job. */
    timeoutMs?: number | (() => number);
}
const safeError = (value: unknown): string => (value instanceof Error ? value.message : String(value))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b(api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 500);
const MISSING_MODEL_ERROR = "请在设置 → 模型插头配置独立的“日常剧情筹备”岗位；不会借用导演模型";
/** Exact legacy host diagnostic was emitted before any paid-attempt receipt. */
const missingModelBlock = (batch: PlotBatch | undefined): boolean => batch?.blockedBy === "model" || (batch?.error === MISSING_MODEL_ERROR && batch.retrieval === undefined);
const object = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const text = (x: unknown, max = 500): string => typeof x === "string" ? x.trim().slice(0, max) : "";
const texts = (x: unknown): string[] => Array.isArray(x) ? x.slice(0, 3).map(v => text(v, 240)).filter(Boolean) : [];
export const plotContextKey = (c: PlotContext): string => plotHash([c.sessionId, c.cardIdentity]);
const incompleteSources = (branch: BranchEntryLike[]): Set<unknown> => new Set(branch.flatMap(e => e.customType === "rp-turn-settlement" && object(e.data).authorComplete === false ? [object(e.data).narrativeEntryId] : []));
export function plotHistory(branch: BranchEntryLike[]): Array<{
    id: string;
    role: string;
    text: string;
}> {
    const incomplete = incompleteSources(branch);
    return branch.flatMap(e => {
        if (e.message?.role === "assistant" && (incomplete.has(e.id) || ["aborted", "error"].includes(e.message.stopReason ?? "")))
            return [];
        if (!e.id || !e.message || !["user", "assistant"].includes(e.message.role ?? ""))
            return [];
        const details = object(e.message.details);
        const raw = e.message.role === "assistant" ? details.rpNarrative : e.message.content;
        const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(p => object(p).type === "text" ? text(object(p).text, 16000) : "").join("") : "";
        return value ? [{ id: e.id, role: e.message.role!, text: value }] : [];
    });
}
export function completedPlotRounds(branch: BranchEntryLike[]): number {
    const incomplete = incompleteSources(branch);
    return branch.filter(e => e.id && !incomplete.has(e.id) && e.message?.role === "assistant" && !["aborted", "error"].includes(e.message.stopReason ?? "") && text(object(e.message.details).rpNarrative, 1000000)).length;
}
function activeSelection(branch: BranchEntryLike[]): {
    entryId: string;
    selection: PlotSelection;
} | null {
    for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (e.customType === "rp-plot-direction" && object(e.data).cancel === true)
            return null;
        const value = object(e.message?.details).rpPlotSelection as PlotSelection | undefined;
        if (e.message?.role === "user" && e.id && value?.version === 1 && value.option?.id && value.contextKey)
            return { entryId: e.id, selection: value };
    }
    return null;
}
function evidenceOf(raw: unknown, history: ReturnType<typeof plotHistory>): PlotEvidence[] {
    if (!Array.isArray(raw))
        return [];
    return raw.slice(0, 4).flatMap(e => {
        const row = object(e), entryId = text(row.entryId, 256), quote = text(row.quote, 240);
        return quote.length >= 4 && history.some(h => h.id === entryId && h.text.includes(quote)) ? [{ entryId, quote }] : [];
    });
}
function progressHistory(history: ReturnType<typeof plotHistory>, selectionEntryId: string): ReturnType<typeof plotHistory> {
    const index = history.findIndex(h => h.id === selectionEntryId);
    return index < 0 ? [] : history.slice(index + 1).filter(h => h.role === "assistant");
}
/** Optional, source-scoped planning service; never awaited by the story engine. */
export class PlotOptionsEngine {
    readonly store: PlotOptionsStore;
    #task: {
        key: string;
        controller: AbortController;
    } | null = null;
    #generation = 0;
    #timer?: ReturnType<typeof setInterval>;
    #lastError = "";
    #errorKey = "";
    private readonly deps: PlotOptionsDeps;
    constructor(deps: PlotOptionsDeps) { this.deps = deps; this.store = new PlotOptionsStore(join(deps.cwd, ".liyuan", "plot-options")); }
    start(): void {
        if (!this.#timer) {
            this.#timer = setInterval(() => {
                try {
                    this.tick();
                }
                catch (e) {
                    this.#lastError = safeError(e);
                    try {
                        this.#errorKey = plotContextKey(this.deps.context());
                    }
                    catch { /* Missing card must not escape the optional timer. */ }
                }
            }, 5000);
            this.#timer.unref();
        }
    }
    cancel(): void { this.#generation++; this.#task?.controller.abort(new Error("剧情筹备已取消")); }
    close(): void { this.cancel(); clearInterval(this.#timer); }
    #cards(): PlotCard[] { return plotCards(this.deps.library()); }
    #visible(c: PlotContext): PlotBatch[] {
        const ids = new Set(c.branch.map(e => e.id));
        return this.store.batches(plotContextKey(c)).filter(b => (b.sourceId === "root" || ids.has(b.sourceId)) && b.contextKey === plotContextKey(c));
    }
    #active(c: PlotContext, batches = this.#visible(c)): PlotOptionsView["active"] {
        const active = activeSelection(c.branch);
        if (!active || active.selection.contextKey !== plotContextKey(c))
            return null;
        const sourceAvailable = this.#cards().some(card => card.id === active.selection.option.cardId && card.hash === active.selection.option.cardHash);
        const progress = [...batches].reverse().find(b => b.progress?.selectionEntryId === active.entryId)?.progress;
        const history = progressHistory(plotHistory(c.branch), active.entryId);
        if (progress && ((progress.status !== "preparing" && !progress.evidence.length) || !progress.evidence.every(e => history.some(h => h.id === e.entryId && h.text.includes(e.quote)))))
            return { entryId: active.entryId, sourceAvailable, option: active.selection.option };
        return { entryId: active.entryId, sourceAvailable, option: active.selection.option, ...(progress ? { progress } : {}) };
    }
    controlKey(): string { const c = this.deps.context(); return plotHash([plotContextKey(c), c.sourceId, c.branch.filter(e => e.customType === "rp-plot-direction").map(e => e.id)]); }
    view(): PlotOptionsView {
        const c = this.deps.context(), settings = this.store.settings(), batches = this.#visible(c), cards = this.#cards();
        const running = this.#task?.key === plotContextKey(c);
        const failure = this.#errorKey === plotContextKey(c) && !(c.modelKey && this.#lastError === MISSING_MODEL_ERROR) ? this.#lastError : "";
        const latest = batches.at(-1), savedError = c.modelKey && missingModelBlock(latest) ? undefined : latest?.error, libraryHash = plotHash(cards.map(x => [x.id, x.hash]));
        const materialKey = plotMaterialKey(c, plotHistory(c.branch));
        const compatible = (b: PlotBatch) => b.relevanceVersion === PLOT_RELEVANCE_VERSION && b.materialKey === materialKey;
        const usable = [...batches].reverse().find(b => compatible(b) && !b.error && b.outlineHash === c.outlineHash && b.libraryHash === libraryHash && completedPlotRounds(c.branch) - b.rounds <= 2 * settings.interval);
        return { contextKey: plotContextKey(c), controlKey: this.controlKey(), sourceId: c.sourceId === "root" ? null : c.sourceId, ...settings,
            running, libraryCount: cards.length, modelConfigured: !!c.modelKey,
            ...(settings.semantic ? { retrieval: this.deps.semanticSearch?.status(cards) ?? { method: "keyword-fallback", phase: "fallback", indexed: 0, total: cards.length, configured: false, requests: 0, inputTokens: null, message: "语义嵌入未配置，回退关键词" } } : {}),
            ...(latest?.retrieval ? { lastRetrieval: latest.retrieval } : {}),
            options: settings.enabled ? usable?.options ?? [] : [], active: this.#active(c, batches),
            ...(!running && (savedError || failure) ? { error: savedError || failure } : latest?.options.length && !compatible(latest) ? { error: "旧推荐缺少当前资料与适配机制校验，请手动重新筹备；旧记录保留，不自动重跑模型" } : {}) };
    }
    settings(patch: Partial<PlotSettings>, key: string): PlotOptionsView {
        this.#guardKey(key);
        if ((patch.semantic !== undefined || patch.embeddingBatchSize !== undefined) && this.#task)
            throw Error("请等当前筹备完成再切换检索模式");
        if (patch.enabled === false || patch.semantic !== undefined || patch.embeddingBatchSize !== undefined)
            this.cancel();
        this.store.settings(patch);
        this.#lastError = "";
        if ((patch.semantic !== undefined || patch.embeddingBatchSize !== undefined) && this.store.settings().enabled && !this.deps.busy())
            this.#launch(undefined, true);
        else if (patch.enabled === true)
            this.tick();
        return this.view();
    }
    library(query = "", offset = 0): {
        total: number;
        cards: Array<{
            id: string;
            title: string;
            activity: string;
            setting: string;
        }>;
    } {
        const all = this.#cards(), ranked = retrievePlotCards(all, query, Math.max(1, all.length));
        // Retrieval limits model input; browsing can page the entire library.
        const ordered = query ? ranked : all;
        return { total: all.length, cards: ordered.slice(Math.max(0, offset), Math.max(0, offset) + 20).map(c => ({ id: c.id, title: c.title, activity: c.surfaceActivity, setting: c.setting })) };
    }
    refresh(key: string, cardId?: string): PlotOptionsView {
        this.#guardKey(key);
        if (!this.store.settings().enabled)
            throw Error("请先开启日常剧情筹备");
        if (cardId && !this.#cards().some(c => c.id === cardId))
            throw Error("日常剧情卡已失效，请刷新卡库");
        this.#launch(cardId, true);
        return this.view();
    }
    rebuildSemantic(key: string): PlotOptionsView {
        this.#guardKey(key);
        if (!this.store.settings().enabled || !this.store.settings().semantic || !this.deps.semanticSearch)
            throw Error("请先开启后台选材及混合语义检索");
        if (this.#task)
            throw Error("请等当前筹备完成后重建语义索引");
        this.deps.semanticSearch.reset();
        this.#launch(undefined, true);
        return this.view();
    }
    cancelDirection(key: string): PlotOptionsView {
        this.#guardKey(key);
        if (this.deps.busy())
            throw Error("请等本楼结束后取消剧情引导");
        this.cancel();
        this.deps.appendControl({ version: 1, cancel: true });
        return this.view();
    }
    #guardKey(key: string): void {
        if (key !== plotContextKey(this.deps.context()))
            throw Error("会话或角色卡已变化，请刷新剧情选项");
    }
    resolve(choice: PlotChoiceInput): PlotSelection {
        if (!validPlotChoice(choice))
            throw Error("剧情选项绑定无效，草稿保留");
        const c = this.deps.context();
        this.#guardKey(choice.contextKey);
        if (!this.store.settings().enabled)
            throw Error("剧情筹备已关闭，请取消草稿中的剧情方向后重发");
        const batches = this.#visible(c), cards = this.#cards();
        const option = [...batches].reverse().filter(b => b.relevanceVersion === PLOT_RELEVANCE_VERSION && b.materialKey === plotMaterialKey(c, plotHistory(c.branch)) && !b.error && b.outlineHash === c.outlineHash && completedPlotRounds(c.branch) - b.rounds <= 2 * this.store.settings().interval).flatMap(b => b.options).find(o => o.id === choice.optionId);
        if (!option || !cards.some(card => card.id === option.cardId && card.hash === option.cardHash))
            throw Error("剧情选项已过期或不属于当前分支，草稿保留，请重新选择");
        return { version: 1, contextKey: choice.contextKey, option: structuredClone(option) };
    }
    reference(): string | undefined {
        try {
            if (!this.store.settings().enabled)
                return undefined;
            const c = this.deps.context(), active = this.#active(c);
            if (!active || !active.sourceAvailable || ["completed", "shelved"].includes(active.progress?.status ?? ""))
                return undefined;
            const o = active.option;
            return JSON.stringify({ kind: "user-selected-plot-direction-not-fact", title: o.title, experience: o.experience, prerequisites: o.prerequisites, developmentCandidates: o.development, boundaries: o.boundaries, setupCandidates: active.progress?.nextSetup?.length ? active.progress.nextSetup : o.setup, entryCondition: active.progress?.nextEntryCondition || o.entryCondition, ...(active.progress ? { observedProgress: { status: active.progress.status, note: text(active.progress.note, 200), evidenceRefs: active.progress.evidence.map(e => e.entryId).slice(0, 2) } } : {}) });
        }
        catch {
            return undefined;
        } // Optional planning cannot become a story recovery gate.
    }
    tick(): void {
        if (this.#task || this.deps.busy() || !this.store.settings().enabled)
            return;
        const c = this.deps.context(), latest = this.#visible(c).at(-1), rounds = completedPlotRounds(c.branch);
        if (!latest || (!!c.modelKey && missingModelBlock(latest)) || rounds - latest.rounds >= this.store.settings().interval)
            this.#launch();
    }
    #launch(cardId?: string, retry = false): void {
        if (this.#task)
            throw Error("剧情筹备正在运行，请等待完成");
        const c = structuredClone(this.deps.context()), key = plotContextKey(c), controller = new AbortController(), generation = this.#generation;
        this.#task = { key, controller };
        this.#lastError = "";
        void this.#run(c, controller, generation, cardId, retry).catch(e => { this.#lastError = safeError(e); this.#errorKey = key; }).finally(() => {
            if (this.#task?.controller === controller)
                this.#task = null;
        });
    }
    async #run(c: PlotContext, controller: AbortController, generation: number, cardId?: string, retry = false): Promise<void> {
        const cards = this.#cards(), batches = this.#visible(c), active = this.#active(c, batches), history = plotHistory(c.branch);
        const recent = planningHistory(history), worldLore = planningLore(c.worldLore ?? [], history), materialKey = plotMaterialKey(c, history);
        const summary = [...c.branch].reverse().find(e => e.customType === "rp-summary")?.data;
        const initialReferences = history.length ? [] : [{ id: "declared-card", role: "reference", text: JSON.stringify(c.card) }, { id: "declared-persona", role: "reference", text: c.persona }];
        const query = recent.slice(-4).map(h => h.text).join("\n").slice(-22000);
        const focus = recent.at(-1)?.text.slice(-2000) ?? "";
        let selected = cardId ? cards.filter(x => x.id === cardId) : retrievePlotCards(cards, query, 24, batches.slice(-3).flatMap(b => b.options.map(o => o.cardId)), focus);
        const record: PlotBatch = { relevanceVersion: PLOT_RELEVANCE_VERSION, materialKey, contextKey: plotContextKey(c), sourceId: c.sourceId, outlineHash: c.outlineHash,
            sourceHash: plotHash(history), libraryHash: plotHash(cards.map(x => [x.id, x.hash])), rounds: completedPlotRounds(c.branch),
            selectionEntryId: active?.entryId ?? null, options: [], createdAt: new Date().toISOString() };
        const configuredTimeout = typeof this.deps.timeoutMs === "function" ? this.deps.timeoutMs() : this.deps.timeoutMs;
        const timeoutMs = configuredTimeout ?? analysisRequestTimeoutMs({});
        let selectionDeadline: ReturnType<typeof createRequestDeadline> | undefined;
        try {
            if (!c.modelKey) {
                record.blockedBy = "model";
                throw Error(MISSING_MODEL_ERROR);
            }
            if (!c.skill)
                throw Error("缺少日常剧情筹备 Skill");
            if (!selected.length)
                throw Error("尚无已消化的日常剧情卡");
            // Persist the paid-attempt receipt first: a crash or failed final write must not auto-charge the same snapshot again.
            this.store.save({ ...record, error: "上次剧情筹备未完成或结果已失效；可手动重新筹备，不会立即自动重试" });
            record.retrieval = { method: cardId ? "manual" : "keyword", phase: "ready", indexed: 0, total: cards.length, configured: false, requests: 0, inputTokens: null };
            if (!cardId && this.store.settings().semantic) {
                if (this.deps.semanticSearch) {
                    const result = await this.deps.semanticSearch.retrieve({ cards, queries: buildPlotSemanticQueries({ state: c.state, outline: c.outline, persona: c.persona, history: recent, summary }), keywordQuery: query,
                        scopeKey: plotHash([plotContextKey(c), c.sourceId, c.outlineHash]), ...(c.cardPath ? { requestScope: { sessionId: c.sessionId, card: c.cardPath, sourceEntryId: c.sourceId } } : {}), signal: controller.signal, retry, batchSize: this.store.settings().embeddingBatchSize, avoid: batches.slice(-3).flatMap(b => b.options.map(o => o.cardId)) });
                    selected = result.cards;
                    record.retrieval = result.status;
                }
                else
                    record.retrieval = { ...record.retrieval, method: "keyword-fallback", phase: "fallback", message: "未配置语义嵌入，回退关键词" };
                this.store.save({ ...record, error: "剧情筹备尚未完成，已保存检索收据" });
            }
            controller.signal.throwIfAborted();
            const currentSource = this.deps.context();
            if (generation !== this.#generation || plotContextKey(currentSource) !== plotContextKey(c) || currentSource.outlineHash !== c.outlineHash || currentSource.modelKey !== c.modelKey || currentSource.skill !== c.skill || plotMaterialKey(currentSource, plotHistory(currentSource.branch)) !== materialKey || (this.#active(currentSource)?.entryId ?? null) !== record.selectionEntryId || plotHash(this.#cards().map(x => [x.id, x.hash])) !== record.libraryHash || (c.sourceId !== "root" && !currentSource.branch.some(e => e.id === c.sourceId)))
                throw Error("筹备来源已改变，未再调用选材模型");
            selectionDeadline = createRequestDeadline(controller.signal, timeoutMs, "plot-selection", "日常剧情选材");
            const call = this.deps.run(c.skill, JSON.stringify({ card: c.card, standingPersonaReference: c.persona, sceneStateReferenceOnly: JSON.stringify(c.state).slice(0, 8000), worldLore, latestTurn: { userEntryId: history.findLast(h => h.role === "user")?.id ?? null, narrativeEntryId: history.findLast(h => h.role === "assistant")?.id ?? null }, outlineCandidateNotFact: c.outline,
                recentHistory: recent, initialReferences, priorSummary: JSON.stringify(summary ?? null).slice(0, 10000), selectedDirection: active?.sourceAvailable ? active : null, requestedCardId: cardId ?? null,
                libraryCount: cards.length, candidates: selected }, null, 2), selectionDeadline.signal, timeoutMs);
            // Abortable consumes late rejections even when a provider ignores cancellation.
            const raw = await abortable(call, selectionDeadline.signal);
            if (typeof raw !== "string")
                throw Error(raw.error);
            const parsed = object(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")));
            if (!Array.isArray(parsed.options))
                throw Error("剧情筹备输出缺少有效 options 数组");
            const seen = new Set<string>(), plans = new Set<string>(), drafts = new Set<string>();
            let rejected = 0;
            record.options = (Array.isArray(parsed.options) ? parsed.options : []).slice(0, 3).flatMap(value => {
                const row = object(value), card = selected.find(x => x.id === row.cardId);
                if (!card || seen.has(card.id) || !text(row.draft) || text(row.draft).startsWith("/") || !text(row.experience)) { rejected++; return []; }
                if (cardId && card.id !== cardId)
                    return [];
                const checked = validatePlotGrounding(row, recent, card, initialReferences), draftKey = normalizePlanText(text(row.draft, 1500));
                if (!checked || plans.has(checked.signature) || drafts.has(draftKey)) { rejected++; return []; }
                plans.add(checked.signature); drafts.add(draftKey); seen.add(card.id);
                return [{ grounding: checked.grounding, mechanism: checked.mechanism, id: randomUUID(), cardId: card.id, cardHash: card.hash, title: text(row.title, 100) || card.title,
                        experience: text(row.experience, 240), whyNow: text(row.whyNow, 240), draft: text(row.draft, 1500), prerequisites: texts(row.prerequisites), setup: texts(row.setup), development: Object.values(checked.mechanism).map(part => part.adaptation), boundaries: texts(row.boundaries), entryCondition: text(row.entryCondition, 300) }];
            });
            if (rejected && !record.options.length) throw Error("剧情推荐缺少最新原文依据、源活动/摩擦/变化的有效适配，或机制重复；本批未采用，可手动重新筹备");
            const p = object(parsed.progress), status = text(p.status);
            const evidence = evidenceOf(p.evidence, active ? progressHistory(history, active.entryId) : []);
            if (active?.sourceAvailable && ["preparing", "seeded", "engaged", "completed", "shelved"].includes(status) && (status === "preparing" || evidence.length))
                record.progress = { selectionEntryId: active.entryId, status: status as PlotProgress["status"], note: text(p.note), evidence, ...(texts(p.nextSetup).length ? { nextSetup: texts(p.nextSetup) } : {}), ...(text(p.nextEntryCondition) ? { nextEntryCondition: text(p.nextEntryCondition, 300) } : {}) };
        }
        catch (e) {
            record.error = safeError(controller.signal.aborted ? requestAbortError(controller.signal, "剧情筹备已取消") : selectionDeadline?.signal.aborted ? requestAbortError(selectionDeadline.signal) : e);
        }
        finally {
            selectionDeadline?.dispose();
        }
        const current = this.deps.context();
        if ((this.#active(current)?.entryId ?? null) !== record.selectionEntryId)
            return;
        if (generation !== this.#generation || !this.store.settings().enabled || plotContextKey(current) !== record.contextKey || current.modelKey !== c.modelKey || current.skill !== c.skill || plotMaterialKey(current, plotHistory(current.branch)) !== materialKey || current.outlineHash !== c.outlineHash || plotHash(this.#cards().map(x => [x.id, x.hash])) !== record.libraryHash || (c.sourceId !== "root" && !current.branch.some(e => e.id === c.sourceId)))
            return;
        this.store.save(record);
    }
}
