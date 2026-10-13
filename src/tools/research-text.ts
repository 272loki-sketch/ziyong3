/** Bounded focus selection from inert source text; no network or story authority. */
export function selectResearchExcerpt(text: string, focus = "", limit = 4_000): string {
	const maxChars = Number.isFinite(limit) ? Math.max(200, Math.min(4_000, Math.trunc(limit))) : 4_000;
	const terms = [...new Set(focus.trim().toLowerCase().split(/\s+/).filter(word => word.length >= 2))].slice(0, 8);
	if (!terms.length || text.length <= maxChars) return text.slice(0, maxChars);
	const lower = text.toLowerCase();
	const positions: number[] = [];
	for (const term of terms) {
		let from = 0;
		for (let i = 0; i < 12; i++) {
			const at = lower.indexOf(term, from);
			if (at < 0) break;
			positions.push(at);
			from = at + Math.max(1, term.length);
		}
		const last = lower.lastIndexOf(term);
		if (last >= 0) positions.push(last);
	}
	if (!positions.length) return text.slice(0, maxChars);
	let bestStart = 0, bestScore = -1;
	for (const pos of positions) {
		const start = Math.min(Math.max(0, pos - Math.min(600, Math.floor(maxChars / 3))), text.length - maxChars);
		const window = lower.slice(start, start + maxChars);
		const score = terms.reduce((n, term) => n + (window.includes(term) ? 2 + Math.min(4, term.length) : 0), 0);
		if (score > bestScore || (score === bestScore && start < bestStart)) {
			bestScore = score;
			bestStart = start;
		}
	}
	return text.slice(bestStart, bestStart + maxChars);
}
