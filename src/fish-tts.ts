import { parseVoiceInput, removeUnspoken } from "../packages/fish-audio/upstream/lib.js";
import { MODELS } from "../packages/fish-audio/upstream/validate.js";
/** Fish Audio host protocol. Explicit, user-owned names only; no model or story writes. */
export interface FishTtsVoice {
	id: string;
	name: string;
	aliases: string[];
	referenceId: string;
	enabled: boolean;
	[key: string]: unknown;
}
export type FishTtsNetworkMode = "system" | "compatible";
export interface FishTtsConfig {
	networkMode: FishTtsNetworkMode;
	enabled: boolean;
	model: string;
	speed: number;
	readNarration: boolean;
	narratorVoiceId: string;
	voices: FishTtsVoice[];
	[key: string]: unknown;
}
export interface FishTtsBinding { scopeKey: string; sourceEntryId: string }
export interface FishTtsStatus {
	binding: FishTtsBinding;
	revision: number;
	config: FishTtsConfig;
	keyConfigured: boolean;
	keySource: "saved" | "environment" | "none";
	network?: { mode: FishTtsNetworkMode; source: "environment" | "settings" };
	busy: boolean;
}
export interface FishTtsSegment { voiceId: string; speaker: string; text: string; kind: "dialogue" | "narration" }
export interface FishTtsPreview extends FishTtsStatus { segments: FishTtsSegment[]; skippedChars: number; warnings: string[] }
export const FISH_TTS_MAX_TEXT = 16_000;
export const FISH_TTS_CHUNK_SIZE = 800;
export const FISH_TTS_MAX_SEGMENTS = 64;
export const defaultFishTtsConfig = (): FishTtsConfig => ({
	networkMode: "system", enabled: false, model: "s2-pro", speed: 1, readNarration: false, narratorVoiceId: "", voices: [],
});
const nameKey = (name: string) => name.normalize("NFC").toLocaleLowerCase().trim();
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => !["__proto__", "prototype", "constructor"].includes(key));
}
/** Accept the model ID or the canonical Fish model page, never an arbitrary API URL. */
export function fishReferenceId(input: unknown): string {
	if (typeof input !== "string") throw new Error("请填写 Fish Audio 音色 ID");
	const id = parseVoiceInput(input);
	if (!id) throw new Error("音色 ID 格式无效；请复制 32 位音色 ID 或 Fish Audio 音色页面链接");
	return id;
}
/** Preserve future fields by stable voice ID, not by row order. */
export function validateFishTtsConfig(input: unknown, previous: FishTtsConfig = defaultFishTtsConfig()): FishTtsConfig {
	if (!object(input)) throw new Error("角色配音设置必须是对象");
	const config = { ...previous, ...input } as FishTtsConfig;
	if (config.networkMode !== "system" && config.networkMode !== "compatible") throw new Error("Fish 网络模式须为系统直连或兼容直连");
	for (const key of ["enabled", "readNarration"] as const) if (typeof config[key] !== "boolean") throw new Error(`无效开关 ${key}`);
	if (typeof config.model !== "string" || !MODELS.includes(config.model)) throw new Error("Fish 模型名称无效");
	if (typeof config.speed !== "number" || !Number.isFinite(config.speed) || config.speed < 0.5 || config.speed > 2) throw new Error("语速须在 0.5 到 2 之间");
	if (!Array.isArray(config.voices) || config.voices.length > 200) throw new Error("音色表最多支持 200 个角色");
	const ids = new Set<string>(), names = new Set<string>();
	config.voices = config.voices.map(value => {
		if (!object(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id) || ids.has(value.id)) throw new Error("角色记录 ID 缺失或重复");
		ids.add(value.id);
		if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 80 || /[\r\n<>:：\[\]【】]/.test(value.name)) throw new Error("角色名须为 1–80 字，不能包含换行或对白分隔符");
		if (typeof value.enabled !== "boolean" || !Array.isArray(value.aliases) || value.aliases.length > 20 || value.aliases.some(alias => typeof alias !== "string" || !alias.trim() || alias.trim().length > 80 || /[\r\n<>:：\[\]【】]/.test(alias))) throw new Error("角色别名格式无效（每个角色最多 20 个别名）");
		const voice = { ...previous.voices.find(old => old.id === value.id), ...value, name: value.name.trim(), aliases: value.aliases.map(alias => alias.trim()), referenceId: fishReferenceId(value.referenceId) } as FishTtsVoice;
		for (const name of [voice.name, ...voice.aliases]) {
			const key = nameKey(name);
			if (names.has(key)) throw new Error(`角色名或别名重复：${name}；不能猜测该使用哪个音色`);
			names.add(key);
		}
		return voice;
	});
	if (typeof config.narratorVoiceId !== "string" || (config.narratorVoiceId && !config.voices.some(voice => voice.id === config.narratorVoiceId && voice.enabled))) throw new Error("旁白音色不存在或已停用");
	if (config.readNarration && !config.narratorVoiceId) throw new Error("朗读旁白前请指定旁白音色");
	return config;
}
/** Executable HTML/code is not speech. This does not change the displayed/stored story. */
export function fishSpeechText(text: string): string {
	return removeUnspoken(text, { skipMarkup: true, extraTags: [] }).replace(/<!--[\s\S]*?(?:-->|$)/g, "")
		.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "\n")
		.replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "\n")
		.replace(/<(?:br\s*\/|br|\/p|\/div|\/li|\/tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:x[\da-f]+|\d+);/gi, entity => {
			const named: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
			if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
			const code = entity.startsWith("&#x") ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
		})
		.replace(/\[speaker_\d+\]|<\|speaker:[^>]*\|>|[⟪⟫]/gi, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\r\n?/g, "\n").trim();
}
export function splitFishSpeech(text: string): string[] {
	const result: string[] = [];
	let rest = text.trim();
	while (rest.length > FISH_TTS_CHUNK_SIZE) {
		const window = rest.slice(0, FISH_TTS_CHUNK_SIZE);
		const stops = [...window.matchAll(/[。！？!?；;，,\n]\s*/g)];
		let end = stops.at(-1) ? stops.at(-1)!.index! + stops.at(-1)![0].length : window.length;
		if (end < FISH_TTS_CHUNK_SIZE / 2) end = window.length;
		if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
		result.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
	}
	if (rest) result.push(rest);
	return result;
}
/** Conservative attribution: explicit labels or names adjacent to speech verbs; unnamed quotes are not guessed. */
export function planFishSpeech(raw: string, config: FishTtsConfig, selectedVoiceId?: string): Pick<FishTtsPreview, "segments" | "skippedChars" | "warnings"> {
	if (typeof raw !== "string" || raw.length > FISH_TTS_MAX_TEXT) throw new Error(`配音文本最多 ${FISH_TTS_MAX_TEXT} 字；请分段选择，未截断正文`);
	const text = fishSpeechText(raw).normalize("NFC");
	const voices = config.voices;
	const segments: FishTtsSegment[] = [];
	let skippedChars = 0;
	const add = (voice: FishTtsVoice | undefined, content: string, kind: FishTtsSegment["kind"]) => {
		const cleaned = content.replace(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/g, "$1").trim();
		if (!cleaned) return;
		if (!voice || !voice.enabled) { skippedChars += cleaned.length; return; }
		for (const chunk of splitFishSpeech(cleaned)) segments.push({ voiceId: voice.id, speaker: voice.name, text: chunk, kind });
	};
	if (selectedVoiceId) {
		const voice = voices.find(voice => voice.id === selectedVoiceId && voice.enabled);
		if (!voice) throw new Error("所选音色不存在或已停用");
		add(voice, text, "dialogue");
	} else {
		const mapping = new Map<string, FishTtsVoice>();
		for (const voice of voices) for (const name of [voice.name, ...voice.aliases]) mapping.set(nameKey(name), voice);
		const pattern = [...mapping.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
		const narrator = config.readNarration ? voices.find(voice => voice.id === config.narratorVoiceId) : undefined;
		const label = pattern ? new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*|__)?(?:[【\\[](${pattern})[】\\]]\\s*[:：]?|(${pattern})(?:\\*\\*|__)?\\s*[:：])\\s*`, "iu") : null;
		const direct = pattern ? new RegExp(`(?:^|[\\s，,。！？!?；;])(?:\\*\\*|__)?[【\\[]?(${pattern})[】\\]]?(?:\\*\\*|__)?\\s*[:：]\\s*$`, "iu") : null;
		const speech = pattern ? new RegExp(`(${pattern})[^\\n。！？!?；;：:“”「」『』\"]{0,12}?(?:说道|问道|答道|回答|说|问|答|道|喊|嘀咕|低语)\\s*[:：，,]?\\s*$`, "iu") : null;
		const after = pattern ? new RegExp(`^[\\s，,]*(?:[【\\[])?(${pattern})[】\\]]?[^\\n。！？!?；;：:“”「」『』\"]{0,12}?(?:说道|问道|答道|回答|说|问|答|道|喊|嘀咕|低语)[。！!，,]?`, "iu") : null;
		const lookup = (name: string | undefined) => name ? mapping.get(nameKey(name)) : undefined;
		for (const line of text.split(/\n+/)) {
			if (!line.trim()) continue;
			const heading = label?.exec(line);
			const headingVoice = lookup(heading?.[1] ?? heading?.[2]);
			const quotes = [...line.matchAll(/“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"\n]+)"/g)];
			if (!quotes.length) { add(headingVoice ?? narrator, heading ? line.slice(heading[0].length) : line, headingVoice ? "dialogue" : "narration"); continue; }
			let cursor = heading?.[0].length ?? 0;
			for (let index = 0; index < quotes.length; index++) {
				const quote = quotes[index], start = quote.index!, end = start + quote[0].length;
				const prefix = line.slice(cursor, start), suffix = line.slice(end, quotes[index + 1]?.index ?? line.length);
				const directMatch = direct?.exec(prefix), speechMatch = speech?.exec(prefix);
				let attribution = directMatch ?? speechMatch;
				// A clause mentioning two configured characters is not an attribution oracle.
				if (attribution && !directMatch) {
					const clause = attribution[0];
					const mentioned = new Set([...clause.matchAll(new RegExp(pattern, "giu"))].map(match => lookup(match[0])?.id));
					if (mentioned.size > 1) attribution = null;
				}
				const explicitHeading = index === 0 ? headingVoice : undefined;
				let afterMatch = !attribution && !explicitHeading ? after?.exec(suffix) : null;
				if (afterMatch && new Set([...afterMatch[0].matchAll(new RegExp(pattern, "giu"))].map(match => lookup(match[0])?.id)).size > 1) afterMatch = null;
				const voice = lookup(attribution?.[1]) ?? lookup(afterMatch?.[1]) ?? explicitHeading;
				add(narrator, attribution ? prefix.slice(0, attribution.index) : prefix, "narration");
				add(voice ?? narrator, quote.slice(1).find(value => value !== undefined) ?? "", voice ? "dialogue" : "narration");
				cursor = end + (afterMatch?.[0].length ?? 0);
			}
			add(narrator, line.slice(cursor), "narration");
		}
	}
	if (segments.length > FISH_TTS_MAX_SEGMENTS) throw new Error(`本次超过 ${FISH_TTS_MAX_SEGMENTS} 个配音片段，请缩短选段；未截断正文`);
	const warnings: string[] = [];
	if (skippedChars) warnings.push(`有 ${skippedChars} 字旁白或未明确说话人的内容未配音；不会按提到的名字猜测声线。`);
	if (!segments.length) warnings.push("未识别到已绑定角色的对白。可使用「角色名：对白」、【角色名】对白，或「角色名说：“对白”」。");
	return { segments, skippedChars, warnings };
}
