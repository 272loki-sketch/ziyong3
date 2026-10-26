/** Synthetic-only lifecycle gates for original Tavern plugins; no production state, network or model calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mock, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TavernPluginSources } from "../server/tavern-plugin-source.ts";

let vendorEnsureCalls = 0;
const canMockModules = typeof mock.module === "function";
if (canMockModules) {
	mock.module(new URL("../server/tavern-plugin-vendor.ts", import.meta.url).href, {
		namedExports: {
			ensureTavernPluginVendors: async () => { vendorEnsureCalls++; },
			tavernVendorAsset: () => null,
		},
	});
}
const { TavernPluginHttp } = await import("../server/tavern-plugin-http.ts");
const { TavernPluginRuntime, syntheticTavernPluginContext } = await import("../server/tavern-plugin-runtime.ts");

const git = (repo: string, ...args: string[]) => execFileSync("git", [
	"-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args,
], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } }).trim();
function put(root: string, path: string, content: string) {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}
function initRepo(repo: string, version: string) {
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "--quiet");
	git(repo, "config", "user.name", "Synthetic lifecycle test");
	git(repo, "config", "user.email", "fixture@example.invalid");
	reviseRepo(repo, version);
}
function reviseRepo(repo: string, version: string) {
	put(repo, "manifest.json", JSON.stringify({ version, js: "dist/index.js" }) + "\n");
	put(repo, "dist/index.js", `export const syntheticVersion = ${JSON.stringify(version)};\n`);
	put(repo, "src/iframe/node_modules/log.js", "// synthetic original logger fixture\n");
	git(repo, "add", ".");
	git(repo, "commit", "--quiet", "-m", `synthetic ${version}`);
}
async function withFixture(run: (value: { root: string; cwd: string; repo: string }) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "liyuan-tavern-lifecycle-"));
	const cwd = join(root, "host"), repo = join(root, "synthetic-upstream");
	mkdirSync(cwd);
	initRepo(repo, "1.0.0");
	try { await run({ root, cwd, repo }); }
	finally { rmSync(root, { recursive: true, force: true }); }
}
async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server?: Server) {
	if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
}
function serve(http: InstanceType<typeof TavernPluginHttp>) {
	const server = createServer((req, res) => {
		void http.handle(req, res).then(handled => {
			if (!handled) { res.writeHead(404); res.end("not found"); }
		}).catch(error => {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		});
	});
	return server;
}
async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

// A bad active cache is a configuration error, not the same as the feature being disabled.
test("enabled but invalid/corrupt active runtime fails closed instead of silently skipping native plugins", async () => {
	for (const damage of ["bad-active-pointer", "corrupt-active-asset"] as const) {
		await withFixture(async ({ cwd, repo }) => {
			const context = syntheticTavernPluginContext();
			const http = new TavernPluginHttp(cwd, { context: () => context, isStreaming: () => false });
			const runtime = new TavernPluginRuntime(http, () => "http://127.0.0.1:1");
			try {
				const installed = await http.sources.install("helper", { fixtureRepo: repo });
				assert.equal(installed.installed, true);
				http.sources.configure("helper", { enabled: true });
				assert.equal(runtime.enabled(), true);
				if (damage === "bad-active-pointer") {
					const pointerPath = join(http.sources.root, "state.json");
					const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
					pointer.plugins.helper.active = `${"0".repeat(40)}-${"0".repeat(64)}`;
					writeFileSync(pointerPath, `${JSON.stringify(pointer)}\n`);
				} else {
					const activeBundle = http.sources.resolveAsset("helper", "dist/index.js");
					assert.ok(activeBundle);
					writeFileSync(activeBundle, "tampered synthetic cache\n");
				}
				const configured = http.sources.status().plugins.find(plugin => plugin.id === "helper");
				assert.equal(configured?.enabled, true);
				assert.equal(configured?.installed, false);
				assert.throws(() => runtime.enabled(), /已启用原插件不可用或完整性校验失败/);
				await assert.rejects(() => runtime.before({ systemPrompt: "synthetic system", messages: [] }), /已启用原插件不可用或完整性校验失败/);
			} finally {
				http.sources.close();
				await runtime.close();
			}
		});
	}
});

// The source manager uses a staged local Git candidate and an explicitly busy activation hook.
test("busy manual HTTP update stages a verified candidate and does not close/change the active runtime", { skip: !canMockModules && "requires Node's experimental test module mock to stub vendor installation" }, async () => withFixture(async ({ cwd, repo }) => {
	vendorEnsureCalls = 0;
	const context = syntheticTavernPluginContext();
	const http = new TavernPluginHttp(cwd, { context: () => context, isStreaming: () => true });
	const server = serve(http);
	try {
		const first = await http.sources.install("helper", { fixtureRepo: repo });
		assert.equal(first.version, "1.0.0");
		http.sources.configure("helper", { enabled: true, autoUpdate: false });
		reviseRepo(repo, "2.0.0");
		const candidate = await http.sources.checkUpdate("helper", { fixtureRepo: repo });
		assert.equal(candidate.updateAvailable, true);
		http.sources.startAutoUpdate({ isIdle: () => false, intervalMs: 60 * 60 * 1000, idleRetryMs: 60 * 60 * 1000 });
		let changed = 0;
		http.onChanged = () => { changed++; };
		const base = await listen(server);
		const response = await post(base, "/api/tavern-plugins/update", { id: "helper" });
		assert.equal(response.status, 200, "busy update request should complete successfully");
		const result = await response.json() as { version?: string; candidateVersion?: string; pendingActivation?: boolean };
		assert.equal(result.version, "1.0.0");
		assert.equal(result.candidateVersion, "2.0.0");
		assert.equal(result.pendingActivation, true);
		assert.equal(changed, 0, "a staged-only update must not close the current plugin runtime");
		assert.equal(vendorEnsureCalls, 1, "the HTTP vendor installer was stubbed; no browser dependency download ran");
	} finally {
		http.sources.close();
		await close(server);
	}
}));

test("busy internal generate requires a live turn signal, records cumulative source requests without an eight-call ceiling, and stays candidate-only", async () => withFixture(async ({ cwd, repo }) => {
	const context = syntheticTavernPluginContext();
	let calls = 0;
	const receivedSignals: AbortSignal[] = [];
	const http = new TavernPluginHttp(cwd, {
		context: () => context,
		isStreaming: () => true,
		generate: async (messages, signal) => {
			calls++;
			receivedSignals.push(signal!);
			assert.equal(messages[0]?.content, "synthetic request");
			assert.equal(signal?.aborted, false);
			return "synthetic candidate only";
		},
	});
	const server = serve(http);
	try {
		await http.sources.install("helper", { fixtureRepo: repo });
		http.sources.configure("helper", { enabled: true });
		const base = await listen(server);
		const payload = { messages: [{ role: "user", content: "synthetic request" }] };
		const bindingHeaders = () => {
			const binding = http.binding();
			return { "x-liyuan-tavern-scope": binding.scopeKey, "x-liyuan-tavern-source": binding.sourceEntryId };
		};
		const internalHeaders = () => ({ ...bindingHeaders(), "x-liyuan-tavern-host": http.internalToken, "x-liyuan-tavern-turn": http.turnNonce });

		const turn = new AbortController();
		http.turnSignal = turn.signal;
		const external = await post(base, "/api/tavern-plugins/generate", payload, bindingHeaders());
		assert.equal(external.status, 409);
		assert.equal(calls, 0, "requests without the internal host identity must not reach the model stub");

		const aborted = new AbortController();
		aborted.abort();
		http.turnSignal = aborted.signal;
		const canceled = await post(base, "/api/tavern-plugins/generate", payload, internalHeaders());
		assert.equal(canceled.status, 409);
		assert.equal(calls, 0, "an already-aborted turn must not reach the model stub");

		http.turnSignal = turn.signal;
		for (let index = 0; index < 8; index++) {
			const response = await post(base, "/api/tavern-plugins/generate", payload, internalHeaders());
			assert.equal(response.status, 200, "internal synthetic generate request should complete");
			const result = await response.json() as { candidateOnly?: boolean; choices?: Array<{ message?: { content?: string } }> };
			assert.equal(result.candidateOnly, true);
			assert.equal(result.choices?.[0]?.message?.content, "synthetic candidate only");
		}
		assert.equal(calls, 8);
		const ninth = await post(base, "/api/tavern-plugins/generate", payload, internalHeaders());
		assert.equal(ninth.status, 200);
		assert.equal(calls, 9, "the ninth same-source request remains usable and accounted for");

		context.sourceEntryId = "synthetic-next-source";
		context.visibleEntryIds.push(context.sourceEntryId);
		context.chat.push({ mes: "synthetic next source", name: "合成用户", is_user: true, is_system: false, __liyuanEntryId: context.sourceEntryId });
		const nextSource = await post(base, "/api/tavern-plugins/generate", payload, internalHeaders());
		assert.equal(nextSource.status, 200, "a distinct source entry gets its own budget");
		assert.equal(calls, 10, "the next source remains independent of previous request counts");
		turn.abort();
		assert.equal(receivedSignals.at(-1)?.aborted, true, "the internal model signal is joined to the turn cancellation signal");
	} finally {
		http.sources.close();
		await close(server);
	}
}));

test("send adapter preserves mixed blocks and original metadata when a template reorders/inserts messages", async () => {
	const source = readFileSync(join(process.cwd(), "web/public/tavern-compat/host-worldbooks.js"), "utf8");
	const start = source.indexOf("async function generation(packet){");
	const end = source.indexOf("\nasync function ", start + 1);
	assert.ok(start >= 0 && end > start, "host.js generation adapter source must remain identifiable");
	const generationSource = source.slice(start, end).trim();
	const events = {
		GENERATION_AFTER_COMMANDS: "GENERATION_AFTER_COMMANDS",
		GENERATE_AFTER_DATA: "generate_after_data",
		CHAT_COMPLETION_SETTINGS_READY: "chat_completion_settings_ready",
	};
	const host = { flush: async () => undefined };
	const eventSource = {
		async emit(name: string, data: any) {
			if (name !== events.CHAT_COMPLETION_SETTINGS_READY) return;
			const [system, alpha, beta] = data.messages;
			data.messages = [system, beta, { role: "user", content: "template inserted synthetic message" }, alpha];
		},
	};
	const before = new Function("host", "eventSource", "event_types", "ready", `return (${generationSource});`)(host, eventSource, events, true) as (packet: any) => Promise<any>;
	const alpha = {
		role: "user", timestamp: 101, syntheticMessageId: "alpha", sourceMetadata: { owner: "alpha" },
		content: [{ type: "text", text: "alpha text" }, { type: "image", image: "synthetic-image-alpha" }],
	};
	const beta = {
		role: "user", timestamp: 202, syntheticMessageId: "beta", sourceMetadata: { owner: "beta" },
		content: [{ type: "text", text: "beta text" }, { type: "image", image: "synthetic-image-beta" }],
	};
	const result = await before({ systemPrompt: "synthetic system", messages: [alpha, beta] });
	assert.equal(result.messages.length, 3);
	assert.equal(result.messages[0].syntheticMessageId, "beta");
	assert.equal(result.messages[0].timestamp, 202);
	assert.equal(result.messages[0].sourceMetadata.owner, "beta");
	assert.deepEqual(result.messages[0].content, beta.content);
	assert.equal(result.messages[1].syntheticMessageId, undefined, "inserted prompts must not inherit a positional message's metadata");
	assert.equal(Number.isFinite(result.messages[1].timestamp), true, "inserted messages receive a fresh timestamp");
	assert.notEqual(result.messages[1].timestamp, 101);
	assert.notEqual(result.messages[1].timestamp, 202);
	assert.deepEqual(result.messages[1].content, [{ type: "text", text: "template inserted synthetic message" }]);
	assert.equal(result.messages[2].syntheticMessageId, "alpha");
	assert.equal(result.messages[2].timestamp, 101);
	assert.equal(result.messages[2].sourceMetadata.owner, "alpha");
	assert.deepEqual(result.messages[2].content, alpha.content);
	assert.equal(result.messages.some((message: any) => "__liyuanIndex" in message), false, "private identity markers must not leak to the author");
});
