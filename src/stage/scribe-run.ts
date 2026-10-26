/**
 * 场记调度（PLAN-RP-HARNESS M3，R8 记账独占 + R9 叶守卫）。
 *
 * 定稿之后一次旁路调用：读【当前账本 + 本拍对白】→ 出 patch → applyPatch →
 * rp-state 快照落树。台上零世界写入工具，主演只通过正文（含状态栏）表达状态变化。
 *
 * 叶守卫：旁路调用是异步的，期间用户可能 swipe/rewind/切世界线。落树前核对叶位置，
 * 变了就整体丢弃本次记账——快照绝不能写到导航后的分支上（8/02 账本泄漏事故的结构性解法）。
 * 丢弃是安全的：账本 = f(分支)（R4），新分支自会从它自己的最近快照重建。
 *
 * 纯函数 + 注入依赖，零 pi 依赖、可单测。
 */

import { isProviderContentRejection } from "./model-failure.ts";
import { applyPatch, canonicalizeCharacterKeys, saveState } from "../state.ts";
import { buildScribeTurnPrompt, parseScribeResult } from "../scribe.ts";
import type { WorldState } from "../types.ts";

/** 场记快照的会话树条目类型（CustomEntry，不进 LLM 上下文） */
export const STATE_ENTRY_TYPE = "rp-state";

export interface ScribeRunDeps {
	/** 旁路文本调用：返回文本，或 {error} */
	sideText: (systemPrompt: string, userText: string) => Promise<string | { error: string }>;
	/** 记账落树（CustomEntry：data 存整份账本快照） */
	appendStateEntry: (state: WorldState) => void;
	/** 叶守卫读数：调用前后各取一次，不等则丢弃 */
	getLeafId: () => string | null;
	/** 宿主可区分纯会话元数据推进与真实切支；缺省保持严格叶 ID 比较。 */
	isLeafStable?: (anchorId: string | null) => boolean;
	/** 磁盘缓存路径（.liyuan-state/<sessionId>.json）；给出则落盘（server fs.watch → state 帧） */
	stateFile?: string;
	onActivity?: (detail: string) => void;
	identityHints?: Record<string, string>;
}

export interface ScribeRunInput {
	trustedNarrative?: boolean;
	strictPatch?: boolean;
	/** 本拍开演前的账本（= f(分支)） */
	state: WorldState;
	userText: string;
	/** 本拍定稿正文（补丁已套） */
	assistantText: string;
	charName: string;
	userName: string;
}

export type ScribeRunOutcome =
	| { kind: "skipped"; reason: string }
	| { kind: "stale" }
	| { kind: "failed"; error: string }
	| { kind: "applied"; state: WorldState; applied: string[] };

/**
 * 一拍记账。调用方保证：只对干净收笔的台上拍调用（中断半拍/戏外轮不记账）。
 * 失败保留已保存正文及旧账本；宿主保持 pending，供应商内容拒绝不自动重试。
 */
export async function runScribeTurn(deps: ScribeRunDeps, input: ScribeRunInput): Promise<ScribeRunOutcome> {
	const { state, userText, assistantText, charName, userName } = input;
	if (!assistantText.trim()) return { kind: "skipped", reason: "no-text" };

	const leafBefore = deps.getLeafId();
	const prompt = buildScribeTurnPrompt({ state, userText, assistantText, charName, userName, identityHints: deps.identityHints, trustedNarrative: input.trustedNarrative });
	const resp = await deps.sideText(prompt.systemPrompt, prompt.userText);
	// R9 叶守卫：调用期间树动过（swipe/rewind/切线）→ 整体丢弃
	if (!(deps.isLeafStable?.(leafBefore) ?? (deps.getLeafId() === leafBefore))) {
		deps.onActivity?.("记账已丢弃（本拍期间切换了分支）");
		return { kind: "stale" };
	}

	if (typeof resp !== "string") return { kind: "failed", error: resp.error };

	if (isProviderContentRejection(resp)) return { kind: "failed", error: `场记请求被供应商安全策略拒绝：${resp.trim().slice(0, 240)}` };

	const parsed = parseScribeResult(resp, {strictPatch: input.strictPatch});
	if (!parsed) {
		if (input.strictPatch) return { kind: "failed", error: "场记账本补丁 JSON 无法解析，原账本保留" };
		// 短响应直接给全文（多半是格式跑偏）；长响应给尾部（多半是 maxTokens 截断）
		const flat = resp.trim().replace(/\s+/g, " ");
		const detail = flat.length <= 400 ? flat : `…${flat.slice(-160)}`;
		return { kind: "failed", error: `输出不可解析（${resp.length} 字）：${detail}` };
	}
	if (Object.keys(parsed.patch).length === 0) return { kind: "skipped", reason: "empty-patch" };


	const knownNames = [charName, userName, ...Object.keys(state.characters)];
	const result = applyPatch(state, protectKnownCharacterIdentity(canonicalizeCharacterKeys(parsed.patch, knownNames), deps.identityHints));
	if (input.strictPatch && (result.warnings.length || !result.applied.length)) return { kind: "failed", error: "场记补丁 JSON/schema 无效，未修改账本" };
	deps.appendStateEntry(result.state);
	if (deps.stateFile) {
		try {
			saveState(deps.stateFile, result.state);
		} catch {
			// 缓存写失败不影响树上快照（账本权威在树，磁盘只是缓存）
		}
	}
	if (result.applied.length > 0) deps.onActivity?.(`记账 ${summarizeApplied(result.applied)}`);
	return { kind: "applied", state: result.state, applied: result.applied };
}

/** 过程条用的记账摘要：条数 + 前两条中文化字段名 */
function summarizeApplied(applied: string[]): string {
	const label = (s: string): string => {
		if (s.startsWith("time")) return "时间";
		if (s.startsWith("location")) return "地点";
		if (s.startsWith("characters.")) return s.slice("characters.".length).split(" ")[0];
		if (s.startsWith("flags.")) return s.slice("flags.".length).split(" ")[0];
		if (s.startsWith("inventory")) return "物品";
		if (s.startsWith("plot_threads")) return "剧情线";
		return s.split(" ")[0];
	};
	const names = [...new Set(applied.map(label))];
	const shown = names.slice(0, 3).join("、");
	return names.length > 3 ? `${shown} 等 ${names.length} 项` : shown;
}

export function protectKnownCharacterIdentity(patch: Record<string, unknown>, identityHints: Record<string, string> | undefined): Record<string, unknown> {
	if (!identityHints || !patch.characters || typeof patch.characters !== "object" || Array.isArray(patch.characters)) return patch;
	const characters = { ...(patch.characters as Record<string, unknown>) };
	for (const [name, value] of Object.entries(characters)) {
		const hint = identityHints[name];
		if (!hint || !/家族|贵族|挚友|朋友|小姐|夫人/u.test(hint) || !value || typeof value !== "object" || Array.isArray(value)) continue;
		const next = { ...(value as Record<string, unknown>) };
		for (const field of ["status", "notes"] as const) {
			if (typeof next[field] === "string") next[field] = next[field].replace(/塞勒尼斯家(?:族)?女仆|女仆|侍女/gu, "").replace(/\s{2,}/g, " ").trim();
		}
		characters[name] = next;
	}
	return { ...patch, characters };
}

export function repairKnownCharacterIdentityState(state: WorldState, identityHints: Record<string, string> | undefined): { state: WorldState; changed: boolean } {
	if (!identityHints) return { state, changed: false };
	let changed = false;
	const characters = { ...state.characters };
	for (const [name, current] of Object.entries(characters)) {
		const hint = identityHints[name];
		if (!hint || !/家族|贵族|挚友|朋友|小姐|夫人/u.test(hint)) continue;
		const next = { ...current };
		for (const field of ["status", "notes"] as const) {
			if (typeof next[field] === "string") {
				const repaired = next[field].replace(/塞勒尼斯家(?:族)?女仆|女仆|侍女/gu, "").replace(/\s{2,}/g, " ").trim();
				if (repaired !== next[field]) { next[field] = repaired; changed = true; }
			}
		}
		characters[name] = next;
	}
	return changed ? { state: { ...state, characters }, changed } : { state, changed: false };
}
