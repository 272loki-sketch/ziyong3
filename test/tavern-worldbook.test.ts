import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { configPath, handleApiRequest, loadConfig, type RestHost } from "../server/rest.ts";
import { exportCardFile, extractPngTextChunks, readCardRawJson, writeCardJsonToPng } from "../src/card.ts";
import { loreFingerprint, loreSourceKey, overlayPathFor } from "../src/lorebook.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { getCharWorldbookNames, getWorldbook, replaceWorldbook } from "../web/src/tavernShim.ts";

function seedCard(cwd: string, path = "card.png", name = "合成篇章书"): void {
	const json = {
		spec: "chara_card_v3", spec_version: "3.0", keepEnvelope: { unknown: true },
		data: { name: "合成程序卡", description: "offline fixture", first_mes: "合成开场", keepCard: [1, 2],
			character_book: { name, keepBook: "unchanged", entries: [
				{ id: 7, comment: "A_开关", content: "重复正文", enabled: true, keys: ["A"], extensions: { keep: "row" } },
				{ id: 7, comment: "B_开关", content: "重复正文", enabled: false, keys: ["B"], keepEntry: 17 },
				{ id: 42, comment: "C_开关", content: "另一个篇章", enabled: false, keys: ["C"] },
				{ id: 99, comment: "不涉及的模块", content: "默认关闭", enabled: false, disable: true, keys: [] },
			] },
		},
	};
	if (path.endsWith(".json")) { writeFileSync(join(cwd, path), JSON.stringify(json)); return; }
	const source = join(cwd, "synthetic-source.json");
	writeFileSync(source, JSON.stringify(json));
	writeFileSync(join(cwd, path), writeCardJsonToPng(exportCardFile(source, { format: "png", loreMode: "embedded" }).body, json));
	rmSync(source);
}

async function fixture(run: (cwd: string, host: RestHost, setBusy: (value: boolean) => void) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tavern-worldbook-"));
	let busy = false;
	const host = { cwd, isStreaming: () => busy, softRefreshConfig: async () => undefined, notify: () => undefined } as unknown as RestHost;
	try {
		mkdirSync(join(cwd, "assets/lorebooks"), { recursive: true });
		seedCard(cwd);
		writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png" }));
		await run(cwd, host, value => { busy = value; });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
}

async function request(host: RestHost, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
	const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as any;
	req.method = method; req.url = url;
	let status = 0, raw = "";
	const res = { writeHead(code: number) { status = code; }, end(text = "") { raw += text; } };
	assert.equal(await handleApiRequest(req, res as never, host), true);
	return { status, body: JSON.parse(raw) };
}

function payload(book: any, entries = book.entries): any {
	const { name, source, path, cardIdentity, revision } = book;
	return { name, source, path, cardIdentity, revision, entries: entries.map((e: any) => ({ uid: e.uid, enabled: e.enabled, entryKey: e.entryKey, fingerprint: e.fingerprint })) };
}

function rawEntries(cwd: string, path = "card.png"): any[] {
	return (readCardRawJson(join(cwd, path)).raw.data as any).character_book.entries;
}

function seedFile(cwd: string, path: string, name: string): void {
	writeFileSync(join(cwd, path), JSON.stringify({ name, keep: "file", entries: {
		"row-7": { uid: 7, comment: "独立开关", content: "重复正文", enabled: false, keep: "file-row" },
	} }));
}

test("程序卡世界书：无重复挂载也能读取内嵌 PNG 全部行，按原始行键保存启停且保留原字段/立绘", async () => fixture(async (cwd, host) => {
	const before = readFileSync(join(cwd, "card.png"));
	const names = await request(host, "GET", "/api/tavern/worldbooks");
	assert.equal(names.status, 200); assert.deepEqual(names.body, { primary: "合成篇章书", additional: [], global: [], chat: [] });
	const read = await request(host, "GET", "/api/tavern/worldbook?name=合成篇章书");
	assert.equal(read.status, 200); assert.equal(read.body.source, "card"); assert.equal(read.body.path, "card.png");
	assert.equal(read.body.entries.length, 4, "同 uid/重复正文不能去重或丢弃");
	assert.deepEqual(read.body.entries.map((e: any) => e.entryKey), ["0", "1", "2", "3"]);
	assert.ok(read.body.cardIdentity); assert.ok(read.body.revision);
	assert.equal(read.body.entries[0].extensions.keep, "row"); assert.equal(read.body.entries[1].keepEntry, 17);
	const entries = read.body.entries.map((e: any) => ({ ...e, enabled: e.entryKey === "1" ? true : e.entryKey === "0" ? false : e.enabled, content: "不得写正文" }));
	const saved = await request(host, "PUT", "/api/tavern/worldbook", payload(read.body, entries));
	assert.equal(saved.status, 200); assert.equal(saved.body.changed, 2);
	assert.notEqual(saved.body.cardIdentity, read.body.cardIdentity);
	assert.deepEqual(rawEntries(cwd).map(e => e.enabled), [false, true, false, false]);
	assert.equal(rawEntries(cwd)[0].content, "重复正文");
	assert.deepEqual(rawEntries(cwd)[0].extensions, { keep: "row" });
	assert.equal(rawEntries(cwd)[1].keepEntry, 17);
	const raw = readCardRawJson(join(cwd, "card.png")).raw as any;
	assert.deepEqual(raw.data.keepCard, [1, 2]); assert.equal(raw.data.character_book.keepBook, "unchanged");
	assert.equal(rawEntries(cwd)[3].disable, true, "未请求的关闭模块不能被打开");
	const beforeChunks = extractPngTextChunks(before), afterChunks = extractPngTextChunks(readFileSync(join(cwd, "card.png")));
	assert.ok(beforeChunks.ccv3 || beforeChunks.chara);
	assert.deepEqual(Object.keys(afterChunks), Object.keys(beforeChunks));
	assert.equal(loadConfig(cwd).lorebooks?.length ?? 0, 0, "不把卡内书复制挂载");
	const pngData = (b: Buffer) => { let p = 8; const out: string[] = []; while (p + 12 <= b.length) { const n = b.readUInt32BE(p); if (b.toString("ascii", p + 4, p + 8) === "IDAT") out.push(b.subarray(p + 8, p + 8 + n).toString("hex")); p += n + 12; } return out; };
	assert.deepEqual(pngData(readFileSync(join(cwd, "card.png"))), pngData(before));
}));

test("程序卡世界书：同名独立书、内嵌书和旧全局停用按来源隔离，未涉及的源字节不变", async () => fixture(async (cwd, host) => {
	const file = "assets/lorebooks/different-filename.json"; seedFile(cwd, file, "合成篇章书");
	const fp = loreFingerprint("重复正文");
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png", lorebooks: [file], disabledLore: [fp], keepConfig: { private: "untouched" } }));
	const names = await request(host, "GET", "/api/tavern/worldbooks");
	assert.deepEqual(names.body, { primary: "合成篇章书", additional: [], global: ["合成篇章书 · 独立书"], chat: [] });
	const fileBefore = readFileSync(join(cwd, file));
	const book = (await request(host, "GET", "/api/tavern/worldbook?name=合成篇章书")).body;
	book.entries[1].enabled = true;
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).status, 200);
	assert.ok(readFileSync(join(cwd, file)).equals(fileBefore));
	const config = loadConfig(cwd);
	assert.deepEqual(config.disabledLore, [fp]);
	assert.equal(config.loreEntryOverrides?.[loreSourceKey("card", "card.png", fp, "1")], true);
	const cardBefore = readFileSync(join(cwd, "card.png"));
	const independent = (await request(host, "GET", "/api/tavern/worldbook?name=合成篇章书%20·%20独立书")).body;
	assert.equal(independent.source, "file"); independent.entries[0].enabled = true;
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(independent))).status, 200);
	assert.ok(readFileSync(join(cwd, "card.png")).equals(cardBefore));
	assert.equal(JSON.parse(readFileSync(join(cwd, file), "utf8")).entries["row-7"].keep, "file-row");
	assert.deepEqual((loadConfig(cwd) as any).keepConfig, { private: "untouched" });
}));

test("程序卡世界书：同名切卡、卡修订、未知来源和混入坏行整批拒绝，空操作不改原卡", async () => fixture(async (cwd, host) => {
	const book = (await request(host, "GET", "/api/tavern/worldbook?name=合成篇章书")).body;
	assert.equal(book.source, "card");
	const before = readFileSync(join(cwd, "card.png"));
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).body.changed, 0);
	assert.ok(readFileSync(join(cwd, "card.png")).equals(before));
	const bad = payload(book); bad.entries[0].enabled = false; bad.entries[1].entryKey = "not-a-row";
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", bad)).status, 400);
	assert.ok(readFileSync(join(cwd, "card.png")).equals(before));
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", { name: book.name, entries: [{ uid: 7, enabled: false }] })).status, 400);
	seedCard(cwd, "other.png"); writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "other.png" }));
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).status, 400);
	assert.deepEqual(rawEntries(cwd, "other.png").map(e => e.enabled), [true, false, false, false]);
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png" }));
	const next = payload(book); next.entries[0].enabled = false;
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", next)).status, 200);
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).status, 400);
}));

test("程序卡世界书：独立书原显示名和路径别名一致，未挂载/歧义拒绝，修订后拒绝旧快照", async () => fixture(async (cwd, host) => {
	const file = "assets/lorebooks/filename.json"; seedFile(cwd, file, "实际书名");
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png", lorebooks: [file] }));
	for (const name of ["实际书名", "filename", "filename.json", file]) {
		const read = await request(host, "GET", `/api/tavern/worldbook?name=${encodeURIComponent(name)}`);
		assert.equal(read.status, 200); assert.equal(read.body.source, "file"); assert.equal(read.body.path, file);
	}
	const book = (await request(host, "GET", "/api/tavern/worldbook?name=实际书名")).body;
	writeFileSync(join(cwd, file), `${readFileSync(join(cwd, file), "utf8")}\n`);
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).status, 400);
	seedFile(cwd, "assets/lorebooks/unmounted.json", "未挂载书");
	assert.equal((await request(host, "GET", "/api/tavern/worldbook?name=未挂载书")).status, 400);
	seedFile(cwd, "assets/lorebooks/duplicate.json", "实际书名");
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png", lorebooks: [file, "assets/lorebooks/duplicate.json"] }));
	assert.equal((await request(host, "GET", "/api/tavern/worldbook?name=实际书名")).status, 400);
}));

test("程序卡世界书：正文生成忙碌时拒绝保存，包括读取请求体期间才开始忙碌", async () => fixture(async (cwd, host, setBusy) => {
	const book = (await request(host, "GET", "/api/tavern/worldbook?name=合成篇章书")).body;
	assert.equal(book.source, "card");
	const before = readFileSync(join(cwd, "card.png"));
	setBusy(true);
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).status, 409);
	setBusy(false);
	const req = Readable.from((async function* () { yield Buffer.from(JSON.stringify(payload(book))); setBusy(true); })()) as any;
	req.method = "PUT"; req.url = "/api/tavern/worldbook";
	let status = 0;
	await handleApiRequest(req, { writeHead(code: number) { status = code; }, end() {} } as never, host);
	assert.equal(status, 409); assert.ok(readFileSync(join(cwd, "card.png")).equals(before));
}));

test("程序卡世界书垫片：读写同一 REST 来源，克隆行/重复uid和连续同步可用，错误及旧快照不吞掉", async () => fixture(async (cwd, host) => {
	const previousFetch = globalThis.fetch, previousXhr = (globalThis as any).XMLHttpRequest;
	const urls: string[] = [];
	try {
		(globalThis as any).XMLHttpRequest = class {
			status = 200; responseText = JSON.stringify({ primary: "合成篇章书", additional: [], global: [], chat: [] });
			open(method: string, url: string, async: boolean) { assert.equal(method, "GET"); assert.equal(async, false); urls.push(url); }
			send() {}
		};
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			urls.push(url);
			const response = await request(host, init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) : undefined);
			return new Response(JSON.stringify(response.body), { status: response.status });
		}) as typeof fetch;
		assert.equal(getCharWorldbookNames().primary, "合成篇章书");
		const book = await getWorldbook("合成篇章书"); assert.equal(book.length, 4);
		const updated = book.map((e, index) => ({ ...e, enabled: index === 1 }));
		await replaceWorldbook("合成篇章书", updated);
		assert.deepEqual(rawEntries(cwd).map(e => e.enabled), [false, true, false, false]);
		updated[1].enabled = false; updated[2].enabled = true;
		await replaceWorldbook("合成篇章书", updated);
		assert.deepEqual(rawEntries(cwd).map(e => e.enabled), [false, false, true, false]);
		await assert.rejects(replaceWorldbook("合成篇章书", book), /修订|变化|刷新/);
		const fresh = await getWorldbook("合成篇章书");
		await assert.rejects(replaceWorldbook("另一本书", fresh), /来源|世界书|匹配/);
		await assert.rejects(getWorldbook("不存在的书"), /未挂载|不存在/);
		assert.ok(urls.every(url => !url.includes("tavern-plugins")), "不经原插件的合并去重/只读上下文");
	} finally { globalThis.fetch = previousFetch; (globalThis as any).XMLHttpRequest = previousXhr; }
}));


test("程序卡世界书垫片：路径别名、for-in 克隆和空内嵌书保留来源", async () => fixture(async (cwd, host) => {
	const file = "assets/lorebooks/alias.json"; seedFile(cwd, file, "原书名");
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png", lorebooks: [file] }));
	const previousFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			const r = await request(host, init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) : undefined);
			return new Response(JSON.stringify(r.body), { status: r.status });
		}) as typeof fetch;
		const entries = await getWorldbook("alias");
		const copies = entries.map(e => { const copy: any = {}; for (const key in e) if (Object.hasOwn(e, key)) copy[key] = e[key]; copy.enabled = true; return copy; });
		await replaceWorldbook("alias", copies);
		assert.equal(JSON.parse(readFileSync(join(cwd, file), "utf8")).entries["row-7"].enabled, true);
		const raw = readCardRawJson(join(cwd, "card.png")).raw as any; raw.data.character_book.entries = [];
		writeFileSync(join(cwd, "card.png"), writeCardJsonToPng(readFileSync(join(cwd, "card.png")), raw));
		const empty = await getWorldbook("合成篇章书"); assert.deepEqual(empty, []);
		await replaceWorldbook("合成篇章书", empty);
	} finally { globalThis.fetch = previousFetch; }
}));


test("程序卡世界书：只改全局停用覆盖也拒绝旧快照，独立书卸载后不允许写回", async () => fixture(async (cwd, host) => {
	const file = "assets/lorebooks/external.json"; seedFile(cwd, file, "外部书");
	const config = { ...DEFAULT_CONFIG, card: "card.png", lorebooks: [file] };
	writeFileSync(configPath(cwd), JSON.stringify(config));
	const book = (await request(host, "GET", "/api/tavern/worldbook?name=外部书")).body;
	const before = readFileSync(join(cwd, file));
	writeFileSync(configPath(cwd), JSON.stringify({ ...config, disabledLore: [loreFingerprint("重复正文")] }));
	const attempted = payload(book); attempted.entries[0].enabled = true;
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", attempted)).status, 400);
	assert.ok(readFileSync(join(cwd, file)).equals(before));
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png" }));
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", attempted)).status, 400);
	assert.ok(readFileSync(join(cwd, file)).equals(before));
}));

test("程序卡世界书：保存来源豁免失败时卡和配置原字节回滚，不吞保存错误", async () => fixture(async (cwd, host) => {
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png", disabledLore: [loreFingerprint("重复正文")] }));
	const book = (await request(host, "GET", "/api/tavern/worldbook?name=合成篇章书")).body;
	book.entries[1].enabled = true;
	const cardBefore = readFileSync(join(cwd, "card.png")), configBefore = readFileSync(configPath(cwd));
	mkdirSync(configPath(cwd) + ".bak");
	const response = await request(host, "PUT", "/api/tavern/worldbook", payload(book));
	assert.equal(response.status, 400); assert.ok(response.body.error);
	assert.ok(readFileSync(join(cwd, "card.png")).equals(cardBefore));
	assert.ok(readFileSync(configPath(cwd)).equals(configBefore));
}));


test("程序卡世界书：没有当前卡仍兼容挂载的独立书，之后选卡使旧快照失效", async () => fixture(async (cwd, host) => {
	const file = "assets/lorebooks/standalone.json"; seedFile(cwd, file, "独立世界书");
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "", lorebooks: [file] }));
	assert.deepEqual((await request(host, "GET", "/api/tavern/worldbooks")).body, { primary: null, additional: [], global: ["独立世界书"], chat: [] });
	const book = (await request(host, "GET", "/api/tavern/worldbook")).body;
	assert.equal(book.source, "file"); book.entries[0].enabled = true;
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).status, 200);
	const fresh = (await request(host, "GET", "/api/tavern/worldbook")).body;
	writeFileSync(configPath(cwd), JSON.stringify({ ...DEFAULT_CONFIG, card: "card.png", lorebooks: [file] }));
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(fresh))).status, 400);
}));


test("程序卡世界书：既有本卡补充仍可按独立来源读取/启停，不覆盖卡或独立书", async () => fixture(async (cwd, host) => {
	const overlay = overlayPathFor(cwd, "合成程序卡");
	mkdirSync(dirname(overlay), { recursive: true });
	writeFileSync(overlay, JSON.stringify({ entries: [{ uid: 7, comment: "补充开关", content: "合成补充", enabled: false, keep: 9 }] }));
	const names = (await request(host, "GET", "/api/tavern/worldbooks")).body;
	assert.deepEqual(names, { primary: "合成篇章书", additional: ["合成程序卡 · 补充设定"], global: [], chat: [] });
	const before = readFileSync(join(cwd, "card.png"));
	const book = (await request(host, "GET", `/api/tavern/worldbook?name=${encodeURIComponent(names.additional[0])}`)).body;
	assert.equal(book.source, "agent"); book.entries[0].enabled = true;
	assert.equal((await request(host, "PUT", "/api/tavern/worldbook", payload(book))).status, 200);
	const row = JSON.parse(readFileSync(overlay, "utf8")).entries[0];
	assert.equal(row.enabled, true); assert.equal(row.keep, 9);
	assert.ok(readFileSync(join(cwd, "card.png")).equals(before));
}));
