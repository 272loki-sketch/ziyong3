export interface PlotRetrievalStatus {
    method: "keyword" | "hybrid" | "keyword-fallback" | "manual";
    phase: "idle" | "indexing" | "querying" | "ready" | "fallback";
    indexed: number;
    total: number;
    configured: boolean;
    model?: string;
    message?: string;
    requests: number;
    inputTokens: number | null;
}
/** Transport is intent only; the server resolves the full, source-bound recommendation. */
export interface PlotChoiceInput {
    contextKey: string;
    optionId: string;
}
export interface PlotEvidence {
    entryId: string;
    quote: string;
}
export interface PlotMechanism {
    activity: { quote: string; adaptation: string };
    friction: { quote: string; adaptation: string };
    change: { quote: string; adaptation: string };
}
export interface PlotRecommendation {
    /** Optional only for already-committed legacy directions. New recommendations require these receipts. */
    grounding?: PlotEvidence[];
    mechanism?: PlotMechanism;
    id: string;
    cardId: string;
    cardHash: string;
    title: string;
    experience: string;
    whyNow: string;
    draft: string;
    prerequisites: string[];
    setup: string[];
    development: string[];
    boundaries: string[];
    entryCondition: string;
}
export interface PlotSelection {
    version: 1;
    contextKey: string;
    option: PlotRecommendation;
}
export type PlotProgressStatus = "preparing" | "seeded" | "engaged" | "completed" | "shelved";
export interface PlotProgress {
    selectionEntryId: string;
    status: PlotProgressStatus;
    note: string;
    evidence: PlotEvidence[];
    nextSetup?: string[];
    nextEntryCondition?: string;
}
export interface PlotSettings {
    embeddingBatchSize: 1 | 8 | 16 | 32;
    semantic: boolean;
    enabled: boolean;
    interval: 5 | 10;
}
export interface PlotOptionsView {
    embeddingBatchSize: 1 | 8 | 16 | 32;
    semantic: boolean;
    retrieval?: PlotRetrievalStatus;
    lastRetrieval?: PlotRetrievalStatus;
    contextKey: string;
    controlKey: string;
    sourceId: string | null;
    enabled: boolean;
    interval: 5 | 10;
    running: boolean;
    error?: string;
    libraryCount: number;
    modelConfigured: boolean;
    options: PlotRecommendation[];
    active: {
        entryId: string;
        sourceAvailable: boolean;
        option: PlotRecommendation;
        progress?: PlotProgress;
    } | null;
}
export function validPlotChoice(value: unknown): value is PlotChoiceInput {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const row = value as Record<string, unknown>;
    return Object.keys(row).every(k => k === "contextKey" || k === "optionId") &&
        typeof row.contextKey === "string" && /^[a-f0-9]{64}$/.test(row.contextKey) &&
        typeof row.optionId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(row.optionId);
}
