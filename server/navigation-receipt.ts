/** Persist an actual navigation in the append-only tree, not in a second story/cursor store. */
export interface NavigationTree {
 getLeafId(): string | null;
 appendCustomEntry(type: string, data: unknown): string;
 flush(): void;
}
export function persistNavigation(tree: NavigationTree, previousLeaf: string | null): string | null {
 const selected = tree.getLeafId();
 if (selected === previousLeaf) return selected;
 const id = tree.appendCustomEntry("rp-navigation", { version: 1, targetEntryId: selected });
 tree.flush();
 return id;
}
