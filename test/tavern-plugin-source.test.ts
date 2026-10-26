import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { TavernPluginSources, TAVERN_PLUGIN_UPSTREAMS, createTavernPluginGitProvider, type TavernPluginCandidate, type TavernPluginGitProvider } from "../server/tavern-plugin-source.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
function put(repo: string, path: string, bytes: string) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), bytes); }
function revision(repo: string, version: string, body = `export const fixtureVersion = ${JSON.stringify(version)};\r\n`) {
	put(repo, "manifest.json", JSON.stringify({ display_name: "SYNTHETIC ONLY", version, js: "dist/index.js", css: "dist/index.css", i18n: { en: "i18n/en.json" }, unknownFixtureField: { keep: true } }, null, "\t") + "\n");
	put(repo, "dist/index.js", body);
	git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", `synthetic ${version}`);
	return git(repo, "rev-parse", "HEAD");
}
async function fixture(run: (value: { cwd: string; repo: string; source: TavernPluginSources; provider: TavernPluginGitProvider; checks: () => number }) => Promise<void> | void) {
	const base = mkdtempSync(join(tmpdir(), "liyuan-tavern-source-test-")), cwd = join(base, "host"), repo = join(base, "synthetic-upstream");
	let source: TavernPluginSources | undefined;
	try {
	mkdirSync(cwd); mkdirSync(repo); git(repo, "init", "--quiet"); git(repo, "config", "user.name", "Synthetic fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
	for (const [path, bytes] of Object.entries({ "dist/index.css": "/* untouched fixture */\r\n", "dist/lazy.js": "export const lazy = true;\n", "dist/index.js.map": '{"synthetic":true}', "libs/faker.mjs": "export const faker = {};\n", "lib/jsoneditor.js": "export const createJSONEditor = () => {};\n", "templates/nested/settings.html": "<section>synthetic helper settings</section>\n", "settings.html": "<section>synthetic template settings</section>\n", "i18n/en.json": '{"fixture":"only"}\n', "locales/zh-cn.json": '{"fixture":"合成"}\n', "src/not-runtime.ts": "// never copied\n", "src/iframe/node_modules/log.js": "// original synthetic iframe logger\n", "src/iframe/node_modules/other.js": "// never copied\n", "LICENSE": "Synthetic fixture license\n" })) put(repo, path, bytes);
	revision(repo, "1.0.0");
	let checks = 0;
	const provider: TavernPluginGitProvider = {
		async resolveCommit(upstream) { checks++; assert.equal(upstream.repository, TAVERN_PLUGIN_UPSTREAMS[upstream.id].repository); return git(repo, "rev-parse", "HEAD"); },
		async checkout(_upstream, commit, destination) { cpSync(repo, destination, { recursive: true }); git(destination, "checkout", "--quiet", "--detach", commit); },
	};
	source = new TavernPluginSources(cwd, { gitProvider: provider });
	await run({ cwd, repo, source, provider, checks: () => checks });
	} finally { source?.close(); rmSync(base, { recursive: true, force: true }); }
}
function filePermissions(path: string) {
	const info = statSync(path);
	if (process.platform !== "win32") assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, path);
	if (info.isDirectory()) for (const name of readdirSync(path)) filePermissions(join(path, name));
}

test("fixed trusted sources, read-only defaults, complete commit and byte-identical private runtime copy", () => fixture(async ({ cwd, repo, source }) => {
	assert.deepEqual(source.config(), { plugins: { helper: { enabled: false, autoUpdate: true }, template: { enabled: false, autoUpdate: true } } });
	assert.equal(existsSync(source.root), false, "constructor/status do not create private state");
	assert.equal(source.status().plugins.length, 2);
	assert.throws(() => source.configure("untrusted" as never, {}), /不受信任/);
	const before = hash(readFileSync(join(repo, "dist/index.js")));
	const installed = await source.install("helper", { fixtureRepo: repo });
	assert.equal(installed.installed, true); assert.equal(installed.enabled, false); assert.equal(installed.autoUpdate, true);
	assert.equal(installed.commit, git(repo, "rev-parse", "HEAD")); assert.match(installed.commit!, /^[0-9a-f]{40}$/); assert.match(installed.sha256!, /^[0-9a-f]{64}$/);
	for (const path of ["dist/index.js", "dist/index.css", "dist/lazy.js", "lib/jsoneditor.js", "libs/faker.mjs", "templates/nested/settings.html", "settings.html", "i18n/en.json", "locales/zh-cn.json", "manifest.json", "src/iframe/node_modules/log.js"]) {
		const target = source.resolveAsset("helper", path); assert.ok(target); assert.deepEqual(readFileSync(target), readFileSync(join(repo, path)));
	}
	assert.equal(source.resolveAsset("helper", "dist/index.js.map"), null); assert.equal(source.resolveAsset("helper", "src/not-runtime.ts"), null); assert.equal(source.resolveAsset("helper", "src/iframe/node_modules/other.js"), null);
	assert.equal(hash(readFileSync(join(repo, "dist/index.js"))), before); assert.equal(git(repo, "status", "--porcelain"), "");
	assert.deepEqual(source.verify("helper"), { ok: true, errors: [] }); filePermissions(source.root);
	const publicStatus = JSON.stringify(source.status()); assert.equal(publicStatus.includes(cwd), false); assert.equal(publicStatus.includes(repo), false); assert.equal(publicStatus.includes("root"), false);
}));

test("configuration changes only its requested plugin and refuses invalid/enabling missing sources", () => fixture(async ({ source, repo }) => {
	assert.throws(() => source.configure("template", { enabled: true }), /先安装/);
	assert.throws(() => source.configure("helper", { enabled: "yes" } as never), /布尔/);
	assert.throws(() => source.configure("helper", { repository: "https://attacker.invalid" } as never), /布尔/);
	await source.install("helper", { fixtureRepo: repo });
	source.configure("helper", { enabled: true, autoUpdate: false });
	assert.deepEqual(source.config().plugins.template, { enabled: false, autoUpdate: true });
	assert.deepEqual(source.config().plugins.helper, { enabled: true, autoUpdate: false });
	source.configure("helper", { enabled: false }); assert.equal(source.verify("helper").ok, true);
}));

test("check stages but does not activate; update and rollback retain fixed complete versions", () => fixture(async ({ source, repo }) => {
	const first = await source.install("helper", { fixtureRepo: repo }); source.configure("helper", { enabled: true });
	revision(repo, "2.0.0"); const checked = await source.checkUpdate("helper", { fixtureRepo: repo });
	assert.equal(checked.updateAvailable, true); assert.equal(source.status().plugins[0].version, "1.0.0");
	const next = await source.update("helper"); assert.equal(next.version, "2.0.0"); assert.equal(next.previousVersion, "1.0.0"); assert.equal(next.enabled, true);
	assert.equal(readdirSync(join(source.root, "versions/helper")).length, 2);
	const back = await source.rollback("helper"); assert.equal(back.commit, first.commit); assert.equal(back.previousVersion, "2.0.0");
	assert.equal(source.verify("helper").ok, true);
	await source.update("helper"); assert.equal(source.status().plugins[0].version, "2.0.0");
	revision(repo, "3.0.0"); await source.update("helper", { fixtureRepo: repo });
	assert.equal(source.status().plugins[0].previousVersion, "2.0.0"); assert.equal(readdirSync(join(source.root, "versions/helper")).length, 2);
}));

test("manifest and per-file integrity failures never serve altered or traversal assets", () => fixture(async ({ source, repo }) => {
	await source.install("template", { fixtureRepo: repo });
	for (const path of ["../state.json", "/etc/passwd", "dist/../../state.json", "dist\\index.js", "dist/index.js?key=anything", "source.json", "dist/index.js\0"]) assert.equal(source.resolveAsset("template", path), null);
	const original = source.resolveAsset("template", "dist/index.js")!;
	writeFileSync(original, "tampered synthetic bundle");
	assert.equal(source.verify("template").ok, false); assert.equal(source.resolveAsset("template", "dist/index.js"), null);
	assert.equal(source.status().plugins[1].installed, false); assert.match(source.status().plugins[1].lastError!, /完整性/);
	assert.throws(() => source.configure("template", { enabled: true }), /核验/);
}));

test("symlink in an installed asset or upstream Git tree is refused without following it", () => fixture(async ({ source, repo, cwd }) => {
	await source.install("helper", { fixtureRepo: repo });
	const target = source.resolveAsset("helper", "libs/faker.mjs")!;
	const outside = join(cwd, "outside-synthetic.js"); writeFileSync(outside, "outside fixture");
	unlinkSync(target); symlinkSync(outside, target);
	assert.equal(source.resolveAsset("helper", "libs/faker.mjs"), null); assert.equal(source.verify("helper").ok, false);
	unlinkSync(join(repo, "dist/lazy.js")); symlinkSync("../../outside-synthetic.js", join(repo, "dist/lazy.js")); git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", "synthetic symlink");
	await assert.rejects(source.update("helper", { fixtureRepo: repo }), /非普通/);
	assert.equal(source.status().plugins[0].version, "1.0.0"); assert.equal(readFileSync(outside, "utf8"), "outside fixture");
}));

test("fixture bytes must equal the pinned Git blob; missing assets and budgets reject candidates", () => fixture(async ({ source, repo, cwd, provider }) => {
	await source.install("helper", { fixtureRepo: repo }); const current = source.status().plugins[0].commit;
	revision(repo, "2.0.0"); put(repo, "dist/index.js", "modified but not committed");
	await assert.rejects(source.update("helper", { fixtureRepo: repo }), /Git 对象/); assert.equal(source.status().plugins[0].commit, current);
	git(repo, "checkout", "--", "dist/index.js");
	put(repo, "manifest.json", JSON.stringify({ version: "2.0.0", js: "dist/index.js", i18n: { en: "i18n/missing.json" } })); git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", "missing declared locale");
	await assert.rejects(source.update("helper", { fixtureRepo: repo }), /语言文件/); assert.equal(source.status().plugins[0].commit, current);
	const small = new TavernPluginSources(join(cwd, "limited"), { gitProvider: provider, maxBytes: 8 }); mkdirSync(join(cwd, "limited"));
	try { await assert.rejects(small.install("helper", { fixtureRepo: repo }), /预算/); } finally { small.close(); }
	await assert.rejects(source.install("helper", { commit: "HEAD" }), /40 位/);
}));

test("busy install is staged, then actual auto-update activates only after idle and candidate validation", () => fixture(async ({ cwd, repo, provider }) => {
	let idle = false, validated = 0, activated = 0, now = 0;
	const sources = new TavernPluginSources(cwd, { gitProvider: provider, now: () => now, activation: { isIdle: () => idle, validateCandidate(candidate) { validated++; assert.equal(readFileSync(join(candidate.root, "dist/index.js"), "utf8").includes(candidate.version), true); return true; }, onActivated(plugin) { activated++; assert.equal(plugin.installed, true); } } });
	try {
		const pending = await sources.install("helper", { fixtureRepo: repo }); assert.equal(pending.installed, false); assert.equal(pending.pendingActivation, true); assert.equal(validated, 0);
		idle = true; await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].version, "1.0.0"); assert.equal(sources.status().plugins[0].installed, true); assert.equal(activated, 1);
		revision(repo, "2.0.0"); now += 7 * 60 * 60 * 1000; idle = false;
		await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].version, "1.0.0"); assert.equal(sources.status().plugins[0].candidateVersion, "2.0.0");
		idle = true; await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].version, "2.0.0"); assert.equal(activated, 2); assert.equal(sources.config().plugins.helper.enabled, false);
		sources.configure("helper", { autoUpdate: false }); revision(repo, "3.0.0"); now += 7 * 60 * 60 * 1000; await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].version, "2.0.0");
	} finally { sources.close(); }
}));

test("candidate smoke rejection preserves active/previous sources and safe errors, explicit retry can succeed", () => fixture(async ({ cwd, repo, provider }) => {
	let reject = false, failActivation = false;
	const sources = new TavernPluginSources(cwd, { gitProvider: provider, activation: { isIdle: () => true, validateCandidate(candidate) { if (reject) throw new Error(`Missing synthetic interface at ${candidate.root}; apiKey=SYNTHETIC_KEY_ONLY`); }, onActivated() { if (failActivation) throw new Error("synthetic rebind failure"); } } });
	try {
		await sources.install("helper", { fixtureRepo: repo }); const before = sources.status().plugins[0].commit;
		revision(repo, "2.0.0"); reject = true; await assert.rejects(sources.update("helper", { fixtureRepo: repo }), /Missing synthetic/);
		assert.equal(sources.status().plugins[0].commit, before); assert.equal(sources.verify("helper").ok, true);
		assert.equal(JSON.stringify(sources.status()).includes(cwd), false); assert.equal(JSON.stringify(sources.status()).includes("SYNTHETIC_KEY_ONLY"), false);
		reject = false; failActivation = true; await assert.rejects(sources.update("helper"), /已恢复/); assert.equal(sources.status().plugins[0].commit, before);
		failActivation = false; await sources.update("helper"); assert.equal(sources.status().plugins[0].version, "2.0.0");
	} finally { sources.close(); }
}));

test("rechecking idle and all file hashes after async smoke prevents late activation", () => fixture(async ({ cwd, repo, provider }) => {
	let idle = true, changeBytes = false;
	const sources = new TavernPluginSources(cwd, { gitProvider: provider, activation: { isIdle: () => idle, validateCandidate(candidate) { if (candidate.version === "2.0.0") { if (changeBytes) writeFileSync(join(candidate.root, "dist/lazy.js"), "changed during smoke"); else idle = false; } } } });
	try {
		await sources.install("helper", { fixtureRepo: repo }); revision(repo, "2.0.0"); await sources.update("helper", { fixtureRepo: repo });
		assert.equal(sources.status().plugins[0].version, "1.0.0"); assert.equal(sources.status().plugins[0].pendingActivation, true);
		idle = true; changeBytes = true; await assert.rejects(sources.update("helper"), /字节发生变化/); assert.equal(sources.status().plugins[0].version, "1.0.0");
	} finally { sources.close(); }
}));

test("rollback is idle guarded and automatically rejected rolled-back commit is not reactivated", () => fixture(async ({ cwd, repo, provider }) => {
	let idle = true, now = 0;
	const sources = new TavernPluginSources(cwd, { gitProvider: provider, now: () => now, activation: { isIdle: () => idle } });
	try {
		await sources.install("helper", { fixtureRepo: repo }); revision(repo, "2.0.0"); await sources.update("helper", { fixtureRepo: repo });
		idle = false; await assert.rejects(sources.rollback("helper"), /忙碌/); assert.equal(sources.status().plugins[0].version, "2.0.0");
		idle = true; await sources.rollback("helper"); now += 7 * 60 * 60 * 1000; await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].version, "1.0.0");
		await sources.update("helper"); assert.equal(sources.status().plugins[0].version, "2.0.0");
	} finally { sources.close(); }
}));

test("timer performs real activation rather than check-only and close stops work", () => fixture(async ({ cwd, repo, provider }) => {
	let now = 0;
	const sources = new TavernPluginSources(cwd, { gitProvider: provider, now: () => now });
	await sources.install("helper", { fixtureRepo: repo }); revision(repo, "2.0.0"); now = 1000;
	sources.startAutoUpdate({ isIdle: () => true, intervalMs: 100, idleRetryMs: 20, validateCandidate: () => true });
	try {
		for (let i = 0; i < 100 && sources.status().plugins[0].version !== "2.0.0"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(sources.status().plugins[0].version, "2.0.0"); assert.equal(sources.status().plugins[0].previousVersion, "1.0.0");
	} finally { sources.close(); }
	await assert.rejects(sources.install("helper", { fixtureRepo: repo }), /已关闭/);
}));

test("corrupt atomic pointer is not overwritten or treated as a successful fresh install", () => fixture(async ({ source, repo }) => {
	await source.install("helper", { fixtureRepo: repo }); const bytes = "{synthetically damaged pointer\n"; writeFileSync(source.statePath, bytes);
	assert.equal(source.status().plugins[0].installed, false); assert.equal(source.verify("helper").ok, false);
	assert.throws(() => source.configure("helper", { autoUpdate: true }));
	await assert.rejects(source.install("helper", { fixtureRepo: repo })); assert.equal(readFileSync(source.statePath, "utf8"), bytes);
}));

test("sibling plugin updates merge independent atomic pointers rather than losing enabled config", () => fixture(async ({ source, repo }) => {
	await Promise.all([source.install("helper", { fixtureRepo: repo }), source.install("template", { fixtureRepo: repo })]);
	source.configure("template", { enabled: true }); revision(repo, "2.0.0");
	await Promise.all([source.update("helper", { fixtureRepo: repo }), source.update("template", { fixtureRepo: repo })]);
	assert.equal(source.status().plugins.every((plugin) => plugin.version === "2.0.0" && plugin.installed), true);
	assert.equal(source.config().plugins.template.enabled, true); assert.equal(source.config().plugins.helper.enabled, false);
}));

test("production provider uses optional explicit/env HTTP proxy and rejects credential or non-HTTP proxy", () => {
	assert.throws(() => createTavernPluginGitProvider("file:///tmp/fixture"), /HTTP/);
	assert.throws(() => createTavernPluginGitProvider("http://fixture-user:fixture-pass@127.0.0.1:1"), /无凭据/);
	assert.equal(typeof createTavernPluginGitProvider("http://127.0.0.1:7890").checkout, "function");
});


test("manual staged install resumes after idle even when automatic future updates are disabled", () => fixture(async ({ cwd, repo, provider }) => {
	let idle = false;
	const sources = new TavernPluginSources(cwd, { gitProvider: provider, activation: { isIdle: () => idle } });
	try { sources.configure("helper", { autoUpdate: false }); const pending = await sources.install("helper", { fixtureRepo: repo }); assert.equal(pending.pendingActivation, true); idle = true; await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].installed, true); assert.equal(sources.config().plugins.helper.autoUpdate, false); } finally { sources.close(); }
}));

test("repeated failed automatic downloads are rate-limited and preserve the original active bytes", () => fixture(async ({ cwd, repo, provider }) => {
	let now = 0, calls = 0;
	const sources = new TavernPluginSources(cwd, { now: () => now, gitProvider: { ...provider, async resolveCommit() { calls++; throw new Error("synthetic upstream unavailable"); } } });
	try { await sources.install("helper", { fixtureRepo: repo }); now += 7 * 60 * 60 * 1000; await sources.autoUpdateOnce(); await sources.autoUpdateOnce(); await sources.autoUpdateOnce(); assert.equal(calls, 1); assert.equal(sources.status().plugins[0].version, "1.0.0"); assert.equal(sources.verify("helper").ok, true); assert.match(sources.status().plugins[0].lastError!, /unavailable/); } finally { sources.close(); }
}));

test("source record and parent directory tampering fail closed and do not prune outside the cache", () => fixture(async ({ source, repo, cwd }) => {
	await source.install("helper", { fixtureRepo: repo });
	const file = source.resolveAsset("helper", "dist/index.js")!, version = dirname(dirname(dirname(file))), recordFile = join(version, "source.json");
	const record = JSON.parse(readFileSync(recordFile, "utf8")); record.files[0].sha256 = "0".repeat(64); writeFileSync(recordFile, JSON.stringify(record));
	assert.equal(source.verify("helper").ok, false); assert.equal(source.resolveAsset("helper", "dist/index.js"), null);
	const outside = join(cwd, "outside-directory"); mkdirSync(outside); writeFileSync(join(outside, "retained.txt"), "do not follow private-cache symlink");
	const versions = join(source.root, "versions"); rmSync(versions, { recursive: true }); symlinkSync(outside, versions, "dir");
	assert.equal(source.verify("helper").ok, false); await assert.rejects(source.install("helper", { fixtureRepo: repo }), /普通目录/); assert.equal(readFileSync(join(outside, "retained.txt"), "utf8"), "do not follow private-cache symlink");
}));

test("invalid/mismatched injected commit provider cannot produce a falsely pinned candidate", () => fixture(async ({ cwd, provider }) => {
	const invalid = new TavernPluginSources(cwd, { gitProvider: { ...provider, async resolveCommit() { return "main"; } } });
	try { await assert.rejects(invalid.install("helper"), /完整固定 commit/); assert.equal(invalid.status().plugins[0].installed, false); } finally { invalid.close(); }
	const mismatch = new TavernPluginSources(cwd, { gitProvider: { ...provider, async resolveCommit() { return "a".repeat(40); }, async checkout(upstream, _commit, destination, signal) { await provider.checkout(upstream, await provider.resolveCommit(upstream, signal), destination, signal); } } });
	try { await assert.rejects(mismatch.install("helper"), /固定 commit 不一致/); assert.equal(mismatch.status().plugins[0].installed, false); assert.equal(readdirSync(mismatch.root).some((name) => name.startsWith(".staging-")), false); } finally { mismatch.close(); }
}));

test("closing an in-flight source check cancels before activation and removes its temporary checkout", () => fixture(async ({ cwd, provider }) => {
	let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
	const sources = new TavernPluginSources(cwd, { gitProvider: { ...provider, async resolveCommit(_upstream, signal) { entered(); await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("synthetic canceled download")), { once: true })); return "a".repeat(40); } } });
	const pending = sources.install("helper"); await ready; sources.close(); await assert.rejects(pending, /canceled/); assert.equal(sources.status().plugins[0].installed, false); assert.equal(readdirSync(sources.root).some((name) => name.startsWith(".staging-")), false);
}));

test("native Git gets explicit proxy then dedicated env then HTTPS/HTTP fallback; no network is called", async () => {
	const calls: { file: string; args: readonly string[]; options: childProcess.ExecFileOptions }[] = [];
	const originalExecFile = childProcess.execFile;
	childProcess.execFile = ((file: string, args: readonly string[], options: childProcess.ExecFileOptions, callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
		calls.push({ file, args: [...args], options });
		queueMicrotask(() => callback(null, Buffer.from(`${"a".repeat(40)}\tHEAD\n`), Buffer.alloc(0)));
		return {} as childProcess.ChildProcess;
	}) as typeof childProcess.execFile;
	syncBuiltinESMExports();
	const keys = ["LIYUAN_TAVERN_GIT_PROXY", "HTTPS_PROXY", "HTTP_PROXY"] as const; const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	try {
		process.env.LIYUAN_TAVERN_GIT_PROXY = "http://127.0.0.1:7011"; process.env.HTTPS_PROXY = "http://127.0.0.1:7012"; process.env.HTTP_PROXY = "http://127.0.0.1:7013";
		for (const [explicit, expected, remove] of [["http://127.0.0.1:7010", "7010", undefined], [undefined, "7011", undefined], [undefined, "7012", "LIYUAN_TAVERN_GIT_PROXY"], [undefined, "7013", "HTTPS_PROXY"]] as const) {
			if (remove) delete process.env[remove];
			const beforeCount = calls.length;
			await createTavernPluginGitProvider(explicit).resolveCommit(TAVERN_PLUGIN_UPSTREAMS.helper, new AbortController().signal);
			assert.equal(calls.length, beforeCount + 1);
			const args = calls.at(-1)!.args.join(" "); assert.equal(calls.at(-1)!.file, "git");
			assert.match(args, new RegExp(`http\\.proxy=http://127\\.0\\.0\\.1:${expected}`)); assert.match(args, /https:\/\/github.com\/N0VI028\/JS-Slash-Runner.git/);
		}
	} finally {
		for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
		childProcess.execFile = originalExecFile; syncBuiltinESMExports();
	}
});


test("automatic smoke rejection is retained without repeatedly loading the same failed candidate", () => fixture(async ({ cwd, repo, provider }) => {
	let now = 0, reject = false, checks = 0;
	const sources = new TavernPluginSources(cwd, { gitProvider: provider, now: () => now, activation: { isIdle: () => true, validateCandidate() { checks++; return !reject; } } });
	try { await sources.install("helper", { fixtureRepo: repo }); revision(repo, "2.0.0"); reject = true; now += 7 * 60 * 60 * 1000; await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].version, "1.0.0"); assert.match(sources.status().plugins[0].lastError!, /拒绝/); const attempts = checks; await sources.autoUpdateOnce(); now += 7 * 60 * 60 * 1000; await sources.autoUpdateOnce(); assert.equal(checks, attempts); assert.match(sources.status().plugins[0].lastError!, /拒绝/); assert.equal(sources.status().plugins[0].pendingActivation, false); reject = false; await sources.update("helper"); assert.equal(sources.status().plugins[0].version, "2.0.0"); } finally { sources.close(); }
}));

test("ENOSPC staging failure reports its safe code and never changes current or rollback bytes", () => fixture(async ({ cwd, repo, provider }) => {
	let full = false;
	const sources = new TavernPluginSources(cwd, { gitProvider: { ...provider, async checkout(...args) { if (full) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); return provider.checkout(...args); } } });
	try { await sources.install("helper", { fixtureRepo: repo }); revision(repo, "2.0.0"); await sources.update("helper", { fixtureRepo: repo }); const current = sources.status().plugins[0]; revision(repo, "3.0.0"); full = true; await assert.rejects(sources.update("helper", { commit: git(repo, "rev-parse", "HEAD") }), { code: 'ENOSPC' }); assert.equal(sources.status().plugins[0].commit, current.commit); assert.equal(sources.status().plugins[0].previousVersion, current.previousVersion); assert.equal(sources.verify("helper").ok, true); assert.equal(readdirSync(sources.root).some(name=>name.startsWith('.staging-')), false); } finally { sources.close(); }
}));


test("disabling automatic updates during asynchronous candidate smoke prevents late activation", () => fixture(async ({ cwd, repo, provider }) => {
	let now = 0;
	let sources!: TavernPluginSources;
	sources = new TavernPluginSources(cwd, { gitProvider: provider, now: () => now, activation: { isIdle: () => true, async validateCandidate(candidate) { if (candidate.version === "2.0.0") { await Promise.resolve(); sources.configure("helper", { autoUpdate: false }); } } } });
	try { await sources.install("helper", { fixtureRepo: repo }); revision(repo, "2.0.0"); now += 7 * 60 * 60 * 1000; await sources.autoUpdateOnce(); assert.equal(sources.status().plugins[0].version, "1.0.0"); assert.equal(sources.status().plugins[0].autoUpdate, false); assert.equal(sources.status().plugins[0].pendingActivation, false); } finally { sources.close(); }
}));


test("missing active pointer with retained versions is not silently treated as a new cache", () => fixture(async ({ source, repo }) => {
	await source.install("helper", { fixtureRepo: repo }); revision(repo, "2.0.0"); await source.update("helper", { fixtureRepo: repo });
	const file = source.resolveAsset("helper", "dist/index.js")!, original = readFileSync(file), versions = readdirSync(join(source.root, "versions/helper"));
	unlinkSync(source.statePath); assert.equal(source.status().plugins[0].installed, false); await assert.rejects(source.install("helper", { fixtureRepo: repo }), /指针缺失/);
	assert.deepEqual(readFileSync(file), original); assert.deepEqual(readdirSync(join(source.root, "versions/helper")), versions); assert.equal(existsSync(source.statePath), false);
}));


test("same-commit legacy helper cache lacking original iframe logger is safely re-extracted", () => fixture(async ({ source, repo }) => {
	const installed = await source.install("helper", { fixtureRepo: repo });
	const file = source.resolveAsset("helper", "dist/index.js")!, directory = dirname(dirname(dirname(file))), recordFile = join(directory, "source.json");
	const record = JSON.parse(readFileSync(recordFile, "utf8")); record.files = record.files.filter((entry: {path:string}) => entry.path !== "src/iframe/node_modules/log.js"); record.sha256 = hash(JSON.stringify(record.files));
	writeFileSync(recordFile, JSON.stringify(record)); unlinkSync(join(directory, "runtime/src/iframe/node_modules/log.js"));
	const legacyKey = `${record.commit}-${record.sha256}`; renameSync(directory, join(dirname(directory), legacyKey));
	const pointer = JSON.parse(readFileSync(source.statePath, "utf8")); pointer.plugins.helper.active = legacyKey; writeFileSync(source.statePath, JSON.stringify(pointer));
	assert.equal(source.verify("helper").ok, true); assert.equal(source.resolveAsset("helper", "src/iframe/node_modules/log.js"), null);
	const repaired = await source.install("helper", { fixtureRepo: repo }); assert.equal(repaired.commit, installed.commit); assert.equal(repaired.sha256, installed.sha256);
	assert.deepEqual(readFileSync(source.resolveAsset("helper", "src/iframe/node_modules/log.js")!), readFileSync(join(repo, "src/iframe/node_modules/log.js")));
	assert.equal(readdirSync(join(source.root, "versions/helper")).length, 2);
}));

// Serving verified bytes is distinct from caching verification or reopening a verified path.
test("readAsset returns the verified original buffer once and detects a later tampered file", () => fixture(async ({ source }) => {
	await source.install("helper");
	const first = source.readAsset("helper", "dist/index.js");
	assert.ok(first);
	const original = Buffer.from(first.bytes);
	writeFileSync(first.path, "export const fixtureVersion = 'tampered';\n");
	assert.deepEqual(first.bytes, original, "a response uses the already-verified bytes, never the modified path");
	assert.equal(source.readAsset("helper", "dist/index.js"), null);
	assert.equal(source.verify("helper").ok, false);
	assert.equal(source.readAsset("helper", "../state.json"), null);
}));
