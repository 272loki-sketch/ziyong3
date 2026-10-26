/**
 * 众生侧写（内置）：正文定稿后，为镜头外的若干人物写"同一时间他们在做什么"的候选。
 * 只产出候选；采纳、校验与落树仍由鲜活生态统一处理（见 npc-ecology.ts）。
 * 纯函数：选人、提示词、解析。网络、存储与计费在宿主（server/npc-sidewrite-http.ts）。
 */
import { createHash } from "node:crypto";
import type { NpcParallelEntry } from "./npc-parallel.ts";

/** 内置实现的稳定来源标识（收据与候选封存沿用 upstreamVersion/upstreamCommit 字段）。 */
export const NPC_SIDEWRITE_VERSION = "builtin-1";
export const NPC_SIDEWRITE_COMMIT = createHash("sha1").update("liyuan-npc-sidewrite/builtin-1").digest("hex");

export interface NpcSidewriteSettings {
	enabled: boolean;
	/** 每轮最多写几人（含正文锚点人物）；0 = 不限。 */
	maxPerRound: number;
	/** 最近几轮写过的人降低权重。 */
	cooldownRounds: number;
	minWords: number;
	maxWords: number;
	/** 第三人称 / 第一人称。 */
	person: "third" | "first";
	/** 用户自定义写作要求；空 = 使用内置要求。 */
	style: string;
	/** 不参与侧写的人物。 */
	ignored: string[];
	/** 人物权重（0 = 不参与；缺省 1）。 */
	weights: Record<string, number>;
}

export const DEFAULT_NPC_SIDEWRITE_SETTINGS: NpcSidewriteSettings = {
	enabled: true, maxPerRound: 3, cooldownRounds: 3, minWords: 200, maxWords: 600, person: "third", style: "", ignored: [], weights: {},
};

const int = (value: unknown, fallback: number, min: number, max: number) => {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** 规范化用户设置；未知字段丢弃。兼容旧原插件设置里的同名字段（maxPerRound、minWords 等）。 */
export function normalizeNpcSidewriteSettings(raw: unknown): NpcSidewriteSettings {
	const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	const d = DEFAULT_NPC_SIDEWRITE_SETTINGS;
	const minWords = int(s.minWords, d.minWords, 50, 3000);
	const ignored = Array.isArray(s.ignored) ? s.ignored : Array.isArray(s.ignoredNpcs) ? s.ignoredNpcs : [];
	const weights: Record<string, number> = {};
	if (s.weights && typeof s.weights === "object" && !Array.isArray(s.weights))
		for (const [name, w] of Object.entries(s.weights as Record<string, unknown>)) if (name.trim() && name.length <= 120) weights[name.trim()] = int(w, 1, 0, 99);
	return {
		enabled: s.enabled !== false && s.autoTrigger !== false,
		maxPerRound: int(s.maxPerRound, d.maxPerRound, 0, 24),
		cooldownRounds: int(s.cooldownRounds, d.cooldownRounds, 0, 50),
		minWords,
		maxWords: Math.max(minWords, int(s.maxWords, d.maxWords, 50, 6000)),
		person: s.person === "first" ? "first" : "third",
		style: typeof s.style === "string" ? s.style.slice(0, 20000) : "",
		ignored: [...new Set(ignored.filter((n): n is string => typeof n === "string" && !!n.trim() && n.length <= 120).map(n => n.trim()))].slice(0, 200),
		weights,
	};
}

export interface NpcSidewriteCandidate { name: string; notes: string; weight: number }

/** 正文里提到次数最多的人物；当前正文没有时回看更早的正文。只是相关性，不当作已发生互动。 */
export function sidewriteAnchor(names: string[], passages: string[]): string | undefined {
	for (const passage of passages) {
		let best: { name: string; count: number } | undefined;
		for (const name of names) {
			if (name.trim().length < 2) continue;
			const count = passage.split(name).length - 1;
			if (count > 0 && (!best || count > best.count)) best = { name, count };
		}
		if (best) return best.name;
	}
}

/**
 * 选人：锚点人物必选；其余按权重无放回抽样，最近 cooldownRounds 轮写过的人权重 ×0.3。
 * random 可注入以便测试。
 */
export function pickSidewriteTargets(roster: NpcSidewriteCandidate[], settings: NpcSidewriteSettings, history: string[][], anchor?: string, random: () => number = Math.random): string[] {
	const pool = roster.filter(n => n.weight > 0);
	const chosen: string[] = [];
	if (anchor && pool.some(n => n.name === anchor)) chosen.push(anchor);
	const limit = settings.maxPerRound > 0 ? settings.maxPerRound : pool.length;
	const cooling = new Set(settings.cooldownRounds > 0 ? history.slice(-settings.cooldownRounds).flat() : []);
	let rest = pool.filter(n => !chosen.includes(n.name));
	while (chosen.length < limit && rest.length) {
		const weights = rest.map(n => n.weight * (cooling.has(n.name) ? 0.3 : 1));
		const total = weights.reduce((a, b) => a + b, 0);
		if (total <= 0) break;
		let r = random() * total, index = rest.length - 1;
		for (let i = 0; i < rest.length; i++) { r -= weights[i]; if (r <= 0) { index = i; break; } }
		chosen.push(rest[index].name);
		rest = rest.filter((_, i) => i !== index);
	}
	return chosen;
}

const DEFAULT_STYLE = [
	"说人话：用词浅白，句子短，动作与对话为主，环境描写不超过两句。",
	"每段开头一行写清时间、地点、场合；可以跨场景，用一句话带过切换。",
	"允许写视角人物的内心，内心要给出外在言行没说出的东西；不写主角的内心，其他人只写外在言行。",
	"约七成写他这一时段真实的工作与生活，约三成自然长出与主线有关的小萌芽；什么都没发生、只是状态变了也可以。",
	"不复述主正文，不升华，不说教，不用 Markdown。",
].join("\n");

export interface NpcSidewritePromptInput {
	targets: Array<{ name: string; notes: string; previous?: string }>;
	narrative: string;
	userName: string;
	settings: NpcSidewriteSettings;
}

/** 一次请求写完全部选中人物。 */
export function buildSidewritePrompt(input: NpcSidewritePromptInput): { systemPrompt: string; userText: string; maxTokens: number } {
	const { settings } = input;
	const person = settings.person === "first" ? "第一人称（我）" : "第三人称";
	const systemPrompt = [
		"你在为一部互动小说补写幕后视角：主角这一拍进行的同时，镜头外的人物各自在过什么日子。",
		"这些文字是候选，会由世界状态统一审核；它们不是正文，不改写、不续写主正文。",
		"铁律：",
		`- 每位人物只写他自己一个人的视角，${person}；人物之间不串味、不互相剧透心理。`,
		`- 信息隔离：人物只知道亲眼所见、亲耳所闻；不得知晓主正文里未公开的信息，不得知道${input.userName || "主角"}的具体遭遇、位置或计划。`,
		`- 不替${input.userName || "主角"}做任何决定、承诺或行动。`,
		"- 时间与主正文同一时段，不跳到未来。",
	].join("\n");
	const lines: string[] = [];
	lines.push("【本轮要写的人物（名字必须逐字一致）】");
	input.targets.forEach((t, i) => {
		lines.push(`${i + 1}. ${t.name}`);
		if (t.notes.trim()) lines.push(`   设定/近期动向：${t.notes.trim().slice(0, 2000)}`);
		if (t.previous?.trim()) lines.push(`   上回合收尾（紧接此处续写，不要重新起头）：${t.previous.trim().slice(-800)}`);
	});
	lines.push("", "【主正文（主角视角，仅用于对齐时间与场景）】", input.narrative.slice(-6000) || "（空）");
	lines.push("", "【写作要求】", settings.style.trim() || DEFAULT_STYLE);
	lines.push("", `【篇幅】每位约 ${settings.minWords}-${settings.maxWords} 字，总共不超过 ${input.targets.length * settings.maxWords} 字，每位都必须写完。`);
	lines.push("", "【输出格式】每位人物一个块，块外不要输出任何内容：",
		"<npc:名字>", "（时间 + 地点 + 场合）", "（正文）", "</npc:名字>",
		"<npc信息:名字>", "知道：…", "不知道：…", "只能推断：…", "</npc信息:名字>");
	// 中文约 1.5 token/字，留出余量；交给宿主再按岗位下限放大。
	const maxTokens = Math.min(32000, Math.ceil(input.targets.length * settings.maxWords * 2) + 800);
	return { systemPrompt, userText: lines.join("\n"), maxTokens };
}

/** 按 <npc:名字> 分块解析；只认名单内的名字，每人取第一块。 */
export function parseSidewriteOutput(raw: string, names: string[]): Map<string, NpcParallelEntry> {
	const out = new Map<string, NpcParallelEntry>();
	const text = String(raw ?? "").replace(/\r\n/g, "\n");
	const marks = [...text.matchAll(/<npc[:：]\s*([^<>\n]{1,60}?)\s*>/g)];
	const resolve = (written: string) => {
		const w = written.trim().toLowerCase();
		const matches = names.filter(n => n.trim().toLowerCase() === w);
		return matches.length === 1 ? matches[0] : undefined;
	};
	marks.forEach((mark, i) => {
		const name = resolve(mark[1]);
		if (!name || out.has(name)) return;
		const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
		let seg = text.slice(mark.index! + mark[0].length, end);
		let info = "";
		const infoMatch = /<npc信息(?:[:：][^>]*)?>([\s\S]*?)(?:<\/npc信息[^>]*>|$)/.exec(seg);
		if (infoMatch) { info = infoMatch[1].trim(); seg = seg.slice(0, infoMatch.index); }
		const body = seg.replace(/<\/npc[^>]*>/g, "").trim();
		if (body) out.set(name, { name, text: body, ...(info ? { info } : {}) });
	});
	return out;
}
