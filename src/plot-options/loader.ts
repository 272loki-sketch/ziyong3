import { existsSync, readFileSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { corpusDocumentsFile, corpusDigestsDir, type CorpusDailyPattern } from "../outline/corpus.ts";
/** Only ready digest patterns, never source novels; reuse unchanged files across polling/turns. */
export function createPlotLibraryLoader(cwd: string): () => Array<CorpusDailyPattern & {
    docId: string;
}> {
    const cache = new Map<string, {
        signature: string;
        rows: Array<CorpusDailyPattern & {
            docId: string;
        }>;
    }>();
    const fields = ["title", "setting", "surfaceActivity", "initiative", "sweetBeat", "friction", "misunderstanding", "microChange", "escalationLimit", "naturalStop", "failureWarning", "locator"] as const;
    return () => {
        const index = corpusDocumentsFile(cwd);
        if (!existsSync(index) || lstatSync(index).isSymbolicLink())
            return [];
        const docs: unknown = JSON.parse(readFileSync(index, "utf8"));
        if (!Array.isArray(docs))
            throw Error("日常剧情卡文档索引损坏");
        const rows: Array<CorpusDailyPattern & {
            docId: string;
        }> = [], visible = new Set<string>();
        for (const d of docs) {
            if (d?.status !== "ready" || typeof d.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(d.id))
                continue;
            const file = join(corpusDigestsDir(cwd), `${d.id}.json`);
            if (!existsSync(file) || lstatSync(file).isSymbolicLink())
                continue;
            visible.add(d.id);
            const stat = statSync(file), signature = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
            let item = cache.get(d.id);
            if (item?.signature !== signature) {
                const digest = JSON.parse(readFileSync(file, "utf8"));
                const patterns: unknown[] = Array.isArray(digest.dailyPatterns) ? digest.dailyPatterns : [];
                const normalized = patterns.flatMap(value => {
                    if (!value || typeof value !== "object" || Array.isArray(value))
                        return [];
                    const row = value as Record<string, unknown>;
                    if (typeof row.title !== "string" || !row.title.trim())
                        return [];
                    const clean = Object.fromEntries(fields.map(f => [f, typeof row[f] === "string" ? row[f].slice(0, 2000) : ""])) as unknown as CorpusDailyPattern;
                    return [{ ...clean, docId: d.id }];
                });
                item = { signature, rows: normalized };
                cache.set(d.id, item);
            }
            rows.push(...item.rows);
        }
        for (const id of cache.keys())
            if (!visible.has(id))
                cache.delete(id);
        return rows;
    };
}
