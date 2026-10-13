/** 双模式的单一正文所有者。专家调用由主 Agent 发起，但固定阶段由收据门禁保证。 */
import { RESEARCH_READS } from "../research/session.ts";
import { AUTHOR_RECOVERY_CONTRACT, isAuthorTransportTimeout, parseAuthorRecoveryReceipt } from "./author-recovery.ts";
import { isNativeToolsUnsupported } from "./model-failure.ts";
import { applyDraftEdits } from "../draft.ts";
import type { AssistantMsgLike, StageStreamEvent } from "./engine.ts";
import type { StageTool } from "./tools.ts";
import type { DirectorPhase, DirectorTask, DirectorReport } from "./agent-director.ts";
import { DIRECTOR_ROLES, formatDirectorReports } from "./agent-director.ts";
import type { GenerationMode, GenerationWorkflow } from "./generation-mode.ts";

type Message = Record<string, unknown>;
export interface AgentTurnOptions {
	mode: GenerationMode;
	systemPrompt: string;
	messages: unknown[];
	readTools: StageTool[];
	directorPrompt: string;
	stream: (context: { systemPrompt: string; messages: unknown[]; tools?: StageTool[] }, signal?: AbortSignal) => AsyncIterable<StageStreamEvent> & { result(): Promise<AssistantMsgLike>; requestBudget?: { requestedMaxTokens: number; actualMaxTokens?: number } };
	read: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string; isError?: boolean }>;
	experts: (phase: DirectorPhase, tasks: DirectorTask[], draft?: string, signal?: AbortSignal) => Promise<DirectorReport[]>;
	signal?: AbortSignal;
	isCurrent: () => boolean;
	onDelta?: (text: string, reset: boolean) => void;
	onThinking?: (text: string) => void;
	onResync?: (text: string) => void;
	onActivity?: (text: string) => void;
	toolsSupported?: boolean;
	timeoutMs?: number;
	/** Engine strict default; legacy library callers may explicitly keep degraded delivery. */
	allowDegraded?: boolean;
	normalizeNarrative?: (text: string) => string;
	outputRecoveryPrompt?: string;
	toolProtocolRecoveryPrompt?: string;
}
export interface AgentTurnResult {
	narrative: string;
	authorDraft: string;
	final: AssistantMsgLike | null;
	aborted: boolean;
	error?: string;
	workflow: GenerationWorkflow;
}
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): StageTool => ({ name, description, parameters: { type: "object", properties, required } });
const FLOW_TOOLS: StageTool[] = [
	tool("get_draft", "读取当前尚未定稿的稿件。"),
	tool("consult_experts", "执行当前固定专家阶段。tasks 包含本阶段所有岗位各一次，返回报告，不修改正文。", { tasks: { type: "array", items: { type: "object", properties: { role: { type: "string" }, task: { type: "string" } }, required: ["role", "task"] } } }, ["tasks"]),
	tool("begin_narrative", "开始正文通道；下一次普通文本一次交付完整正文及原始启用材料要求的适用附属格式，作为草稿。"),
	tool("begin_revision", "开始修订通道；下一次普通文本一次交付完整正文及原始启用材料要求的适用附属格式，替换尚未定稿的完整草稿。"),
	tool("apply_draft_edits", "定点修改尚未定稿的草稿。每项 old 必须唯一匹配；任何一项失败整批不套用。", { edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] } } }, ["edits"]),
	tool("finalize", "将当前草稿定稿。需固定阶段收据。专家审阅失败时只有明确 acceptDegraded=true 才可降级交付；不要求修订。", { acceptDegraded: { type: "boolean" } }),
];
const AUTHOR_DELIVERY_CONTRACT = "【作者交付合同】普通文本是输出载体，不是仅交纯正文。进入正文或修订通道时，按当前启用的原始角色卡、预设和世界书，本轮一次交付完整正文及适用附属格式；标签、顺序和位置由原材料决定，不另设格式名单，不等待拍后检查或补交。本合同不改变准备阶段的报告、任务简报、定稿决策或输出恢复回执协议。";
const now = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const textOf = (msg: AssistantMsgLike | null): string => (msg?.content ?? []).filter(x => x.type === "text").map(x => x.text ?? "").join("");
type AgentPhase = "evidence" | "ideas" | "ready" | "writing" | "review" | "decision" | "revision" | "finished";
const cancelled = (o: AgentTurnOptions) => o.signal?.aborted === true || !o.isCurrent();
const textualProtocol = (value: string) => /^\s*(?:<tool_call>|<function_call>|<\|?DSML\|?|<｜DSML｜|(?:draft_append|draft_write|consult_experts|finalize)\s*\()/i.test(value)
	|| /<(?:tool_call|function_call)>\s*\{[\s\S]*?"(?:name|arguments)"\s*:/i.test(value);
/** Structural incompleteness, not a word/style blacklist. Only the author continues it. */
export function narrativeNeedsCompletion(text:string,stopReason?:string):boolean {
	if(stopReason==="length")return true;
	return [["“","”"],["「","」"],["『","』"]].some(([open,close])=>text.split(open).length>text.split(close).length);
}

/** Conservative markup boundary, not a card schema or required-format check. */
export function authorDraftHasUnclosedContainer(text: string): boolean {
 const ignoredHtml = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr|html|head|body|p|li|dt|dd|rt|rp|optgroup|option|colgroup|thead|tbody|tfoot|tr|td|th)$/i;
 // Mask examples first so neither their openings nor their closings affect markup.
 const masked = text.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[^\n]*(?:\n|$)|$(?![\s\S]))/gm, "")
  .replace(/(`+)[^\n]*?\1/g, "").replace(/<!--(?:[\s\S]*?-->|[\s\S]*$)/g, "");
 const markup = masked.replace(/<\/?([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)(?:\s[^<>]*)?>/g, (raw, tag, offset) => {
  if (ignoredHtml.test(tag) || /\/\s*>$/.test(raw)) return "";
  if (raw.startsWith("</")) return raw;
  // Reject prose comparisons and unquoted prose masquerading as attributes.
  if (offset > 0 && !/[\s>。！？；：.!?;:]/u.test(masked[offset - 1])) return "";
  if (!/^<[^\s>]+(?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*>$/.test(raw)) return "";
  return raw;
 });
  const stack: string[] = [];
  for (const match of markup.matchAll(/<\/?([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)(?:\s[^<>]*)?>/g)) {
   const name = match[1].toLowerCase();
   if (!match[0].startsWith("</")) stack.push(name);
   else {
    const parent = stack.lastIndexOf(name);
    // A closed parent ends its children too: append-only recovery cannot repair
    // a missing child close before an already delivered parent close.
    if (parent >= 0) stack.length = parent;
   }
  }
  return stack.length > 0;
}

export async function runAgentTurn(o: AgentTurnOptions): Promise<AgentTurnResult> {
	const originalSignal = o.signal;
	const deadline = AbortSignal.timeout(Math.max(1, Math.min(7200_000, o.timeoutMs ?? (o.mode === "director" ? 3600_000 : 1800_000))));
	o = { ...o, signal: originalSignal ? AbortSignal.any([originalSignal, deadline]) : deadline };
	const workflow: GenerationWorkflow = { version: 1, mode: o.mode, stages: [], writerRounds: 0, toolFallback: o.toolsSupported === false };
	const convo: unknown[] = [...o.messages];
	let final: AssistantMsgLike | null = null, draft = "", revisionDraft = "", error: string | undefined;
	let nativeProtocolRetries = 0;
    let researchCalls = 0;
    const compactResearchHistory = () => {
        const rows = convo.filter((m: any) => m?.role === "toolResult" && (RESEARCH_READS.has(m.toolName) || m.toolName === "research_record")) as Message[];
        for (const row of rows.slice(0, -4)) {
            const content = row.content as Array<{ type: string; text?: string }>;
            const text = content?.[0]?.text;
            if (!text || text.length < 600) continue;
            try {
                const receipt = JSON.parse(text);
                if (receipt.compacted) continue;
                row.content = [{ type: "text", text: JSON.stringify({ kind: "research-history-reference", compacted: true, question_id: receipt.question_id,
                    evidence_ids: receipt.evidence_ids ?? receipt.evidence?.map((e: any) => e.id), stop: receipt.stop,
                    receipt_available: "research_record.read", ...(row.toolName === "web_research" ? { candidates: (receipt.results ?? []).map((r: any) => ({ url: r.url, title: r.title })) } : {}) }) }];
            } catch { /* errors stay as original bounded text */ }
        }
    };
 let transportRetries = 0;
 const failedRecoveryReplies: Message[] = [];
	let failedReview = false, completionAttempts = 0, completionPending = false, completionBuffer = "";
	const mainThoughts: string[] = [];
 const recoveryMaterials: string[] = [];
 let requestBudget: { requestedMaxTokens: number; actualMaxTokens?: number } | undefined;
	let phase: AgentPhase = o.mode === "director" ? "evidence" : "writing";
	const isPhase = (...values: AgentPhase[]) => values.includes(phase);
	const readNames = new Set(o.readTools.map(x => x.name));
	const normalizeDraft = (text:string) => o.normalizeNarrative ? o.normalizeNarrative(text) : text;
 const completionReason = (text: string, stopReason?: string) => stopReason === "length" ? "provider-length" as const
  : authorDraftHasUnclosedContainer(text) ? "unclosed-container" as const
  : narrativeNeedsCompletion(normalizeDraft(text)) ? "unclosed-dialogue" as const : undefined;
	const receipts = (stage: GenerationWorkflow["stages"][number]["stage"], status: GenerationWorkflow["stages"][number]["status"], calls: number) => workflow.stages.push({ stage, status, calls });
	const exactEdits = (edits: unknown): boolean => Array.isArray(edits) && edits.length > 0 && edits.every(e => { if (!e || typeof e.old !== "string" || !e.old || typeof e.new !== "string") return false; const at = draft.indexOf(e.old); return at >= 0 && draft.indexOf(e.old, at + 1) < 0; });
	const canFinalize = () => o.mode === "direct" || workflow.stages.some(x => x.stage === "review");
	const protocol = (): string => {
		if (phase === "evidence" || phase === "ideas" || phase === "review") return `【流程阶段】${phase}。本阶段岗位：${DIRECTOR_ROLES[phase].join(" / ")}。使用 consult_experts，tasks 为这些岗位各一项；所有结果均是报告。`;
		if (phase === "ready") return "【流程阶段】资料阶段完成。用 begin_narrative 切入正文通道。";
		if (phase === "decision") return "【流程阶段】审阅已完成。无需修改可 finalize；修改可 apply_draft_edits 或 begin_revision。";
		return "";
	};
	if (o.mode === "director") { const input = convo.pop(); convo.push(now(`${o.directorPrompt}\n\n${protocol()}`)); if (input) convo.push(input); }

	async function owned<T>(promise: Promise<T>): Promise<T> {
		if (cancelled(o)) { void promise.catch(() => undefined); throw new Error("本拍取消、超时或分支改变"); }
		return await new Promise<T>((resolve, reject) => {
			const stop = () => { cleanup(); reject(new Error("本拍取消、超时或分支改变")); };
			const watch = setInterval(() => { if (cancelled(o)) stop(); }, 100);
			const cleanup = () => { clearInterval(watch); o.signal?.removeEventListener("abort", stop); };
			o.signal?.addEventListener("abort", stop, { once: true });
			promise.then(value => { cleanup(); if (cancelled(o)) reject(new Error("迟到结果未采用")); else resolve(value); }, err => { cleanup(); reject(err); });
		});
	}

 function draftContextMessage(text: string): Message {
  // This is a context projection of the accepted draft, not another billable
  // model response. A full assistant shape is required by SDK token accounting.
  return { ...(final ?? {}), role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
   usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
 }
	async function request(tools: StageTool[] | undefined, narrative: boolean, recovery = false): Promise<{ message: AssistantMsgLike | null; text: string; error?: string }> {
		if (cancelled(o)) return { message: null, text: "", error: "本拍已取消或分支改变" };
  if (workflow.writerRounds >= (o.mode === "director" ? 24 : 8)) return { message: null, text: "", error: "主 Agent达到流程轮数预算，保留未完成草稿" };
		workflow.writerRounds++;
		const priorDraft = narrative ? (phase === "writing" ? draft + (completionPending ? completionBuffer : "") : phase === "revision" ? revisionDraft : "") : "";
		let text = "", thought = "", message: AssistantMsgLike | null = null, failure: string | undefined;
  requestBudget = undefined;
		try {
			// A continuation is not another director turn. Retain every original input,
    // delivered report/read source and draft, but do not replay control-tool
    // scaffolding or usage from a different context into SDK token calibration.
    const latestInstruction = [...convo].reverse().find((m: any) => m?.role === "user");
    const originalMessages = recovery ? o.messages.map((m: any) => m?.role === "assistant" ? { ...m, usage: (draftContextMessage("").usage) } : m) : o.messages;
     compactResearchHistory();
     const messages = recovery ? [...originalMessages, ...recoveryMaterials.map(now), draftContextMessage(draft), ...failedRecoveryReplies, ...(latestInstruction ? [latestInstruction] : []), now(AUTHOR_RECOVERY_CONTRACT)] : convo;
    const systemPrompt = `${o.systemPrompt}\n\n${AUTHOR_DELIVERY_CONTRACT}`;
     const stream = o.stream({ systemPrompt: recovery ? `${systemPrompt}\n\n${o.outputRecoveryPrompt ?? ""}\n\n${AUTHOR_RECOVERY_CONTRACT}` : systemPrompt, messages, ...(tools?.length ? { tools } : {}) }, o.signal);
    requestBudget = stream.requestBudget;
			const iterator = stream[Symbol.asyncIterator]();
			try { while (true) {
				const next = await owned(iterator.next()); if (next.done) break; const event = next.value;
				if (cancelled(o)) break;
				if (event.type === "text_delta" && event.delta) {
					const first = text.length === 0; text += event.delta;
					if (narrative) o.onDelta?.(event.delta, first && !priorDraft);
				} else if (event.type === "thinking_delta" && event.delta) { thought += event.delta; o.onThinking?.(event.delta); }
				else if (event.type === "done") message = event.message ?? null;
				else if (event.type === "error") { message = event.error ?? null; failure = message?.errorMessage || "主演请求失败"; break; }
			}
			} finally { void Promise.resolve(iterator.return?.()).catch(() => undefined); }
			if (!message && !cancelled(o) && !failure) failure = "主演流未返回最终消息";
			if (!text && message && !cancelled(o)) { text = textOf(message); if (narrative && text) o.onDelta?.(text, !priorDraft); }
			if (!thought && message && !cancelled(o)) { thought = message.content.filter(x => x.type === "thinking").map(x => x.thinking ?? "").join(""); if (thought) o.onThinking?.(thought); }
			if (message?.stopReason === "error") failure = message.errorMessage || "主演请求失败";
			if (message?.stopReason === "aborted") failure = message.errorMessage || "主演请求中断";
		} catch (err) { failure = err instanceof Error ? err.message : String(err); }
		if (thought) mainThoughts.push(thought);
		if (textualProtocol(text) || (message?.stopReason === "toolUse" && !message.content.some(item => item.type === "toolCall"))) { failure = "API返回文本化工具协议或空工具调用，未作为正文接收"; text = ""; if (narrative) o.onResync?.(priorDraft); }
		if (narrative && (cancelled(o) || failure) && text.trim()) draft = priorDraft + text;
  const usage = message?.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : undefined;
  (workflow.writerCalls ??= []).push({ round: workflow.writerRounds, phase: recovery ? "recovery" : phase, textChars: text.length,
   ...(message?.stopReason ? { stopReason: String(message.stopReason) } : {}),
   ...(typeof usage?.input === "number" ? { inputTokens: usage.input } : {}), ...(typeof usage?.output === "number" ? { outputTokens: usage.output } : {}),
   ...(requestBudget ? { requestedMaxTokens: requestBudget.requestedMaxTokens, ...(requestBudget.actualMaxTokens !== undefined ? { actualMaxTokens: requestBudget.actualMaxTokens } : {}) } : {}) });
		return { message, text, ...(failure ? { error: failure } : {}) };
	}

  function beginCompletion(stopReason?: string, interrupted = false): void {
   const reason = interrupted ? "transport-interrupted" : completionReason(draft, stopReason)!;
   failedRecoveryReplies.length = 0;
  workflow.recovery ??= { reason, status: "pending", attempts: 0, invalidReceipts: 0 };
  workflow.recovery.status = "pending";
  completionPending = true;
  convo.push(now((o.outputRecoveryPrompt ?? "【输出恢复】") + "\n" + JSON.stringify({ reason, draftIsPartial: true, operation: "continue_narrative", tail: draft.slice(-800) })));
   o.onActivity?.(reason === "transport-interrupted" ? "作者暂态传输超时：正在接续同一拍已收到的原稿" : reason === "provider-length" ? "主作者响应标记 length：正在接续同一拍未完成正文" : reason === "unclosed-container" ? "原作者容器未闭合：正在接续同一拍完整原稿" : "正文对白未闭合：正在接续同一拍原稿");
 }
 async function recoverDraft(): Promise<boolean> {
  const recovery = workflow.recovery!;
  for (let attempt = 0; attempt < 2; attempt++) {
   recovery.attempts++;
   const repair = await request(undefined, false, true); final = repair.message ?? final;
   if (repair.error) { error = repair.error; recovery.status = "failed"; return false; }
   const parsed = parseAuthorRecoveryReceipt(repair.text);
   const invalid = repair.message?.stopReason === "length" ? "truncated-receipt"
    : parsed.ok === false ? parsed.reason : textualProtocol(parsed.suffix) ? "textual-protocol" : draft.length > 0 && parsed.suffix.startsWith(draft) ? "duplicate-draft" : undefined;
   if (invalid) {
    recovery.invalidReceipts++; recovery.lastValidation = invalid;
    o.onActivity?.(`主作者输出恢复回执校验失败（${invalid}）${attempt === 0 ? "，同一作者有界重试" : "，原稿保留未完成"}`);
    if (attempt === 0) {
      // Keep one bounded failed receipt in the actual retry context, not in draft.
      failedRecoveryReplies.push(draftContextMessage(repair.text.slice(0, 12000)));
     convo.push(now((o.outputRecoveryPrompt ?? "【输出恢复】") + "\n" + JSON.stringify({ operation: "continue_narrative", validation_errors: [invalid], partialDraftIsUnchanged: true, tail: draft.slice(-800) })));
     continue;
    }
    error = `主作者输出恢复回执无效（${invalid}），两次校验均未通过；保留未完成原稿，不捏造续写`;
    recovery.status = "failed"; return false;
   }
   if (!parsed.ok) throw new Error("unreachable recovery validation");
   // Preserve the original author's source, including closing wrappers. Normalize
   // the complete draft only, never strip the receipt's leading space or tags.
   draft += parsed.suffix;
    const remaining = completionReason(draft);
    if (remaining) {
     recovery.lastValidation = remaining;
     error = "主作者接续后原稿容器或对白仍未闭合，保留未完成稿，不冒称定稿";
    recovery.status = "failed"; return false;
   }
   if (repair.message) convo.push({ ...repair.message, content: [{ type: "text", text: draft }] });
   completionPending = false; completionBuffer = ""; recovery.status = "success";
   o.onResync?.(draft); o.onActivity?.("原作者输出恢复完成，回到原拍审阅／定稿流程");
   return true;
  }
  return false;
 }

 async function requestWriting(tools: StageTool[] | undefined): Promise<Awaited<ReturnType<typeof request>> & { recovered?: boolean }> {
  let result = await request(tools, true);
  if (!result.error || cancelled(o) || result.message?.stopReason === "aborted" || !isAuthorTransportTimeout(result.error) || transportRetries >= 1) return result;
  // A partial draft must never be regenerated by replaying the writing request.
  if (draft) {
   if (!o.outputRecoveryPrompt) return result;
   transportRetries++;
   final = result.message ?? final;
   beginCompletion(undefined, true);
   const recovered = await recoverDraft();
   return { message: final, text: "", ...(recovered ? { recovered: true } : { error: error ?? result.error }) };
  }
  transportRetries++;
  o.onActivity?.("作者暂态传输超时且未收到正文：同一作者有界重试一次");
  result = await request(tools, true);
  return result;
 }

	async function batch(p: DirectorPhase, tasks: DirectorTask[]): Promise<string> {
		const roles = DIRECTOR_ROLES[p];
		if (tasks.length !== roles.length || roles.some(role => tasks.filter(task => task.role === role).length !== 1)) return `未执行：本阶段必须恰好包含 ${roles.join(" / ")} 各一次。`;
		const rawResults = await owned(o.experts(p, tasks, p === "review" ? draft : undefined, o.signal));
		const results = roles.map(role => {
			const matches = rawResults.filter(report => report.role === role);
			return matches.length === 1 && ["success", "degraded", "failed"].includes(matches[0].status)
				? matches[0] : { role, status: "failed" as const, summary: "岗位回执缺失或重复，未当成成功。", facts: [], inferences: [], candidates: [], issues: [] };
		});
		if (p === "review") failedReview = results.some(report => report.status === "failed");
		if (cancelled(o)) throw new Error("专家结果已丢弃：回合取消或分支改变");
		receipts(p, results.some(x => x.status === "failed") && o.allowDegraded === false ? "failed" : results.some(x => x.status !== "success") ? "degraded" : "success", roles.length);
		if (o.allowDegraded === false && results.some(x => x.status === "failed")) throw new Error(`固定${p}阶段仍有失败岗位：${results.filter(x => x.status === "failed").map(x=>x.role).join("、")}。已诊断并尝试恢复，未跳过进入下一阶段。`);
		phase = p === "evidence" ? "ideas" : p === "ideas" ? "ready" : "decision";
		o.onActivity?.(`${p === "evidence" ? "固定资料分析" : p === "ideas" ? "双角度构思" : "固定成稿审阅"}${results.some(x => x.status !== "success") ? "已结束（部分报告降级）" : "已完成"}`);
  const deliveredReport = formatDirectorReports(results);
  recoveryMaterials.push(deliveredReport);
		return `${deliveredReport}\n\n${protocol()}`;
	}

	async function plainFallback(reason: "configured" | "unsupported"): Promise<void> {
		workflow.toolFallback = true;
		workflow.toolFallbackReason = reason;
		o.onActivity?.("主演工具协议不可用：固定阶段使用文本通道接续，未切换创作模式");
		if (o.mode === "director") {
			for (const p of ["evidence", "ideas"] as const) {
				if (workflow.stages.some(x => x.stage === p)) continue;
				let tasks: DirectorTask[] = DIRECTOR_ROLES[p].map(role => ({ role, task: "依据本拍输入和来源材料完成该岗位报告。" }));
				if (p === "ideas") {
					// Preserve main ownership of angle selection even without native function tools.
					convo.push(now('【文本流程协议】当前 ideas 阶段。以 JSON 返回两份任务简报，不输出正文：{"tasks":[{"role":"idea-a","task":"角度简报"},{"role":"idea-b","task":"另一个角度简报"}]}。'));
					const planned = await request(undefined, false);
					if (planned.error || cancelled(o)) { error = planned.error; return; }
					try {
						const value = JSON.parse(planned.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
						if (!Array.isArray(value.tasks) || value.tasks.length !== 2 || DIRECTOR_ROLES.ideas.some(role => value.tasks.filter((x: DirectorTask) => x?.role === role).length !== 1)
							|| value.tasks.some((x: DirectorTask) => typeof x.task !== "string" || !x.task.trim()) || value.tasks[0].task.trim() === value.tasks[1].task.trim()) throw new Error("角度简报无效");
						tasks = value.tasks.map((x: DirectorTask) => ({ role: x.role, task: x.task.slice(0, 2000) }));
					} catch { error = "文本角度简报不可解析或岗位不完整，未执行无差别构思"; return; }
					if (planned.message) convo.push(planned.message);
				}
				convo.push(now(await batch(p, tasks)));
			}
		}
		phase = "writing";
		convo.push(now("【正文通道】资料已就绪，本轮一次交付完整正文及原始启用材料要求的适用附属格式；标签、顺序和位置遵循原材料，不等待拍后补交。"));
		const initial = await requestWriting(undefined); final = initial.message;
		if (initial.error || cancelled(o)) { error = initial.error; return; }
		if (!initial.recovered) draft = initial.text.trim(); if (!draft) { error = "主演未返回正文"; return; }
   if (completionReason(draft, initial.message?.stopReason)) {
    if (!o.outputRecoveryPrompt) { error = "原稿仍被供应商截断或容器/对白未闭合；保留未完成原稿"; return; }
   if (initial.message) convo.push(initial.message);
   beginCompletion(initial.message?.stopReason);
   if (!await recoverDraft()) return;
  }
		receipts("draft", "success", 1);
		if (o.mode === "director") {
			phase = "review";
			const reviewResult = await batch("review", DIRECTOR_ROLES.review.map(role => ({ role, task: "核对当前未定稿正文，只报告有依据的问题。" })));
			if (cancelled(o)) return;
			const previous = draft;
			convo.push(final!); convo.push(now(`【定稿决策】\n${reviewResult}\n\n只返回 JSON：无需修订时 {"decision":"keep"}，需要修订时 {"decision":"revise","edits":[{"old":"唯一原文","new":"替换文本"}]}；专家请求失败时另须显式提供 "acceptDegraded":true 才能降级交付。当前草稿：\n${draft}`));
			const decision = await request(undefined, false); final = decision.message ?? final;
			if (decision.error) { error = decision.error; return; }
			try {
				const row = JSON.parse(decision.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
				if (!["keep", "revise"].includes(row.decision)) throw new Error("无效定稿决策");
				if (failedReview && row.acceptDegraded !== true) { error = "审阅请求失败，尚未形成明确的降级定稿决策"; return; }
				if (row.decision === "revise") {
					const edited = exactEdits(row.edits) ? applyDraftEdits(draft, row.edits) : { ok: false, text: undefined };
					if (edited.ok && typeof edited.text === "string") draft = edited.text;
					else { receipts("revision", "failed", 0); error = "文本修订未通过唯一原文定位，保留原稿但不冒称已完成定稿"; return; }
				}
			} catch { error = "文本定稿决策不可解析，保持原始草稿但不冒称已定稿"; o.onActivity?.(error); return; }
			if (draft !== previous) { receipts("revision", "success", 1); o.onResync?.(draft); }
		}
		phase = "finished"; receipts("finalize", workflow.stages.some(x => x.status === "degraded") ? "degraded" : "success", 0);
	}

	try {
		if (o.toolsSupported === false) await plainFallback("configured");
		else for (let round = 0; round < (o.mode === "director" ? 24 : 8) && !cancelled(o) && phase !== "finished"; round++) {
			const writing = phase === "writing" || phase === "revision";
			if(completionPending && o.outputRecoveryPrompt) {
    if (!await recoverDraft()) break;
    receipts("draft","success",1);
				if(o.mode==="direct"){phase="finished";receipts("finalize","success",0);}else{phase="review";convo.push(now(protocol()));}
				continue;
			}
			const available = o.mode === "director" && !writing ? [...o.readTools, ...FLOW_TOOLS] : o.readTools;
			const result = phase === "writing" ? await requestWriting(available) : await request(available, writing); final = result.message ?? final;
			if (result.error) {
				if (!draft && isNativeToolsUnsupported(result.error) && !workflow.toolFallback) { await plainFallback("unsupported"); break; }
				if (result.error.includes("文本化工具协议") && nativeProtocolRetries++ < 1 && o.toolProtocolRecoveryPrompt) {
					convo.push(now(o.toolProtocolRecoveryPrompt + "\n" + JSON.stringify({ phase, error: "malformed_native_tool_protocol", toolsSupported: true })));
					o.onActivity?.("原生工具回执无效：同一API重新提交一次，不切文本协议");
					continue;
				}
				error = result.error; break;
			}
			if (cancelled(o)) break;
   if ("recovered" in result && result.recovered) {
    receipts("draft", "success", 1);
    if (o.mode === "direct") { phase = "finished"; receipts("finalize", "success", 0); }
    else { phase = "review"; convo.push(now(protocol())); }
    continue;
   }
			const calls = (result.message?.content ?? []).filter(x => x.type === "toolCall");
			if (calls.length === 0) {
				if (writing && result.text.trim()) {
					const revision: boolean = phase === "revision"; const rawDraft = revision ? revisionDraft + result.text.trim() : completionPending ? draft + completionBuffer + result.text : draft + result.text.trim(); draft = rawDraft; revisionDraft = ""; completionPending=false;completionBuffer="";
					if(completionReason(draft,result.message?.stopReason)) {
      if (!o.outputRecoveryPrompt) { error = "原稿未完成且没有输出恢复协议；保留原稿，不接受裸全文接续"; break; }
						if(completionAttempts++>=2){error="原稿仍以未闭合容器/对白或供应商截断结束；已保留未完成稿，不冒称定稿";break;}
						if(result.message)convo.push({...result.message,content:[...(result.message.content??[]).filter(x=>x.type!=="text"),{type:"text",text:rawDraft}]});
      beginCompletion(result.message?.stopReason);
						phase="writing";completionBuffer="";continue;
					}
					receipts(revision ? "revision" : "draft", "success", 1);
					if (revision) o.onResync?.(draft);
					if (o.mode === "direct") { phase = "finished"; receipts("finalize", workflow.stages.some(x => x.status === "degraded") ? "degraded" : "success", 0); }
					else { phase = revision ? "decision" : "review"; convo.push(result.message!); convo.push(now(protocol())); }
				} else { if (result.message) convo.push(result.message); convo.push(now(protocol() || "当前正文通道未收到内容。")); }
				continue;
			}
			// 正文通道中，工具前后的主 Agent文字连续保留；准备通道文字不入稿。
			if (writing && result.text) { if (phase === "revision") { revisionDraft += result.text; draft = revisionDraft; } else if(completionPending)completionBuffer+=result.text;else draft += result.text; }
			if (result.message) convo.push(result.message);
			let transitionAccepted = false;
            const sourceReadsThisRound = new Set<string>();
			for (const call of calls) {
				if (cancelled(o) || phase === "finished") break;
				const beforePhase: AgentPhase = phase;
				const name = call.name ?? "", args = call.arguments ?? {};
				let text: string;
				if (transitionAccepted && FLOW_TOOLS.some(t => t.name === name && t.name !== "get_draft")) text = "未执行：本生成轮已受理一次阶段转换，读取回执后下一轮继续。";
				else if (name === "get_draft" && o.mode === "director") text = draft;
    else if (readNames.has(name)) {
     const researching = RESEARCH_READS.has(name) || name === "research_record";
     // Reserve native rounds for the original author and the remaining fixed director transitions.
     const reserve = o.mode === "direct" ? 1 : (phase as AgentPhase) === "evidence" ? 6 : (phase as AgentPhase) === "ideas" ? 5 : (phase as AgentPhase) === "ready" ? 4 : phase === "writing" ? 3 : 1;
     if (researching && (researchCalls >= (o.mode === "direct" ? 6 : 16) || workflow.writerRounds >= (o.mode === "direct" ? 8 : 24) - reserve)) {
         text = JSON.stringify({ kind: "research-limit", stop: "limits", unresolved: "研究工具预算已到；保留未知，不再研究" });
     } else {
         if (researching) researchCalls++;
         const question = typeof args.question_id === "string" ? args.question_id : "task";
         if (name === "web_research" && sourceReadsThisRound.has(question)) {
             text = JSON.stringify({ kind: "research-deferred", question_id: question, reason: "same-response query preceded by unread source result", pending: "model must consume actual source receipt before a dependent follow-up" });
         } else {
         const source = await owned(o.read(name, args, o.signal)); text = source.text;
         if (["web_open", "canon_research", "corpus_research"].includes(name)) sourceReadsThisRound.add(question);
         if (!source.isError) { recoveryMaterials.push(source.text); if (researching && recoveryMaterials.length > 16) recoveryMaterials.splice(0, recoveryMaterials.length - 16); }
         }
     }
    }
				else if (name === "consult_experts" && o.mode === "director" && isPhase("evidence", "ideas", "review")) {
					const tasks = Array.isArray(args.tasks) ? args.tasks.map(raw => ({ role: String((raw as Record<string, unknown>)?.role ?? ""), task: String((raw as Record<string, unknown>)?.task ?? "").slice(0, 2000) })) as DirectorTask[] : [];
					text = await batch(phase as DirectorPhase, tasks);
				} else if (name === "begin_narrative" && isPhase("ready")) { phase = "writing"; text = "正文通道已开启。下一轮普通文本一次交付完整正文及原始启用材料要求的适用附属格式，作为草稿；标签、顺序和位置遵循原材料，不等待拍后补交。"; }
				else if (name === "begin_revision" && phase === "decision") { revisionDraft = ""; phase = "revision"; text = "修订通道已开启。下一轮普通文本一次交付完整正文及原始启用材料要求的适用附属格式，替换尚未定稿的完整草稿；标签、顺序和位置遵循原材料，不等待拍后补交。"; }
				else if (name === "apply_draft_edits" && phase === "decision") {
					transitionAccepted = true; // Always read the mutation receipt before deciding to finalize.
					const edited = exactEdits(args.edits) ? applyDraftEdits(draft, args.edits as never) : { ok: false, text: undefined };
					if (edited.ok && typeof edited.text === "string") { draft = edited.text; receipts("revision", "success", 0); o.onResync?.(draft); text = "定点修改已应用。"; }
					else text = "修改未受理：原文定位失败，整批保持不变。";
				} else if (name === "finalize" && phase === "decision" && draft && canFinalize()) {
					if (failedReview && args.acceptDegraded !== true) text = "专家审阅未成功；需明确 acceptDegraded=true 才能降级交付，不当作审阅通过。";
					else { phase = "finished"; receipts("finalize", workflow.stages.some(x => x.status === "degraded") ? "degraded" : "success", 0); text = "当前草稿已定稿。"; }
				}
				else text = `未执行工具 ${name}：当前阶段 ${phase}，不允许越过固定阶段或修改已定稿内容。`;
				if (phase !== beforePhase) transitionAccepted = true;
				convo.push({ role: "toolResult", toolCallId: (call as { id?: string }).id, toolName: name, content: [{ type: "text", text }], timestamp: Date.now() });
			}
		}
		if (!cancelled(o) && phase !== "finished" && !error) error = "主 Agent达到流程轮数预算，未完成固定阶段；保留未完成草稿，不冒称定稿";
	} catch (err) { error = err instanceof Error ? err.message : String(err); }
	if (deadline.aborted && !originalSignal?.aborted) error = "Agent总体时间预算耗尽，保留已写内容但不冒称定稿";
	const aborted = cancelled(o) || phase !== "finished";
 if (aborted && workflow.recovery?.status === "pending") workflow.recovery.status = "failed";
	if (draft) final = { ...(final ?? { role: "assistant", content: [] }), role: "assistant", content: [...mainThoughts.map(thinking => ({ type: "thinking", thinking })), { type: "text", text: draft }], stopReason: aborted ? "aborted" : "stop", ...(error ? { errorMessage: error } : {}) };
	return { narrative: normalizeDraft(draft), authorDraft: draft, final, aborted, ...(error ? { error } : {}), workflow };
}
