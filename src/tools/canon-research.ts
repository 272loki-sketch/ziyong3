import { intArg, strArg, type ToolSpec } from "./registry.ts";
import type { AgenticResearchDeps } from "./agentic-research.ts";
import type { CanonEvidenceHit, CanonResearchScope } from "../novel-play/research.ts";

export interface CanonResearchDeps {
    corpusResearch?: AgenticResearchDeps["corpusResearch"];
	canonResearch?: (query: string, maxResults: number, scope?: CanonResearchScope) => Promise<CanonEvidenceHit[]> | CanonEvidenceHit[];
}

/** Bounded, active-branch source evidence. No arbitrary corpus/file path or network. */
export const canonResearchTool: ToolSpec<CanonResearchDeps> = {
	name: "canon_research",
	domain: "research",
	mode: "read",
	surfaces: ["stage"],
	label: "原著证据定位",
	description: () => "检索作品包精确引文；visible按进度，author-planning供作者查公开未来，不证明角色已知或分支已发生。秘密节点不返回。",
	parameters: () => ({
		type: "object",
		properties: {
            question_id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,40}$", default: "task" },
			query: { type: "string", minLength: 2, maxLength: 160, description: "公开角色、事件、时间线或事实问题" },
			scope: { type: "string", enum: ["visible", "author-planning"], default: "visible" },
			max_results: { type: "integer", minimum: 1, maximum: 6, default: 3 },
		},
		required: ["query"],
		additionalProperties: false,
	}),
	async run(args, deps) {
		const query = strArg(args, "query").slice(0, 160);
		if (!deps.canonResearch || query.length < 2) return { text: "当前没有可用的小说开演原著证据，或查询不完整。" };
		try {
            const limit = intArg(args, "max_results", 3, 1, 6), scope = args.scope === "author-planning" ? "author-planning" : "visible";
            const hits = await deps.canonResearch(query, limit, scope);
            // An event-index miss is not a full-source miss. Reuse the same bound
            // corpus reader, preserving visibility/version/branch guards and offsets.
            if (!hits.length && deps.corpusResearch) {
                const source = await deps.corpusResearch(query, limit, scope);
                if (source.hits.length) return { text: JSON.stringify({ kind: "canon-source-evidence", actuality: "reference-not-branch-fact", coverage: "immutable-source-fulltext-fallback", eventIndexMatched: false, hits: source.hits }), activity: "已检索当前作品包原文细节", details: source.hits };
                return { text: JSON.stringify({ kind: "canon-source-evidence", actuality: "reference-not-branch-fact", coverage: "event-index-and-bound-fulltext-search", hits: [], unresolved: "当前作品包已可见范围未找到匹配的确切原文证据，不能据此断言原著没有该事件。" }), details: [] };
            }
            if (!hits.length) return { text: "当前作品包已可见范围未找到匹配的确切原文证据，不能据此断言原著没有该事件。" };
			return { text: JSON.stringify({ kind: "canon-source-evidence", actuality: "reference-not-branch-fact", coverage: "indexed-event-source-spans", hits: hits.map(({ summary, ...locator }) => ({ ...locator, eventInterpretation: { text: summary, verified: false } })) }), activity: "已检索当前作品包原著证据", details: hits };
		} catch {
			return { text: "当前原著证据不可读取或作品版本已失效；未采用未经核对的来源。" };
		}
	},
};
