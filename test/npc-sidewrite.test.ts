import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createServer, type Server } from "node:http";
import {
	NPC_SIDEWRITE_COMMIT, NPC_SIDEWRITE_VERSION, buildSidewritePrompt, normalizeNpcSidewriteSettings, parseSidewriteOutput, pickSidewriteTargets, sidewriteAnchor, DEFAULT_NPC_SIDEWRITE_SETTINGS,
} from "../src/stage/npc-sidewrite.ts";
import { NpcSidewriteHttp, type NpcSidewriteHost } from "../server/npc-sidewrite-http.ts";
import { defaultLiteraryEcologyState } from "../src/stage/literary-ecology.ts";
import { sealNpcCandidates, type NpcParallelGenerationInput } from "../src/stage/npc-parallel.ts";
import { tavernPluginScope } from "../server/tavern-plugin-store.ts";

const settings = (patch: Partial<typeof DEFAULT_NPC_SIDEWRITE_SETTINGS> = {}) => ({ ...DEFAULT_NPC_SIDEWRITE_SETTINGS, ...patch });

test("settings normalize, clamp and migrate legacy original-plugin fields", () => {
	const s = normalizeNpcSidewriteSettings({ maxPerRound: 99, minWords: 900, maxWords: 100, autoTrigger: false, ignoredNpcs: ["甲", "甲", ""], person: "x", unknown: 1, template: "旧模板不再作为提示词" });
	assert.equal(s.maxPerRound, 24); assert.equal(s.minWords, 900); assert.equal(s.maxWords, 900);
	assert.equal(s.enabled, false, "legacy autoTrigger=false stays off");
	assert.deepEqual(s.ignored, ["甲"]); assert.equal(s.person, "third"); assert.ok(!("unknown" in s) && !("template" in s));
	assert.deepEqual(normalizeNpcSidewriteSettings(undefined), DEFAULT_NPC_SIDEWRITE_SETTINGS);
});

test("anchor prefers the current narrative, then earlier story; picking always includes it and respects the cap", () => {
	assert.equal(sidewriteAnchor(["池宽治", "堀北"], ["池宽治说话。池宽治走开。堀北看书。", "堀北堀北堀北"]), "池宽治");
	assert.equal(sidewriteAnchor(["池宽治", "堀北"], ["无人", "堀北在旧正文里"]), "堀北");
	assert.equal(sidewriteAnchor(["甲"], ["甲甲"]), undefined, "single-character names are too ambiguous");
	const roster = ["甲一", "乙二", "丙三", "丁四", "戊五"].map(name => ({ name, notes: "", weight: 1 }));
	for (let seed = 0; seed < 20; seed++) {
		let x = seed / 20; const rnd = () => (x = (x * 9301 + 49297) % 233280 / 233280);
		const picked = pickSidewriteTargets(roster, settings({ maxPerRound: 3 }), [], "丁四", rnd);
		assert.equal(picked.length, 3); assert.equal(picked[0], "丁四"); assert.equal(new Set(picked).size, 3);
	}
	assert.deepEqual(pickSidewriteTargets(roster, settings({ maxPerRound: 0 }), [], undefined, () => 0).length, 5, "0 = unlimited");
	assert.deepEqual(pickSidewriteTargets([{ name: "甲一", notes: "", weight: 0 }], settings(), [], "甲一"), [], "weight 0 never writes, even as anchor");
});

test("cooldown lowers recent picks without excluding them", () => {
	const roster = ["甲一", "乙二"].map(name => ({ name, notes: "", weight: 1 }));
	let recent = 0;
	for (let i = 0; i < 400; i++) { let x = i / 400; if (pickSidewriteTargets(roster, settings({ maxPerRound: 1 }), [["甲一"]], undefined, () => x)[0] === "甲一") recent++; }
	assert.ok(recent > 40 && recent < 160, `cooling member picked ${recent}/400 (expected about 23%)`);
});

test("prompt carries isolation rules, previous ending and budget; parser binds only roster names", () => {
	const p = buildSidewritePrompt({ targets: [{ name: "甲一", notes: "在书店", previous: "上回甲一锁了门。" }], narrative: "主正文", userName: "主角", settings: settings({ maxWords: 500 }) });
	assert.match(p.systemPrompt, /不替主角/); assert.match(p.userText, /上回甲一锁了门/); assert.match(p.userText, /<npc:名字>/);
	assert.ok(p.maxTokens >= 1000 && p.maxTokens <= 32000);
	const out = parseSidewriteOutput("前言\n<npc:甲一>\n上午，书店。\n甲一整理书。\n</npc:甲一>\n<npc信息:甲一>知道：店务</npc信息:甲一>\n<npc：乙二 >乙在操场</npc>\n<npc:外人>不该收</npc:外人>\n<npc:甲一>重复块</npc:甲一>", ["甲一", "乙二"]);
	assert.deepEqual([...out.keys()], ["甲一", "乙二"]);
	assert.equal(out.get("甲一")!.text, "上午，书店。\n甲一整理书。"); assert.equal(out.get("甲一")!.info, "知道：店务");
	assert.equal(out.get("乙二")!.text, "乙在操场");
	assert.equal(parseSidewriteOutput("没有任何块", ["甲一"]).size, 0);
});

test("built-in source identity satisfies the sealed candidate contract", () => {
	assert.match(NPC_SIDEWRITE_COMMIT, /^[a-f0-9]{40}$/); assert.ok(NPC_SIDEWRITE_VERSION);
	const scope = { sessionId: "s", card: "c", sourceEntryId: "e", visibleEntryIds: ["e"] };
	assert.equal(sealNpcCandidates({ version: NPC_SIDEWRITE_VERSION, commit: NPC_SIDEWRITE_COMMIT, entries: [{ name: "甲一", text: "甲一在书店。" }], calls: 1, errors: [] }, scope, defaultLiteraryEcologyState()).length, 1);
});

function fixture(options: { ecologyEnabled?: boolean; model?: boolean; branch?: any[] } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-npc-sidewrite-"));
	const ecology = { ...defaultLiteraryEcologyState(), actors: [
		{ id: "a1", name: "甲一", tier: "active", location: "书店", activity: "整理书", shortGoal: "", longGoal: "" },
		{ id: "a2", name: "乙二", tier: "background", location: "操场", activity: "", shortGoal: "", longGoal: "" },
		{ id: "u", name: "主角", tier: "core", location: "", activity: "", shortGoal: "", longGoal: "" },
	] } as any;
	let scope = { sessionId: "s1", card: "card.png", sourceEntryId: "e2", visibleEntryIds: ["e1", "e2"] };
	const host: NpcSidewriteHost = {
		binding: () => scope, isBusy: () => false,
		config: () => ({ ecologyEnabled: options.ecologyEnabled ?? true, ...(options.model === false ? {} : { model: { provider: "p", id: "m" } }) }),
		branch: () => options.branch ?? [], ecology: () => ecology, materials: () => ({ card: { name: "卡" }, config: { userName: "主角" } }),
	};
	const http = new NpcSidewriteHttp(cwd, host);
	const requests: any[] = [];
	let reply: (req: any) => string | Promise<string> = () => "<npc:甲一>甲一在书店整理书。</npc:甲一><npc:乙二>乙二在操场跑步。</npc:乙二>";
	const input = (narrative = "主角与甲一说话。"): NpcParallelGenerationInput => ({
		scope, ecology, state: { roster: { characters: { 丙三: "同学" } } } as any, lore: [], history: [], userName: "主角", charName: "卡", userText: "", narrative, guard: () => {},
		generate: async request => { requests.push(request); return reply(request); },
	});
	return { cwd, http, host, ecology, requests, input, setReply: (fn: typeof reply) => { reply = fn; }, setScope: (s: typeof scope) => { scope = s; }, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("host is off by default and requires ecology plus an explicit model role", () => {
	const f = fixture(); try { assert.equal(f.http.enabled(), false); } finally { f.cleanup(); }
	for (const opt of [{ ecologyEnabled: false }, { model: false }]) {
		const g = fixture(opt); try {
			mkdirSync(join(g.cwd, ".liyuan-npc-parallel"), { recursive: true });
			writeFileSync(join(g.cwd, ".liyuan-npc-parallel/state.json"), JSON.stringify({ enabled: true }));
			assert.equal(g.http.enabled(), false);
		} finally { g.cleanup(); }
	}
});

test("a legacy enabled source switch keeps the module on after migration", () => {
	const f = fixture(); try {
		mkdirSync(join(f.cwd, ".liyuan-npc-parallel"), { recursive: true });
		writeFileSync(join(f.cwd, ".liyuan-npc-parallel/state.json"), JSON.stringify({ schema: 1, enabled: true, autoUpdate: true, active: "x".repeat(10) }));
		assert.equal(f.http.enabled(), true);
	} finally { f.cleanup(); }
});

test("one request writes the anchor plus picks; result is cached for the same source and material", async () => {
	const f = fixture(); try {
		mkdirSync(join(f.cwd, ".liyuan-npc-parallel"), { recursive: true }); writeFileSync(join(f.cwd, ".liyuan-npc-parallel/state.json"), JSON.stringify({ enabled: true }));
		const batch = await f.http.generate(f.input());
		assert.equal(f.requests.length, 1); assert.equal(f.requests[0].messages.length, 2);
		assert.match(f.requests[0].messages[1].content, /1\. 甲一/, "anchor named in the narrative is listed first");
		assert.ok(!f.requests[0].messages[1].content.includes("主角\n"), "protagonist is never a target");
		assert.equal(batch.commit, NPC_SIDEWRITE_COMMIT); assert.deepEqual(batch.errors, []);
		assert.ok(batch.entries.some(e => e.name === "甲一"));
		const again = await f.http.generate(f.input());
		assert.equal(f.requests.length, 1, "same source and material reuses the saved batch"); assert.equal(again.cached, true);
	} finally { f.cleanup(); }
});

test("missing people are skipped, not retried; an empty or failed reply is a failed batch without fake entries", async () => {
	const f = fixture(); try {
		mkdirSync(join(f.cwd, ".liyuan-npc-parallel"), { recursive: true }); writeFileSync(join(f.cwd, ".liyuan-npc-parallel/state.json"), JSON.stringify({ enabled: true }));
		f.setReply(() => "<npc:甲一>只写了甲一。</npc:甲一>");
		const partial = await f.http.generate(f.input());
		assert.deepEqual(partial.entries.map(e => e.name), ["甲一"]); assert.deepEqual(partial.errors, []); assert.equal(f.requests.length, 1);
		assert.deepEqual(f.http.store.read(f.input().scope).state.chatMetadata.npc_sidewrite_history, [["甲一"]], "unwritten targets do not receive a cooldown penalty");
		f.setReply(() => "模型说了些无关的话");
		const empty = await f.http.generate(f.input("另一段正文，甲一出场。"));
		assert.equal(empty.entries.length, 0); assert.match(empty.errors[0], /schema/);
		f.setReply(() => { throw Error("504 synthetic gateway timeout"); });
		const failed = await f.http.generate(f.input("第三段正文，甲一出场。"));
		assert.equal(failed.entries.length, 0); assert.ok(failed.errors[0].includes("504") || /timeout/.test(failed.errors[0]));
		assert.equal(failed.calls, 1);
	} finally { f.cleanup(); }
});

test("ignored people are never written; settings REST is CAS-bound and never resurrects the legacy ignore list", async () => {
	const f = fixture(); let server: Server | undefined; try {
		mkdirSync(join(f.cwd, ".liyuan-npc-parallel"), { recursive: true }); writeFileSync(join(f.cwd, ".liyuan-npc-parallel/state.json"), JSON.stringify({ enabled: true }));
		server = createServer((req, res) => { void f.http.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
		await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((ok, fail) => {
			const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, res => { let t = ""; res.on("data", c => t += c); res.on("end", () => ok({ status: res.statusCode!, body: JSON.parse(t || "{}") })); });
			req.on("error", fail); if (body) req.write(JSON.stringify(body)); req.end();
		});
		const status = (await call("GET", "/api/npc-parallel/status")).body;
		assert.equal(status.enabled, true); assert.equal(status.settings.maxPerRound, 3);
		const stale = await call("PUT", "/api/npc-parallel/settings", { settings: { ignored: ["甲一"] }, scopeKey: status.scopeKey, sourceEntryId: status.sourceEntryId, revision: status.revision + 5 });
		assert.equal(stale.status, 409);
		const saved = await call("PUT", "/api/npc-parallel/settings", { settings: { ...status.settings, ignored: ["甲一"], maxPerRound: 5 }, scopeKey: status.scopeKey, sourceEntryId: status.sourceEntryId, revision: status.revision });
		assert.equal(saved.status, 200); assert.deepEqual(saved.body.settings.ignored, ["甲一"]); assert.equal(saved.body.settings.maxPerRound, 5);
		await f.http.generate(f.input());
		assert.ok(!/\d\. 甲一/.test(f.requests.at(-1).messages[1].content), "ignored person not listed as a target");
		const roster = (await call("GET", "/api/npc-parallel/roster")).body;
		assert.ok(roster.names.includes("甲一") && !roster.names.includes("主角"));
		const fresh = (await call("GET", "/api/npc-parallel/status")).body;
		const off = await call("PUT", "/api/npc-parallel/config", { enabled: false, scopeKey: fresh.scopeKey, sourceEntryId: fresh.sourceEntryId, revision: fresh.revision });
		assert.equal(off.status, 200); assert.equal(off.body.enabled, false);
		assert.equal(JSON.parse(readFileSync(join(f.cwd, ".liyuan-npc-parallel/state.json"), "utf8")).enabled, false);
		assert.equal((await call("POST", "/api/npc-parallel/install", {})).status, 404, "no source management endpoints remain");
	} finally { server?.close(); f.cleanup(); }
});

test("previous accepted sidewrite for the same person is passed as the continuation ending", async () => {
	const branch = [{ id: "e1", customType: "rp-npc-parallel", data: { version: 1, sourceEntryId: "e1", upstreamVersion: NPC_SIDEWRITE_VERSION, upstreamCommit: NPC_SIDEWRITE_COMMIT, calls: 1, status: "accepted", entries: [{ name: "甲一", text: "甲一在上一拍锁上了店门。", id: "x", actorId: "a1", hash: "h", status: "accepted", reason: "", eventIds: [] }] } }];
	const f = fixture({ branch }); try {
		mkdirSync(join(f.cwd, ".liyuan-npc-parallel"), { recursive: true }); writeFileSync(join(f.cwd, ".liyuan-npc-parallel/state.json"), JSON.stringify({ enabled: true }));
		await f.http.generate(f.input());
		assert.match(f.requests[0].messages[1].content, /甲一在上一拍锁上了店门/);
	} finally { f.cleanup(); }
});

test("scope is per session/card and a changed source refuses to write", async () => {
	const f = fixture(); try {
		mkdirSync(join(f.cwd, ".liyuan-npc-parallel"), { recursive: true }); writeFileSync(join(f.cwd, ".liyuan-npc-parallel/state.json"), JSON.stringify({ enabled: true }));
		const input = f.input();
		f.setScope({ sessionId: "other", card: "card.png", sourceEntryId: "x", visibleEntryIds: ["x"] });
		await assert.rejects(f.http.generate(input), /改变/);
		assert.notEqual(tavernPluginScope({ sessionId: "s1", card: "card.png" }), tavernPluginScope({ sessionId: "other", card: "card.png" }));
	} finally { f.cleanup(); }
});

for (const endpoint of ["config", "settings"]) for (const change of ["head", "busy"]) {
	test(`${endpoint} refuses a ${change} change while its request body is streaming`, async () => {
		const f = fixture();
		try {
			const initial = f.http.status(), original = f.input().scope;
			let status = 0;
			const req = {
				url: `/api/npc-parallel/${endpoint}`, method: "PUT",
				async *[Symbol.asyncIterator]() {
					await Promise.resolve();
					if (change === "head") f.setScope({ ...original, sourceEntryId: "e3", visibleEntryIds: ["e1", "e2", "e3"] });
					else f.host.isBusy = () => true;
					yield Buffer.from(JSON.stringify({ scopeKey: initial.scopeKey, sourceEntryId: initial.sourceEntryId, revision: initial.revision, enabled: true, settings: { ignored: ["甲一"] } }));
				},
			};
			const res = { writeHead(code: number) { status = code; }, end() {} };
			await f.http.handle(req as any, res as any);
			assert.equal(status, 409);
			assert.equal(f.http.switchedOn(), false);
			assert.deepEqual(f.http.settings(original).ignored, []);
			assert.equal(f.http.store.read(original).revision, initial.revision);
		} finally { f.cleanup(); }
	});
}
