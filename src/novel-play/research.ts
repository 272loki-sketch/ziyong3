/** Exact, read-only source locators. Event interpretation is never a story fact. */
import type { NovelPackage, NovelAnchor } from "./canon.ts";
import type { NovelSource, NovelEvidence } from "./source.ts";
import { assertNovelEvidence } from "./source.ts";
export type CanonResearchScope = "visible" | "author-planning";
export interface CanonEvidenceHit {
	nodeId: string; stageId: string; title: string; summary: string;
	chapter: string; chapterCandidates: string[]; chunkIndex: number;
	start: number; end: number; quote: string; score: number;
	docId: string; packageRevision: string; sourceFingerprint: string;
	nodeOrder: number; dependsOn: string[];
	match: "source-text" | "event-title";
	timeline: "past-or-current" | "future-for-author-planning";
	characterKnowledge: "not-established";
	branchConflictSourceIds?: string[];
}
export function chapterFor(source: NovelSource, ref: NovelEvidence): { chapter: string; chapterCandidates: string[] } {
	const chunk = source.chunks.find(chunk => chunk.index === ref.chunkIndex)!;
	const titles = chunk.chapters.filter(Boolean);
	if (titles.length <= 1) return { chapter: titles[0] ?? "", chapterCandidates: titles };
	// Older chunks only carry a list of titles. Infer boundaries only from unique,
	// exact heading lines, otherwise report ambiguity instead of inventing a chapter.
	const headings = titles.map(title => {
		const lines = [...chunk.text.matchAll(/^.*$/gm)].filter(line => line[0].trim() === title);
		return { title, at: lines.length === 1 ? lines[0].index! : -1 };
	}).sort((a,b) => a.at - b.at);
	if (headings.some(h => h.at < 0)) return { chapter: "", chapterCandidates: titles };
	const matches = headings.filter((h,i) => ref.start >= h.at && ref.end <= (headings[i+1]?.at ?? chunk.text.length));
	return { chapter: matches.length === 1 ? matches[0].title : "", chapterCandidates: titles };
}
export function searchVisibleCanonEvidence(pkg: NovelPackage, source: NovelSource, anchor: NovelAnchor, query: string, limit = 3, scope: CanonResearchScope = "visible"): CanonEvidenceHit[] {
	if (pkg.revision !== anchor.packageRevision || pkg.sourceFingerprint !== source.fingerprint || pkg.docId !== source.docId || pkg.sourceChunkChars !== source.chunkChars) return [];
	const topic = query.normalize("NFKC").trim().toLowerCase();
	if (!topic || topic.length > 160) return [];
	const current = anchor.kind === "source-end" ? undefined : pkg.nodes.find(node => node.id === anchor.nodeId);
	if (anchor.kind !== "source-end" && !current) return [];
	const maxOrder = current ? current.order - (anchor.kind !== "source-end" && anchor.position === "before" ? 1 : 0) : Infinity;
	const words = topic.split(/\s+/).filter(term => term.length >= 2).slice(0, 12);
	const fragments = [...new Set(words.flatMap(term => /[^\x00-\x7f]/u.test(term) && term.length > 2
		? [term, ...Array.from({length: Math.min(term.length - 1, 40)}, (_,i) => term.slice(i,i+2))] : [term]))];
	const hits: CanonEvidenceHit[] = [];
	const exactNodes = new Set<string>();
	for (const node of [...pkg.nodes].sort((a,b) => a.order - b.order)) {
		if (node.visibility !== "public" || (node.order > maxOrder && scope !== "author-planning")) continue;
		const title = node.title.normalize("NFKC").toLowerCase(), titleExact = title.includes(topic);
		for (const ref of node.sourceRefs) {
			try { assertNovelEvidence(source, ref); } catch { continue; }
			const quoteText = ref.quote.normalize("NFKC").toLowerCase();
			const sourceExact = quoteText.includes(topic);
			const sourceMatches = fragments.filter(term => quoteText.includes(term));
			const titleMatches = fragments.filter(term => title.includes(term));
			if (!titleExact && !sourceExact && sourceMatches.length + titleMatches.length < Math.min(2, fragments.length || 2)) continue;
			if (titleExact || sourceExact) exactNodes.add(node.id);
			const score = (sourceExact ? 100 : 0) + (titleExact ? 40 : 0) + sourceMatches.length * 3 + titleMatches.length;
			// Centre long locators around the actual query match, maintaining exact UTF-16 offsets.
			const matchedAt = sourceExact ? quoteText.indexOf(topic) : Math.min(...sourceMatches.map(term => quoteText.indexOf(term)));
            let at = 0;
            if (Number.isFinite(matchedAt) && matchedAt > 0) {
                // Locate the original UTF-16 boundary after normalization without
                // pretending normalized character offsets are source offsets.
                let lo = 0, hi = ref.quote.length;
                while (lo < hi) {
                    const mid = Math.floor((lo + hi) / 2);
                    if (ref.quote.slice(0, mid).normalize("NFKC").toLowerCase().length <= matchedAt) lo = mid + 1;
                    else hi = mid;
                }
                at = Math.max(0, lo - 1);
            }
			const offset = Math.min(Math.max(0, at - 300), Math.max(0, ref.quote.length - 900));
			const quote = ref.quote.slice(offset, offset + 900), start = ref.start + offset;
			hits.push({ nodeId: node.id, stageId: node.stageId, title: node.title, summary: node.summary.slice(0, 600),
				...chapterFor(source, { ...ref, start, end: start + quote.length }), chunkIndex: ref.chunkIndex,
				start, end: start + quote.length, quote, score, docId: pkg.docId, packageRevision: pkg.revision,
				sourceFingerprint: source.fingerprint, nodeOrder: node.order, dependsOn: [...node.dependsOn],
				match: sourceExact || sourceMatches.length ? "source-text" : "event-title",
				timeline: node.order > maxOrder ? "future-for-author-planning" : "past-or-current", characterKnowledge: "not-established" });
		}
	}
	const exact = hits.filter(hit => exactNodes.has(hit.nodeId));
	const cap = Number.isFinite(limit) ? Math.max(1, Math.min(6, Math.trunc(limit))) : 3;
	return (exact.length ? exact : hits).sort((a,b) => b.score - a.score || a.nodeOrder - b.nodeOrder || a.start - b.start).slice(0, cap);
}
