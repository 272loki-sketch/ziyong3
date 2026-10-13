/**
 * Executable, MODEL-AGNOSTIC reference for observable agent-led research.
 * Not yet wired to StageEngine or a model provider. No prompt injection,
 * story writes, network access, or persistence. Codex owns production wiring.
 */
export type ResearchMode = "direct" | "director";
export type Origin = "canon" | "world" | "web-page" | "web-snippet";
export type Verdict = "supported" | "inferred" | "conflicted" | "unknown";
export type ClaimKind = "canon" | "world" | "external" | "interpretation";
export type StopReason = "sufficient" | "gaps" | "limits" | "cancelled" | "stale-scope" | "unsafe" | "adapter-error";

export interface ResearchScope { key: string; allowWeb: boolean }
export interface ResearchQuestion { id: string; text: string; important: boolean }
export interface Candidate { id: string; query: string; url: string; title: string; snippet: string }
export interface Evidence {
  id: string; questionId: string; origin: Origin; title: string;
  locator?: string; sourceRevision?: string; sourceUrl?: string; excerpt: string;
  scopeKey: string; sourceChecked: boolean;
}
export interface ResearchClaim {
  questionId: string; text: string; kind: ClaimKind;
  verdict: Verdict; evidenceIds: string[];
}
export interface ResearchGap { questionId: string; reason: string }
export type ResearchDecision =
  | { action: "local"; questionId: string; query: string }
  | { action: "search"; questionId: string; queries: string[] }
  | { action: "open"; questionId: string; url: string; focus: string }
  | { action: "finish"; claims: ResearchClaim[]; gaps: ResearchGap[] };
export type ResearchReceipt =
  | { type: "local"; questionId: string; evidenceIds: string[] }
  | { type: "search"; questionId: string; candidates: Candidate[]; queries: string[] }
  | { type: "open"; questionId: string; evidenceIds: string[]; url: string }
  | { type: "rejected"; reason: string };

export interface ResearchSnapshot {
  scopeKey: string; mode: ResearchMode;
  questions: readonly ResearchQuestion[];
  evidence: readonly Evidence[]; receipts: readonly ResearchReceipt[];
  budget: Readonly<{ agentSteps: number; localLookups: number; publicQueries: number; sourceOpens: number }>;
}
export interface ResearchAdapters {
  /** The model chooses each next action from the latest receipts. */
  nextDecision(snapshot: ResearchSnapshot, signal: AbortSignal): Promise<ResearchDecision>;
  findLocal(questionId: string, query: string, signal: AbortSignal): Promise<Evidence[]>;
  searchPublic(queries: string[], signal: AbortSignal): Promise<Candidate[]>;
  openPublic(questionId: string, url: string, focus: string, signal: AbortSignal): Promise<Evidence[]>;
  /** MUST delegate to PR #2 off/manual/auto and existing privacy checks. */
  authorizePublicQuery(query: string): boolean;
  /** Host checks session/tree/card/source-version for every resumed await. */
  isCurrentScope(scopeKey: string): boolean;
}
export interface ResearchRunOptions {
  scope: ResearchScope; mode: ResearchMode; questions: ResearchQuestion[];
  deadlineMs?: number;
  /** Explicit user URLs still need the host's HTTP/SSRF gate. */
  userProvidedUrls?: string[];
  signal?: AbortSignal;
  budgets?: Partial<{ agentSteps: number; localLookups: number; publicQueries: number; sourceOpens: number }>;
}
export interface ResearchOutcome {
  stop: StopReason; evidence: Evidence[]; claims: ResearchClaim[];
  gaps: ResearchGap[]; receipts: ResearchReceipt[];
  used: { agentSteps: number; localLookups: number; publicQueries: number; sourceOpens: number };
}

/**
 * Only provenance is checked here. Semantic entailment and temporal knowledge
 * MUST still be evaluated by the model and existing story-review mechanisms.
 * A snippet cannot be a definitive original-canon or real-world source.
 */
export function sanitizeClaims(claims: readonly ResearchClaim[], evidence: readonly Evidence[]): ResearchClaim[] {
  const byId = new Map(evidence.map(row => [row.id, row]));
  return claims.map(claim => {
    // A hostile/malformed model response cannot consume unbounded memory or hide
    // unsupported references beyond a truncated list.
    const withinLimit = claim.text.length <= 1200 && claim.evidenceIds.length <= 16;
    const ids = claim.evidenceIds.slice(0, 16).filter(id => byId.has(id));
    const checked = withinLimit && claim.evidenceIds.length > 0 && claim.evidenceIds.every(id => {
      const row = byId.get(id);
      if (!row || row.questionId !== claim.questionId || !row.sourceChecked || !row.locator || !row.excerpt.trim()) return false;
      if (claim.kind === "canon") return row.origin === "canon" && Boolean(row.sourceRevision);
      if (claim.kind === "world") return row.origin === "world";
      if (claim.kind === "external") return row.origin === "web-page";
      if (claim.kind === "interpretation") return claim.verdict === "inferred"; // provenance supports an inference, never a directly sourced motive
      return false;
    });
    return {
      ...claim, text: claim.text.slice(0, 1200), evidenceIds: ids,
      verdict: (claim.verdict === "supported" || claim.verdict === "inferred") && !checked ? "unknown" as const : claim.verdict,
    };
  });
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  return value == null ? fallback : Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.trunc(value))) : fallback;
}

/** Optional: a host must never run this before every normal direct narration. */
export async function runAgenticResearch(opts: ResearchRunOptions, adapters: ResearchAdapters): Promise<ResearchOutcome> {
  const maxima = opts.mode === "director"
    ? { agentSteps: 12, localLookups: 8, publicQueries: 9, sourceOpens: 6 }
    : { agentSteps: 4, localLookups: 2, publicQueries: 3, sourceOpens: 1 };
  const allowed = {
    agentSteps: clamp(opts.budgets?.agentSteps, maxima.agentSteps, maxima.agentSteps),
    localLookups: clamp(opts.budgets?.localLookups, maxima.localLookups, maxima.localLookups),
    publicQueries: clamp(opts.budgets?.publicQueries, maxima.publicQueries, maxima.publicQueries),
    sourceOpens: clamp(opts.budgets?.sourceOpens, maxima.sourceOpens, maxima.sourceOpens),
  };
  const used = { agentSteps: 0, localLookups: 0, publicQueries: 0, sourceOpens: 0 };
  const receipts: ResearchReceipt[] = [], evidence: Evidence[] = [];
  const seen = new Map<string, Set<string>>(); // An identical source may answer two distinct research questions.
  const MAX_EVIDENCE = 32, MAX_RECEIPTS = 32;
  const record = (receipt: ResearchReceipt) => {
    if (receipts.length >= MAX_RECEIPTS) receipts.shift();
    receipts.push(receipt);
  };
  const userUrls = new Set((opts.userProvidedUrls ?? []).filter(url => typeof url === "string" && url.length <= 2048).slice(0, 16));
  const candidateQuestions = new Map<string, Set<string>>();
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, clamp(opts.deadlineMs, opts.mode === "director" ? 30000 : 5000, 60000));
  const stopOnAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener("abort", stopOnAbort, { once: true });
  const valid = () => !controller.signal.aborted && adapters.isCurrentScope(opts.scope.key);
  const awaitTask = async <T>(work: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new Error("research stopped");
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => finish(() => reject(new Error("research stopped")));
      controller.signal.addEventListener("abort", abort, { once: true });
      work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (controller.signal.aborted) abort();
    });
  };
  const normalize = (text: string) => text.trim().replace(/\s+/gu, " ");
  const ids = new Set(opts.questions.map(q => q.id));
  const gaps: ResearchGap[] = [];
  let claims: ResearchClaim[] = [];
  let stop: StopReason = "limits";
  const remember = (items: Evidence[], questionId: string, expectedUrl?: string): string[] => {
    const added: string[] = [];
    for (const item of items.slice(0, 8)) {
      if (evidence.length >= MAX_EVIDENCE) break;
      if (item.scopeKey !== opts.scope.key || item.questionId !== questionId || !item.id || !item.excerpt) continue;
      // Web text is only admissible when the trusted reader binds it to the opened URL.
      if (expectedUrl && (item.origin !== "web-page" || item.sourceUrl !== expectedUrl)) continue;
      const key = item.id;
      const covered = seen.get(key) ?? new Set<string>();
      if (covered.has(questionId)) continue;
      const id = covered.size ? JSON.stringify([questionId, key]) : key;
      if (evidence.some(row => row.id === id)) continue;
      covered.add(questionId); seen.set(key, covered);
      evidence.push({ ...item, id, title: item.title.slice(0, 200), excerpt: item.excerpt.slice(0, 4000) });
      added.push(id);
    }
    return added;
  };
  try {
    while (used.agentSteps < allowed.agentSteps) {
      if (!valid()) { stop = controller.signal.aborted ? "cancelled" : "stale-scope"; break; }
      used.agentSteps++;
      const snapshot: ResearchSnapshot = {
        scopeKey: opts.scope.key, mode: opts.mode, questions: opts.questions,
        evidence: evidence.map(row => ({ ...row, excerpt: row.excerpt.slice(0, 1200) })),
        receipts: receipts.slice(-16),
        budget: {
          agentSteps: allowed.agentSteps - used.agentSteps,
          localLookups: allowed.localLookups - used.localLookups,
          publicQueries: allowed.publicQueries - used.publicQueries,
          sourceOpens: allowed.sourceOpens - used.sourceOpens,
        },
      };
      const action = await awaitTask(adapters.nextDecision(snapshot, controller.signal));
      if (!valid()) { stop = controller.signal.aborted ? "cancelled" : "stale-scope"; break; }
      if (action.action === "finish") {
        claims = sanitizeClaims(action.claims.filter(claim => ids.has(claim.questionId)).slice(0, 32), evidence);
        gaps.push(...action.gaps.filter(gap => ids.has(gap.questionId)).slice(0, 32).map(gap => ({ ...gap, reason: gap.reason.slice(0, 500) })));
        for (const question of opts.questions) {
          if (question.important && !claims.some(c => c.questionId === question.id && c.verdict === "supported") && !gaps.some(g => g.questionId === question.id))
            gaps.push({ questionId: question.id, reason: "关键问题没有经过来源支持的结论" });
        }
        stop = gaps.length || claims.some(c => c.verdict === "unknown" || c.verdict === "conflicted") ? "gaps" : "sufficient";
        break;
      }
      if (!ids.has(action.questionId)) { record({ type: "rejected", reason: "question outside scope" }); continue; }
      if (action.action === "local") {
        if (used.localLookups >= allowed.localLookups) { record({ type: "rejected", reason: "local budget exhausted" }); continue; }
        used.localLookups++;
        const rows = await awaitTask(adapters.findLocal(action.questionId, normalize(action.query).slice(0, 160), controller.signal));
        if (!valid()) { stop = controller.signal.aborted ? "cancelled" : "stale-scope"; break; }
        record({ type: "local", questionId: action.questionId, evidenceIds: remember(rows, action.questionId) });
      } else if (action.action === "search") {
        const queries = [...new Set(action.queries.filter((query): query is string => typeof query === "string").map(normalize).filter(query => query.length > 0 && query.length <= 160))].slice(0, 3);
        if (!queries.length) { record({ type: "rejected", reason: "empty or invalid public queries" }); continue; }
        if (!opts.scope.allowWeb || !queries.every(adapters.authorizePublicQuery)) {
          record({ type: "rejected", reason: "public query not authorized; no private data sent" });
          continue;
        }
        const acceptedQueries = queries.slice(0, Math.max(0, allowed.publicQueries - used.publicQueries));
        if (!acceptedQueries.length) { record({ type: "rejected", reason: "public query budget exhausted" }); continue; }
        used.publicQueries += acceptedQueries.length;
        const candidates = await awaitTask(adapters.searchPublic(acceptedQueries, controller.signal));
        if (!valid()) { stop = controller.signal.aborted ? "cancelled" : "stale-scope"; break; }
        const accepted = candidates.filter(candidate => acceptedQueries.includes(candidate.query) &&
          /^https:\/\//i.test(candidate.url) && candidate.url.length <= 2048).slice(0, 12).map(candidate => ({
          ...candidate, title: candidate.title.slice(0, 200), snippet: candidate.snippet.slice(0, 450),
        }));
        for (const candidate of accepted) {
          const questions = candidateQuestions.get(candidate.url) ?? new Set<string>();
          questions.add(action.questionId); candidateQuestions.set(candidate.url, questions);
        }
        record({ type: "search", questionId: action.questionId, queries: acceptedQueries, candidates: accepted });
      } else {
        if (!opts.scope.allowWeb || !(userUrls.has(action.url) || candidateQuestions.get(action.url)?.has(action.questionId))) {
          record({ type: "rejected", reason: "source URL not authorized for this research question" }); continue;
        }
        if (used.sourceOpens >= allowed.sourceOpens) {
          record({ type: "rejected", reason: "source read budget exhausted" }); continue;
        }
        used.sourceOpens++;
        const rows = await awaitTask(adapters.openPublic(action.questionId, action.url, normalize(action.focus).slice(0, 160), controller.signal));
        if (!valid()) { stop = controller.signal.aborted ? "cancelled" : "stale-scope"; break; }
        record({ type: "open", questionId: action.questionId, url: action.url, evidenceIds: remember(rows, action.questionId, action.url) });
      }
    }
    if (stop === "limits") for (const question of opts.questions)
      gaps.push({ questionId: question.id, reason: "研究预算已到，尚未形成已验证结论" });
  } catch {
    stop = timedOut ? "limits" : controller.signal.aborted ? "cancelled" : !adapters.isCurrentScope(opts.scope.key) ? "stale-scope" : "adapter-error";
    if (stop === "limits") for (const question of opts.questions)
      gaps.push({ questionId: question.id, reason: "研究时间耗尽" });
    if (stop === "adapter-error") record({ type: "rejected", reason: "研究工具失败；不得冒充已核实" });
  } finally {
    clearTimeout(deadline);
    opts.signal?.removeEventListener("abort", stopOnAbort);
  }
  return { stop, evidence: stop === "cancelled" || stop === "stale-scope" ? [] : evidence, claims, gaps, receipts, used };
}
