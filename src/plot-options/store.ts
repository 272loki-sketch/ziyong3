import type { PlotRetrievalStatus } from "./types.ts";
import { existsSync, mkdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicWithBackup } from "../atomic-json.ts";
import type { PlotProgress, PlotRecommendation, PlotSettings } from "./types.ts";
export interface PlotBatch {
    relevanceVersion?: number;
    materialKey?: string;
    contextKey: string;
    sourceId: string;
    outlineHash: string;
    sourceHash: string;
    libraryHash: string;
    rounds: number;
    selectionEntryId: string | null;
    options: PlotRecommendation[];
    progress?: PlotProgress;
    createdAt: string;
    error?: string;
    /** No retrieval or model request was started: safe to resume after explicit configuration. */
    blockedBy?: "model";
    retrieval?: PlotRetrievalStatus;
}
const defaults: PlotSettings = { enabled: false, interval: 5, semantic: false, embeddingBatchSize: 32 };
/** Private sidecar only. No background task appends to the shared Session Tree. */
export class PlotOptionsStore {
    private readonly root: string;
    constructor(root: string) { this.root = root; }
    private file(name: string): string {
        if (!/^[a-z0-9-]+$/.test(name))
            throw Error("非法剧情筹备存储键");
        if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink())
            throw Error("剧情筹备目录不能是符号链接");
        const path = join(this.root, `${name}.json`);
        if (existsSync(path) && lstatSync(path).isSymbolicLink())
            throw Error("剧情筹备文件不能是符号链接");
        return path;
    }
    private read(name: string): unknown {
        const file = this.file(name);
        if (!existsSync(file))
            return undefined;
        return JSON.parse(readFileSync(file, "utf8"));
    }
    private write(name: string, value: unknown): void {
        const path = this.file(name);
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        writeJsonAtomicWithBackup(path, value);
    }
    cache(name: string, value?: unknown): unknown {
        if (!/^semantic-[a-f0-9]{64}$/.test(name))
            throw Error("非法语义索引键");
        if (value !== undefined) {
            this.write(name, value);
            return value;
        }
        return this.read(name);
    }
    settings(patch?: Partial<PlotSettings>): PlotSettings {
        const raw = this.read("settings") as Partial<PlotSettings> | undefined;
        const current = { embeddingBatchSize: ([1, 8, 16, 32].includes(Number(raw?.embeddingBatchSize)) ? Number(raw?.embeddingBatchSize) : 32) as PlotSettings["embeddingBatchSize"], semantic: raw?.semantic === true, enabled: raw?.enabled === true, interval: raw?.interval === 10 ? 10 as const : 5 as const };
        if (!patch)
            return current;
        if ((patch.embeddingBatchSize !== undefined && ![1, 8, 16, 32].includes(patch.embeddingBatchSize)) || (patch.semantic !== undefined && typeof patch.semantic !== "boolean") || (patch.enabled !== undefined && typeof patch.enabled !== "boolean") || (patch.interval !== undefined && patch.interval !== 5 && patch.interval !== 10))
            throw Error("刷新周期只能是5/10楼，嵌入批量只能为1/8/16/32");
        const next = { ...raw, ...defaults, ...current, ...patch };
        this.write("settings", next);
        return next;
    }
    batches(contextKey: string): PlotBatch[] {
        if (!/^[a-f0-9]{64}$/.test(contextKey))
            throw Error("非法剧情筹备作用域");
        const data = this.read(contextKey);
        return Array.isArray(data) ? data as PlotBatch[] : [];
    }
    save(batch: PlotBatch): void {
        const batches = this.batches(batch.contextKey);
        this.write(batch.contextKey, [...batches, batch].slice(-48));
    }
}
