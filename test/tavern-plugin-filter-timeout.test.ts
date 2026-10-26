import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@liyuan/agent-runtime";
import { StageEngine, type StageStreamFn, type StageTurnEndInfo } from "../src/stage/engine.ts";
import { SUPPLEMENTARY_PROTOCOL } from "../src/stage/supplementary.ts";

// Synthetic-only: the native worldbook filter runs before the user row is saved, so it must be bounded.
type Before = (packet: any, signal?: AbortSignal) => Promise<any>;
const TIMEOUT = "timeout" as const;
const within = <T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([work, new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), ms); })]).finally(() => clearTimeout(timer));
};
const retainAll = (packet: any) => ({ ...packet, retainedWorldbookIndices: packet.worldbookEntries.map((_: unknown, index: number) => index) });
// The same hook also preprocesses the assembled generation prompt (no worldbookEntries); that call passes through.
const filterOnly = (before: Before): Before => async (packet, signal) => packet.worldbookEntries ? before(packet, signal) : packet;

function fixture(before: Before, timeoutMs?: number) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-filter-timeout-"));
	writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "Synthetic keeper", description: "Synthetic description", first_mes: "Synthetic greeting.",
		character_book: { entries: [{ id: 1, keys: [], constant: true, enabled: true, content: "Synthetic constant lore." }] } } }));
	mkdirSync(join(cwd, ".liyuan"));
	cpSync(new URL("../skills/", import.meta.url), join(cwd, "skills"), { recursive: true });
	const steps = ["literaryDirector", "literaryContinuity", "directorSetting", "directorIdeas", "directorReviewFacts", "directorReviewStyle", "ecologyRuntime", "scribe"];
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", generationMode: "direct", literaryWorldEnabled: false, literaryEcologyEnabled: false,
		stepModels: Object.fromEntries(steps.map(id => [id, { provider: "faux", id }])) }));
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	const requests: string[] = [], activity: string[] = [], notes: string[] = [], ended: StageTurnEndInfo[] = [];
	const streamFn: StageStreamFn = (model, context) => {
		const supplementary = String(context.systemPrompt ?? "").startsWith(SUPPLEMENTARY_PROTOCOL);
		requests.push(supplementary ? "supplementary" : model.id);
		const text = supplementary ? JSON.stringify({ version: 2, narrative: null, items: [] })
			: model.id === "writer" ? "<content>Synthetic keeper answers.</content>"
			: model.id === "scribe" ? '{"patch":{"location":"Synthetic room"}}'
			: model.id === "literaryDirector" ? '{"scenePressure":"Existing task","candidateBeats":["Check the log"]}'
			: '{"summary":"Synthetic report","facts":[],"inferences":[],"candidates":[],"issues":[],"actors":[],"occurrences":[]}';
		const message: any = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 10, output: 10 } };
		return { async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: text }; yield { type: "done", message }; }, async result() { return message; } } as never;
	};
	const model = { id: "writer", provider: "faux", maxTokens: 10000 };
	const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, findModel: (provider, id) => ({ ...model, provider, id }), getAuth: async () => ({}), streamFn,
		events: { onActivity: detail => activity.push(detail), onNotify: (_level, text) => notes.push(text), onTurnEnd: info => ended.push(info) },
		tavernPlugins: { enabled: () => true, before: filterOnly(before), after: async () => {} },
		...(timeoutMs === undefined ? {} : { tavernPluginFilterTimeoutMs: timeoutMs }) } as never);
	const users = () => (sm.getBranch() as any[]).filter(entry => entry.type === "message" && entry.message?.role === "user");
	return { cwd, sm, engine, requests, activity, notes, ended, users, cleanup() { engine.abort(); rmSync(cwd, { recursive: true, force: true }); } };
}

test("hanging native worldbook filter rejects the turn within its bound before saving input; the next turn works", { timeout: 30_000 }, async () => {
	let hang = true;
	const releases: Array<() => void> = [], signals: AbortSignal[] = [], acks: string[] = [];
	const f = fixture(async (packet, signal) => {
		if (signal) signals.push(signal);
		if (hang) await new Promise<void>(resolve => { releases.push(resolve); });
		return retainAll(packet);
	}, 50);
	const submission = (id: string) => ({ generationMode: "direct" as const, clientMessageId: id, onAccepted: () => acks.push(`accepted:${id}`), onRejected: (reason: string) => acks.push(`rejected:${id}:${reason}`) });
	const first = f.engine.performTurn("Synthetic first input.", submission("m1"));
	try {
		const started = Date.now();
		const outcome = await within(first, 3000);
		assert.notEqual(outcome, TIMEOUT, "a never-resolving filter must not hold the unsaved input past its bound");
		assert.ok(Date.now() - started < 3000);
		assert.equal(acks.length, 1, JSON.stringify(acks));
		assert.match(acks[0]!, /^rejected:m1:/);
		assert.match(acks[0]!, /世界书过滤超时/);
		assert.match(acks[0]!, /未受理/);
		assert.match(acks[0]!, /草稿保留/);
		assert.equal(f.users().length, 0, "the timed-out input must not be appended");
		assert.deepEqual(f.requests, [], "no model request may run after a failed pre-save filter");
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.aborted, true, "the plugin runtime must see an aborted signal so it discards its page/browser");
		assert.match(f.ended.at(-1)?.error ?? "", /世界书过滤超时/);
		assert.equal(f.ended.at(-1)?.entryId, undefined);
		assert.ok(f.activity.includes("正在准备酒馆插件世界书过滤…"));

		hang = false;
		const second = await within(f.engine.performTurn("Synthetic second input.", submission("m2")), 15_000);
		assert.notEqual(second, TIMEOUT, "the engine must not stay busy after a filter timeout");
		assert.ok(acks.includes("accepted:m2"), JSON.stringify(acks));
		assert.equal(f.users().length, 1);
		assert.ok(f.requests.includes("writer"), f.notes.join("\n"));
		assert.equal(signals.length, 2);
		assert.equal(signals[1]!.aborted, false, "the next turn uses a fresh, live signal");
	} finally {
		f.engine.abort(); for (const release of releases) release();
		await within(first, 5000);
		f.cleanup();
	}
});

test("user stop during a hanging native worldbook filter settles promptly without saving or timeout wording", { timeout: 30_000 }, async () => {
	const releases: Array<() => void> = [], acks: string[] = [];
	let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
	const f = fixture(async packet => { entered(); await new Promise<void>(resolve => { releases.push(resolve); }); return retainAll(packet); }, 60_000);
	const turn = f.engine.performTurn("Synthetic input.", { generationMode: "direct", clientMessageId: "m1", onAccepted: () => acks.push("accepted"), onRejected: reason => acks.push(`rejected:${reason}`) });
	try {
		assert.notEqual(await within(enteredPromise, 5000), TIMEOUT);
		f.engine.abort();
		assert.notEqual(await within(turn, 2000), TIMEOUT, "stop must not wait for an unresponsive plugin");
		assert.equal(f.users().length, 0);
		assert.deepEqual(f.requests, []);
		assert.ok(!acks.includes("accepted"));
		assert.ok(!acks.some(ack => /超时/.test(ack)), "a user stop is not a timeout");
		assert.ok(f.ended.at(-1)?.error);
	} finally {
		for (const release of releases) release();
		await within(turn, 5000);
		f.cleanup();
	}
});

test("fast native worldbook filter path is unchanged and announces progress before the filter runs", { timeout: 30_000 }, async () => {
	const signals: AbortSignal[] = [], acks: string[] = [];
	let activityAtCall = -1;
	const f = fixture(async (packet, signal) => { if (signal) signals.push(signal); activityAtCall = f.activity.indexOf("正在准备酒馆插件世界书过滤…"); return retainAll(packet); });
	try {
		await f.engine.performTurn("Synthetic input.", { generationMode: "direct", clientMessageId: "m1", onAccepted: () => acks.push("accepted"), onRejected: reason => acks.push(`rejected:${reason}`) });
		assert.deepEqual(acks, ["accepted"]);
		assert.equal(f.users().length, 1);
		assert.ok(f.requests.includes("writer"), f.notes.join("\n"));
		assert.ok(activityAtCall >= 0, "progress note must be emitted before the filter starts");
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.aborted, false, "the bound must not fire after a fast filter");
		assert.ok(!f.notes.some(note => /世界书过滤超时/.test(note)));
	} finally { f.cleanup(); }
});

test("default native worldbook filter bound stays above the existing 45 s MVU-ready wait", async () => {
	const engine: Record<string, unknown> = await import("../src/stage/engine.ts");
	assert.equal(engine.TAVERN_WORLDBOOK_FILTER_TIMEOUT_MS, 120_000);
});
