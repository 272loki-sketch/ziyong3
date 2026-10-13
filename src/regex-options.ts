/**
 * 梨园内置的全局行动选项识别契约。
 * 这是一个严格的结构化渲染器，不是对角色卡/预设正文执行的通用全局替换。
 * 调用方只应在叙事显示层使用 range；不得把移除标签后的文本写回消息、rpNarrative 或作者原稿。
 */
export const GLOBAL_ACTION_OPTIONS_RULE = Object.freeze({
	id: "liyuan.global.action-options.v1",
	scope: "global" as const,
	name: "行动选项卡",
	openTag: "<options>",
	closeTag: "</options>",
	maxInputChars: 250_000,
	maxOptions: 32,
	maxOptionChars: 160,
});

export type GlobalActionOptionsResult =
	| { status: "absent" }
	| { status: "invalid"; reason: string }
	| { status: "valid"; options: string[]; start: number; end: number };

const OPTION_TAG_TOKEN = /<\/?options\b[^>]*>/gi;
const LIST_PREFIX = /^\s*(?:(?:\d{1,2}\s*[.)、])|[-*•])\s*/;

/**
 * 只解析一个、无属性、非嵌套的精确 <options>...</options> 块。
 * 内容只按纯文本行处理；返回的选项适合交给 React text node 展示，不返回 HTML。
 */
export function parseGlobalActionOptions(text: string): GlobalActionOptionsResult {
	if (typeof text !== "string" || !text) return { status: "absent" };
	if (text.length > GLOBAL_ACTION_OPTIONS_RULE.maxInputChars) {
		return { status: "invalid", reason: "消息超过全局行动选项解析上限" };
	}

	const tokens = [...text.matchAll(OPTION_TAG_TOKEN)];
	if (tokens.length === 0) return { status: "absent" };
	if (tokens.length !== 2) return { status: "invalid", reason: "仅支持单个完整的 <options> 区块" };

	const [open, close] = tokens;
	if (open[0] !== GLOBAL_ACTION_OPTIONS_RULE.openTag || close[0] !== GLOBAL_ACTION_OPTIONS_RULE.closeTag
		|| open.index === undefined || close.index === undefined || open.index >= close.index) {
		return { status: "invalid", reason: "行动选项标签必须是无属性的 <options>...</options>" };
	}

	const start = open.index;
	const end = close.index + close[0].length;
	const body = text.slice(start + open[0].length, close.index);
	if (/[<>]/.test(body)) return { status: "invalid", reason: "选项内容只接受纯文本，不解析 HTML 或嵌套标签" };

	const lines = body.split(/\r?\n/).map((line) => line.replace(LIST_PREFIX, "").trim()).filter(Boolean);
	if (lines.length === 0) return { status: "invalid", reason: "行动选项区块为空" };
	if (lines.length > GLOBAL_ACTION_OPTIONS_RULE.maxOptions) {
		return { status: "invalid", reason: `行动选项最多 ${GLOBAL_ACTION_OPTIONS_RULE.maxOptions} 条` };
	}
	if (lines.some((line) => line.length > GLOBAL_ACTION_OPTIONS_RULE.maxOptionChars)) {
		return { status: "invalid", reason: `单条行动选项最多 ${GLOBAL_ACTION_OPTIONS_RULE.maxOptionChars} 字` };
	}
	return { status: "valid", options: lines, start, end };
}

/** 显示层辅助：只在 parser 成功时隐藏标签块；调用方必须保留并持久化原始 text。 */
export function hideGlobalActionOptionsBlockForDisplay(text: string, parsed = parseGlobalActionOptions(text)): string {
	return parsed.status === "valid" ? text.slice(0, parsed.start) + text.slice(parsed.end) : text;
}

/** 将按钮选择交给现有主输入回调，不发送请求，也不接触故事状态。 */
export function dispatchGlobalActionOption(option: string, onSelectOption?: (text: string) => void): boolean {
	if (!onSelectOption || typeof option !== "string") return false;
	const value = option.trim();
	if (!value || value.length > GLOBAL_ACTION_OPTIONS_RULE.maxOptionChars || /[<>]/.test(value)) return false;
	onSelectOption(value);
	return true;
}
