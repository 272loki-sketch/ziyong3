/** 只读回合性能投影。collector 显式归属一拍；不得从可变的全局“当前拍”取 owner。 */
export const TURN_PERFORMANCE_ENTRY_TYPE = "rp-turn-performance";
export const PERFORMANCE_PHASES = [
	"prep", "agent.evidence", "agent.ideas", "agent.review", "settlement.recovery", "prep.arrival", "prep.continuity", "prep.novelCalibration", "prep.plotAdaptation",
	"prep.director", "prep.sceneConductor", "prep.database", "prep.memoryRecall", "prep.memoryArcs",
	"writer", "settlement.planFact", "settlement.scribe", "settlement.worldFacts",
	"settlement.worldProposal", "settlement.worldAudit", "settlement.world", "settlement.ecology", "settlement.rewrite", "settlement.memory", "settlement.tavern", "settlement.supplementary", "curtain", "compaction",
] as const;
export type PerformancePhase = typeof PERFORMANCE_PHASES[number];
export type PerformanceStatus = "success" | "degraded" | "failed" | "aborted" | "skipped";
const PERFORMANCE_REASONS = ["merged-database-recall", "upstream-plugin-managed", "missing-director-candidate"] as const;
export type PerformanceReason = typeof PERFORMANCE_REASONS[number];
export interface DatabaseRequestObservation { collector: TurnPerformanceCollector; phase: "prep.database" | "settlement.memory" }
export interface PhasePerformance {
	durationMs: number;
	calls: number;
	inputTokens?: number;
	outputTokens?: number;
	/** 有 usage 的 harness attempts 数；tokens 是已取得数据之和，不伪称完整供应商统计。 */
	usageCalls?: number;
	status?: PerformanceStatus;
	reason?: PerformanceReason;
}
export interface RequestCallPerformance {id:string;phase:string;model:string;durationMs?:number;firstTokenMs?:number;inputTokens?:number;outputTokens?:number;totalTokens?:number;status:string;usageSource:"missing"|"provider-sdk"}
export interface TurnPerformance {
 requests?:RequestCallPerformance[];
	version: 1;
	narrativeEntryId: string;
	totalMs: number;
	timeToFirstNarrativeMs?: number;
	/** 正文＋原格式已持久化并可展示，区别于包含后台结算的 totalMs。 */
	timeToAuthorReadyMs?: number;
	phases: Partial<Record<PerformancePhase, PhasePerformance>>;
	callsScope: "harness-attempts";
	providerRetries: "unknown";
}

type Phase = { intervals: Array<[number, number]>; open: Map<symbol, number>; calls: number; inputTokens?: number; outputTokens?: number; usageCalls: number; status?: PerformanceStatus; reason?: PerformanceReason };
const numeric = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const STATUS = ["success", "degraded", "failed", "aborted", "skipped"] as const;
const unionMs = (intervals: Array<[number, number]>): number => {
	let total = 0, end = -Infinity;
	for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
		total += Math.max(0, stop - Math.max(start, end));
		end = Math.max(end, stop);
	}
	return Math.round(total);
};

export class TurnPerformanceCollector {
	#now: () => number;
	#start: number;
	#first?: number;
	#authorReady?: number;
	#closed = false;
	#phases = new Map<PerformancePhase, Phase>();
	constructor(now = () => performance.now()) { this.#now = now; this.#start = now(); }
	#phase(name: PerformancePhase): Phase {
		let phase = this.#phases.get(name);
		if (!phase) { phase = { intervals: [], open: new Map(), calls: 0, usageCalls: 0 }; this.#phases.set(name, phase); }
		return phase;
	}
	beginPhase(name: PerformancePhase): (status?: PerformanceStatus) => void {
		if (this.#closed) return () => {};
		const phase = this.#phase(name), token = Symbol();
		phase.open.set(token, this.#now());
		return (status) => {
			if (this.#closed) return;
			const start = phase.open.get(token);
			if (start === undefined) return;
			phase.open.delete(token); phase.intervals.push([start, this.#now()]);
			if (status) phase.status = status;
		};
	}
	beginCall(name: PerformancePhase): { usage: (usage: unknown) => void; end: (status?: PerformanceStatus) => void } {
		if (this.#closed) return { usage: () => {}, end: () => {} };
		const phase = this.#phase(name); phase.calls++;
		const end = this.beginPhase(name);
		let recorded = false;
		return { end, usage: (raw) => {
			if (this.#closed || recorded) return;
			const usage = object(raw); if (!usage) return;
			const input = numeric(usage.input), output = numeric(usage.output);
			if (input === undefined && output === undefined) return;
			recorded = true; phase.usageCalls++;
			if (input !== undefined) phase.inputTokens = (phase.inputTokens ?? 0) + input + (numeric(usage.cacheRead) ?? 0) + (numeric(usage.cacheWrite) ?? 0);
			if (output !== undefined) phase.outputTokens = (phase.outputTokens ?? 0) + output;
		} };
	}
	narrative(): void { if (!this.#closed && this.#first === undefined) this.#first = this.#now(); }
	status(name: PerformancePhase, status: PerformanceStatus, reason?: PerformanceReason): void { if (!this.#closed) { const phase = this.#phase(name); phase.status = status; phase.reason = reason; } }
	authorReady(): void { if (!this.#closed && this.#authorReady === undefined) this.#authorReady = this.#now(); }
	finish(narrativeEntryId: string): TurnPerformance {
		const now = this.#now(); this.#closed = true;
		const phases: TurnPerformance["phases"] = {};
		for (const [name, phase] of this.#phases) {
			phases[name] = {
				durationMs: unionMs([...phase.intervals, ...[...phase.open.values()].map((start): [number, number] => [start, now])]),
				calls: phase.calls,
				...(phase.inputTokens !== undefined ? { inputTokens: phase.inputTokens } : {}),
				...(phase.outputTokens !== undefined ? { outputTokens: phase.outputTokens } : {}),
				...(phase.usageCalls ? { usageCalls: phase.usageCalls } : {}),
				...(phase.status ? { status: phase.status } : {}),
				...(phase.reason ? { reason: phase.reason } : {}),
			};
		}
		return { version: 1, narrativeEntryId, totalMs: Math.max(0, Math.round(now - this.#start)), ...(this.#authorReady !== undefined ? { timeToAuthorReadyMs: Math.max(0, Math.round(this.#authorReady - this.#start)) } : {}), ...(this.#first !== undefined ? { timeToFirstNarrativeMs: Math.max(0, Math.round(this.#first - this.#start)) } : {}), phases, callsScope: "harness-attempts", providerRetries: "unknown" };
	}
}

/** 白名单投影：忽略 prompt、reasoning、任意 phase 名和额外字段。 */
export function projectTurnPerformance(value: unknown, narrativeEntryId: string): TurnPerformance | undefined {
	const raw = object(value);
	if (!raw || raw.version !== 1 || raw.narrativeEntryId !== narrativeEntryId || numeric(raw.totalMs) === undefined) return undefined;
	const totalMs = Math.round(raw.totalMs as number), phases: TurnPerformance["phases"] = {}, rawPhases = object(raw.phases);
	for (const name of PERFORMANCE_PHASES) {
		const row = object(rawPhases?.[name]); if (!row || numeric(row.durationMs) === undefined || numeric(row.calls) === undefined) continue;
		const phase: PhasePerformance = { durationMs: Math.round(row.durationMs as number), calls: Math.floor(row.calls as number) };
		for (const key of ["inputTokens", "outputTokens", "usageCalls"] as const) { const n = numeric(row[key]); if (n !== undefined) phase[key] = Math.floor(n); }
		if (STATUS.includes(row.status as PerformanceStatus)) phase.status = row.status as PerformanceStatus;
		if (PERFORMANCE_REASONS.includes(row.reason as PerformanceReason)) phase.reason = row.reason as PerformanceReason;
		phases[name] = phase;
	}
	const first = numeric(raw.timeToFirstNarrativeMs);
	const authorReady = numeric(raw.timeToAuthorReadyMs);
 const requests=Array.isArray(raw.requests)?raw.requests.slice(0,100).flatMap(value=>{const row=object(value);if(!row||typeof row.id!=="string"||typeof row.phase!=="string"||typeof row.model!=="string"||!row.status)return [];const call:RequestCallPerformance={id:row.id.slice(0,80),phase:row.phase.slice(0,80),model:row.model.slice(0,150),status:String(row.status).slice(0,20),usageSource:row.usageSource==="provider-sdk"?"provider-sdk":"missing"};for(const key of["durationMs","firstTokenMs","inputTokens","outputTokens","totalTokens"]as const){const number=numeric(row[key]);if(number!==undefined)call[key]=Math.round(number);}return[call];}):undefined;
	return { version: 1, narrativeEntryId, totalMs, ...(authorReady !== undefined && authorReady <= totalMs ? { timeToAuthorReadyMs: Math.round(authorReady) } : {}), ...(requests?{requests}:{}), ...(first !== undefined && first <= totalMs ? { timeToFirstNarrativeMs: Math.round(first) } : {}), phases, callsScope: "harness-attempts", providerRetries: "unknown" };
}
