/** Bounded, volatile reference cache. Never persisted or adopted as story facts. */
export interface ResearchCacheScope { contextKey: string; sourceLeafId: string; ancestorIds: ReadonlySet<string> }
export function createResearchEvidenceCache(ttlMs = 600_000, maxEntries = 64, now = () => Date.now()) {
	const entries = new Map<string, { scope: ResearchCacheScope; value: unknown; expires: number; size: number }>();
	let total = 0;
	return {
		get<T>(key: string, scope: ResearchCacheScope): T | undefined {
			const item = entries.get(key);
			if (!item) return undefined;
			if (item.expires <= now()) { entries.delete(key); total -= item.size; return undefined; }
			if (item.scope.contextKey !== scope.contextKey || !scope.ancestorIds.has(item.scope.sourceLeafId)) return undefined;
			return structuredClone(item.value) as T;
		},
		put(key: string, scope: ResearchCacheScope, value: unknown): void {
			const size = JSON.stringify(value).length;
			if (size > 160_000) return;
			const old = entries.get(key); if (old) { entries.delete(key); total -= old.size; }
			entries.set(key, { scope: { ...scope, ancestorIds: new Set<string>() }, value: structuredClone(value), expires: now() + ttlMs, size }); total += size;
			while (entries.size > maxEntries || total > 160_000) {
				const first = entries.keys().next().value!; total -= entries.get(first)!.size; entries.delete(first);
			}
		},
	};
}
export type ResearchEvidenceCache = ReturnType<typeof createResearchEvidenceCache>;
