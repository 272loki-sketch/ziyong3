/**
 * 众生侧写宿主（内置实现）。
 * 选人、单次批量请求、解析，结果作为候选交给鲜活生态采纳；没有浏览器、原插件或源码下载。
 * 状态沿用 `.liyuan-npc-parallel/` 下按 session/card/来源分支的私有存储：设置、名单、本来源批次缓存与请求计数。
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TavernPluginStore, tavernPluginScope } from "./tavern-plugin-store.ts";
import { writeJsonAtomicWithBackup } from "../src/atomic-json.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import {
	npcFailureReason, npcReceiptFromBranch, savedNpcAdmissionBatch, sealNpcCandidates,
	type NpcParallelBatch, type NpcParallelGenerationInput, type NpcParallelProvider, type NpcParallelScope,
} from "../src/stage/npc-parallel.ts";
import {
	NPC_SIDEWRITE_COMMIT, NPC_SIDEWRITE_VERSION, buildSidewritePrompt, normalizeNpcSidewriteSettings, parseSidewriteOutput,
	pickSidewriteTargets, sidewriteAnchor, type NpcSidewriteCandidate, type NpcSidewriteSettings,
} from "../src/stage/npc-sidewrite.ts";
import type { LiteraryEcologyState } from "../src/stage/literary-ecology.ts";

export interface NpcSidewriteHost {
	binding(): NpcParallelScope;
	isBusy(): boolean;
	config(): { ecologyEnabled: boolean; model?: { provider: string; id: string } };
	branch(): Array<{ id?: string; type?: string; customType?: string; data?: any; message?: any }>;
	ecology(): LiteraryEcologyState;
	materials(): { card: { name: string }; config: { userName: string } };
}

const ROOT = ".liyuan-npc-parallel";
const SETTINGS_KEY = "npc_parallel";
const HISTORY_LIMIT = 30;
const clone = <T>(value: T): T => structuredClone(value);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (res: ServerResponse, status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
async function body(req: IncomingMessage) { let bytes = 0, text = ""; for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) throw Error("侧写设置请求过大"); text += chunk; } return JSON.parse(text || "{}"); }

export class NpcSidewriteHttp {
	readonly store: TavernPluginStore;
	readonly host: NpcSidewriteHost;
	readonly #switchPath: string;
	#running = 0;

	constructor(cwd: string, host: NpcSidewriteHost) {
		this.host = host;
		mkdirSync(join(cwd, ROOT), { recursive: true, mode: 0o700 });
		this.store = new TavernPluginStore(join(cwd, ROOT));
		this.#switchPath = join(cwd, ROOT, "state.json");
	}

	busy(): boolean { return this.#running > 0; }

	/** 外层模块开关（全局）；沿用旧 state.json 的 enabled 字段。默认关。 */
	switchedOn(): boolean {
		try { return existsSync(this.#switchPath) && JSON.parse(readFileSync(this.#switchPath, "utf8")).enabled === true; } catch { return false; }
	}

	#setSwitch(enabled: boolean): void {
		mkdirSync(dirname(this.#switchPath), { recursive: true, mode: 0o700 });
		writeJsonAtomicWithBackup(this.#switchPath, { schema: 2, implementation: NPC_SIDEWRITE_VERSION, enabled });
	}

	scopeGuard(scope: NpcParallelScope): void {
		const current = this.host.binding();
		if (current.sessionId !== scope.sessionId || current.card !== scope.card || (!current.visibleEntryIds.includes(scope.sourceEntryId) && current.sourceEntryId !== scope.sourceEntryId))
			throw Object.assign(Error("侧写会话、卡或祖先来源已改变"), { statusCode: 409 });
	}

	settings(scope = this.host.binding()): NpcSidewriteSettings {
		const state = this.store.read(scope).state;
		const raw = state.extensionSettings[SETTINGS_KEY] as Record<string, unknown> | undefined;
		const meta = state.chatMetadata[SETTINGS_KEY] as { ignoredNpcs?: unknown } | undefined;
		// 旧原插件把忽略名单放在 chatMetadata；读取时并入，保存后统一放在设置里。
		const merged = { ...(raw ?? {}), ignored: [...(Array.isArray(raw?.ignored) ? raw!.ignored as unknown[] : []), ...(Array.isArray(meta?.ignoredNpcs) ? meta!.ignoredNpcs : [])] };
		return normalizeNpcSidewriteSettings(merged);
	}

	enabled(scope = this.host.binding()): boolean {
		return this.switchedOn() && this.host.config().ecologyEnabled && !!this.host.config().model && this.settings(scope).enabled;
	}

	provider(): NpcParallelProvider {
		return {
			enabled: () => this.enabled(),
			claimRequest: (scope, guard) => { this.store.recordModelRequest(scope, () => { guard(); this.scopeGuard(scope); }); },
			generate: input => this.generate(input),
		};
	}

	/** 名单：已提交的生态人物 + 账本名册；排除主角、角色卡名与忽略名单。 */
	roster(input: Pick<NpcParallelGenerationInput, "ecology" | "state" | "userName" | "charName">, settings: NpcSidewriteSettings): NpcSidewriteCandidate[] {
		const ignored = new Set(settings.ignored), skip = (name: string) => !name.trim() || name === input.userName || name === input.charName || ignored.has(name);
		const roster = new Map<string, NpcSidewriteCandidate>();
		for (const actor of input.ecology.actors) {
			if (skip(actor.name) || roster.has(actor.name)) continue;
			const notes = [actor.location && `位置：${actor.location}`, actor.activity && `近况：${actor.activity}`, actor.shortGoal && `短期目标：${actor.shortGoal}`, actor.longGoal && `长期目标：${actor.longGoal}`].filter(Boolean).join("；");
			roster.set(actor.name, { name: actor.name, notes, weight: settings.weights[actor.name] ?? (actor.tier === "background" ? 1 : 2) });
		}
		for (const [name, notes] of Object.entries(input.state.roster?.characters ?? {})) {
			if (skip(name) || roster.has(name)) continue;
			roster.set(name, { name, notes: String(notes ?? ""), weight: settings.weights[name] ?? 1 });
		}
		return [...roster.values()].slice(0, 48);
	}

	/** 已采纳侧写里该人物最近一段，用于续写衔接。 */
	#previousText(name: string, scope: NpcParallelScope): string | undefined {
		const branch = this.host.branch().filter(e => e.id && scope.visibleEntryIds.includes(e.id) && e.id !== scope.sourceEntryId);
		for (let i = branch.length - 1; i >= 0; i--) {
			const receipt = npcReceiptFromBranch(branch, branch[i].id!);
			if (receipt?.status !== "accepted") continue;
			const entry = receipt.entries.find(e => e.name === name && e.status === "accepted");
			if (entry) return entry.text;
		}
	}

	#storyPassages(scope: NpcParallelScope, narrative: string): string[] {
		const earlier = this.host.branch().filter(e => e.id && scope.visibleEntryIds.includes(e.id) && e.id !== scope.sourceEntryId && e.type === "message" && e.message?.role === "assistant" && typeof e.message?.details?.rpNarrative === "string").map(e => e.message.details.rpNarrative as string).reverse();
		return [narrative, ...earlier];
	}

	async generate(input: NpcParallelGenerationInput): Promise<NpcParallelBatch> {
		const { scope } = input;
		const guard = () => { input.guard(); this.scopeGuard(scope); };
		guard();
		if (!this.enabled(scope)) throw Error("众生侧写或鲜活世界未启用，或独立模型岗位未配置");
		const upstream = { version: NPC_SIDEWRITE_VERSION, commit: NPC_SIDEWRITE_COMMIT };
		if (input.admissionCandidateHashes) {
			if (!input.explicitRetry) throw Error("仅显式补办可复用已保存候选，未请求模型");
			const batch = savedNpcAdmissionBatch(this.host.branch(), scope, input.admissionCandidateHashes, upstream, input.ecology);
			const settings = this.settings(scope);
			if (batch.entries.some(e => settings.ignored.includes(e.name) || e.name === input.userName || e.name === input.charName)) throw Error("候选人物已被忽略或不属于侧写岗位，未请求模型");
			return batch;
		}
		const settings = this.settings(scope);
		let current = this.store.read(scope);
		const roster = this.roster(input, settings);
		const narrativeHash = sha(input.narrative);
		const materialHash = sha(JSON.stringify([roster, settings, NPC_SIDEWRITE_VERSION]));
		// 同一来源、同一材料：已完成的批次直接复用，不重复收费。
		const cached = current.state.messages[scope.sourceEntryId]?.extra?.npc_parallel_batch as { narrativeHash?: string; materialHash?: string; batch?: NpcParallelBatch } | undefined;
		if (cached?.batch && cached.narrativeHash === narrativeHash && cached.materialHash === materialHash && cached.batch.commit === upstream.commit && !cached.batch.errors?.length) {
			try { sealNpcCandidates(cached.batch, scope, input.ecology); return { ...clone(cached.batch), cached: true }; } catch { /* 无效缓存：重新生成 */ }
		}
		const history = Array.isArray(current.state.chatMetadata.npc_sidewrite_history) ? (current.state.chatMetadata.npc_sidewrite_history as unknown[]).filter((r): r is string[] => Array.isArray(r) && r.every(n => typeof n === "string")) : [];
		const anchor = sidewriteAnchor(roster.map(n => n.name), this.#storyPassages(scope, input.narrative));
		const targets = pickSidewriteTargets(roster, settings, history, anchor);
		const save = (batch: NpcParallelBatch, recordHistory: boolean) => {
			const state = clone(current.state);
			state.messages[scope.sourceEntryId] = { ...state.messages[scope.sourceEntryId], extra: { ...state.messages[scope.sourceEntryId]?.extra, npc_parallel_batch: { sourceEntryId: scope.sourceEntryId, materialHash, settingsHash: sha(JSON.stringify(settings)), narrativeHash, batch } } };
			if (recordHistory) state.chatMetadata.npc_sidewrite_history = [...history, batch.entries.map(entry => entry.name)].slice(-HISTORY_LIMIT);
			this.store.save(scope, current.revision, state, guard);
			current = this.store.read(scope);
		};
		if (!targets.length) {
			const batch: NpcParallelBatch = { ...upstream, entries: [], calls: 0, errors: [] };
			save(batch, false);
			return batch;
		}
		const prompt = buildSidewritePrompt({
			targets: targets.map(name => ({ name, notes: roster.find(n => n.name === name)?.notes ?? "", previous: this.#previousText(name, scope) })),
			narrative: input.narrative, userName: input.userName, settings,
		});
		this.#running++;
		try {
			let raw: string;
			try {
				raw = await input.generate({ messages: [{ role: "system", content: prompt.systemPrompt }, { role: "user", content: prompt.userText }], maxTokens: prompt.maxTokens, purpose: "npc-sidewrite" }, input.signal);
			} catch (error) {
				guard();
				const batch: NpcParallelBatch = { ...upstream, entries: [], calls: 1, errors: [npcFailureReason(error)], selectedTargets: targets, targets: targets.map(name => ({ name, status: "unresolved" as const })) };
				save(batch, false);
				return batch;
			}
			guard();
			const parsed = parseSidewriteOutput(raw, targets);
			const entries = targets.flatMap(name => parsed.get(name) ? [parsed.get(name)!] : []);
			const missing = targets.filter(name => !parsed.has(name));
			// 缺人不重试也不报错：写出来的人照常候选，没写出来的这轮跳过（人数本就不必凑满）。
			const batch: NpcParallelBatch = { ...upstream, entries, calls: 1, errors: entries.length ? [] : ["schema format failure：侧写输出里没有可识别的人物块"], selectedTargets: targets, targets: targets.map(name => ({ name, status: missing.includes(name) ? "unresolved" as const : "generated" as const })) };
			sealNpcCandidates(batch, scope, input.ecology);
			save(batch, entries.length > 0);
			return batch;
		} finally { this.#running--; }
	}

	status() {
		const scope = this.host.binding(), config = this.host.config(), settings = this.settings(scope);
		const receipt = npcReceiptFromBranch(this.host.branch(), scope.sourceEntryId);
		return {
			implementation: NPC_SIDEWRITE_VERSION, enabled: this.switchedOn(), executionEnabled: this.enabled(scope),
			ecologyEnabled: config.ecologyEnabled, model: config.model, busy: this.host.isBusy() || this.busy(),
			scopeKey: tavernPluginScope(scope), sourceEntryId: scope.sourceEntryId, revision: this.store.read(scope).revision,
			settings, requestBudget: this.store.modelRequestBudget(scope),
			...(receipt ? { receipt: { status: receipt.status, sourceEntryId: receipt.sourceEntryId, total: receipt.entries.length, accepted: receipt.entries.filter(e => e.status === "accepted").length, rejected: receipt.entries.filter(e => e.status !== "accepted").length, retained: receipt.retainedEntries?.length ?? 0, ...(receipt.reason ? { reason: npcFailureReason(receipt.reason) } : {}) } } : {}),
		};
	}

	async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (!path.startsWith("/api/npc-parallel/")) return false;
		try {
			if (req.method === "GET" && path === "/api/npc-parallel/status") { json(res, 200, this.status()); return true; }
			if (req.method === "PUT" && (path === "/api/npc-parallel/config" || path === "/api/npc-parallel/settings")) {
				if (this.host.isBusy() || this.busy()) throw Object.assign(Error("正文或生态结算进行中，请稍后再改侧写设置"), { statusCode: 409 });
				const scope = this.host.binding(), data = await body(req), saved = this.store.read(scope);
				// Reading a streamed body yields: management writes require the same current head, not just an ancestor.
				const guard = () => {
					const current = this.host.binding();
					if (current.sessionId !== scope.sessionId || current.card !== scope.card || current.sourceEntryId !== scope.sourceEntryId)
						throw Object.assign(Error("侧写设置来源已过期，请刷新后重试"), { statusCode: 409 });
					if (this.host.isBusy() || this.busy()) throw Object.assign(Error("侧写设置提交前宿主已忙"), { statusCode: 409 });
				};
				guard();
				if (data.scopeKey !== tavernPluginScope(scope) || data.sourceEntryId !== scope.sourceEntryId || data.revision !== saved.revision)
					throw Object.assign(Error("侧写设置来源或版本已过期，请刷新后重试"), { statusCode: 409 });
				if (path.endsWith("/config")) {
					if (typeof data.enabled !== "boolean") throw Error("缺少开关值");
					if (data.enabled && !this.host.config().ecologyEnabled) throw Error("请先启用鲜活世界；不自动开启其它模块");
					if (data.enabled && !this.host.config().model) throw Error("众生侧写独立模型岗位未配置");
					guard(); this.#setSwitch(data.enabled);
				} else {
					const next = clone(saved.state);
					const settings = normalizeNpcSidewriteSettings({ ...data.settings, enabled: data.settings?.enabled !== false });
					next.extensionSettings[SETTINGS_KEY] = settings;
					const meta = next.chatMetadata[SETTINGS_KEY] as Record<string, unknown> | undefined;
					if (meta && "ignoredNpcs" in meta) { const rest = { ...meta }; delete rest.ignoredNpcs; next.chatMetadata[SETTINGS_KEY] = rest; }
					this.store.save(scope, saved.revision, next, guard);
				}
				json(res, 200, this.status()); return true;
			}
			if (req.method === "GET" && path === "/api/npc-parallel/roster") {
				const scope = this.host.binding(), m = this.host.materials();
				const settings = this.settings(scope);
				const all = this.roster({ ecology: this.host.ecology(), state: { roster: { characters: {} } } as never, userName: m.config.userName, charName: m.card.name }, { ...settings, ignored: [] });
				json(res, 200, { names: all.map(n => n.name), ignored: settings.ignored, weights: settings.weights }); return true;
			}
			json(res, 404, { error: "未支持的众生侧写接口" }); return true;
		} catch (error) {
			const e = error as { statusCode?: number; code?: string };
			json(res, e.code === "ENOSPC" || e.code === "EDQUOT" ? 507 : e.statusCode ?? 400, { error: error instanceof Error ? error.message : "侧写操作失败" }); return true;
		}
	}
}
