/** Branch-local ledger freshness. Diagnostic metadata never changes story/state facts. */
import { createHash } from "node:crypto";
import { applyPatch } from "../state.ts";
import { stateFromBranch } from "./assemble.ts";
import type { BranchEntryLike } from "./assemble.ts";
import { classifyModelFailure, type ModelFailureKind } from "./model-failure.ts";
export interface LedgerStatus {
 scope?: {sessionId: string; card: string};
 status: "initial" | "current" | "pending" | "failed" | "blocked";
 sourceEntryId?: string;
 revision?: string;
 canConfirm?: boolean;
 canRetry?: boolean;
 snapshotSourceEntryId?: string;
 failureKind?: ModelFailureKind;
 message: string;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function ledgerFailureForSource(branch: BranchEntryLike[], sourceEntryId: string): ModelFailureKind | undefined {
 const entry = [...branch].reverse().find(e => e.customType === "rp-turn-diagnostic" && object(e.data).sourceEntryId === sourceEntryId && object(e.data).stage === "scribe");
 const diagnostic = object(entry?.data);
 return diagnostic.kind === "failed" ? diagnostic.failureKind === "content-filter" ? "content-filter" : classifyModelFailure(diagnostic.error).kind : undefined;
}
export function ledgerStatusFromBranch(branch: BranchEntryLike[]): LedgerStatus {
 const incomplete = new Set(branch.filter(e => e.customType === "rp-turn-settlement" && object(e.data).authorComplete === false).map(e => object(e.data).narrativeEntryId));
 const narrative = [...branch].reverse().find(e => e.id && !incomplete.has(e.id) && e.message?.role === "assistant" && !["aborted", "error"].includes(e.message.stopReason ?? "") && typeof object(e.message.details).rpNarrative === "string" && String(object(e.message.details).rpNarrative).trim());
 if (!narrative?.id) return { status: "initial", message: "尚无已完成正文的自动记账结果" };
 const sourceEntryId = narrative.id;
 const snapshots = branch.filter(e => e.customType === "rp-state");
 const snapshotSource = object(snapshots.at(-1)?.data)._diagnosticSourceEntryId;
 const relevant = branch.filter(e => e.customType === "rp-state" || object(e.data).narrativeEntryId === sourceEntryId || object(e.data).sourceEntryId === sourceEntryId);
 const revision = createHash("sha256").update(JSON.stringify([sourceEntryId, object(narrative.message?.details).rpNarrative, relevant.map(e => [e.id, e.customType, e.data])])).digest("hex");
 const lastReply = [...branch].reverse().find(e => e.message?.role === "assistant" && typeof object(e.message.details).rpNarrative === "string");
 const details = object(narrative.message?.details), workflow = object(details.rpGenerationWorkflow);
 const authorComplete = narrative.message?.stopReason === "stop" && ["direct", "director"].includes(String(details.rpGenerationMode)) &&
  typeof details.rpAuthorDraft === "string" && !!details.rpAuthorDraft.trim() && (!workflow.recovery || object(workflow.recovery).status === "success") &&
  branch.some(e => e.customType === "rp-presentation-delivery" && object(e.data).targetEntryId === sourceEntryId && object(e.data).version === 1 && object(e.data).display === details.rpAuthorDraft);
 const base = { sourceEntryId, revision, canRetry: lastReply?.id === sourceEntryId && authorComplete, canConfirm: lastReply?.id === sourceEntryId, ...(typeof snapshotSource === "string" ? { snapshotSourceEntryId: snapshotSource } : {}) };
 const receipt = object([...branch].reverse().find(e => e.customType === "rp-turn-settlement" && object(e.data).narrativeEntryId === sourceEntryId)?.data);
 const diagnostic = object([...branch].reverse().find(e => e.customType === "rp-turn-diagnostic" && object(e.data).sourceEntryId === sourceEntryId && object(e.data).stage === "scribe")?.data);
 // A valid no-change receipt also settles this turn; a later snapshot from a user edit alone does not.
 if (receipt.ledgerDone === true || snapshots.some(e => object(e.data)._diagnosticSourceEntryId === sourceEntryId) || diagnostic.kind === "skipped" && diagnostic.reason === "empty-patch")
  return { ...base, status: "current", canConfirm: false, canRetry: false, message: receipt.ledgerOrigin === "user-confirmed" ? "账本已由用户核对确认，未调用模型" : "账本已跟随本轮正文完成整理" };
 const failureKind = ledgerFailureForSource(branch, sourceEntryId);
 if (failureKind === "content-filter") return { ...base, status: "blocked", failureKind, message: "本轮自动记账被供应商安全策略拒绝，当前账本尚未跟上最新剧情。旧快照与用户编辑保留；不会自动换模型或重试。" };
 if (diagnostic.kind === "failed" || diagnostic.kind === "stale") return { ...base, status: "failed", ...(failureKind ? { failureKind } : {}), message: diagnostic.kind === "stale" ? "本轮记账因来源变化未采用，当前账本尚未跟上最新剧情。" : "本轮自动记账失败，当前账本尚未跟上最新剧情；旧快照与用户编辑保留。" };
 return { ...base, status: "pending", message: "本轮账本尚未完成整理，当前内容可能仍是上一份快照。" };
}

/** Complete only the ledger domain; never manufacture success for other settlement routes. */
export function ledgerCompletionReceipt(branch: BranchEntryLike[], sourceEntryId: string, origin: "user-confirmed" | "scribe-retry") {
 const checkpoint = object([...branch].reverse().find(e => e.customType === "rp-turn-settlement" && object(e.data).narrativeEntryId === sourceEntryId)?.data);
 const degradedDomains = Array.isArray(checkpoint.degradedDomains) ? checkpoint.degradedDomains.filter(x => x !== "ledger") : [];
 const complete = checkpoint.worldDone === true && checkpoint.ecologyDone === true && checkpoint.presentationDone === true;
 return { ...checkpoint, version: 1, narrativeEntryId: sourceEntryId, ledgerDone: true, ledgerOrigin: origin, degradedDomains,
  status: !complete ? "pending" : degradedDomains.length ? "degraded" : "complete" };
}
export interface LedgerConfirmationExpected { sessionId: string; card: string; sourceEntryId: string; revision: string }
/** Explicit human review, not a model-success receipt. No story/other-domain facts are fabricated. */
export function planLedgerConfirmation(branch: BranchEntryLike[], sourceEntryId: string, revision: string, patch: Record<string, unknown>) {
 const status = ledgerStatusFromBranch(branch);
 if (!status.canConfirm || status.status === "current" || status.sourceEntryId !== sourceEntryId || status.revision !== revision)
  throw Object.assign(new Error("正文或账本已变化，请刷新并重新核对后确认"), { statusCode: 409 });
 if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("缺少有效账本 patch");
 const result = applyPatch(stateFromBranch(branch), patch);
 if (result.warnings.length) throw new Error(`账本补丁未采用：${result.warnings.join("；")}`);
 return { result, state: { ...result.state, _diagnosticSourceEntryId: sourceEntryId, _ledgerOrigin: "user-confirmed" },
  diagnostic: { version: 1, sourceEntryId, stage: "scribe", kind: "applied", origin: "user-confirmed" },
  settlement: ledgerCompletionReceipt(branch, sourceEntryId, "user-confirmed") };
}
