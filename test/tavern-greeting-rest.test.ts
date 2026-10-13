import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { handleApiRequest, type RestHost, type TavernGreetingContext, type TavernGreetingExpected, type TavernGreetingSnapshot } from "../server/rest.ts";

const greetings = ["开场一", "开场二", "开场三"];
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tavern-greeting-"));
	const config = join(cwd, "liyuan.config.json");
	const png = join(cwd, "fixture.png");
	const configBytes = Buffer.from('{"card":"fixture.png","greetingIndex":0,"unknown":{"preserve":true}}\n');
	const pngBytes = Buffer.from("synthetic png bytes are read-only");
	writeFileSync(config, configBytes);
	writeFileSync(png, pngBytes);
	let state: TavernGreetingSnapshot = { context: { sessionId: "session-a", card: "fixture.png", leafId: "leaf-a", messageCount: 1, greetingIndex: 0, greetings: [...greetings] }, hasStarted: false, greetingOnly: true, busy: false };
	let streaming = false;
	let selects = 0;
	let select: (index: number, expected: TavernGreetingExpected) => Promise<boolean> = async (index) => {
		selects++;
		state = { ...state, context: { ...state.context, leafId: "leaf-selected", greetingIndex: index } };
		return true;
	};
	const host = { cwd, isStreaming: () => streaming, readTavernGreetingSnapshot: () => state, selectTavernGreeting: (index: number, expected: TavernGreetingExpected) => select(index, expected) } as unknown as RestHost;
	return { cwd, config, png, configBytes, pngBytes, host, get state() { return state; }, set state(value: TavernGreetingSnapshot) { state = value; }, set streaming(value: boolean) { streaming = value; }, set select(value: typeof select) { select = value; }, get selects() { return selects; }, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
function req(method: string, path: string, raw = "") {
	const request = Readable.from(raw ? [Buffer.from(raw)] : []) as Readable & { method: string; url: string };
	request.method = method;
	request.url = path;
	return request;
}
async function call(host: RestHost, method: string, path: string, raw = "") {
	let status = 0;
	let text = "";
	const response = { setHeader() {}, writeHead(code: number) { status = code; }, end(body = "") { text += body; } };
	assert.equal(await handleApiRequest(req(method, path, raw) as never, response as never, host), true);
	return { status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}
const expected = (context: TavernGreetingContext): TavernGreetingExpected => ({ sessionId: context.sessionId, card: context.card, leafId: context.leafId, greetingIndex: context.greetingIndex });
const payload = (f: ReturnType<typeof fixture>, index = 1) => JSON.stringify({ index, expected: expected(f.state.context) });
function unchanged(f: ReturnType<typeof fixture>) {
	assert.deepEqual(readFileSync(f.config), f.configBytes);
	assert.deepEqual(readFileSync(f.png), f.pngBytes);
}

test("GET greeting context returns the synchronous canonical visible-message count and string pool", async () => {
	const f = fixture();
	try {
		const result = await call(f.host, "GET", "/api/tavern/greeting-context");
		assert.equal(result.status, 200);
		assert.deepEqual(result.body, { sessionId: "session-a", card: "fixture.png", leafId: "leaf-a", messageCount: 1, greetingIndex: 0, greetings });
	} finally { f.cleanup(); }
});

test("POST greeting-select applies and returns fresh leaf/index context", async () => {
	const f = fixture();
	try {
		const result = await call(f.host, "POST", "/api/tavern/greeting-select", payload(f));
		assert.equal(result.status, 200);
		assert.deepEqual(result.body, { context: { ...f.state.context } });
		assert.equal((result.body.context as TavernGreetingContext).leafId, "leaf-selected");
		assert.equal((result.body.context as TavernGreetingContext).greetingIndex, 1);
		assert.equal(f.selects, 1);
		unchanged(f);
	} finally { f.cleanup(); }
});

test("started, busy, stale scope, stale greeting and out-of-range requests conflict without selection or file mutation", async () => {
	for (const mode of ["started", "busy", "session", "card", "leaf", "greeting", "index"] as const) {
		const f = fixture();
		try {
			if (mode === "started") f.state = { ...f.state, hasStarted: true, greetingOnly: false, context: { ...f.state.context, messageCount: 2 } };
			if (mode === "busy") f.streaming = true;
			let raw = payload(f);
			if (mode === "session" || mode === "card" || mode === "leaf" || mode === "greeting") {
				const e = expected(f.state.context);
				if (mode === "session") e.sessionId = "stale-session";
				if (mode === "card") e.card = "stale-card";
				if (mode === "leaf") e.leafId = "stale-leaf";
				if (mode === "greeting") e.greetingIndex = 2;
				raw = JSON.stringify({ index: 1, expected: e });
			}
			if (mode === "index") raw = JSON.stringify({ index: 99, expected: expected(f.state.context) });
			const result = await call(f.host, "POST", "/api/tavern/greeting-select", raw);
			assert.equal(result.status, mode === "index" ? 400 : 409, mode);
			assert.equal(f.selects, 0, mode);
			unchanged(f);
		} finally { f.cleanup(); }
	}
});

test("unknown, text-write, malformed and non-integer request fields reject with 400", async () => {
	const f = fixture();
	try {
		const validExpected = expected(f.state.context);
		for (const raw of [
			JSON.stringify({ index: 1, expected: validExpected, text: "must not write" }),
			JSON.stringify({ index: 1.5, expected: validExpected }),
			JSON.stringify({ index: 1, expected: { ...validExpected, card: "fixture.png", surprise: true } }),
			"{not-json",
		]) {
			const result = await call(f.host, "POST", "/api/tavern/greeting-select", raw);
			assert.equal(result.status, 400);
			assert.equal(f.selects, 0);
			unchanged(f);
		}
	} finally { f.cleanup(); }
});

test("scope is rechecked after the request body await and rejects a concurrent binding change", async () => {
	const f = fixture();
	try {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const body = payload(f);
		async function* delayed() { await gate; yield Buffer.from(body); }
		const request = Readable.from(delayed()) as Readable & { method: string; url: string };
		request.method = "POST";
		request.url = "/api/tavern/greeting-select";
		let status = 0; let text = "";
		const response = { setHeader() {}, writeHead(code: number) { status = code; }, end(value = "") { text += value; } };
		const pending = handleApiRequest(request as never, response as never, f.host);
		f.state = { ...f.state, context: { ...f.state.context, sessionId: "session-b" } };
		release();
		await pending;
		assert.equal(status, 409);
		assert.equal(JSON.parse(text).error.length > 0, true);
		assert.equal(f.selects, 0);
		unchanged(f);
	} finally { f.cleanup(); }
});

test("post-await verification refuses a selector that changes scope or fails to select the requested greeting", async () => {
	for (const outcome of ["scope", "wrong-index", "started"] as const) {
		const f = fixture();
		try {
			f.select = async (index) => {
				if (outcome === "scope") f.state = { ...f.state, context: { ...f.state.context, card: "other-card", leafId: "leaf-selected", greetingIndex: index } };
				if (outcome === "wrong-index") f.state = { ...f.state, context: { ...f.state.context, leafId: "leaf-selected", greetingIndex: 2 } };
				if (outcome === "started") f.state = { ...f.state, hasStarted: true, greetingOnly: false, context: { ...f.state.context, leafId: "leaf-selected", greetingIndex: index, messageCount: 2 } };
				return true;
			};
			const result = await call(f.host, "POST", "/api/tavern/greeting-select", payload(f));
			assert.equal(result.status, 409, outcome);
			unchanged(f);
		} finally { f.cleanup(); }
	}
});
