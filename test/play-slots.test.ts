import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { DIRECTOR_ROLES } from "../src/stage/agent-director.ts";
import { PlaySlots } from "../server/play-slots.ts";

async function until(check: () => boolean, timeout = 15_000): Promise<void> {
	const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await new Promise(ok => setTimeout(ok, 20)); } throw Error("synthetic wait timed out");
}
async function listen(server: ReturnType<typeof createServer>): Promise<string> { await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
function connect(base: string, id: string, cookie = "fixture-parent=allowed", origin?: string) {
	const frames: any[] = []; const ws = new WebSocket(base.replace("http:", "ws:") + `/api/play-slots/${id}/ws`, { headers: { cookie, ...(origin ? { origin } : {}) } }); ws.on("message", raw => frames.push(JSON.parse(raw.toString()))); ws.on("error", () => {}); return { ws, frames };
}

test("three real isolated workers, same-engine concurrent generation, pause/resume, permissions and authenticated gateway (synthetic only)", { timeout: 150_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-play-slots-test-"));
	let supervisor: PlaySlots | undefined, gateway: ReturnType<typeof createServer> | undefined, model: ReturnType<typeof createServer> | undefined;
	const clients: WebSocket[] = []; let modelCalls = 0, writerCalls = 0;
	let release!: () => void; const writing = new Promise<void>(ok => { release = ok; });
	let allowed = true;
	try {
		model = createServer((req, res) => { void (async () => {
			let raw = ""; for await (const chunk of req) raw += chunk;
			const data = JSON.parse(raw); modelCalls++;
			let content: string;
			let toolCall: { name: string; arguments: Record<string, unknown> } | undefined;
			const isDirector = (data.messages as any[]).some(message => JSON.stringify(message.content).includes("【流程阶段】"));
			if (data.model === "writer" && isDirector) {
				const calls = (data.messages as any[]).flatMap(message => message.tool_calls ?? []).map(call => call.function.name);
				const consults = calls.filter(name => name === "consult_experts").length;
				const draft = (data.messages as any[]).some(message => message.role === "assistant" && typeof message.content === "string" && message.content.includes("合成正文 C"));
				if (consults < 2 || draft && consults < 3) {
					const phase = consults === 0 ? "evidence" : consults === 1 ? "ideas" : "review";
					toolCall = { name: "consult_experts", arguments: { tasks: DIRECTOR_ROLES[phase].map((role, index) => ({ role, task: `合成独立岗位简报${index}` })) } };
				} else if (!calls.includes("begin_narrative")) toolCall = { name: "begin_narrative", arguments: {} };
				else if (draft) toolCall = { name: "finalize", arguments: {} };
			}
			if (toolCall) content = "";
			else if (data.model === "writer") {
				writerCalls++; await writing;
				const messages = JSON.stringify(data.messages);
				content = messages.includes("A-only-input") ? "合成正文 A：甲独自推开门。" : messages.includes("B-only-input") ? "合成正文 B：乙在湖边坐下。" : "合成正文 C：丙翻开自己的书。";
			} else if (data.model === "director") content = JSON.stringify({ scenePressure: "已有场景", characterInitiatives: [{ character: "合成人物", motive: "继续故事", immediateIntent: "观察", limit: "已知事实" }], candidateBeats: ["继续场景"] });
			else if (data.model === "expert") content = JSON.stringify({ summary: "合成独立报告，无需改动正文", facts: [], inferences: [], candidates: [], issues: [] });
			else content = JSON.stringify({ patch: { location: "合成场景" } });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ id: `synthetic-${modelCalls}`, object: "chat.completion", created: 1, model: data.model, choices: [{ index: 0, message: { role: "assistant", content, ...(toolCall ? { tool_calls: [{ id: `fixture-tool-${modelCalls}`, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] } : {}) }, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }));
		})().catch(() => { res.writeHead(500); res.end(); }); });
		const modelBase = await listen(model);
		mkdirSync(join(cwd, "cards"));
		for (const name of ["A", "B", "C"]) writeFileSync(join(cwd, `cards/${name}.json`), JSON.stringify({ data: { name: `合成卡${name}`, description: `独立人物${name}`, first_mes: `${name}合成开场，不使用生产资料。` } }));
		const stage = { card: "cards/A.json", userName: "合成玩家", userPersona: "合成身份", greeting: true, generationMode: "direct", literaryWorldEnabled: false, literaryEcologyEnabled: false, novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false }, stepModels: { literaryDirector: { provider: "fixture", id: "director" }, scribe: { provider: "fixture", id: "scribe" }, ...Object.fromEntries(["literaryContinuity", "directorSetting", "ecologyRuntime", "directorIdeas", "directorReviewFacts", "directorReviewStyle"].map(step => [step, { provider: "fixture", id: "expert" }])) } };
		const agent = { version: 1, defaultProvider: "fixture", defaultModel: "writer", defaultThinkingLevel: "off", providers: { fixture: { baseUrl: `${modelBase}/v1`, api: "openai-completions", apiKey: "synthetic-not-real", compat: { streaming: false, supportsTools: true, supportsDeveloperRole: false }, models: [{ id: "writer" }, { id: "director" }, { id: "scribe" }, { id: "expert" }] } } };
		supervisor = new PlaySlots(cwd, { cardFile(card) { if (!["cards/A.json", "cards/B.json", "cards/C.json"].includes(card)) throw Error("not allowed"); return { file: join(cwd, card), name: `合成卡${card.at(-6)}` }; }, snapshot: () => ({ config: stage, agent }), authorized: req => allowed && req.headers.cookie === "fixture-parent=allowed" });
		gateway = createServer((req, res) => { void supervisor!.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
		gateway.on("upgrade", (req, socket, head) => { if (!supervisor!.handleUpgrade(req, socket, head)) socket.destroy(); });
		const base = await listen(gateway);
		const create = async (card: string) => { const response = await fetch(base + "/api/play-slots", { method: "POST", headers: { cookie: "fixture-parent=allowed", "content-type": "application/json" }, body: JSON.stringify({ card }) }); const body = await response.json() as any; assert.equal(response.status, 201, JSON.stringify(body)); return body.slot; };
		supervisor.assertCanRestart();
		const [a, b, c] = await Promise.all([create("cards/A.json"), create("cards/B.json"), create("cards/C.json")]);
		assert.equal(supervisor.list().filter(slot => slot.state === "running").length, 3);
		assert.throws(() => supervisor!.assertCanRestart(), /暂停全部卡位/);
		await assert.rejects(supervisor.create("cards/A.json"), /三个/);
		assert.equal((await fetch(base + "/api/play-slots")).status, 403);
		assert.equal((await fetch(base + "/api/play-slots", { headers: { cookie: "fixture-parent=allowed", origin: "http://evil.invalid" } })).status, 403);
		const denied = connect(base, a.id, "fixture-parent=denied"); clients.push(denied.ws); await new Promise(ok => denied.ws.once("close", ok)); assert.deepEqual(denied.frames, []);
		const foreign = connect(base, a.id, "fixture-parent=allowed", "http://evil.invalid"); clients.push(foreign.ws); await new Promise(ok => foreign.ws.once("close", ok)); assert.deepEqual(foreign.frames, []);
		const ca = connect(base, a.id), cb = connect(base, b.id), cc = connect(base, c.id); clients.push(ca.ws, cb.ws, cc.ws);
		await until(() => [ca, cb, cc].every(client => client.frames.some(frame => frame.type === "hello")));
		const session = (client: typeof ca) => client.frames.find(frame => frame.type === "hello").sessionId;
		assert.equal(new Set([session(ca), session(cb), session(cc)]).size, 3);
		const ida = randomUUID(), idb = randomUUID(), idc = "m-synthetic-fallback-1";
		ca.ws.send(JSON.stringify({ type: "prompt", text: "A-only-input", sessionId: session(ca), messageId: ida, generationMode: "direct" }));
		cb.ws.send(JSON.stringify({ type: "prompt", text: "B-only-input", sessionId: session(cb), messageId: idb, generationMode: "direct" }));
		cc.ws.send(JSON.stringify({ type: "prompt", text: "C-only-input", sessionId: session(cc), messageId: idc, generationMode: "director" }));
		await until(() => writerCalls === 3, 40_000);
		assert.equal(supervisor.list().find(slot => slot.id === a.id)!.busy, true);
		await assert.rejects(supervisor.pause(a.id));
		// All three writer requests have reached the held synthetic provider concurrently.
		assert.equal(supervisor.list().every(slot => slot.busy), true);
		cc.ws.send(JSON.stringify({ type: "abort" }));
		await until(() => cc.frames.some(frame => frame.type === "agent" && frame.state === "end"), 5000);
		assert.equal(supervisor.list().find(slot => slot.id === a.id)!.busy, true);
		assert.equal(supervisor.list().find(slot => slot.id === b.id)!.busy, true);
		release();
		await until(() => ca.frames.some(frame => frame.type === "hello" && frame.messages.some((message: any) => message.text.includes("合成正文 A"))) && cb.frames.some(frame => frame.type === "hello" && frame.messages.some((message: any) => message.text.includes("合成正文 B"))), 40_000);
		cc.ws.send(JSON.stringify({ type: "prompt", text: "C-only-input again", sessionId: session(cc), messageId: "m-synthetic-fallback-2", generationMode: "director" }));
		await until(() => cc.frames.some(frame => frame.type === "hello" && frame.messages.some((message: any) => message.text.includes("合成正文 C"))), 40_000);
		await until(() => !supervisor!.list().some(slot => slot.busy));
		cc.ws.send(JSON.stringify({ type: "abort" })); // Slot C's control packet never changes A/B history.
		assert.equal(JSON.stringify(cc.frames).includes("A-only-input"), false);
		assert.equal(JSON.stringify(cc.frames).includes("B-only-input"), false);
		assert.equal(JSON.stringify(ca.frames).includes("B-only-input"), false); assert.equal(JSON.stringify(cb.frames).includes("A-only-input"), false);
		const before = writerCalls;
		ca.ws.send(JSON.stringify({ type: "prompt", text: "A-only-input", sessionId: session(ca), messageId: ida, generationMode: "direct" }));
		await until(() => ca.frames.filter(frame => frame.type === "prompt_ack" && frame.messageId === ida).length >= 2);
		assert.equal(writerCalls, before);
		await supervisor.pause(a.id); assert.equal(supervisor.list().find(slot => slot.id === a.id)!.state, "paused");
		assert.equal(readdirSync(join(supervisor.root, a.id, "work/agent/sessions")).length > 0, true);
		await supervisor.start(a.id); const resumed = connect(base, a.id); clients.push(resumed.ws); await until(() => resumed.frames.some(frame => frame.type === "hello"));
		assert.equal(session(resumed), session(ca)); assert.equal(JSON.stringify(resumed.frames).includes("合成正文 A"), true);
		const bytes = readFileSync(join(supervisor.root, a.id, "work/liyuan.config.json"), "utf8"); assert.equal(JSON.parse(bytes).card, "cards/A.json");
		assert.deepEqual(JSON.parse(readFileSync(join(supervisor.root, a.id, "work/liyuan-profiles/parallel.json"), "utf8")).config, agent);
		allowed = false; supervisor.revokeInvalidSockets(); await until(() => resumed.ws.readyState === WebSocket.CLOSED);
		for (const slot of supervisor.list()) await supervisor.pause(slot.id);
		supervisor.assertCanRestart();
	} finally {
		release(); for (const socket of clients) socket.terminate(); supervisor?.close();
		if (gateway) await new Promise<void>(ok => gateway!.close(() => ok())); if (model) await new Promise<void>(ok => model!.close(() => ok()));
		await new Promise(ok => setTimeout(ok, 500)); rmSync(cwd, { recursive: true, force: true });
	}
});

test("parallel slot refuses shared OAuth refresh tokens without changing primary auth or leaving a workspace", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-play-slots-oauth-test-"));
	let slots: PlaySlots | undefined;
	try {
		mkdirSync(join(cwd, "auth")); writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "合成OAuth卡", first_mes: "合成" } }));
		const bytes = JSON.stringify({ fixture: { type: "oauth", access: "synthetic-access-only", refresh: "synthetic-refresh-only", expires: 1 } });
		writeFileSync(join(cwd, "auth/auth.json"), bytes);
		slots = new PlaySlots(cwd, { cardFile: () => ({ file: join(cwd, "card.json"), name: "合成OAuth卡" }), snapshot: () => ({ config: {}, agent: { providers: { fixture: { apiKey: "placeholder" } } }, agentDirectory: join(cwd, "auth") }), authorized: () => true });
		await assert.rejects(slots.create("card.json"), { code: "slot_oauth_unsupported" });
		assert.equal(readFileSync(join(cwd, "auth/auth.json"), "utf8"), bytes);
		assert.deepEqual(slots.list(), []); assert.deepEqual(readdirSync(slots.root), []);
	} finally { slots?.close(); rmSync(cwd, { recursive: true, force: true }); }
});
