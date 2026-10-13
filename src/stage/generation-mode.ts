/** 模式是提交身份的一部分，不由剧情重要性推断。 */
export type GenerationMode = "direct" | "director";
export const DEFAULT_GENERATION_MODE: GenerationMode = "director";
export function isGenerationMode(value: unknown): value is GenerationMode {
	return value === "direct" || value === "director";
}
export function effectiveGenerationMode(value: unknown): GenerationMode {
	return isGenerationMode(value) ? value : DEFAULT_GENERATION_MODE;
}
export interface GenerationStageReceipt {
	stage: "evidence" | "ideas" | "draft" | "review" | "revision" | "finalize";
	status: "success" | "degraded" | "failed" | "skipped";
	calls: number;
}
export interface AuthorCallReceipt {
 round: number; phase: string; stopReason?: string; textChars: number; inputTokens?: number; outputTokens?: number; requestedMaxTokens?: number; actualMaxTokens?: number;
}
export interface AuthorRecoveryWorkflow {
 reason: "provider-length" | "unclosed-dialogue" | "unclosed-container" | "transport-interrupted"; status: "pending" | "success" | "failed";
 attempts: number; invalidReceipts: number; lastValidation?: string;
}
export interface GenerationWorkflow {
	version: 1;
	mode: GenerationMode;
	stages: GenerationStageReceipt[];
	writerRounds: number;
	toolFallback: boolean;
	toolFallbackReason?: "configured" | "unsupported";
 writerCalls?: AuthorCallReceipt[];
 recovery?: AuthorRecoveryWorkflow;
 research?: import("../research/session.ts").ResearchSummary;
}
/** Wire 只允许有限的阶段元信息；不传原始报告、prompt、reasoning。 */
export function generationWorkflowView(value: unknown): GenerationWorkflow | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	if (row.version !== 1 || !isGenerationMode(row.mode)) return undefined;
	const stages = ["evidence", "ideas", "draft", "review", "revision", "finalize"];
	const statuses = ["success", "degraded", "failed", "skipped"];
 const recovery = row.recovery && typeof row.recovery === "object" ? row.recovery as Record<string, unknown> : undefined;
 const recoveryView: AuthorRecoveryWorkflow | undefined = recovery && ["provider-length", "unclosed-dialogue", "unclosed-container", "transport-interrupted"].includes(String(recovery.reason)) && ["pending", "success", "failed"].includes(String(recovery.status))
  ? { reason: recovery.reason as AuthorRecoveryWorkflow["reason"], status: recovery.status as AuthorRecoveryWorkflow["status"], attempts: Math.max(0, Math.min(8, Number(recovery.attempts) || 0)), invalidReceipts: Math.max(0, Math.min(8, Number(recovery.invalidReceipts) || 0)), ...(["invalid-json", "ambiguous-json", "invalid-suffix", "textual-protocol", "truncated-receipt", "unclosed-dialogue", "unclosed-container", "duplicate-draft"].includes(String(recovery.lastValidation)) ? { lastValidation: String(recovery.lastValidation) } : {}) } : undefined;
 const writerCalls: AuthorCallReceipt[] = (Array.isArray(row.writerCalls) ? row.writerCalls : []).flatMap(call => {
  if (!call || typeof call !== "object" || !["evidence", "ideas", "ready", "writing", "review", "decision", "revision", "finished", "recovery"].includes(call.phase)) return [];
  return [{ round: Math.max(1, Math.min(40, Number(call.round) || 1)), phase: call.phase.slice(0, 40), textChars: Math.max(0, Number(call.textChars) || 0), ...(["stop", "length", "toolUse", "aborted", "error"].includes(String(call.stopReason)) ? { stopReason: String(call.stopReason) } : {}), ...(typeof call.inputTokens === "number" ? { inputTokens: Math.max(0, call.inputTokens) } : {}), ...(typeof call.outputTokens === "number" ? { outputTokens: Math.max(0, call.outputTokens) } : {}), ...(typeof call.requestedMaxTokens === "number" ? { requestedMaxTokens: Math.max(0, call.requestedMaxTokens) } : {}), ...(typeof call.actualMaxTokens === "number" ? { actualMaxTokens: Math.max(0, call.actualMaxTokens) } : {}) }];
 }).slice(-40);
    const research = row.research && typeof row.research === "object" ? row.research as Record<string, unknown> : undefined;
    const researchView: GenerationWorkflow["research"] = research && ["not-requested", "in-progress", "sufficient", "gaps", "limits", "cancelled", "stale-scope"].includes(String(research.stop))
        ? { stop: research.stop as NonNullable<GenerationWorkflow["research"]>["stop"], ...Object.fromEntries(["questions", "evidence", "claims", "unresolved", "searches", "opens", "reused", "local"].map(key => [key, Math.max(0, Math.min(100, Number(research[key]) || 0))])) } as NonNullable<GenerationWorkflow["research"]> : undefined;
	return { version: 1, mode: row.mode, writerRounds: Math.max(0, Math.min(40, Number(row.writerRounds) || 0)), toolFallback: row.toolFallback === true, ...(researchView ? { research: researchView } : {}),
		...(["configured", "unsupported"].includes(String(row.toolFallbackReason)) ? { toolFallbackReason: row.toolFallbackReason as "configured" | "unsupported" } : {}),
  ...(writerCalls.length ? { writerCalls } : {}), ...(recoveryView ? { recovery: recoveryView } : {}),
		stages: (Array.isArray(row.stages) ? row.stages : []).flatMap(item => {
			if (!item || typeof item !== "object") return [];
			const v = item as Record<string, unknown>;
			if (!stages.includes(String(v.stage)) || !statuses.includes(String(v.status))) return [];
			return [{ stage: v.stage as GenerationStageReceipt["stage"], status: v.status as GenerationStageReceipt["status"], calls: Math.max(0, Math.min(16, Number(v.calls) || 0)) }];
		}).slice(0, 40) };
}
