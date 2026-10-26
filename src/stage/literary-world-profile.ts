import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import { readJsonFile } from "../jsonio.ts";
import { classifyModelFailure } from "./model-failure.ts";
import { clipPromptText } from "./prompt-budget.ts";
import type { CharacterCard, LorebookEntry } from "../types.ts";
import type { RpPreset } from "../preset.ts";
import type { BranchEntryLike } from "./assemble.ts";
import { moduleKindForId, WORLD_MODULE_PACK_BY_KIND, type WorldModuleKind } from "./literary-world-modular.ts";

export const WORLD_MANIFEST_ENTRY_TYPE = "rp-world-manifest";

export type WorldProfileStatus = "draft" | "stable";
export type WorldModuleMode = "observe" | "active" | "suspended";
export type WorldModuleCadence = "every-beat" | "on-time-advance" | "on-trigger" | "per-day" | "per-arc" | "strategic-turn";

export interface WorldProfileEvidence {
	source: string;
	claim: string;
}

export interface WorldProfileModule {
	id: string;
	name: string;
	mode: WorldModuleMode;
	cadence: WorldModuleCadence;
	confidence: number;
	reason: string;
	stateFocus: string[];
	writerProjection: string;
	kind: WorldModuleKind;
	skillPack: string;
}

export interface CardWorldProfile {
	version: 1;
	cardKey: string;
	cardName: string;
	/** Host-owned content revision binding; cardKey remains stable across managed edits. */
	contentKey?: string;
	revision: number;
	analyzedTurns: number;
	status: WorldProfileStatus;
	sourceFingerprint: string;
	updatedAt: string;
	digest: string;
	labels: string[];
	primaryScale: "intimate" | "scene" | "local" | "institutional" | "regional" | "epic";
	defaultTimeStep: "moment" | "scene" | "hour" | "day" | "week" | "strategic-turn";
	worldActivity: "quiet" | "low" | "normal" | "active" | "epic";
	modules: WorldProfileModule[];
	disabledModules: string[];
	userRequirements: string[];
	optimizationNotes: string[];
	unresolvedQuestions: string[];
	evidence: WorldProfileEvidence[];
}

export interface WorldSimulationManifest {
	version: 1;
	cardKey: string;
	profileRevision: number;
	contentKey?: string;
	profileStatus: WorldProfileStatus;
	digest: string;
	primaryScale: CardWorldProfile["primaryScale"];
	defaultTimeStep: CardWorldProfile["defaultTimeStep"];
	worldActivity: CardWorldProfile["worldActivity"];
	modules: WorldProfileModule[];
	disabledModules: string[];
	userRequirements: string[];
	createdAt: string;
	/** 同一卡不同开场/世界书/预设组合的玩法槽；基础画像共享，分支 Manifest 保留具体玩法。 */
	playKey?: string;
}

const clean = (value: unknown, max = 300): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const strings = (value: unknown, maxItems = 20, maxChars = 300): string[] => Array.isArray(value)
	? value.map((item) => clean(item, maxChars)).filter(Boolean).slice(0, maxItems)
	: [];
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
	? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
	: [];
const confidence = (value: unknown): number => Math.max(0, Math.min(1, Number(value) || 0));

function objectOf(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	const source = value.trim();
	for (const candidate of [source, source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], source.match(/\{[\s\S]*\}/)?.[0]]) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {}
	}
	return null;
}

export function legacyWorldCardKey(cwd: string, cardPath: string): string {
	const absolute = isAbsolute(cardPath) ? normalize(cardPath) : normalize(join(cwd, cardPath));
	return createHash("sha1").update(absolute.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 12);
}

export function worldCardKey(cwd: string, cardPath: string, card?: CharacterCard): string {
	if (!card) return legacyWorldCardKey(cwd, cardPath);
	// 身份只取卡自身的稳定内容，不取预设、挂载书和开场选择；移动文件或迁移项目后仍能找到同一适配。
	const identity = { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario, creatorNotes: card.creatorNotes, tags: card.tags, book: card.book };
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}

export function worldProfilePath(cwd: string, cardPath: string, card?: CharacterCard): string {
	return join(cwd, ".liyuan", "world", "cards", worldCardKey(cwd, cardPath, card), "profile.json");
}

export function worldProfileFingerprint(input: {
	card: CharacterCard;
	entries: LorebookEntry[];
	preset: RpPreset | null;
	greetingIndex?: number;
}): string {
	const material = {
		card: input.card,
		lore: input.entries.map((entry) => ({ source: entry.source, bookId: entry.bookId, entryKey: entry.entryKey, enabled: entry.enabled, title: entry.comment, keys: entry.keys, content: entry.content })),
		preset: input.preset ? {
			name: input.preset.name,
			blocks: input.preset.blocks.filter((block) => block.enabled).map((block) => ({ name: block.name, channel: block.channel, content: block.content })),
		} : null,
		greetingIndex: input.greetingIndex ?? 0,
	};
	return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function worldPlayKey(sourceFingerprint: string): string {
	return sourceFingerprint.slice(0, 16);
}

export function defaultCardWorldProfile(cwd: string, cardPath: string, cardName: string, sourceFingerprint = "", card?: CharacterCard): CardWorldProfile {
	return {
		version: 1,
		cardKey: worldCardKey(cwd, cardPath, card),
		contentKey: worldCardKey(cwd, cardPath, card),
		cardName,
		revision: 0,
		analyzedTurns: 0,
		status: "draft",
		sourceFingerprint,
		updatedAt: "",
		digest: "当前角色卡尚未建立独立世界适配。",
		labels: [],
		primaryScale: "scene",
		defaultTimeStep: "scene",
		worldActivity: "normal",
		modules: [],
		disabledModules: [],
		userRequirements: [],
		optimizationNotes: [],
		unresolvedQuestions: [],
		evidence: [],
	};
}

export function normalizeCardWorldProfile(
	value: unknown,
	base: CardWorldProfile,
	opts?: { preserveStatus?: boolean; sourceFingerprint?: string; analyzedTurns?: number; requireModules?: boolean },
): CardWorldProfile | null {
	let source = objectOf(value);
	if (!source) return null;
	// 有些推理模型会把交付包在 profile/result/data 下；只接受单层对象包裹，避免为了
	// provider 文风差异让完整画像不可用。
	const wrapped = [source.profile, source.result, source.data].find((item) => item && typeof item === "object" && !Array.isArray(item));
	if (wrapped && !source.modules && !source.digest) source = wrapped as Record<string, unknown>;
	// An arbitrary JSON object (or partial response) is not an analyzed profile.
	if (!clean(source.digest, 1200) || (opts?.requireModules && !Array.isArray(source.modules))) return null;
	const analyzedTurnsSource = Number(source.analyzedTurns);
	const analyzedTurns = opts?.analyzedTurns ?? (Number.isFinite(analyzedTurnsSource) ? analyzedTurnsSource : base.analyzedTurns);
	const allowedModes = new Set<WorldModuleMode>(["observe", "active", "suspended"]);
	const allowedCadences = new Set<WorldModuleCadence>(["every-beat", "on-time-advance", "on-trigger", "per-day", "per-arc", "strategic-turn"]);
	const allowedSkillPacks = new Set(Object.values(WORLD_MODULE_PACK_BY_KIND));
	const seen = new Set<string>();
	const modules = records(source.modules).flatMap((item): WorldProfileModule[] => {
		const id = clean(item.id, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
		if (!id || seen.has(id)) return [];
		seen.add(id);
		const rawMode = clean(item.mode, 30) as WorldModuleMode;
		const rawCadence = clean(item.cadence, 40) as WorldModuleCadence;
		const kind = ["institution", "social", "infrastructure", "rules", "objective", "mystery", "strategy", "survival", "environment", "custom", "legacy"].includes(String(item.kind)) ? item.kind as WorldModuleKind : moduleKindForId(id);
		const requestedPack = clean(item.skillPack, 80);
		return [{
			id,
			name: clean(item.name, 100) || id,
			mode: allowedModes.has(rawMode) ? rawMode : "observe",
			cadence: allowedCadences.has(rawCadence) ? rawCadence : "on-trigger",
			confidence: confidence(item.confidence),
			reason: clean(item.reason, 600),
			stateFocus: strings(item.stateFocus, 16, 160),
			writerProjection: clean(item.writerProjection, 600),
			kind,
			skillPack: allowedSkillPacks.has(requestedPack) ? requestedPack : WORLD_MODULE_PACK_BY_KIND[kind],
		}];
	}).slice(0, 16);
	if (opts?.requireModules && modules.length !== (source.modules as unknown[]).length) return null;
	const scales = new Set(["intimate", "scene", "local", "institutional", "regional", "epic"]);
	const steps = new Set(["moment", "scene", "hour", "day", "week", "strategic-turn"]);
	const activities = new Set(["quiet", "low", "normal", "active", "epic"]);
	return {
		version: 1,
		cardKey: base.cardKey,
		cardName: base.cardName,
		...(base.contentKey ? { contentKey: base.contentKey } : {}),
		revision: Math.max(base.revision + 1, Math.round(Number(source.revision) || 0)),
		analyzedTurns: Math.max(0, Math.round(analyzedTurns)),
		status: opts?.preserveStatus ? base.status : source.status === "stable" ? "stable" : "draft",
		sourceFingerprint: opts?.sourceFingerprint ?? (clean(source.sourceFingerprint, 100) || base.sourceFingerprint),
		updatedAt: new Date().toISOString(),
		digest: clean(source.digest, 1200) || base.digest,
		labels: strings(source.labels, 12, 80),
		primaryScale: scales.has(String(source.primaryScale)) ? source.primaryScale as CardWorldProfile["primaryScale"] : base.primaryScale,
		defaultTimeStep: steps.has(String(source.defaultTimeStep)) ? source.defaultTimeStep as CardWorldProfile["defaultTimeStep"] : base.defaultTimeStep,
		worldActivity: activities.has(String(source.worldActivity)) ? source.worldActivity as CardWorldProfile["worldActivity"] : base.worldActivity,
		modules,
		disabledModules: strings(source.disabledModules, 32, 80),
		userRequirements: [...new Set([...base.userRequirements, ...strings(source.userRequirements, 40, 500)])].slice(0, 40),
		optimizationNotes: strings(source.optimizationNotes, 40, 500).length ? strings(source.optimizationNotes, 40, 500) : base.optimizationNotes,
		unresolvedQuestions: strings(source.unresolvedQuestions, 20, 500),
		evidence: records(source.evidence).map((item) => ({ source: clean(item.source, 160), claim: clean(item.claim, 500) })).filter((item) => item.source && item.claim).slice(0, 40),
	};
}

/** Only an explicit card binding on this ancestor chain may bridge a legacy content revision. */
function profileManifestFromBoundBranch(cwd: string, cardPath: string, branch: BranchEntryLike[]): WorldSimulationManifest | undefined {
	const lastBinding = [...branch].reverse().find(entry => entry.type === "custom" && entry.customType === "rp-card");
	const bindingIndex = lastBinding ? branch.lastIndexOf(lastBinding) : -1;
	if (bindingIndex < 0) return;
	const binding = branch[bindingIndex].data as { card?: unknown } | undefined;
	const absolute = (path: string) => normalize(isAbsolute(path) ? path : join(cwd, path));
	if (typeof binding?.card !== "string" || absolute(binding.card) !== absolute(cardPath)) return;
	return worldManifestFromBranch(branch.slice(bindingIndex + 1)) ?? undefined;
}

const validCardKey = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{12}|[a-f0-9]{16})$/.test(value);

export function loadCardWorldProfile(cwd: string, cardPath: string, cardName: string, sourceFingerprint = "", card?: CharacterCard, branch: BranchEntryLike[] = []): CardWorldProfile | null {
	const contentKey = worldCardKey(cwd, cardPath, card);
	const path = worldProfilePath(cwd, cardPath, card);
	const legacyPath = worldProfilePath(cwd, cardPath);
	const boundManifest = profileManifestFromBoundBranch(cwd, cardPath, branch);
	const boundKey = boundManifest?.contentKey ?? boundManifest?.cardKey;
	const boundPath = validCardKey(boundKey) ? join(cwd, ".liyuan", "world", "cards", boundKey, "profile.json") : undefined;
	const sourcePath = [path, legacyPath, boundPath].find(candidate => candidate && existsSync(candidate));
	if (!sourcePath) return null;
	try {
		const raw = readJsonFile(sourcePath) as Record<string, unknown>;
		if (!raw || typeof raw !== "object" || raw.cardName !== cardName || sourcePath === boundPath && raw.cardKey !== boundManifest?.cardKey) return null;
		const base = defaultCardWorldProfile(cwd, cardPath, cardName, "", card);
		// A saved content binding, exact legacy path or same-source branch is evidence;
		// a matching display name alone is never enough to associate two cards.
		if (validCardKey(raw.cardKey) && (raw.contentKey === contentKey || sourcePath === legacyPath || sourcePath === boundPath && raw.cardKey === boundManifest?.cardKey)) base.cardKey = raw.cardKey;
		const parsed = normalizeCardWorldProfile(raw, { ...base, revision: -1 }, { sourceFingerprint: undefined, requireModules: true });
		return parsed ? { ...parsed, revision: Math.max(0, parsed.revision), updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "", contentKey: validCardKey(raw.contentKey) ? raw.contentKey : basename(dirname(sourcePath)) } : null;
	} catch {
		return null;
	}
}

export function saveCardWorldProfile(cwd: string, cardPath: string, profile: CardWorldProfile, card?: CharacterCard): void {
	if (!validCardKey(profile.cardKey)) throw new Error("世界画像身份无效，未写入");
	const path = worldProfilePath(cwd, cardPath, card);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ ...profile, contentKey: worldCardKey(cwd, cardPath, card) }, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

/** Call only around an explicit edit of this exact source, never on card selection/import. */
export function carryCardWorldProfile(cwd: string, cardPath: string, before: CharacterCard, after: CharacterCard): void {
	if (worldCardKey(cwd, cardPath, before) === worldCardKey(cwd, cardPath, after)) return;
	const profile = loadCardWorldProfile(cwd, cardPath, before.name, "", before);
	if (profile) saveCardWorldProfile(cwd, cardPath, { ...profile, cardName: after.name }, after);
}

export function manifestFromProfile(profile: CardWorldProfile): WorldSimulationManifest {
	const disabled = new Set(profile.disabledModules);
	return {
		version: 1,
		cardKey: profile.cardKey,
		profileRevision: profile.revision,
		...(profile.contentKey ? { contentKey: profile.contentKey } : {}),
		profileStatus: profile.status,
		digest: profile.digest,
		primaryScale: profile.primaryScale,
		defaultTimeStep: profile.defaultTimeStep,
		worldActivity: profile.worldActivity,
		modules: profile.modules.filter((module) => !disabled.has(module.id)),
		disabledModules: [...disabled],
		userRequirements: profile.userRequirements,
		createdAt: new Date().toISOString(),
		playKey: worldPlayKey(profile.sourceFingerprint),
	};
}

export function worldManifestFromBranch(branch: BranchEntryLike[], cardKey?: string): WorldSimulationManifest | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== WORLD_MANIFEST_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as WorldSimulationManifest;
		if (data.version !== 1 || (cardKey && data.cardKey !== cardKey) || !Array.isArray(data.modules)) continue;
		return data;
	}
	return null;
}

export function profileNeedsAnalysis(profile: CardWorldProfile | null, sourceFingerprint: string, completedTurns = 0, reviewEveryTurns = 8): boolean {
	if (!profile) return true;
	if (profile.status === "stable") return false;
	if (profile.sourceFingerprint !== sourceFingerprint) return true;
	return completedTurns >= profile.analyzedTurns + Math.max(1, reviewEveryTurns);
}

export function buildWorldProfilePrompt(input: {
	skillBody: string;
	card: CharacterCard;
	entries: LorebookEntry[];
	preset: RpPreset | null;
	greetingIndex?: number;
	previous?: CardWorldProfile | null;
	recentHistory?: Array<{ role: string; text: string }>;
}): { systemPrompt: string; userText: string } {
	const selectedGreeting = input.greetingIndex && input.greetingIndex > 0
		? input.card.alternateGreetings[input.greetingIndex - 1] ?? input.card.firstMes
		: input.card.firstMes;
	const previousProfile = input.previous ? { ...input.previous } : null;
	if (previousProfile) delete previousProfile.contentKey;
	// Match the aggregate lore budget used by other side projections, retaining
	// provenance on exactly the entries delivered rather than the unbounded input.
	const worldLore: Array<{ source?: string; title: string; content: string }> = [];
	let loreChars = 0;
	for (const entry of input.entries.filter(entry => entry.enabled !== false && entry.content.trim()).slice(0, 40)) {
		if (loreChars >= 24_000) break;
		const content = clipPromptText(entry.content, Math.min(2_000, 24_000 - loreChars));
		worldLore.push({ source: entry.source, title: entry.comment || entry.keys[0] || "", content });
		loreChars += content.length;
	}
	return {
		systemPrompt: `你在为梨园建立一张角色卡长期复用的独立世界适配画像。Skill 是分析与适配规则的唯一权威；代码只负责输入、解析、版本和持久化。只返回一个合法 JSON 对象，不输出 Markdown、解释、思考过程或 profile/result 包装。顶层必须直接含 digest、labels、primaryScale、defaultTimeStep、worldActivity、modules、disabledModules、userRequirements、optimizationNotes、unresolvedQuestions、evidence。\n\n# 工作流 Skill\n${input.skillBody}`,
		userText: JSON.stringify({
			character_card: {
				name: input.card.name,
				description: input.card.description.slice(0, 8000),
				personality: input.card.personality.slice(0, 5000),
				scenario: input.card.scenario.slice(0, 5000),
				creatorNotes: input.card.creatorNotes.slice(0, 3000),
				tags: input.card.tags.slice(0, 30),
			},
			selected_greeting: selectedGreeting,
			world_lore: worldLore,
			preset: input.preset ? { name: input.preset.name, enabledBlockNames: input.preset.blocks.filter((block) => block.enabled).map((block) => block.name) } : null,
			previous_profile: previousProfile,
			recent_play: (input.recentHistory?.slice(-8) ?? []).map((item) => ({ role: item.role, text: item.text.slice(0, 2000) })),
		}, null, 2),
	};
}

const worldProfileLeases = new Set<string>();
const worldProfileLeaseKey = (cwd: string, cardPath: string, card: CharacterCard) => JSON.stringify([normalize(cwd), worldCardKey(cwd, cardPath, card)]);
export function worldProfileAnalysisRunning(cwd: string, cardPath: string, card: CharacterCard): boolean {
	return worldProfileLeases.has(worldProfileLeaseKey(cwd, cardPath, card));
}

/** Shared manual/settlement analysis: bounded transport retry, no invented default profile. */
export async function analyzeCardWorldProfile(input: Parameters<typeof buildWorldProfilePrompt>[0] & {
	cwd: string;
	cardPath: string;
	completedTurns: number;
	run: (systemPrompt: string, userText: string, forceNonStreaming: boolean) => Promise<string | { error: string }>;
	guard?: () => void;
}): Promise<CardWorldProfile> {
	const leaseKey = worldProfileLeaseKey(input.cwd, input.cardPath, input.card);
	if (worldProfileLeases.has(leaseKey)) throw new Error("这张卡的世界画像正在分析，请等待完成后重试");
	worldProfileLeases.add(leaseKey);
	try {
		const fingerprint = worldProfileFingerprint(input);
		const base = input.previous ?? defaultCardWorldProfile(input.cwd, input.cardPath, input.card.name, fingerprint, input.card);
		const prompt = buildWorldProfilePrompt(input);
		for (const forceNonStreaming of [false, true]) {
			input.guard?.();
			const result = await input.run(prompt.systemPrompt, prompt.userText, forceNonStreaming);
			input.guard?.();
			if (typeof result !== "string") {
				const failure = classifyModelFailure(result.error);
				if (!forceNonStreaming && failure.retryable && (failure.kind === "transport" || failure.kind === "timeout" || failure.kind === "format")) continue;
				throw new Error(`画像分析失败：${result.error}`);
			}
			const profile = normalizeCardWorldProfile(result, base, { preserveStatus: !!input.previous, sourceFingerprint: fingerprint, analyzedTurns: input.completedTurns, requireModules: true });
			if (profile) return { ...profile, revision: base.revision + 1, status: base.status, contentKey: worldCardKey(input.cwd, input.cardPath, input.card), ...(input.previous ? { worldActivity: base.worldActivity, disabledModules: base.disabledModules, modules: profile.modules.map(module => ({ ...module, mode: base.modules.find(previous => previous.id === module.id)?.mode ?? module.mode })), optimizationNotes: [...new Set([...base.optimizationNotes, ...profile.optimizationNotes])] } : {}) };
		}
		throw new Error("画像输出不是完整的世界适配 JSON，未覆盖已有画像；请检查画像模型的请求记录后重试");
	} finally { worldProfileLeases.delete(leaseKey); }
}
