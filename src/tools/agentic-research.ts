import { strArg, intArg, type ToolSpec, type ToolResult } from "./registry.ts";
import type { FulltextHit } from "../novel-play/fulltext.ts";
import type { CanonResearchScope } from "../novel-play/research.ts";
export interface CorpusResearchResult {
  documents: Array<{ id: string; title: string; version?: number }>;
  hits: FulltextHit[];
  error?: string;
}
export interface AgenticResearchDeps {
  corpusResearch?: (
    query: string,
    limit: number,
    scope: CanonResearchScope,
    docId?: string,
  ) => Promise<CorpusResearchResult>;
  researchRecord?: (args: Record<string, unknown>) => ToolResult;
}
const question = {
  type: "string",
  pattern: "^[a-zA-Z0-9_-]{1,40}$",
  default: "task",
};
export const corpusResearchTool: ToolSpec<AgenticResearchDeps> = {
  name: "corpus_research",
  domain: "research",
  mode: "read",
  surfaces: ["stage"],
  label: "原文全文检索",
  description: () =>
    "检索当前作品或卡绑定文档原文，含未入事件索引的细节；空query列文档。精确UTF16位置及版本；author-planning是作者参考，不证明角色已知或分支事实。",
  parameters: () => ({
    type: "object",
    properties: {
      query: { type: "string", maxLength: 160 },
      doc_id: { type: "string", maxLength: 160 },
      question_id: question,
      scope: {
        type: "string",
        enum: ["visible", "author-planning"],
        default: "visible",
      },
      max_results: { type: "integer", minimum: 1, maximum: 6, default: 3 },
    },
    additionalProperties: false,
  }),
  async run(args, deps) {
    if (!deps.corpusResearch) return { text: "当前没有授权的作品源文。" };
    try {
      const row = await deps.corpusResearch(
        strArg(args, "query"),
        intArg(args, "max_results", 3, 1, 6),
        args.scope === "author-planning" ? "author-planning" : "visible",
        strArg(args, "doc_id") || undefined,
      );
      return {
        text: JSON.stringify({
          kind: "corpus-source-evidence",
          authority: "reference-not-branch-fact",
          ...row,
          ...(!row.hits.length && strArg(args, "query")
            ? {
                unresolved:
                  "未检索到不代表原著没有；范围、词形或版本可能不匹配",
              }
            : {}),
        }),
        details: row.hits,
      };
    } catch {
      return { text: "源文读取失败或版本过期；没有采用未经核对的引文。" };
    }
  },
};
export const researchRecordTool: ToolSpec<AgenticResearchDeps> = {
  name: "research_record",
  domain: "research",
  mode: "read",
  surfaces: ["stage"],
  label: "研究证据回执",
  description: () =>
    "按需声明事实问题、核对host证据ID、记录supported/inferred/conflicted/unknown及缺口；finish停止研究，read回查。只读参考，不改正文或世界线；出处核验不等于语义确证。",
  parameters: () => ({
    type: "object",
    properties: {
      action: { type: "string", enum: ["plan", "assess", "finish", "read"] },
      question_id: question,
      source_ids: {
        type: "array",
        maxItems: 16,
        items: { type: "string", maxLength: 120 },
      },
      questions: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            id: question,
            text: { type: "string", maxLength: 500 },
            important: { type: "boolean" },
          },
          required: ["id", "text"],
          additionalProperties: false,
        },
      },
      claims: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            questionId: question,
            text: { type: "string", maxLength: 1200 },
            kind: {
              type: "string",
              enum: ["canon", "world", "external", "interpretation"],
            },
            verdict: {
              type: "string",
              enum: ["supported", "inferred", "conflicted", "unknown"],
            },
            evidenceIds: {
              type: "array",
              maxItems: 16,
              items: { type: "string", maxLength: 80 },
            },
          },
          required: ["questionId", "text", "kind", "verdict", "evidenceIds"],
          additionalProperties: false,
        },
      },
      gaps: {
        type: "array",
        maxItems: 24,
        items: {
          type: "object",
          properties: {
            questionId: question,
            reason: { type: "string", maxLength: 500 },
          },
          required: ["questionId", "reason"],
          additionalProperties: false,
        },
      },
      evidence_ids: {
        type: "array",
        maxItems: 16,
        items: { type: "string", maxLength: 80 },
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  async run(args, deps) {
    return deps.researchRecord?.(args) ?? { text: "当前没有研究回执通道。" };
  },
};
