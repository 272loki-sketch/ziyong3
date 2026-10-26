import { requestFailure } from "../stage/request-failure.ts";
import { RequestJournal } from "../stage/request-journal.ts";
import { loadMemoryConfig } from "../memory/config.ts";
import { embedTextsCloud } from "../memory/embed.ts";
import { plotHash } from "./library.ts";
import type { PlotEmbeddingProvider } from "./semantic.ts";
/** Reuse only the dedicated embedding connection, never a chat role or memory data/store. */
export function plotEmbeddingProvider(cwd: string): PlotEmbeddingProvider | undefined {
    const config = loadMemoryConfig(cwd), cloud = config.cloudEmbed;
    if (config.embedMode !== "cloud" || !cloud.baseUrl.trim() || !cloud.model.trim() || !cloud.apiKey.trim())
        return undefined;
    const snapshot = { ...cloud };
    return {
        key: plotHash(["plot-cloud-embed-v1", snapshot.baseUrl.replace(/\/+$/, ""), snapshot.model, snapshot.apiKey]),
        model: snapshot.model,
        async embed(texts, signal, scope) {
            let inputTokens: number | undefined;
            let record: ReturnType<RequestJournal["begin"]> | undefined;
            try {
                if (scope)
                    record = new RequestJournal(cwd).begin({ scope: { sessionId: scope.sessionId, card: scope.card }, sourceEntryId: scope.sourceEntryId, phase: "plot.embedding", provider: "cloud-embedding", model: snapshot.model }, { input: texts });
            }
            catch { /* Observation must not become a narrative gate. */ }
            try {
                const vectors = await embedTextsCloud(texts, snapshot, {
                    signal, strict: true, onPayload: payload => { try {
                        record?.payload(payload);
                    }
                    catch { /* Private observation only. */ } }, maxResponseBytes: 16 * 1024 * 1024,
                    onUsage: usage => { const n = usage.prompt_tokens ?? usage.input_tokens; if (typeof n === "number" && Number.isFinite(n) && n >= 0)
                        inputTokens = n; },
                });
                try {
                    record?.end("success", inputTokens === undefined ? undefined : { input: inputTokens });
                }
                catch { /* Private observation only. */ }
                return { vectors, ...(inputTokens === undefined ? {} : { inputTokens }) };
            }
            catch (e) {
                try {
                    const failure = requestFailure(e, signal, snapshot.apiKey);
                    record?.end(failure.origin === "cancelled" ? "aborted" : "failed", inputTokens === undefined ? undefined : { input: inputTokens }, undefined, failure);
                }
                catch { /* Private observation only. */ }
                throw e;
            }
        },
    };
}
