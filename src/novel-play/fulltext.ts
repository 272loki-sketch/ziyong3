/** Read-only full-source search. Uses the existing immutable chunks, never an event summary. */
import { createHash } from "node:crypto";
import type { NovelSource, NovelEvidence } from "./source.ts";
import { assertNovelEvidence } from "./source.ts";
import type { NovelPackage, NovelAnchor } from "./canon.ts";
import { chapterFor, type CanonResearchScope } from "./research.ts";

export interface FulltextHit extends NovelEvidence {
  docId: string;
  sourceFingerprint: string;
  chunkFingerprint: string;
  packageRevision?: string;
  chapter: string;
  chapterCandidates: string[];
  title: string;
  timeline:
    | "source-before-anchor"
    | "future-for-author-planning"
    | "unmapped-author-only";
  layout: "immutable-novel-source" | "corpus-current-chunker";
  characterKnowledge: "not-established";
  branchConflictSourceIds: string[];
}
export interface FulltextContext {
  package: NovelPackage;
  anchor: NovelAnchor;
  conflicts?: Array<{ nodeId: string; sourceEntryIds: string[] }>;
}
const fold = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
function originalOffset(
  text: string,
  normalizedOffset: number,
  normalized: string,
): number {
  // Fast path is checked against the actual normalized suffix, not assumed from equal lengths.
  const tail = normalized.slice(normalizedOffset, normalizedOffset + 160);
  if (
    fold(text.slice(0, normalizedOffset)).length === normalizedOffset &&
    fold(text.slice(normalizedOffset, normalizedOffset + 400)).startsWith(tail)
  )
    return normalizedOffset;
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (fold(text.slice(0, mid)).length <= normalizedOffset) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
/** Bounded output, O(source length * bounded query terms). Offsets are chunk-relative UTF-16. */
function* fulltextSearch(
  source: NovelSource,
  query: string,
  limit = 3,
  scope: CanonResearchScope = "visible",
  context?: FulltextContext,
): Generator<FulltextHit[], void> {
  const topic = fold(query).trim();
  if (topic.length < 2 || topic.length > 160) return;
  if (
    context &&
    (context.package.docId !== source.docId ||
      context.package.sourceFingerprint !== source.fingerprint ||
      context.package.sourceChunkChars !== source.chunkChars ||
      context.package.revision !== context.anchor.packageRevision)
  )
    return;
  const node =
    context?.anchor.kind === "source-end"
      ? undefined
      : context?.package.nodes.find(
          (n) => n.id === (context?.anchor as { nodeId?: string }).nodeId,
        );
  if (context && context.anchor.kind !== "source-end" && !node) return;
  const refs = node?.sourceRefs.filter((ref) => {
    try {
      assertNovelEvidence(source, ref);
      return true;
    } catch {
      return false;
    }
  });
  if (node && !refs?.length) return;
  const sorted = refs
    ?.slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.start - b.start);
  const cutoff =
    context?.anchor.kind === "source-end"
      ? undefined
      : context?.anchor.position === "before"
        ? sorted?.[0]
        : sorted?.at(-1);
  const cutoffAt = cutoff
    ? context?.anchor.kind !== "source-end" &&
      context?.anchor.position === "before"
      ? cutoff.start
      : cutoff.end
    : undefined;
  // No package means chronology is unknown: it is an author reference, never character knowledge.
  if (!context && scope !== "author-planning") return;
  const terms = [
    ...new Set(topic.split(/\s+/u).filter((t) => t.length >= 2)),
  ].slice(0, 8);
  const hits: Array<FulltextHit & { score: number }> = [];
  const cap = Number.isFinite(limit)
    ? Math.max(1, Math.min(6, Math.trunc(limit)))
    : 3;
  for (const chunk of source.chunks) {
    const headingLines = [...chunk.text.matchAll(/^.*$/gm)];
    const headings = chunk.chapters.map((title) => ({
      title,
      rows: headingLines.filter((line) => line[0].trim() === title),
    }));
    const ordered =
      headings.length && headings.every((h) => h.rows.length === 1)
        ? headings
            .map((h) => ({ title: h.title, at: h.rows[0].index! }))
            .sort((a, b) => a.at - b.at)
        : [];
    let end = chunk.text.length;
    if (scope === "visible" && cutoff) {
      if (chunk.index > cutoff.chunkIndex) continue;
      if (chunk.index === cutoff.chunkIndex) end = Math.min(end, cutoffAt!);
    }
    const secret =
      context?.package.nodes
        .filter((n) => n.visibility !== "public")
        .flatMap((n) => n.sourceRefs)
        .filter(
          (ref) =>
            ref.chunkIndex === chunk.index &&
            Number.isSafeInteger(ref.start) &&
            Number.isSafeInteger(ref.end),
        )
        .sort((a, b) => a.start - b.start) ?? [];
    const spans: Array<[number, number]> = [];
    let begin = 0;
    for (const ref of secret) {
      if (ref.start > begin) spans.push([begin, Math.min(ref.start, end)]);
      begin = Math.max(begin, ref.end);
    }
    if (begin < end) spans.push([begin, end]);
    for (const [from, to] of spans) {
      if (to <= from) continue;
      const raw = chunk.text.slice(from, to),
        normalized = fold(raw);
      const exact = normalized.indexOf(topic);
      const occurrences = (term: string) => {
        const rows: number[] = [];
        let pos = 0;
        for (let i = 0; i < 12; i++) {
          const at = normalized.indexOf(term, pos);
          if (at < 0) break;
          rows.push(at);
          pos = at + term.length;
        }
        const last = normalized.lastIndexOf(term);
        if (last >= 0 && !rows.includes(last)) rows.push(last);
        return rows;
      };
      const positions =
        exact >= 0 ? occurrences(topic) : terms.flatMap(occurrences);
      for (const at of [...new Set(positions)].slice(0, 40)) {
        const original =
          from +
          (raw === normalized ? at : originalOffset(raw, at, normalized));
        let chapterStart = from,
          chapterEnd = to;
        // Use only exact, unique stored chapter headings; no title heuristics.
        if (ordered.length) {
          const containing = ordered.find(
            (h, i) =>
              original >= h.at &&
              original < (ordered[i + 1]?.at ?? chunk.text.length),
          );
          if (containing) {
            const index = ordered.indexOf(containing);
            chapterStart = Math.max(from, containing.at);
            chapterEnd = Math.min(
              to,
              ordered[index + 1]?.at ?? chunk.text.length,
            );
          }
        }
        const start = Math.max(chapterStart, original - 220),
          stop = Math.min(chapterEnd, start + 900);
        const quote = chunk.text.slice(start, stop),
          lower = fold(quote);
        const matched = terms.filter((t) => lower.includes(t)).length;
        if (exact < 0 && matched < Math.min(2, terms.length || 1)) continue;
        if (hits.some((h) => h.chunkIndex === chunk.index && h.start === start))
          continue;
        const ref = { chunkIndex: chunk.index, start, end: stop, quote };
        assertNovelEvidence(source, ref);
        const timeline = !context
          ? ("unmapped-author-only" as const)
          : cutoff &&
              (chunk.index > cutoff.chunkIndex ||
                (chunk.index === cutoff.chunkIndex && stop > cutoffAt!))
            ? ("future-for-author-planning" as const)
            : ("source-before-anchor" as const);
        const matchingNodes =
          context?.package.nodes.filter((n) =>
            n.sourceRefs.some(
              (r) =>
                r.chunkIndex === chunk.index && r.start < stop && r.end > start,
            ),
          ) ?? [];
        const conflicts =
          context?.conflicts
            ?.filter((c) => matchingNodes.some((n) => n.id === c.nodeId))
            .flatMap((c) => c.sourceEntryIds) ?? [];
        hits.push({
          ...ref,
          ...chapterFor(source, ref),
          docId: source.docId,
          title: source.title,
          sourceFingerprint: source.fingerprint,
          chunkFingerprint: createHash("sha256")
            .update(chunk.text, "utf8")
            .digest("hex"),
          ...(context ? { packageRevision: context.package.revision } : {}),
          timeline,
          layout: context ? "immutable-novel-source" : "corpus-current-chunker",
          characterKnowledge: "not-established",
          branchConflictSourceIds: [...new Set(conflicts)],
          score: (exact >= 0 ? 100 : 0) + matched * 5,
        });
        // Keep only best bounded rows while scanning all chunks (not all source text in the model context).
        hits.sort(
          (a, b) =>
            b.score - a.score ||
            a.chunkIndex - b.chunkIndex ||
            a.start - b.start,
        );
        if (hits.length > cap) hits.length = cap;
      }
    }
    yield hits.map(({ score: _score, ...hit }) => hit);
  }
}

/** Pure oracle API; production uses the cooperative wrapper below. */
export function searchNovelFulltext(
  source: NovelSource,
  query: string,
  limit = 3,
  scope: CanonResearchScope = "visible",
  context?: FulltextContext,
): FulltextHit[] {
  let hits: FulltextHit[] = [];
  for (const current of fulltextSearch(source, query, limit, scope, context))
    hits = current;
  return hits;
}
/** Yield to WS/abort timers between bounded source batches; no second search algorithm. */
export async function searchNovelFulltextAsync(
  source: NovelSource,
  query: string,
  limit = 3,
  scope: CanonResearchScope = "visible",
  context?: FulltextContext,
  signal?: AbortSignal,
): Promise<FulltextHit[]> {
  let hits: FulltextHit[] = [],
    batches = 0;
  const deadline = AbortSignal.timeout(15000);
  const stopped = () => signal?.aborted || deadline.aborted;
  if (stopped()) throw new Error("local source search cancelled or timed out");
  for (const current of fulltextSearch(source, query, limit, scope, context)) {
    if (stopped())
      throw new Error("local source search cancelled or timed out");
    hits = current;
    if (++batches % 8 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (stopped()) throw new Error("local source search cancelled or timed out");
  return hits;
}
