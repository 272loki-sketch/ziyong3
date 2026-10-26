/** Synthetic HTTP boundary tests only. No upstream download, browser, model service or production data. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TavernPluginHttp, createTavernPluginGenerator, type TavernPluginContext } from "../server/tavern-plugin-http.ts";
import { MVU_COMMIT } from "../server/mvu-assets.ts";
import { emptyTavernPluginState, tavernPluginScope, type TavernPluginState } from "../server/tavern-plugin-store.ts";

const PRIVATE_KEY = "SYNTHETIC_ONLY_PRIVATE_KEY_NEVER_A_CREDENTIAL";
const PRIVATE_THINKING = "SYNTHETIC_ONLY_PRIVATE_THINKING_NEVER_A_STORY";
const PRIVATE_FILE = "SYNTHETIC_ONLY_PRIVATE_FILE_NOT_A_TAVERN_ASSET";
function context(): TavernPluginContext {
	return {
		sessionId: "synthetic-http-session", card: "synthetic-card", sourceEntryId: "story", visibleEntryIds: ["root", "story"], userName: "合成用户", userPersona: "合成身份",
		chat: [
			{ mes: "合成输入，不调用模型", name: "合成用户", is_user: true, is_system: false, extra: {}, __liyuanEntryId: "root" },
			{ mes: "合成已保存正文，不能被插件改写", name: "合成角色", is_user: false, is_system: false, extra: {}, __liyuanEntryId: "story" },
		],
		character: { name: "合成角色", avatar: "synthetic.png", description: "合成卡", data: { name: "合成角色", description: "合成卡", extensions: {} } },
		preset: { name: "合成预设", prompts: [{ identifier: "fixture", content: "合成启用预设", enabled: true }], extensions: {} },
		readonlyBooks: { "Synthetic-Readonly": { entries: [{ uid: 1, content: "合成只读世界书", key: ["fixture"], enabled: true }] } }, model: { id: "synthetic-model", contextWindow: 32768 },
	};
}
interface Result { status: number; headers: IncomingMessage["headers"]; text: string; data: any }
interface Fixture {
	cwd: string; http: TavernPluginHttp; base: string;
	live: TavernPluginContext; enabled: boolean; streaming: boolean; calls: number; signals: Array<AbortSignal|undefined>;
	started?: (req: IncomingMessage) => void;
	get(path: string, headers?: Record<string, string>): Promise<Result>;
	post(path: string, value: unknown, headers?: Record<string, string>): Promise<Result>;
	bindingHeaders(): Record<string, string>;
	enable(): Promise<void>;
	streamBody(path: string, value: unknown, duringBody: () => void, headers?: Record<string, string>): Promise<Result>;
}
function collect(res: IncomingMessage): Promise<Result> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []; res.on("data", value => chunks.push(Buffer.from(value))); res.once("error", reject);
		res.once("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let data: unknown; try { data = JSON.parse(text); } catch { data = undefined; } resolve({ status: res.statusCode ?? 0, headers: res.headers, text, data }); });
	});
}
async function fixture(run: (f: Fixture) => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tavern-http-test-")); let server: ReturnType<typeof createServer> | undefined, api: TavernPluginHttp | undefined;
	try {
		const cache = join(cwd, ".liyuan-tavern-plugins"); mkdirSync(cache, { mode: 0o700 });
		writeFileSync(join(cache, "network.json"), JSON.stringify({ gitProxy: "http://127.0.0.1:9", apiKey: PRIVATE_KEY }), { mode: 0o600 });
		writeFileSync(join(cwd, "synthetic-private.json"), PRIVATE_FILE, { mode: 0o600 });
		const f = { cwd, live: context(), enabled: false, streaming: false, calls: 0, signals: [] } as Fixture;
		// Private data lives only in this host closure, not in its canonical context contract.
		const privateHostData = { key: PRIVATE_KEY, thinking: PRIVATE_THINKING };
		api = new TavernPluginHttp(cwd, {
			context: () => structuredClone(f.live), isStreaming: () => f.streaming,
			generate: async (_messages, signal) => { f.calls++; f.signals.push(signal); assert.equal(privateHostData.key, PRIVATE_KEY); return "合成模型候选，不是已保存正文"; },
		}); f.http = api;
		Object.defineProperty(f, "enabled", { get: () => f.http.sources.config().plugins.helper.enabled, set: (enabled: boolean) => { f.http.sources.configure("helper", { enabled }); }, configurable: true });
		f.enable = async () => {
			// Positive permission gates use a genuine, tiny, local Git installation; no forged installed status.
			const repo = join(cwd, "synthetic-upstream"); mkdirSync(join(repo, "dist"), { recursive: true }); mkdirSync(join(repo, "src/iframe/node_modules"), { recursive: true });
			writeFileSync(join(repo, "manifest.json"), JSON.stringify({ version: "1.0.0", js: "dist/index.js" })); writeFileSync(join(repo, "dist/index.js"), "export const syntheticOnly = true;\n"); writeFileSync(join(repo, "src/iframe/node_modules/log.js"), "// synthetic logger\n");
			const git = (...args: string[]) => execFileSync("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
			git("init", "--quiet"); git("config", "user.name", "Synthetic HTTP fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "--quiet", "-m", "synthetic runtime only");
			await f.http.sources.install("helper", { fixtureRepo: repo }); f.enabled = true;
		};
		server = createServer((req, res: ServerResponse) => {
			const result = f.http.handle(req, res); f.started?.(req);
			void result.then(handled => { if (!handled) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "synthetic unknown route" })); } }).catch(() => { if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "synthetic unexpected host error" })); });
		});
		await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
		const port = (server.address() as { port: number }).port; f.base = `http://127.0.0.1:${port}`;
		const send = (method: string, path: string, value?: unknown, headers: Record<string, string> = {}): Promise<Result> => new Promise((resolve, reject) => {
			const body = value === undefined ? undefined : JSON.stringify(value);
			const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}), ...headers } }, res => { void collect(res).then(resolve, reject); });
			req.once("error", reject); req.end(body);
		});
		f.get = (path, headers) => send("GET", path, undefined, headers); f.post = (path, value, headers) => send("POST", path, value, headers);
		f.bindingHeaders = () => { const bound = f.http.binding(); return { "x-liyuan-tavern-scope": bound.scopeKey, "x-liyuan-tavern-source": bound.sourceEntryId }; };
		f.streamBody = async (path, value, duringBody, headers = f.bindingHeaders()) => {
			const payload = JSON.stringify(value), split = Math.max(1, Math.floor(payload.length / 2)); let begun!: () => void;
			const ready = new Promise<void>(resolve => { begun = resolve; });
			f.started = req => { if (req.url === path) begun(); };
			let req!: ReturnType<typeof httpRequest>;
			const result = new Promise<Result>((resolve, reject) => {
				req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked", ...headers } }, res => { void collect(res).then(resolve, reject); }); req.once("error", reject);
			});
			req.flushHeaders(); req.write(payload.slice(0, split));
			try {
				// handle() already executed its initial synchronous guards and is awaiting the unfinished body.
				await ready; duringBody(); req.end(payload.slice(split)); return await result;
			} finally { f.started = undefined; if (!req.writableEnded) req.destroy(); }
		};
		await run(f);
	} finally {
		api?.sources.close();
		if (server?.listening) { const done = new Promise<void>(resolve => server!.close(() => resolve())); server.closeAllConnections(); await done; }
		rmSync(cwd, { recursive: true, force: true });
	}
}
const stateBody = (state: TavernPluginState = emptyTavernPluginState(), revision = 0) => ({ revision, state });
const prompt = () => ({ messages: [{ role: "user", content: "合成脚本请求，不调用真实模型" }] });
function assertNoPrivateFields(value: unknown) {
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) { assert.equal(/^(apiKey|api_key|authorization|internalToken|thinking|rpThinking|reasoning|rpAuthorDraft)$/i.test(key), false, key); assertNoPrivateFields(child); }
}

test("safe public status excludes host private paths, keys, thinking and internal token", () => fixture(async f => {
	const result = await f.get("/api/tavern-plugins/status"); assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.data.plugins.length, 2); assert.equal(result.data.runtimeEnabled, false);
	for (const privateValue of [f.cwd, f.http.sources.root, PRIVATE_KEY, PRIVATE_THINKING, f.http.internalToken]) assert.equal(result.text.includes(privateValue), false);
	assertNoPrivateFields(result.data); assert.equal("root" in result.data, false); assert.equal(f.calls, 0);
}));

test("context returns canonical story/scope, no thinking, private credential or unrelated session state", () => fixture(async f => {
	const result = await f.get("/api/tavern-plugins/context"); assert.equal(result.status, 200); assert.equal(result.data.scopeKey, tavernPluginScope(f.live)); assert.equal(result.data.sourceEntryId, "story"); assert.deepEqual(result.data.visibleEntryIds, ["root", "story"]);
	assert.deepEqual(result.data.chat, f.live.chat); assert.deepEqual(result.data.state, emptyTavernPluginState()); assert.equal(result.text.includes(PRIVATE_THINKING), false); assert.equal(result.text.includes(PRIVATE_KEY), false); assertNoPrivateFields(result.data);
	const oldScope = result.data.scopeKey; f.live.card = "other-synthetic-card";
	const switched = await f.get("/api/tavern-plugins/context"); assert.notEqual(switched.data.scopeKey, oldScope); assert.deepEqual(switched.data.state, emptyTavernPluginState()); assert.equal(f.calls, 0);
}));

for (const missing of ["both", "scope", "source", "wrong-scope", "wrong-source"] as const) {
	test(`state write rejects missing/foreign binding (${missing})`, () => fixture(async f => {
		const headers = f.bindingHeaders(); if (missing === "both" || missing === "scope") delete headers["x-liyuan-tavern-scope"]; if (missing === "both" || missing === "source") delete headers["x-liyuan-tavern-source"];
		if (missing === "wrong-scope") headers["x-liyuan-tavern-scope"] = "f".repeat(64); if (missing === "wrong-source") headers["x-liyuan-tavern-source"] = "unrelated-branch";
		const result = await f.post("/api/tavern-plugins/state", stateBody(), headers); assert.equal(result.status, 409); assert.equal(f.http.store.read(f.live).revision, 0); assert.equal(f.calls, 0);
	}));
}

test("state saves and global CAS reject stale revisions without story rewrite", () => fixture(async f => {
	const original = structuredClone(f.live.chat), value = emptyTavernPluginState(); value.chatMetadata = { variables: { counter: 17 } }; value.messages.story = { variables: [{ derived: true }] };
	const headers = f.bindingHeaders(), first = await f.post("/api/tavern-plugins/state", stateBody(value), headers); assert.equal(first.status, 200); assert.equal(first.data.revision, 1);
	const stale = await f.post("/api/tavern-plugins/state", stateBody(emptyTavernPluginState(), 0), headers); assert.equal(stale.status, 409);
	const ctx = await f.get("/api/tavern-plugins/context"); assert.deepEqual(ctx.data.state, value); assert.deepEqual(ctx.data.chat, original); assert.equal(ctx.data.revision, 1); assert.equal(f.calls, 0);
}));

test("late state body cannot commit after branch switches", () => fixture(async f => {
	const value = emptyTavernPluginState(); value.chatMetadata = { shouldNotSave: true };
	const result = await f.streamBody("/api/tavern-plugins/state", stateBody(value), () => { f.live.sourceEntryId = "new-branch"; f.live.visibleEntryIds = ["root", "new-branch"]; });
	assert.equal(result.status, 409); assert.equal(f.http.store.read(f.live).revision, 0); assert.deepEqual(f.http.store.read(f.live).state, emptyTavernPluginState()); assert.equal(f.calls, 0);
}));

test("frontend state write is refused while main author is streaming", () => fixture(async f => {
	f.streaming = true; const result = await f.post("/api/tavern-plugins/state", stateBody(), f.bindingHeaders()); assert.equal(result.status, 409); assert.equal(f.http.store.read(f.live).revision, 0); assert.equal(f.calls, 0);
}));

test("readonly book, canonical/unknown message fields and foreign messages are rejected through HTTP", () => fixture(async f => {
	const cases: Array<{ state: TavernPluginState; status: number }> = [];
	const readonly = emptyTavernPluginState(); readonly.worldbooks["Synthetic-Readonly"] = { entries: [{ uid: 1, content: "forbidden rewrite" }] }; cases.push({ state: readonly, status: 400 });
	for (const field of ["mes", "text", "thinking", "rpNarrative", "rpAuthorDraft", "unexpected"]) { const value = emptyTavernPluginState(); value.messages.story = { [field]: "not canonical" } as never; cases.push({ state: value, status: 400 }); }
	const foreign = emptyTavernPluginState(); foreign.messages.sibling = { variables: [{ secret: "synthetic sibling data" }] }; cases.push({ state: foreign, status: 409 });
	const unknown = { ...emptyTavernPluginState(), unknown: {} } as never; cases.push({ state: unknown, status: 400 });
	for (const sample of cases) { const result = await f.post("/api/tavern-plugins/state", stateBody(sample.state), f.bindingHeaders()); assert.equal(result.status, sample.status); }
	assert.equal(f.http.store.read(f.live).revision, 0); assert.equal(f.calls, 0); assert.equal(f.live.chat[1].mes, "合成已保存正文，不能被插件改写");
}));

test("disabled plugin generate is rejected before the virtual paid stub is called", () => fixture(async f => {
	const result = await f.post("/api/tavern-plugins/generate", prompt(), f.bindingHeaders()); assert.equal(result.status, 400); assert.match(result.data.error, /未启用/); assert.equal(f.calls, 0);
}));

test("streaming main author blocks plugin generate even for an enabled source", () => fixture(async f => {
	await f.enable(); f.streaming = true; const result = await f.post("/api/tavern-plugins/generate", prompt(), f.bindingHeaders()); assert.equal(result.status, 409); assert.equal(f.calls, 0);
}));

for (const changed of ["enabled", "streaming", "branch"] as const) {
	test(`generate rechecks ${changed} after awaiting the HTTP body, virtual paid calls stay zero`, () => fixture(async f => {
		await f.enable();
		const result = await f.streamBody("/api/tavern-plugins/generate", prompt(), () => {
			if (changed === "enabled") f.enabled = false; else if (changed === "streaming") f.streaming = true; else { f.live.sourceEntryId = "late-branch"; f.live.visibleEntryIds = ["root", "late-branch"]; }
		}); assert.equal(result.status, 409); assert.equal(f.calls, 0); assert.equal(f.http.store.read(f.live).revision, 0);
	}));
}

test("generate rejects missing binding or malformed prompt before model invocation", () => fixture(async f => {
	await f.enable(); assert.equal((await f.post("/api/tavern-plugins/generate", prompt())).status, 409);
	for (const messages of [undefined, [], [{ role: "tool", content: "invalid role" }], [{ role: "user", content: { bad: true } }], Array.from({ length: 201 }, () => ({ role: "user", content: "fixture" }))]) {
		if (Array.isArray(messages) && messages.length === 0) continue; // Empty arrays are not prohibited by this HTTP contract.
		assert.equal((await f.post("/api/tavern-plugins/generate", { messages }, f.bindingHeaders())).status, 400);
	}
	assert.equal(f.calls, 0);
}));

test("authorized pure-synthetic generate returns candidate-only result and never alters canonical story", () => fixture(async f => {
	await f.enable(); const original = structuredClone(f.live.chat);
	const result = await f.post("/api/tavern-plugins/generate", prompt(), f.bindingHeaders()); assert.equal(result.status, 200); assert.equal(f.calls, 1, "one local stub call, zero external/paid API requests"); assert.equal(result.data.candidateOnly, true); assert.equal(result.data.choices[0].message.role, "assistant");
	assert.deepEqual(f.live.chat, original); assert.equal(f.http.store.read(f.live).revision, 0);
}));

test("original static asset bytes are unchanged; traversal/hidden/private-file paths never escape fixture root", () => fixture(async f => {
	const root = join(f.cwd, "candidate-runtime"); mkdirSync(join(root, "dist"), { recursive: true }); const original = Buffer.from("export const syntheticOriginal = true;\r\n"); writeFileSync(join(root, "dist/index.js"), original);
	f.http.candidate = { id: "helper", root, version: "1.0.0", commit: "a".repeat(40), sha256: "b".repeat(64), manifest: { version: "1.0.0", js: "dist/index.js" }, files: [{ path: "dist/index.js", sha256: createHash("sha256").update(original).digest("hex"), bytes: original.length }] };
	for (const prefix of ["/tavern-compat/scripts/extensions/third-party/JS-Slash-Runner/", "/scripts/extensions/third-party/JS-Slash-Runner/"]) {
		const valid = await f.get(`${prefix}dist/index.js`); assert.equal(valid.status, 200); assert.equal(valid.text, original.toString("utf8")); assert.equal(valid.headers["x-content-type-options"], "nosniff");
		for (const path of ["../../../../../../synthetic-private.json", "%2e%2e/%2e%2e/synthetic-private.json", "dist/../../../synthetic-private.json", "dist\\..\\synthetic-private.json", "%2fetc%2fpasswd", ".hidden.json", "source.json", "manifest.json/../../synthetic-private.json"]) {
			const result = await f.get(`${prefix}${path}`); assert.ok(result.status >= 400, `${path}: ${result.status}`); assert.equal(result.text.includes(PRIVATE_FILE), false);
		}
	}
	const status = await f.get("/api/tavern-plugins/status"), ctx = await f.get("/api/tavern-plugins/context"); assert.equal(status.text.includes(root), false); assert.equal(ctx.text.includes(root), false); assert.equal(readFileSync(join(f.cwd, "synthetic-private.json"), "utf8"), PRIVATE_FILE); assert.equal(f.calls, 0);
}));

test("old internal request cannot borrow a replacement turn signal while its HTTP body is pending", () => fixture(async f => {
 await f.enable(); f.streaming = true;
 const old = new AbortController(), next = new AbortController(); f.http.turnSignal = old.signal;
 const headers = { ...f.bindingHeaders(), "x-liyuan-tavern-host": f.http.internalToken, "x-liyuan-tavern-turn": f.http.turnNonce };
 const result = await f.streamBody("/api/tavern-plugins/generate", prompt(), () => { old.abort(); f.http.turnSignal = next.signal; }, headers);
 assert.equal(result.status, 409); assert.equal(f.calls, 0); assert.equal(f.http.store.read(f.live).revision, 0);
 // A current realm gets all eight attempts: the stale request consumed none.
 for (let n = 0; n < 8; n++) assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), { ...headers, "x-liyuan-tavern-turn": f.http.turnNonce })).status, 200);
 assert.equal(f.calls, 8); next.abort(); assert.equal(f.signals.every(signal => signal?.aborted), true);
}));

test("old realm nonce is rejected even after a new same-source turn starts before the request arrives", () => fixture(async f => {
 await f.enable(); const old = new AbortController(), next = new AbortController(); f.http.turnSignal = old.signal;
 const headers = { ...f.bindingHeaders(), "x-liyuan-tavern-host": f.http.internalToken, "x-liyuan-tavern-turn": f.http.turnNonce };
 f.http.turnSignal = next.signal;
 assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), headers)).status, 409); assert.equal(f.calls, 0);
 assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), { ...headers, "x-liyuan-tavern-turn": f.http.turnNonce })).status, 200);
 assert.equal(f.signals[0]?.aborted, false); old.abort(); assert.equal(f.signals[0]?.aborted, false); next.abort(); assert.equal(f.signals[0]?.aborted, true);
}));

test("internal token without the current turn nonce and signal cannot call the model, even when idle", () => fixture(async f => {
 await f.enable(); const headers = { ...f.bindingHeaders(), "x-liyuan-tavern-host": f.http.internalToken };
 assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), headers)).status, 409);
 f.http.turnSignal = new AbortController().signal;
 assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), headers)).status, 409); assert.equal(f.calls, 0);
}));

test("more than 256 sources retain the first source's cumulative accounting without a quota", () => fixture(async f => {
 await f.enable(); const first = f.live.sourceEntryId;
 assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), f.bindingHeaders())).status, 200);
 for (let n = 0; n < 256; n++) { f.live.sourceEntryId = "synthetic-budget-" + n; f.live.visibleEntryIds = [f.live.sourceEntryId]; assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), f.bindingHeaders())).status, 200); }
 f.live.sourceEntryId = first; f.live.visibleEntryIds = [first];
 for (let n = 0; n < 7; n++) assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), f.bindingHeaders())).status, 200);
 assert.equal((await f.post("/api/tavern-plugins/generate", prompt(), f.bindingHeaders())).status, 200); assert.equal(f.calls, 265);assert.equal(f.http.store.modelRequestUsage(f.live).used,9);
 assert.equal(f.http.store.read(f.live).revision, 0);
}));

test("old internal realm state save is rejected if the same-source turn changes during the HTTP body", () => fixture(async f => {
 const first=new AbortController(),next=new AbortController();f.http.turnSignal=first.signal;
 const headers={...f.bindingHeaders(),"x-liyuan-tavern-host":f.http.internalToken,"x-liyuan-tavern-turn":f.http.turnNonce};
 const result=await f.streamBody("/api/tavern-plugins/state",stateBody(),()=>{f.http.turnSignal=next.signal;},headers);
 assert.equal(result.status,409);assert.equal(f.http.store.read(f.live).revision,0);
}));

test("state saves also recheck external busy state after awaiting the HTTP body", () => fixture(async f => {
 const result=await f.streamBody("/api/tavern-plugins/state",stateBody(),()=>{f.streaming=true;});
 assert.equal(result.status,409);assert.equal(f.http.store.read(f.live).revision,0);
}));

function mvuFixture(f:Fixture){
 const root=join(f.cwd,".liyuan-tavern-plugins/mvu");mkdirSync(root,{recursive:true});const bytes="synthetic pinned MVU",sha=createHash("sha256").update(bytes).digest("hex");writeFileSync(join(root,"bundle.js"),bytes);writeFileSync(join(root,"manifest.json"),JSON.stringify({version:1,commit:MVU_COMMIT,bundleSha256:sha,assets:{}}));writeFileSync(join(root,"config.json"),JSON.stringify({version:1,enabled:true}));
 const saved=f.http.store.read(f.live);saved.state.extensionSettings.mvu_settings={更新方式:"额外模型解析",额外模型解析配置:{模型来源:"自定义",api地址:"https://synthetic-parser.invalid/v1",模型名称:"gemini-3.8-flash",密钥:""}};f.http.store.save(f.live,saved.revision,saved.state,()=>{});
 f.http.turnSignal=new AbortController().signal;f.http.internalPhase="after";
 return {payload:{...prompt(),model:"gemini-3.8-flash",reverse_proxy:"https://synthetic-parser.invalid/v1",chat_completion_source:"custom",stream:false,max_tokens:4096},headers:{...f.bindingHeaders(),"x-liyuan-tavern-host":f.http.internalToken,"x-liyuan-tavern-turn":f.http.turnNonce}};
}
test("HTTP custom MVU dispatch uses shared generator and exact 3.8 model; persisted accounting permits further paid sends after eight",()=>fixture(async f=>{
 await f.enable();const {payload,headers}=mvuFixture(f),model={provider:"new",id:"gemini-3.8-flash",baseUrl:payload.reverse_proxy,maxTokens:8192};let authCalls=0;
 const generate=createTavernPluginGenerator({models:()=>[model],mvuRef:()=>({provider:"new",id:model.id}),writer:()=>{throw Error("must not fallback writer");},auth:async selected=>{authCalls++;assert.equal(selected.id,model.id);return {ok:true,apiKey:"synthetic-only"};},stream:(selected,_context,options,binding)=>{assert.equal(selected.id,model.id);assert.equal(binding.purpose,"mvu.parse");assert.equal(binding.sourceEntryId,"story");assert.equal(options.maxTokens,4096);f.calls++;return {async *[Symbol.asyncIterator](){yield {type:"done"};},async result(){return {stopReason:"stop",content:[{type:"text",text:"synthetic patch"}]};}};}});
 f.http.host.generateManagesBudget=true;f.http.host.generate=(messages,signal,options)=>generate(messages,signal,options!);
 for(let n=0;n<8;n++)assert.equal((await f.post("/api/tavern-plugins/generate",payload,headers)).status,200);
 assert.equal((await f.post("/api/tavern-plugins/generate",payload,headers)).status,200);assert.equal(f.calls,9);assert.equal(authCalls,9);
}));
test("body purpose or custom payload cannot forge trusted after/current MVU settings",()=>fixture(async f=>{
 await f.enable();const {payload,headers}=mvuFixture(f);
 assert.equal((await f.post("/api/tavern-plugins/generate",{...payload,purpose:"mvu.parse"},f.bindingHeaders())).status,400);
 f.http.internalPhase=undefined;assert.equal((await f.post("/api/tavern-plugins/generate",payload,headers)).status,400);
 f.http.internalPhase="after";const saved=f.http.store.read(f.live);(saved.state.extensionSettings.mvu_settings as any).更新方式="随正文输出";f.http.store.save(f.live,saved.revision,saved.state,()=>{});
 assert.equal((await f.post("/api/tavern-plugins/generate",payload,headers)).status,400);assert.equal(f.calls,0);
}));
for(const reason of ["scope","cancel","settings"] as const)test(`HTTP auth await rechecks ${reason}, no billed send or consumed allowance`,()=>fixture(async f=>{
 await f.enable();const {payload,headers}=mvuFixture(f),model={provider:"new",id:payload.model,baseUrl:payload.reverse_proxy};
 const generate=createTavernPluginGenerator({models:()=>[model],mvuRef:()=>({provider:"new",id:model.id}),writer:()=>undefined,auth:async()=>{await Promise.resolve();if(reason==="scope")f.live.sourceEntryId="foreign";if(reason==="cancel")f.http.turnSignal=new AbortController().signal;if(reason==="settings"){const saved=f.http.store.read(f.live);(saved.state.extensionSettings.mvu_settings as any).更新方式="随正文输出";f.http.store.save(f.live,saved.revision,saved.state,()=>{});}return {ok:true};},stream:()=>{f.calls++;throw Error("must not bill");}});
 f.http.host.generateManagesBudget=true;f.http.host.generate=(messages,signal,options)=>generate(messages,signal,options!);
 assert.ok((await f.post("/api/tavern-plugins/generate",payload,headers)).status>=400);assert.equal(f.calls,0);
}));

test("native extension lookup exposes only pinned metadata, not credentials or an unverified latest claim", () => fixture(async f => {
 await f.enable();
 const result = await f.post("/api/tavern-plugins/legacy/extensions/version", {extensionName:"JS-Slash-Runner",global:false}, f.bindingHeaders());
 assert.equal(result.status,200);assert.match(result.data.currentCommitHash,/^[a-f0-9]{40}$/);assert.equal(result.data.remoteUrl,"https://github.com/N0VI028/JS-Slash-Runner.git");assert.equal("isUpToDate" in result.data,false,"installation alone is not an update check");
 assert.equal(result.text.includes(PRIVATE_KEY),false);assert.equal(f.calls,0);assert.equal(f.http.store.read(f.live).revision,0);
 for(const name of ["../helper","untrusted-extension","ST-Prompt-Template"]){const denied=await f.post("/api/tavern-plugins/legacy/extensions/version",{extensionName:name},f.bindingHeaders());assert.notEqual(denied.status,200);}
 assert.equal((await f.post("/api/tavern-plugins/legacy/extensions/version",{extensionName:"JS-Slash-Runner"},{})).status,409);
 const stale=await f.streamBody("/api/tavern-plugins/legacy/extensions/version",{extensionName:"JS-Slash-Runner"},()=>{f.live.sourceEntryId="other-source";});assert.equal(stale.status,409);assert.equal(f.calls,0);
}));
