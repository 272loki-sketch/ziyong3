/** Production research state for the existing native-tool Agent. No model or story writes. */
import { createHash } from "node:crypto";
import type {
  ResearchClaim,
  ResearchGap,
  ResearchQuestion,
  Evidence,
} from "./agentic-loop.ts";
import { sanitizeClaims } from "./agentic-loop.ts";

export const RESEARCH_READS = new Set([
  "web_research",
  "web_open",
  "canon_research",
  "corpus_research",
]);
export interface ResearchEvidence extends Evidence {
  retrievedAt?: string;
  reused?: boolean;
  focus?: string;
  timeline?: string;
  characterKnowledge?: "not-established";
  branchConflictSourceIds?: string[];
}
export interface ResearchSummary {
  stop:
    | "not-requested"
    | "in-progress"
    | "sufficient"
    | "gaps"
    | "limits"
    | "cancelled"
    | "stale-scope";
  questions: number;
  evidence: number;
  claims: number;
  unresolved: number;
  searches: number;
  opens: number;
  reused: number;
  local: number;
}
const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const idValid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(v);
const hash = (v: string) =>
  createHash("sha256").update(v).digest("hex").slice(0, 24);

/** Each turn owns its scope, question authorization and host-issued provenance. */
export function createResearchSession(
  scopeKey: string,
  task: string,
  isCurrent: () => boolean,
  userUrls: string[] = [],
) {
  const questions = new Map<string, ResearchQuestion>([
    ["task", { id: "task", text: task.slice(0, 500), important: false }],
  ]);
  const evidence = new Map<string, ResearchEvidence>(),
    urls = new Map<string, Set<string>>();
  const receipts: Array<Record<string, unknown>> = [];
  let claims: ResearchClaim[] = [],
    gaps: ResearchGap[] = [],
    touched = false;
  const counters = { searches: 0, opens: 0, reused: 0, local: 0 };
  let stop: ResearchSummary["stop"] = "not-requested";
  const reject = (reason: string) => ({
    text: JSON.stringify({ kind: "research-rejected", reason }),
    isError: true,
  });
  const current = () => isCurrent();
  const qid = (args: Record<string, unknown>) =>
    args.question_id === undefined
      ? "task"
      : idValid(args.question_id)
        ? args.question_id
        : "";
  function validQuestion(args: Record<string, unknown>) {
    return current() && questions.has(qid(args));
  }
  function declareReadQuestion(name: string, args: Record<string, unknown>) {
    if (!current()) return false;
    const id = qid(args);
    if (questions.has(id)) return true;
    if (
      !id ||
      questions.size >= 13 ||
      (name === "web_open" && !userUrls.includes(str(args.url, 2048)))
    )
      return false;
    const queries = Array.isArray(args.queries)
      ? args.queries.filter((q) => typeof q === "string").join(" / ")
      : "";
    const text = str(args.query ?? args.focus ?? queries, 500);
    if (!text && name !== "corpus_research") return false;
    questions.set(id, { id, text: text || "当前源文目录", important: true });
    return true;
  }

  function canOpen(args: Record<string, unknown>) {
    const url = str(args.url, 2048);
    return (
      validQuestion(args) &&
      (userUrls.includes(url) || urls.get(qid(args))?.has(url) === true)
    );
  }
  function remember(
    questionId: string,
    row: Omit<ResearchEvidence, "id" | "questionId" | "scopeKey">,
  ) {
    if (!current() || !questions.has(questionId) || evidence.size >= 32)
      return undefined;
    const id =
      "e:" +
      hash(
        JSON.stringify([
          scopeKey,
          questionId,
          row.origin,
          row.locator,
          row.sourceRevision,
          row.excerpt,
        ]),
      );
    const full: ResearchEvidence = { ...row, id, questionId, scopeKey };
    evidence.set(id, full);
    return id;
  }
  /** Only called AFTER a real host tool succeeds, never with model supplied evidence. */
  function accept(
    name: string,
    args: Record<string, unknown>,
    details: unknown,
  ) {
    if (!current() || !validQuestion(args)) return [] as string[];
    const questionId = qid(args),
      ids: string[] = [];
    touched = true;
    stop = "in-progress";
    if (name === "web_research" && Array.isArray(details)) {
      const allowed = urls.get(questionId) ?? new Set<string>();
      const queries = new Set(
        Array.isArray(args.queries)
          ? args.queries
              .filter((x) => typeof x === "string")
              .map((x) => x.normalize("NFKC").replace(/\s+/g, " ").trim())
          : [],
      );
      for (const raw of details.slice(0, 3)) {
        const row = object(raw);
        if (
          typeof row.query !== "string" ||
          !queries.has(row.query) ||
          row.error ||
          row.rejected
        )
          continue;
        if (row.reused) counters.reused++;
        else counters.searches++;
        for (const candidate of (Array.isArray(row.results)
          ? row.results
          : []
        ).slice(0, 5)) {
          const url = str(object(candidate).url, 2048);
          if (/^https:\/\//i.test(url)) allowed.add(url);
        }
      }
      urls.set(questionId, allowed);
    } else if (name === "web_open") {
      const row = object(details),
        requested = str(args.url, 2048);
      if (
        row.url !== requested ||
        !canOpen(args) ||
        row.trust !== "external-untrusted"
      )
        return ids;
      if (row.reused) counters.reused++;
      else counters.opens++;
      const locator = object(row.locator),
        excerpt =
          typeof row.excerpt === "string" ? row.excerpt.slice(0, 4000) : "";
      // The scope host constructs offsets and hash from its own reader result.
      const checked =
        typeof row.sourceFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(row.sourceFingerprint) &&
        Number.isSafeInteger(locator.start) &&
        Number.isSafeInteger(locator.end) &&
        Number(locator.start) >= 0 &&
        Number(locator.end) - Number(locator.start) === excerpt.length;
      if (excerpt) {
        const id = remember(questionId, {
          origin: "web-page",
          focus: str(row.focus, 100),
          title: requested,
          sourceUrl: requested,
          sourceRevision: str(row.sourceFingerprint, 64),
          retrievedAt: str(row.retrievedAt, 40),
          reused: row.reused === true,
          locator: checked
            ? `${requested}#utf16=${locator.start}-${locator.end}`
            : undefined,
          excerpt,
          sourceChecked: checked,
        });
        if (id) ids.push(id);
      }
    } else if (
      (name === "canon_research" || name === "corpus_research") &&
      Array.isArray(details)
    ) {
      counters.local++;
      for (const raw of details.slice(0, 6)) {
        const row = object(raw),
          quote = typeof row.quote === "string" ? row.quote.slice(0, 4000) : "",
          fingerprint = str(row.sourceFingerprint, 64);
        if (
          !quote ||
          !fingerprint ||
          !Number.isSafeInteger(row.chunkIndex) ||
          !Number.isSafeInteger(row.start) ||
          !Number.isSafeInteger(row.end) ||
          Number(row.end) - Number(row.start) !== quote.length
        )
          continue;
        const locator = JSON.stringify({
          docId: row.docId,
          packageRevision: row.packageRevision,
          sourceFingerprint: fingerprint,
          chapter: row.chapter,
          chapterCandidates: row.chapterCandidates,
          chunkIndex: row.chunkIndex,
          start: row.start,
          end: row.end,
        });
        const id = remember(questionId, {
          origin: "canon",
          title: str(row.title, 120),
          locator,
          sourceRevision: JSON.stringify([
            row.docId,
            row.packageRevision,
            fingerprint,
            row.chunkFingerprint,
          ]),
          excerpt: quote,
          sourceChecked: true,
          timeline: str(row.timeline, 50),
          characterKnowledge: "not-established",
          branchConflictSourceIds: Array.isArray(row.branchConflictSourceIds)
            ? row.branchConflictSourceIds
                .filter((id): id is string => typeof id === "string")
                .slice(0, 16)
            : [],
        });
        if (id) ids.push(id);
      }
    }
    receipts.push({ tool: name, questionId, evidenceIds: ids });
    if (receipts.length > 24) receipts.shift();
    return ids;
  }
  function attachWorld(
    questionId: string,
    rows: Array<{ id: string; text: string }>,
  ) {
    if (!questions.has(questionId)) return;
    for (const row of rows.slice(0, 16)) {
      const excerpt = row.text.slice(0, 3000);
      if (excerpt.trim())
        remember(questionId, {
          origin: "world",
          title: row.id,
          locator: JSON.stringify({
            sourceId: row.id,
            start: 0,
            end: excerpt.length,
          }),
          sourceRevision: hash(row.text),
          excerpt,
          sourceChecked: true,
        });
    }
  }
  function record(args: Record<string, unknown>) {
    if (!current()) return reject("stale scope; no result adopted");
    const action = args.action;
    if (!["plan", "assess", "finish", "read"].includes(String(action)))
      return reject("invalid action");
    touched = true;
    if (
      action === "read" &&
      args.evidence_ids !== undefined &&
      (!Array.isArray(args.evidence_ids) ||
        args.evidence_ids.length > 16 ||
        args.evidence_ids.some(
          (id) => typeof id !== "string" || id.length > 80,
        ))
    )
      return reject("invalid evidence ids");
    if (action === "plan") {
      if (
        !Array.isArray(args.questions) ||
        args.questions.length < 1 ||
        args.questions.length > 12
      )
        return reject("questions must contain 1..12 items");
      const input = args.questions.map(object);
      if (
        input.some((q) => !idValid(q.id) || !str(q.text, 500)) ||
        new Set(input.map((q) => q.id)).size !== input.length
      )
        return reject("invalid or duplicate question ids");
      if (
        input.some(
          (q) =>
            q.id !== "task" &&
            questions.has(q.id as string) &&
            questions.get(q.id as string)!.text !== str(q.text, 500),
        ) ||
        questions.size +
          input.filter((q) => !questions.has(q.id as string)).length >
          13
      )
        return reject("question identity is immutable or limit exceeded");
      for (const q of input)
        questions.set(q.id as string, {
          id: q.id as string,
          text: q.id === "task" ? task.slice(0, 500) : str(q.text, 500),
          important: q.important === true,
        });
      stop = "in-progress";
    } else if (action === "assess" || action === "finish") {
      if (
        action === "finish" &&
        args.claims === undefined &&
        args.gaps === undefined &&
        claims.length
      )
        args = { ...args, claims, gaps };
      // The public tool schema makes gaps optional. Omission is an empty model
      // list, not proof of completeness; host provenance checks still derive gaps.
      if (Array.isArray(args.claims) && args.gaps === undefined) args = { ...args, gaps: [] };
      if (
        !Array.isArray(args.claims) ||
        args.claims.length > 32 ||
        !Array.isArray(args.gaps) ||
        args.gaps.length > 24
      )
        return reject("bounded claims and gaps required");
      const input = args.claims.map(object),
        missing = args.gaps.map(object);
      if (
        input.some(
          (c) =>
            !questions.has(str(c.questionId, 40)) ||
            !["canon", "world", "external", "interpretation"].includes(
              String(c.kind),
            ) ||
            !["supported", "inferred", "conflicted", "unknown"].includes(
              String(c.verdict),
            ) ||
            typeof c.text !== "string" ||
            c.text.length > 1200 ||
            !Array.isArray(c.evidenceIds) ||
            c.evidenceIds.length > 16 ||
            c.evidenceIds.some(
              (id) => typeof id !== "string" || id.length > 80,
            ),
        ) ||
        missing.some(
          (g) => !questions.has(str(g.questionId, 40)) || !str(g.reason, 500),
        )
      )
        return reject("invalid claim or gap schema");
      claims = sanitizeClaims(
        input.map((c) =>
          c.kind === "interpretation" && c.verdict === "supported"
            ? { ...c, verdict: "inferred" }
            : c,
        ) as unknown as ResearchClaim[],
        [...evidence.values()],
      ).map((c) =>
        c.kind === "interpretation" && c.verdict === "supported"
          ? { ...c, verdict: "inferred" as const }
          : c,
      );
      gaps = missing.map((g) => ({
        questionId: str(g.questionId, 40),
        reason: str(g.reason, 500),
      }));
      for (const q of questions.values()) {
        const cs = claims.filter((c) => c.questionId === q.id);
        const unresolved =
          cs.some(
            (c) => c.verdict === "unknown" || c.verdict === "conflicted",
          ) ||
          (q.important && !cs.some((c) => c.verdict === "supported"));
        if (unresolved && !gaps.some((g) => g.questionId === q.id))
          gaps.push({
            questionId: q.id,
            reason: "证据不足、推演或来源冲突；未确证",
          });
      }
      stop =
        action === "finish"
          ? gaps.length
            ? "gaps"
            : "sufficient"
          : "in-progress";
    }
    const requested = Array.isArray(args.evidence_ids)
      ? new Set(
          args.evidence_ids.filter((id) => typeof id === "string").slice(0, 16),
        )
      : undefined;
    const view = {
      kind: "research-receipt",
      authority: "reference-not-branch-fact",
      semanticSupport: "model-assessed-not-host-proven",
      stop,
      questions: [...questions.values()].map((q) => ({
        ...q,
        text: q.text.slice(0, 220),
      })),
      claims: claims.map((c) => ({ ...c, text: c.text.slice(0, 420) })),
      gaps: gaps.map((g) => ({ ...g, reason: g.reason.slice(0, 220) })),
      evidence: [...evidence.values()]
        .filter((e) => !requested || requested.has(e.id))
        .slice(-6),
      receipts: receipts.slice(-6),
      omittedEvidenceIds: [] as string[],
    };
    // Whole JSON and exact quotations, never character-cut a locator or silently fake its span.
    while (JSON.stringify(view).length > 12000 && view.evidence.length)
      view.omittedEvidenceIds.push(view.evidence.shift()!.id);
    while (JSON.stringify(view).length > 12000 && view.receipts.length)
      view.receipts.shift();
    if (JSON.stringify(view).length > 16000)
      return reject("receipt capacity exceeded; assess fewer claims");
    return {
      text: JSON.stringify(view),
      activity:
        action === "finish" ? "研究已停止（回执，不写故事事实）" : undefined,
    };
  }
  function summary(
    reason?: ResearchSummary["stop"],
  ): ResearchSummary | undefined {
    if (!touched) return undefined;
    return {
      stop: !current() ? "stale-scope" : (reason ?? stop),
      questions: questions.size - 1,
      evidence: evidence.size,
      claims: claims.length,
      unresolved:
        gaps.length ||
        (reason === "gaps"
          ? Math.max(
              1,
              [...questions.values()].filter(
                (q) =>
                  q.important &&
                  !claims.some(
                    (c) => c.questionId === q.id && c.verdict === "supported",
                  ),
              ).length,
            )
          : 0),
      ...counters,
    };
  }
  function sources() {
    return evidence.size && current()
      ? [...evidence.values()].map((e) => ({
          id: "reference:" + e.id,
          text: JSON.stringify({
            kind:
              e.origin === "web-page"
                ? "web-source-excerpt"
                : "research-source-evidence",
            authority: "reference-not-branch-fact",
            ...(e.origin === "web-page"
              ? { trust: "external-untrusted", url: e.sourceUrl }
              : {}),
            ...e,
          }),
        }))
      : [];
  }
  return {
    validQuestion,
    canOpen,
    accept,
    record,
    summary,
    sources,
    reject,
    questionId: qid,
    attachWorld,
    declareReadQuestion,
  };
}
