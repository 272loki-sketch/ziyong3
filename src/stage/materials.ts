/**
 * 台上素材装载（PLAN-RP-HARNESS M1）。
 *
 * 每拍开演前从磁盘现读：配置 / 角色卡 / 世界书 / 预设（宏求值）。
 * 引擎每回合调用一次——改卡、改预设、挂书即时生效，没有热重载缝隙。
 * 顺带刷新显示层折叠标签注册表（server 侧单实例，与扩展无共享）。
 *
 * 本模块只读盘、不写盘、零 pi 依赖。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadCardFile, applyMacros, readCardRawJson } from "../card.ts";
import { promptRules, extractRegexScripts, type DisplayRule } from "../cardfront.ts";
import {
	constantEntries,
	loadLorebookRegexScripts,
	mergeEntries,
	mountedLorebookPaths,
	setMountedLorebooks,
} from "../lorebook.ts";
import { addFoldTags, addHistoryStripTags, discoverFoldTagsFromTexts, resetDisplayTagExtras } from "../postprocess.ts";
import { stripProtocolEntries, type ProtocolDrop } from "../protocol-detect.ts";
import {
	assemble,
	type AssembledPiece,
	type AssembleReportItem,
	type DepthPiece,
	type MarkerMaterials,
} from "../preset-assemble.ts";
import { loadPresetDoc, type PresetDoc } from "../preset-doc.ts";
import { normalizeRpPreset, type RpPreset } from "../preset.ts";
import { resolveConfigPath } from "../paths.ts";
import { resolveWorldbooks, type ResolvedWorldbooks } from "../worldbook-bindings.ts";
import { DEFAULT_CONFIG, type CharacterCard, type LorebookEntry, type RpConfig } from "../types.ts";
import { normalizeStepModels } from "../model-routing.ts";
import { scanSkillFiles, type SkillFile } from "./skill-store.ts";
import type { DatabasePluginWorldbookEntry } from "./database-plugin-prompt.ts";

/**
 * 预设格式栈的已知标签：**只在送模历史整块剥**（防往拍模仿），显示层照常渲染。
 * 这些是用户要看的产出（咪咪点评/选择框/变量面板），不是脚手架。
 */
const FORMAT_STACK_TAGS = ["w2g", "catsay", "UpdateVariable", "JSONPatch", "Analysis", "draft_notes", "wfeeling"];

/**
 * 预设装配产物的一片。marker 槽位填的是梨园材料（卡/世界书/人设的原文），
 * 预设块填的是宏求值后的原文——两者都不加 harness 引导语。
 */
export type { AssembledPiece } from "../preset-assemble.ts";

export interface StageMaterials {
	/** Native database placement owns worldbook delivery, not the legacy constant channel. */
	databaseWorldbook?: boolean;
	/** Enabled original Tavern host consumes macros/protocols; sources remain unchanged. */
	nativeTavernPlugins?: boolean;
	config: RpConfig;
	card: CharacterCard;
	/** 角色卡原始 JSON。只供独立谢幕轮判断任意卡格式，不参与正文装配。 */
	rawCard: Record<string, unknown>;
	/** 已解析角色主书/附加/全局/聊天/补充；保留条目身份与启停，旧模式仅剔除外部协议 */
	entries: LorebookEntry[];
	/** 与管理/原宿主共用的来源清单（包含原始行）。 */
	worldbooks?: ResolvedWorldbooks;
	/** 预设文档（原文 + 归一条目）；null＝未配置且无默认预设 */
	presetDoc: PresetDoc | null;
	/** 旧文学旁路消费的归一预设视图；装配权威仍是 presetDoc 原始 JSON。 */
	preset: RpPreset | null;
	/** 装配产物：chatHistory 槽位之前的片段（含已归位的 marker 材料），按预设作者原序 */
	presetBefore: AssembledPiece[];
	/** injection_position=1 的深度注入片段（数据层保真；消费待后续里程碑接入） */
	presetDepth: DepthPiece[];
	/** 预设声明过的 marker 槽位 id——没声明的槽位由梨园按兜底版式补，避免卡内容丢失 */
	declaredMarkers: Set<string>;
	/** skill 一等素材位（M-R2）：工作目录 skills/<name>/SKILL.md 扫描产物 */
	skillFiles: SkillFile[];
	/** 文学主演附加指导；官方原始预设管线不再从预设拆出这一层。 */
	writerGuidance: Array<{ topic: string; text: string }>;
	/** 装配报告：每块去向（engine 落盘 .liyuan/preset-assembly.json） */
	presetAssembly: AssembleReportItem[];
	/** 历史前段全部求值后内容——机械规则提取（extractDraftRules）用 */
	presetRuleTexts: string[];
	/** marker 槽位材料（卡/世界书/人设）——引擎每拍重装历史后段时复用同一份 */
	markerMaterials: MarkerMaterials;
	/** 任一渠道有启用块——扮演规范让位给预设的判定依据 */
	presetActive: boolean;
	/** 卡作者声明的格式入口，供独立谢幕材料裁剪。 */
	statusBarFormats: string[];
	/** 宏求值遇到的清单外宏名（供引擎降级告警） */
	macroWarnings: string[];
	/** M-C2：被判死的外部插件协议条目（世界书通道 H 类退场，进装配报告） */
	protocolDrops: ProtocolDrop[];
	/** 送模侧作者正则（promptOnly/破坏性，预设+卡）——rebuildHistory 应用，剥「作者不想让模型看」的块 */
	promptRules: DisplayRule[];
}

const resolvePath = (cwd: string, p: string): string => (isAbsolute(p) ? p : join(cwd, p));

/** 读配置（含旧字段迁移）；文件缺失/损坏回落默认 */
export function loadStageConfig(cwd: string): RpConfig {
	const configPath = resolveConfigPath(cwd);
	let raw: RpConfig = { ...DEFAULT_CONFIG };
	if (existsSync(configPath)) {
		try {
			raw = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<RpConfig>) };
		} catch {
			raw = { ...DEFAULT_CONFIG };
		}
	}
	delete (raw as unknown as Record<string, unknown>).creationMode;
	if (raw.generationMode === "direct" || raw.generationMode === "director") { delete raw.literaryQuality; delete raw.literaryProfileEveryNTurns; }
	raw.stepModels = normalizeStepModels(raw.stepModels);
	return setMountedLorebooks(raw, mountedLorebookPaths(raw));
}

/** 装载一拍所需全部素材；卡缺失/损坏时抛错（引擎转告用户，不演） */
export function loadStageMaterials(cwd: string, options: { nativeTavernPlugins?: boolean; sessionId?: string } = {}): StageMaterials {
	const config = loadStageConfig(cwd);

	const cardAbs = resolvePath(cwd, config.card);
	const card = loadCardFile(cardAbs);
	const rawCard = readCardRawJson(cardAbs).raw;
	// 卡原文（含 extensions.regex_scripts）：显示/送模两侧与 cardfront 快照同源
	const cardRegexScripts = (() => {
		try {
			return extractRegexScripts(rawCard);
		} catch {
			return [];
		}
	})();

	// 角色显式绑定优先，内嵌仅回退；所有宿主/管理面与生成共用同一来源。
	const worldbooks = resolveWorldbooks(cwd, config, { card, rawCard, sessionId: options.sessionId });
	const lorebookRegexScripts: unknown[] = worldbooks.books.flatMap(book => book.source === "file" ? loadLorebookRegexScripts(book.abs) : []);
	const originalEntries = mergeEntries(...worldbooks.books.map(book => book.entries));
	const protocolFiltered = options.nativeTavernPlugins ? { entries: originalEntries, dropped: [] } : stripProtocolEntries(originalEntries);
	const entries = protocolFiltered.entries;
	const protocolDrops = protocolFiltered.dropped;

	// 预设：工作草稿（preset-override.json）优先，与预设页签热编辑一致。落盘即原文，这里只读不转换。
	const readDoc = (abs: string, name: string): PresetDoc | null => {
		if (!existsSync(abs)) return null;
		try {
			return loadPresetDoc(JSON.parse(readFileSync(abs, "utf8")), name);
		} catch {
			return null;
		}
	};
	let presetDoc: PresetDoc | null = null;
	if (config.preset) {
		const name = (config.preset.split(/[\\/]/).pop() ?? config.preset).replace(/\.json$/i, "");
		presetDoc =
			readDoc(join(cwd, ".liyuan", "preset-override.json"), name) ?? readDoc(resolvePath(cwd, config.preset), name);
	} else {
		// §4.A 默认预设：文风兜底迁出源码，数据发行（presets/默认.json，用户可见可改可换）。
		// 只在没有用户预设时装；用户预设在场完全不装（不叠加）。
		presetDoc = readDoc(join(cwd, "presets", "默认.json"), "默认");
	}

	// marker 材料：梨园按酒馆的槽位交货，**位置由预设作者的 prompt_order 决定**。
	// 填的是原文——包装（标题/小节名）归预设作者，梨园不替他们加话（铁律一）。
	const macroCtx = { charName: card.name, userName: config.userName };
	const markerMaterials: MarkerMaterials = {};
	const putSlot = (slot: keyof MarkerMaterials, text: string | undefined): void => {
		if (text && text.trim()) markerMaterials[slot] = applyMacros(text, macroCtx);
	};
	putSlot("charDescription", card.description);
	putSlot("charPersonality", card.personality);
	putSlot("scenario", card.scenario);
	putSlot("dialogueExamples", card.mesExample);
	putSlot("personaDescription", config.userPersona);
	// 梨园的 LorebookEntry 没有 ST 的 before/after position，常驻条目整份交 worldInfoBefore
	const constantLore = constantEntries(entries);
	if (constantLore.length > 0) {
		putSlot(
			"worldInfoBefore",
			constantLore.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${e.content}`).join("\n"),
		);
	}

	// 装配：模拟酒馆引擎按开关拼一次。历史后段每拍重装（{{lastusermessage}}），此处只取静态面。
	const assembled = presetDoc
		? assemble(presetDoc.entries, { materials: markerMaterials, charName: card.name, userName: config.userName, preserveUnknownMacros: options.nativeTavernPlugins })
		: null;
	const presetBefore = assembled?.before ?? [];
	const presetDepth = assembled?.depth ?? [];
	const declaredMarkers = new Set((assembled?.markers ?? []).map((mk) => mk.id));
	const presetAssembly = assembled?.report ?? [];
	const presetRuleTexts = presetBefore.filter((p) => p.source === "block").map((p) => p.text);
	const presetActive = !!assembled && assembled.before.length + assembled.after.length + assembled.depth.length > 0;
	const preset = presetDoc ? normalizeRpPreset(presetDoc.raw) : null;
	const unsupported = new Set(assembled?.unsupported ?? []);

	// 显示层折叠标签：预设约定的思维链/草稿标签在 UI 折叠（server 侧注册表）；
	// 格式栈标签（catsay/w2g…）只注册到**历史剥**通道——它们是用户要看的产出，
	// 混进 extraFold 会让显示层连内容一起删（8/05：模型写了咪咪点评，屏上没有）。
	resetDisplayTagExtras();
	if (presetDoc) {
		const discovered = discoverFoldTagsFromTexts(
			presetDoc.entries.filter((e) => e.enabled && !e.marker).map((e) => e.content),
		);
		if (discovered.length) addFoldTags(discovered);
		addHistoryStripTags(FORMAT_STACK_TAGS);
	}

	return {
		config,
		card,
		...(options.nativeTavernPlugins ? { nativeTavernPlugins: true } : {}),
		rawCard,
		entries,
		presetDoc,
		preset,
		presetBefore,
		presetDepth,
		declaredMarkers,
		skillFiles: scanSkillFiles(cwd),
		writerGuidance: [],
		presetAssembly,
		presetRuleTexts,
		markerMaterials,
		presetActive,
		// 谢幕只需知道作者正则匹配哪些标签；replacement 可能是数十 KB HTML，绝不送料。
		statusBarFormats: [...cardRegexScripts, ...lorebookRegexScripts].flatMap((script) => {
			if (!script || typeof script !== "object") return [];
			const source = (script as Record<string, unknown>).findRegex;
			return typeof source === "string" && source.trim() ? [source] : [];
		}).slice(0, 32),
		macroWarnings: [...unsupported],
		protocolDrops,
		worldbooks,
		// 送模侧作者正则：预设 + 卡（与 cardfront 显示侧同源；promptOnly/破坏性规则）
		promptRules: promptRules([...((presetDoc?.raw?.extensions as { regex_scripts?: unknown[] } | undefined)?.regex_scripts ?? []), ...cardRegexScripts, ...lorebookRegexScripts]),
	};
}

/** Reassemble markers from selected original entries, never remove text from assembled prompts. */
export function projectStageWorldbookEntries(materials: StageMaterials, retained: number[]): StageMaterials {
 if(!Array.isArray(retained)||retained.some(index=>!Number.isSafeInteger(index)||index<0||index>=materials.entries.length)||new Set(retained).size!==retained.length)throw new Error('Invalid native worldbook selection');
 if(retained.length===materials.entries.length)return materials;
 const selected=new Set(retained),entries=materials.entries.filter((_,index)=>selected.has(index));
 const markerMaterials={...materials.markerMaterials};delete markerMaterials.worldInfoBefore;
 const lore=constantEntries(entries);
 if(lore.length)markerMaterials.worldInfoBefore=applyMacros(lore.map(e=>`- ${e.comment?`【${e.comment}】`:''}${e.content}`).join('\n'),{charName:materials.card.name,userName:materials.config.userName});
 const assembled=materials.presetDoc?assemble(materials.presetDoc.entries,{materials:markerMaterials,charName:materials.card.name,userName:materials.config.userName,preserveUnknownMacros:materials.nativeTavernPlugins}):null;
 return {...materials,entries,markerMaterials,presetBefore:assembled?.before??[],presetDepth:assembled?.depth??[],presetAssembly:assembled?.report??[]};
}

/** Read native placement from the resolved source row, never from normalized lore alone. */
export function stageDatabaseWorldbookEntries(materials: StageMaterials): DatabasePluginWorldbookEntry[] {
	return materials.entries.map(entry => {
		const book = materials.worldbooks?.books.find(book => book.id === entry.bookId);
		if (!book || entry.entryKey === undefined) throw new Error("Native worldbook source row is unavailable");
		const rows = book.rawBook.entries as Record<string, Record<string, unknown>>;
		const raw = rows[entry.entryKey];
		if (!raw) throw new Error("Native worldbook source row is unavailable");
		const extensions = raw.extensions && typeof raw.extensions === "object" ? raw.extensions as Record<string, unknown> : {};
		const option = (snake: string, camel: string) => raw[snake] ?? extensions[snake] ?? raw[camel] ?? extensions[camel];
		return {
			...extensions, ...raw,
			uid: entry.uid, enabled: entry.enabled, disable: !entry.enabled,
			constant: entry.constant, type: entry.constant ? "constant" : "keyword",
			content: applyMacros(typeof raw.content === "string" ? raw.content : entry.content, { charName: materials.card.name, userName: materials.config.userName }),
			keys: entry.keys, keys_secondary: entry.secondaryKeys, selective: entry.selective, order: entry.order,
			position: extensions.position ?? raw.position ?? 0,
			depth: raw.depth ?? extensions.depth ?? 4, role: raw.role ?? extensions.role,
			scan_depth: option("scan_depth", "scanDepth"), case_sensitive: option("case_sensitive", "caseSensitive"),
			match_whole_words: option("match_whole_words", "matchWholeWords"),
			exclude_recursion: option("exclude_recursion", "excludeRecursion"), prevent_recursion: option("prevent_recursion", "preventRecursion"),
		} as DatabasePluginWorldbookEntry;
	});
}

/** Replace the legacy constant slot before reassembly; keep preset text and order untouched. */
export function projectStageDatabaseWorldbook(materials: StageMaterials, worldbook: { before: string; after: string }): StageMaterials {
	const markerMaterials = { ...materials.markerMaterials };
	delete markerMaterials.worldInfoBefore;
	delete markerMaterials.worldInfoAfter;
	if (worldbook.before) markerMaterials.worldInfoBefore = worldbook.before;
	if (worldbook.after) markerMaterials.worldInfoAfter = worldbook.after;
	const assembled = materials.presetDoc ? assemble(materials.presetDoc.entries, {
		materials: markerMaterials, charName: materials.card.name, userName: materials.config.userName,
		preserveUnknownMacros: materials.nativeTavernPlugins,
	}) : null;
	return { ...materials, databaseWorldbook: true, markerMaterials, presetBefore: assembled?.before ?? [],
		presetDepth: assembled?.depth ?? [], presetAssembly: assembled?.report ?? [] };
}

/**
 * 历史后段每拍重装（{{lastusermessage}} 在此生效）。
 *
 * 整份重跑而不是"接着历史前段的变量表往下算"——酒馆每轮就是整份重拼，
 * 只重算后半段会让 `getvar` 看到的值与酒馆不一致。前半段字节稳定（除非块里用了
 * `{{lastusermessage}}`），前缀缓存不受影响。无预设或后段为空返回 undefined。
 */
export function assemblePresetAfter(m: StageMaterials, userText: string): AssembledPiece[] | undefined {
	if (!m.presetDoc) return undefined;
	const r = assemble(m.presetDoc.entries, {
		materials: m.markerMaterials,
		charName: m.card.name,
		userName: m.config.userName,
		userText,
		preserveUnknownMacros: m.nativeTavernPlugins,
	});
	return r.after.length > 0 ? r.after : undefined;
}

/** 常驻世界书条目（enabled+constant，按 order 排序）——system prompt 素材 */
export function constantLoreOf(m: StageMaterials): LorebookEntry[] {
	return m.databaseWorldbook ? [] : constantEntries(m.entries);
}
