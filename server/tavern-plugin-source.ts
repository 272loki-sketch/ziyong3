/** Fixed, unchanged upstream runtime bundles. No upstream code is rebuilt or patched here. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomicWithBackup } from "../src/atomic-json.ts";

export type TavernPluginId = "helper" | "template";
export interface TavernPluginUpstream { id: TavernPluginId; name: string; repository: string }
export const TAVERN_PLUGIN_UPSTREAMS: Readonly<Record<TavernPluginId, Readonly<TavernPluginUpstream>>> = Object.freeze({
	helper: Object.freeze({ id: "helper", name: "酒馆助手", repository: "https://github.com/N0VI028/JS-Slash-Runner.git" }),
	template: Object.freeze({ id: "template", name: "提示词模板", repository: "https://github.com/zonde306/ST-Prompt-Template.git" }),
});
const IDS: TavernPluginId[] = ["helper", "template"];
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION_KEY = /^[0-9a-f]{40}-[0-9a-f]{64}$/;
const RUNTIME_ROOTS = ["dist", "libs", "lib", "templates", "i18n", "locales"];
const IFRAME_LOG_PATH = "src/iframe/node_modules/log.js";
const RUNTIME_PATHS = [...RUNTIME_ROOTS, "settings.html", "manifest.json", "LICENSE", IFRAME_LOG_PATH];
const DEFAULT_INTERVAL = 6 * 60 * 60 * 1000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 4096;

export interface TavernPluginFile { path: string; sha256: string; bytes: number }
export interface TavernPluginManifest { version: string; js: string; css?: string; i18n?: Record<string, string>; [key: string]: unknown }
/** Internal callback data only: root is the verified runtime installation directory, never a public status field. */
export interface TavernPluginCandidate {
	id: TavernPluginId; root: string; version: string; commit: string; sha256: string;
	manifest: TavernPluginManifest; files: TavernPluginFile[];
}
export interface TavernPluginStatus {
	id: TavernPluginId; name: string; enabled: boolean; autoUpdate: boolean; installed: boolean;
	version?: string; commit?: string; sha256?: string; previousVersion?: string;
	candidateVersion?: string; updateAvailable?: boolean; pendingActivation?: boolean;
	lastCheck?: string; lastError?: string;
}
export interface TavernPluginsStatus { plugins: TavernPluginStatus[]; checking: boolean }
export interface TavernPluginConfig { enabled: boolean; autoUpdate: boolean }
export interface TavernPluginsConfig { plugins: Record<TavernPluginId, TavernPluginConfig> }
export interface TavernPluginVerification { ok: boolean; errors: string[] }
export interface TavernPluginGitProvider {
	resolveCommit(upstream: Readonly<TavernPluginUpstream>, signal: AbortSignal): Promise<string>;
	checkout(upstream: Readonly<TavernPluginUpstream>, commit: string, destination: string, signal: AbortSignal): Promise<void>;
}
export interface TavernPluginActivationHooks {
	isIdle: () => boolean | Promise<boolean>;
	validateCandidate?: (candidate: TavernPluginCandidate) => boolean | void | Promise<boolean | void>;
	onActivated?: (plugin: TavernPluginStatus) => void | Promise<void>;
}
export interface TavernPluginAutoUpdateOptions extends TavernPluginActivationHooks { intervalMs?: number; idleRetryMs?: number }
export interface TavernPluginSourceOptions {
	gitProvider?: TavernPluginGitProvider;
	/** Explicit proxy wins; otherwise use LIYUAN_TAVERN_GIT_PROXY, HTTPS_PROXY or HTTP_PROXY. */
	proxy?: string; now?: () => number; maxBytes?: number; maxFiles?: number;
	activation?: TavernPluginActivationHooks;
}
export interface TavernPluginInstallOptions {
	/** Local, explicit offline test seam. Never exposed as an HTTP repository selector. */
	fixtureRepo?: string; commit?: string;
}
export interface TavernPluginCheck { id: TavernPluginId; updateAvailable: boolean; candidateVersion?: string; version?: string; commit?: string; sha256?: string }
interface PluginPointer extends TavernPluginConfig {
	active?: string; previous?: string; candidate?: string; candidateRejected?: boolean; activationRequested?: boolean;
	blockedCommit?: string; lastCheck?: string; lastError?: string;
}
interface Pointer { version: 1; plugins: Record<TavernPluginId, PluginPointer> }
interface SourceRecord { version: 1; id: TavernPluginId; repository: string; commit: string; sourceVersion: string; sha256: string; files: TavernPluginFile[] }
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const aggregate = (files: TavernPluginFile[]) => digest(JSON.stringify(files));
function idOf(value: unknown): TavernPluginId {
	if (value !== "helper" && value !== "template") throw new Error("不受信任的酒馆插件来源");
	return value;
}
function runtimePath(path: string): boolean {
	return path === "manifest.json" || path === "settings.html" || path === "LICENSE" || path === IFRAME_LOG_PATH || RUNTIME_ROOTS.some((root) => path.startsWith(`${root}/`));
}
function safeRelative(path: unknown): path is string {
	return typeof path === "string" && path.length > 0 && path.length < 1024 && !isAbsolute(path) && !path.includes("\\") && !/[\x00-\x1f\x7f?#]/.test(path)
		&& path.split("/").every((piece) => !!piece && piece !== "." && piece !== ".." && piece !== ".git");
}
function assertDirectory(path: string): void {
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("插件私有安装目录不是安全的普通目录");
	} else mkdirSync(path, { mode: 0o700 });
	chmodSync(path, 0o700);
}
/** Avoid following either a parent symlink or a final-file symlink when reading runtime assets. */
function regularFile(root: string, relativePath: string): string {
	if (!safeRelative(relativePath)) throw new Error("插件资源路径无效");
	let path = root;
	const rootStat = lstatSync(path);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("插件安装目录已改变");
	const pieces = relativePath.split("/");
	for (let index = 0; index < pieces.length; index++) {
		path = join(path, pieces[index]);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || (index === pieces.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("插件资源包含非普通文件或符号链接");
	}
	return path;
}
function limitedRead(root: string, path: string, maxBytes: number, expectedBytes?: number): Buffer {
	const file = regularFile(root, path), size = lstatSync(file).size;
	if (size > maxBytes || (expectedBytes !== undefined && size !== expectedBytes)) throw new Error(`插件资源大小或完整性失败：${path}`);
	const bytes = readFileSync(file);
	if (bytes.length > maxBytes || (expectedBytes !== undefined && bytes.length !== expectedBytes)) throw new Error(`插件资源大小或完整性失败：${path}`);
	return bytes;
}
function defaultPointer(): Pointer {
	return { version: 1, plugins: { helper: { enabled: false, autoUpdate: true }, template: { enabled: false, autoUpdate: true } } };
}
function git(args: string[], signal?: AbortSignal, proxy?: string): Promise<Buffer> {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
	const prefix = ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.ext.allow=never", "-c", "http.followRedirects=false"];
	prefix.push("-c", `http.proxy=${proxy ?? ""}`, "-c", "http.version=HTTP/1.1");
	return new Promise((ok, reject) => execFile("git", [...prefix, ...args], {
		encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 120_000, signal,
		env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" },
	}, (error, stdout, stderr) => error ? reject(Object.assign(new Error(`插件 Git 操作失败（${String((error as { code?: unknown }).code ?? "unknown")}）`), { cause: error, networkFailure: /SSL|TLS|connect|resolve host|timed out|unable to access|early EOF|RPC failed/i.test(String(stderr)) })) : ok(stdout)));
}
export function createTavernPluginGitProvider(proxy = process.env.LIYUAN_TAVERN_GIT_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY): TavernPluginGitProvider {
	if (proxy) {
		const proxyUrl = new URL(proxy);
		if (!/^https?:$/.test(proxyUrl.protocol) || proxyUrl.username || proxyUrl.password) throw new Error("Git 代理必须是无凭据的 HTTP 地址");
	}
	const networkGit = async (args:string[],signal:AbortSignal):Promise<Buffer> => {
		try{return await git(args,signal,proxy);}catch(error){if(!proxy||signal.aborted||!(error as {networkFailure?:boolean}).networkFailure)throw error;return git(args,signal);}
	};
	return {
		async resolveCommit(upstream, signal) {
			// No user-controlled repo, branch, redirect, credentials, hooks or build command.
			const repository = TAVERN_PLUGIN_UPSTREAMS[idOf(upstream.id)].repository;
			const text = (await networkGit(["ls-remote", repository, "HEAD"], signal)).toString("utf8").trim();
			const row = text.split("\n").find((line) => line.endsWith("\tHEAD"));
			const commit = row?.split("\t")[0];
			if (!commit || !COMMIT.test(commit)) throw new Error("可信上游没有返回完整 commit");
			return commit;
		},
		async checkout(upstream, commit, destination, signal) {
			if (!COMMIT.test(commit)) throw new Error("插件 commit 必须为完整的 40 位标识");
			const repository = TAVERN_PLUGIN_UPSTREAMS[idOf(upstream.id)].repository;
			await networkGit(["clone", "--depth=1", "--no-checkout", "--", repository, destination], signal);
			// Pin the detected object even if HEAD moves between detection and cloning.
			await networkGit(["-C", destination, "fetch", "--depth=1", "origin", commit], signal);
			await git(["-C", destination, "-c", "core.autocrlf=false", "checkout", "--detach", commit], signal);
		},
	};
}

export class TavernPluginSources {
	readonly root: string;
	readonly statePath: string;
	readonly #options: TavernPluginSourceOptions;
	readonly #provider: TavernPluginGitProvider;
	readonly #now: () => number;
	readonly #running = new Set<TavernPluginId>();
	readonly #errors = new Map<TavernPluginId, string>();
	readonly #controller = new AbortController();
	#hooks?: TavernPluginActivationHooks;
	#timer?: ReturnType<typeof setInterval>;
	#autoRunning = false;
	#closed = false;
	#intervalMs = DEFAULT_INTERVAL;
	constructor(cwd: string, options: TavernPluginSourceOptions = {}) {
		this.root = join(resolve(cwd), ".liyuan-tavern-plugins");
		this.statePath = join(this.root, "state.json");
		this.#options = options;
		this.#provider = options.gitProvider ?? createTavernPluginGitProvider(options.proxy);
		this.#now = options.now ?? Date.now;
		this.#hooks = options.activation;
	}
	#read(): Pointer {
		if (!existsSync(this.root)) return defaultPointer();
		const rootStat = lstatSync(this.root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("插件私有目录不可用；未覆盖原数据");
		if (!existsSync(this.statePath)) {
			const versions = join(this.root, "versions");
			if (existsSync(versions)) {
				const stat = lstatSync(versions);
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("插件版本目录不可用，未覆盖原数据");
				for (const id of IDS) {
					const directory = join(versions, id);
					if (existsSync(directory)) {
						const stat = lstatSync(directory);
						if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("插件版本目录不可用，未覆盖原数据");
						if (readdirSync(directory).some((key) => VERSION_KEY.test(key))) throw new Error("插件原版本存在但激活指针缺失，未覆盖或删除原文件");
					}
				}
			}
			return defaultPointer();
		}
		const value = JSON.parse(limitedRead(this.root, "state.json", 512 * 1024).toString("utf8")) as Pointer;
		if (value.version !== 1 || !value.plugins) throw new Error("插件指针格式损坏；未覆盖原数据");
		for (const id of IDS) {
			const pointer = value.plugins[id];
			if (!pointer || typeof pointer.enabled !== "boolean" || typeof pointer.autoUpdate !== "boolean") throw new Error("插件配置格式损坏；未覆盖原数据");
			for (const flag of [pointer.candidateRejected, pointer.activationRequested]) if (flag !== undefined && typeof flag !== "boolean") throw new Error("插件激活记录损坏");
			for (const key of [pointer.active, pointer.previous, pointer.candidate]) if (key !== undefined && !VERSION_KEY.test(key)) throw new Error("插件版本指针损坏");
			if (pointer.blockedCommit !== undefined && !COMMIT.test(pointer.blockedCommit)) throw new Error("插件回退指针损坏");
			if (pointer.lastCheck !== undefined && (!Number.isFinite(Date.parse(pointer.lastCheck)) || typeof pointer.lastCheck !== "string")) throw new Error("插件更新记录损坏");
			if (pointer.lastError !== undefined && typeof pointer.lastError !== "string") throw new Error("插件错误记录损坏");
		}
		return value;
	}
	#prepare(): void {
		if (this.#closed) throw new Error("插件来源管理已关闭");
		assertDirectory(this.root);
		assertDirectory(join(this.root, "versions"));
		for (const id of IDS) assertDirectory(join(this.root, "versions", id));
	}
	#mutate(id: TavernPluginId, change: (pointer: PluginPointer) => void): void {
		const state = this.#read();
		change(state.plugins[id]);
		this.#prepare();
		writeJsonAtomicWithBackup(this.statePath, state);
	}
	#safeError(error: unknown): string {
		const message = error instanceof Error ? error.message : "酒馆插件操作失败";
		return message.replace(/\b(?:api[-_]?key|token|authorization|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[credential]").replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]").replaceAll(this.root, "[private-cache]").replace(/\b(?:https?:\/\/|[A-Za-z]:[\\/]|\/)[^\s，。；）)]+/g, "[path]").slice(0, 400);
	}
	#rememberError(id: TavernPluginId, error: unknown): void {
		const message = this.#safeError(error);
		this.#errors.set(id, message);
		try { this.#mutate(id, (pointer) => { pointer.lastError = message; }); } catch { /* Preserve unreadable/exhausted state; report the original failure in-memory. */ }
	}
	#directory(id: TavernPluginId, key: string): string {
		if (!VERSION_KEY.test(key)) throw new Error("插件版本指针格式无效");
		return join(this.root, "versions", id, key);
	}
	#record(id: TavernPluginId, key: string): SourceRecord {
		const directory = this.#directory(id, key);
		// Parents must also be ordinary directories: lexical containment alone is not sufficient.
		regularFile(this.root, `versions/${id}/${key}/source.json`);
		const record = JSON.parse(limitedRead(directory, "source.json", 8 * 1024 * 1024).toString("utf8")) as SourceRecord;
		if (record.version !== 1 || record.id !== id || record.repository !== TAVERN_PLUGIN_UPSTREAMS[id].repository || !COMMIT.test(record.commit)
			|| !HASH.test(record.sha256) || key !== `${record.commit}-${record.sha256}` || !Array.isArray(record.files) || !record.files.length
			|| record.files.length > (this.#options.maxFiles ?? MAX_FILES) || typeof record.sourceVersion !== "string") throw new Error("插件来源记录或固定标识不一致");
		let bytes = 0, prior = "";
		for (const file of record.files) {
			if (!safeRelative(file.path) || !runtimePath(file.path) || file.path.endsWith(".map") || !HASH.test(file.sha256) || !Number.isSafeInteger(file.bytes)
				|| file.bytes < 0 || file.path <= prior) throw new Error("插件逐文件完整性记录无效");
			prior = file.path; bytes += file.bytes;
		}
		if (bytes > (this.#options.maxBytes ?? MAX_BYTES) || aggregate(record.files) !== record.sha256) throw new Error("插件文件清单完整性不一致");
		return record;
	}
	#candidate(id: TavernPluginId, key: string): TavernPluginCandidate {
		const record = this.#record(id, key), root = join(this.#directory(id, key), "runtime");
		const manifestFile = record.files.find((file) => file.path === "manifest.json");
		if (!manifestFile) throw new Error("插件 manifest 完整性失败");
		const manifestBytes = limitedRead(root, "manifest.json", this.#options.maxBytes ?? MAX_BYTES, manifestFile.bytes);
		if (!manifestFile || manifestBytes.length !== manifestFile.bytes || digest(manifestBytes) !== manifestFile.sha256) throw new Error("插件 manifest 完整性失败");
		const manifest = this.#manifest(manifestBytes, new Set(record.files.map((file) => file.path)));
		if (manifest.version !== record.sourceVersion) throw new Error("插件版本与原 manifest 不一致");
		return { id, root, version: record.sourceVersion, commit: record.commit, sha256: record.sha256, manifest, files: record.files };
	}
	#verifyKey(id: TavernPluginId, key?: string): TavernPluginVerification {
		if (!key) return { ok: false, errors: ["尚未安装原插件"] };
		try {
			const candidate = this.#candidate(id, key);
			for (const file of candidate.files) {
				const bytes = limitedRead(candidate.root, file.path, this.#options.maxBytes ?? MAX_BYTES, file.bytes);
				if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`插件资源完整性失败：${file.path}`);
			}
			return { ok: true, errors: [] };
		} catch (error) { return { ok: false, errors: [this.#safeError(error)] }; }
	}
	#pluginStatus(id: TavernPluginId, pointer: PluginPointer): TavernPluginStatus {
		const verified = this.#verifyKey(id, pointer.active);
		const result: TavernPluginStatus = { id, name: TAVERN_PLUGIN_UPSTREAMS[id].name, enabled: pointer.enabled, autoUpdate: pointer.autoUpdate, installed: verified.ok };
		try { if (pointer.active) { const current = this.#candidate(id, pointer.active); result.version = current.version; result.commit = current.commit; result.sha256 = current.sha256; } } catch { /* Do not publish paths or malformed records. */ }
		try { if (pointer.previous) result.previousVersion = this.#candidate(id, pointer.previous).version; } catch { /* Previous corruption never silently becomes active. */ }
		try { if (pointer.candidate) { const candidate = this.#candidate(id, pointer.candidate); result.candidateVersion = candidate.version; result.updateAvailable = pointer.candidate !== pointer.active; result.pendingActivation = result.updateAvailable && !pointer.candidateRejected && !pointer.candidate.startsWith(`${pointer.blockedCommit}-`) && (pointer.autoUpdate || pointer.activationRequested === true); } } catch { /* verify/update will report the damaged candidate. */ }
		if (pointer.lastCheck) result.lastCheck = pointer.lastCheck;
		const error = this.#errors.get(id) ?? pointer.lastError ?? (pointer.active && !verified.ok ? verified.errors.join("；") : undefined);
		if (error) result.lastError = this.#safeError(new Error(error));
		return result;
	}
	status(): TavernPluginsStatus {
		try { const state = this.#read(); return { plugins: IDS.map((id) => this.#pluginStatus(id, state.plugins[id])), checking: this.#running.size > 0 }; }
		catch (error) { return { plugins: IDS.map((id) => ({ id, name: TAVERN_PLUGIN_UPSTREAMS[id].name, enabled: false, autoUpdate: true, installed: false, lastError: this.#safeError(error) })), checking: this.#running.size > 0 }; }
	}
	config(): TavernPluginsConfig {
		const state = this.#read();
		return { plugins: { helper: { enabled: state.plugins.helper.enabled, autoUpdate: state.plugins.helper.autoUpdate }, template: { enabled: state.plugins.template.enabled, autoUpdate: state.plugins.template.autoUpdate } } };
	}
	configure(value: TavernPluginId, patch: Partial<TavernPluginConfig>): TavernPluginsConfig {
		const id = idOf(value);
		if (!patch || typeof patch !== "object" || Object.keys(patch).some((key) => key !== "enabled" && key !== "autoUpdate")
			|| (patch.enabled !== undefined && typeof patch.enabled !== "boolean") || (patch.autoUpdate !== undefined && typeof patch.autoUpdate !== "boolean")) throw new Error("插件启用/自动更新必须是布尔配置");
		if (patch.enabled === true && !this.verify(id).ok) throw new Error("请先安装并核验原插件后再启用");
		this.#mutate(id, (pointer) => { if (patch.enabled !== undefined) pointer.enabled = patch.enabled; if (patch.autoUpdate !== undefined) pointer.autoUpdate = patch.autoUpdate; });
		return this.config();
	}
	verify(value: TavernPluginId): TavernPluginVerification {
		const id = idOf(value);
		try { return this.#verifyKey(id, this.#read().plugins[id].active); } catch (error) { return { ok: false, errors: [this.#safeError(error)] }; }
	}
	/** Original bytes only. Invalid paths, symlinks, missing or altered assets are never served. */
	resolveAsset(value: TavernPluginId, relativePath: string): string | null {
		const id = idOf(value);
		if (!safeRelative(relativePath)) return null;
		try {
			const key = this.#read().plugins[id].active;
			if (!key) return null;
			const candidate = this.#candidate(id, key), file = candidate.files.find((entry) => entry.path === relativePath);
			if (!file) return null;
			const path = regularFile(candidate.root, relativePath), bytes = limitedRead(candidate.root, relativePath, this.#options.maxBytes ?? MAX_BYTES, file.bytes);
			return bytes.length === file.bytes && digest(bytes) === file.sha256 ? path : null;
		} catch { return null; }
	}
	#manifest(bytes: Uint8Array, paths: Set<string>): TavernPluginManifest {
		const manifest = JSON.parse(Buffer.from(bytes).toString("utf8")) as TavernPluginManifest;
		if (typeof manifest.version !== "string" || !/^[0-9][0-9A-Za-z.+-]{0,99}$/.test(manifest.version)
			|| !safeRelative(manifest.js) || !manifest.js.startsWith("dist/") || !paths.has(manifest.js)) throw new Error("原插件 manifest 缺少可用版本或原始 dist 入口");
		if (manifest.css !== undefined && manifest.css !== "" && (!safeRelative(manifest.css) || !paths.has(manifest.css))) throw new Error("原插件缺少 manifest 声明的样式");
		if (manifest.i18n !== undefined) {
			if (!manifest.i18n || typeof manifest.i18n !== "object" || Array.isArray(manifest.i18n)) throw new Error("原插件 i18n 格式无效");
			for (const path of Object.values(manifest.i18n)) if (!safeRelative(path) || !paths.has(path)) throw new Error("原插件缺少声明的语言文件");
		}
		return manifest;
	}
	async #stage(id: TavernPluginId, options: TavernPluginInstallOptions): Promise<string> {
		if (options.commit !== undefined && !COMMIT.test(options.commit)) throw new Error("插件 commit 必须为完整的 40 位标识");
		this.#prepare();
		const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(180_000)]);
		const upstream = TAVERN_PLUGIN_UPSTREAMS[id];
		const commit = options.commit ?? (options.fixtureRepo ? (await git(["-C", resolve(options.fixtureRepo), "rev-parse", "--verify", "HEAD"], signal)).toString("utf8").trim() : await this.#provider.resolveCommit(upstream, signal));
		if (!COMMIT.test(commit)) throw new Error("上游没有提供完整固定 commit");
		const pointer = this.#read().plugins[id];
		for (const existing of [pointer.active, pointer.previous, pointer.candidate]) {
			if (existing?.startsWith(`${commit}-`) && this.#verifyKey(id, existing).ok) {
				// Re-extract an older helper cache that predates its one explicitly allowed original iframe logger.
				if (id !== "helper" || this.#record(id, existing).files.some((file) => file.path === IFRAME_LOG_PATH)) return existing;
			}
		}
		const stage = mkdtempSync(join(this.root, ".staging-")); chmodSync(stage, 0o700);
		try {
			const repository = options.fixtureRepo ? resolve(options.fixtureRepo) : join(stage, "repository");
			if (!options.fixtureRepo) await this.#provider.checkout(upstream, commit, repository, signal);
			const actualCommit = (await git(["-C", repository, "rev-parse", "--verify", "HEAD"], signal)).toString("utf8").trim();
			if (actualCommit !== commit) throw new Error("下载的原插件与固定 commit 不一致");
			const tree = (await git(["-C", repository, "ls-tree", "-rz", "--full-tree", commit, "--", ...RUNTIME_PATHS], signal)).toString("utf8");
			const selected = tree.split("\0").filter(Boolean).map((row) => {
				const split = row.indexOf("\t"), metadata = row.slice(0, split).split(" "), path = row.slice(split + 1);
				return { mode: metadata[0], type: metadata[1], object: metadata[2], path };
			}).filter((entry) => !entry.path.endsWith(".map")).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
			if (!selected.length || selected.length > (this.#options.maxFiles ?? MAX_FILES)) throw new Error("原插件运行文件数超出安全预算");
			const installation = join(stage, "installation"), runtime = join(installation, "runtime");
			assertDirectory(installation); assertDirectory(runtime);
			const files: TavernPluginFile[] = []; let total = 0;
			for (const entry of selected) {
				if (!safeRelative(entry.path) || !runtimePath(entry.path) || entry.type !== "blob" || !/^100(?:644|755)$/.test(entry.mode) || !COMMIT.test(entry.object)) throw new Error("原插件运行文件包含非普通 Git 文件");
				const source = regularFile(repository, entry.path), stat = lstatSync(source);
				if (stat.size > (this.#options.maxBytes ?? MAX_BYTES) || (total += stat.size) > (this.#options.maxBytes ?? MAX_BYTES)) throw new Error("原插件运行文件大小超出安全预算");
				const bytes = readFileSync(source);
				const gitHash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
				if (gitHash !== entry.object) throw new Error(`原插件文件不等于固定 Git 对象：${entry.path}`);
				let targetDirectory = runtime;
				for (const piece of entry.path.split("/").slice(0, -1)) { targetDirectory = join(targetDirectory, piece); assertDirectory(targetDirectory); }
				writeFileSync(join(runtime, entry.path), bytes, { mode: 0o600, flag: "wx" });
				files.push({ path: entry.path, sha256: digest(bytes), bytes: bytes.length });
			}
			const manifest = this.#manifest(readFileSync(join(runtime, "manifest.json")), new Set(files.map((file) => file.path)));
			const sha256 = aggregate(files), key = `${commit}-${sha256}`;
			const record: SourceRecord = { version: 1, id, repository: upstream.repository, commit, sourceVersion: manifest.version, sha256, files };
			writeFileSync(join(installation, "source.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			const target = this.#directory(id, key);
			if (existsSync(target)) {
				if (!this.#verifyKey(id, key).ok) throw new Error("同标识缓存已损坏；未覆盖原插件版本");
			} else renameSync(installation, target);
			if (!this.#verifyKey(id, key).ok) throw new Error("候选全文件复核失败");
			return key;
		} finally { rmSync(stage, { recursive: true, force: true }); }
	}
	async #operation<T>(id: TavernPluginId, fn: () => Promise<T>): Promise<T> {
		if (this.#closed) throw new Error("插件来源管理已关闭");
		if (this.#running.has(id)) throw new Error("该插件正在检查或安装，请稍后重试");
		this.#running.add(id);
		try { const result = await fn(); this.#errors.delete(id); return result; }
		catch (error) {
			this.#rememberError(id, error);
			const safe = new Error(this.#safeError(error), { cause: error });
			if (typeof (error as { code?: unknown })?.code === "string") Object.assign(safe, { code: (error as { code: string }).code });
			throw safe;
		}
		finally { this.#running.delete(id); }
	}
	async #check(id: TavernPluginId, options: TavernPluginInstallOptions): Promise<string> {
		this.#mutate(id, (pointer) => { pointer.lastCheck = new Date(this.#now()).toISOString(); });
		const key = await this.#stage(id, options);
		this.#mutate(id, (pointer) => {
			const preserveValidationFailure = pointer.candidate === key && pointer.candidateRejected;
			pointer.lastCheck = new Date(this.#now()).toISOString();
			if (key !== pointer.active) {
				if (pointer.candidate !== key) { pointer.candidateRejected = false; delete pointer.activationRequested; }
				pointer.candidate = key;
			} else { delete pointer.candidate; delete pointer.candidateRejected; delete pointer.activationRequested; }
			if (!preserveValidationFailure) delete pointer.lastError;
		});
		this.#collect(id);
		return key;
	}
	async #activate(id: TavernPluginId, key: string, rollback = false, automatic = false): Promise<boolean> {
		if (!this.#verifyKey(id, key).ok) throw new Error("候选原插件完整性失败，未切换激活版本");
		if (this.#hooks && !await this.#hooks.isIdle()) {
			if (rollback) throw new Error("生成或宿主任务忙碌，未回退原插件");
			return false;
		}
		const candidate = this.#candidate(id, key);
		try { if (this.#hooks?.validateCandidate && await this.#hooks.validateCandidate(candidate) === false) throw new Error("宿主实测拒绝候选原插件，未切换激活版本"); }
		catch (error) { if (!rollback) this.#mutate(id, (pointer) => { pointer.candidateRejected = true; }); throw error; }
		if (this.#closed || this.#controller.signal.aborted) throw new Error("插件安装已取消，未切换激活版本");
		if (!this.#verifyKey(id, key).ok) throw new Error("宿主校验后原插件字节发生变化，未切换激活版本");
		if (this.#hooks && !await this.#hooks.isIdle()) {
			if (rollback) throw new Error("生成或宿主任务忙碌，未回退原插件");
			return false;
		}
		const before = { ...this.#read().plugins[id] };
		if (automatic && ((!before.autoUpdate && !before.activationRequested) || before.candidate !== key || before.candidateRejected || key.startsWith(`${before.blockedCommit}-`))) return false;
		if (before.active === key) { this.#mutate(id, (pointer) => { delete pointer.activationRequested; }); return true; }
		this.#mutate(id, (pointer) => {
			pointer.previous = pointer.active;
			pointer.active = key;
			delete pointer.candidate; delete pointer.candidateRejected; delete pointer.activationRequested; delete pointer.lastError;
			if (rollback && before.active) pointer.blockedCommit = before.active.slice(0, 40); else delete pointer.blockedCommit;
		});
		try { await this.#hooks?.onActivated?.(this.#pluginStatus(id, this.#read().plugins[id])); }
		catch (error) {
			// If a runtime rebind fails, restore the prior verified atomic pointer, never erase its assets.
			this.#mutate(id, (pointer) => { const enabled = pointer.enabled, autoUpdate = pointer.autoUpdate; Object.assign(pointer, before, { enabled, autoUpdate }); for (const field of ["active", "previous", "candidate", "candidateRejected", "activationRequested", "blockedCommit"] as const) if (!(field in before)) delete pointer[field]; if (!rollback) { pointer.candidate = key; pointer.candidateRejected = true; delete pointer.activationRequested; } });
			throw new Error("原插件宿主激活失败，已恢复先前版本", { cause: error });
		}
		this.#collect(id);
		return true;
	}
	#collect(id: TavernPluginId): void {
		const pointer = this.#read().plugins[id], retained = new Set([pointer.active, pointer.previous, pointer.candidate]);
		const directory = join(this.root, "versions", id);
		if (!existsSync(directory)) return;
		for (const parent of [this.root, join(this.root, "versions"), directory]) {
			const stat = lstatSync(parent);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("插件版本目录已改变，未清理缓存");
		}
		for (const entry of readdirSync(directory)) if (VERSION_KEY.test(entry) && !retained.has(entry)) {
			try { rmSync(join(directory, entry), { recursive: true, force: true }); } catch { /* Retaining an obsolete cache is safer than failing activation or removing retained versions. */ }
		}
	}
	async install(value: TavernPluginId, options: TavernPluginInstallOptions = {}): Promise<TavernPluginStatus> {
		const id = idOf(value);
		return this.#operation(id, async () => { const key = await this.#check(id, options); this.#mutate(id, (pointer) => { pointer.activationRequested = true; delete pointer.candidateRejected; delete pointer.blockedCommit; }); await this.#activate(id, key); return this.#pluginStatus(id, this.#read().plugins[id]); });
	}
	async checkUpdate(value: TavernPluginId, options: TavernPluginInstallOptions = {}): Promise<TavernPluginCheck> {
		const id = idOf(value);
		return this.#operation(id, async () => { const key = await this.#check(id, options), candidate = this.#candidate(id, key), pointer = this.#read().plugins[id]; return { id, updateAvailable: key !== pointer.active, candidateVersion: candidate.version, version: candidate.version, commit: candidate.commit, sha256: candidate.sha256 }; });
	}
	async update(value: TavernPluginId, options: TavernPluginInstallOptions = {}): Promise<TavernPluginStatus> {
		const id = idOf(value);
		return this.#operation(id, async () => {
			const pointer = this.#read().plugins[id];
			const key = options.fixtureRepo || options.commit || !pointer.candidate ? await this.#check(id, options) : pointer.candidate;
			this.#mutate(id, (item) => { delete item.candidateRejected; delete item.blockedCommit; item.activationRequested = true; });
			await this.#activate(id, key); return this.#pluginStatus(id, this.#read().plugins[id]);
		});
	}
	async rollback(value: TavernPluginId): Promise<TavernPluginStatus> {
		const id = idOf(value);
		return this.#operation(id, async () => {
			const previous = this.#read().plugins[id].previous;
			if (!previous) throw new Error("没有可回退的已验证原插件版本");
			await this.#activate(id, previous, true); return this.#pluginStatus(id, this.#read().plugins[id]);
		});
	}
	startAutoUpdate(options: TavernPluginAutoUpdateOptions): void {
		if (this.#closed) throw new Error("插件来源管理已关闭");
		if (!options || typeof options.isIdle !== "function") throw new Error("自动更新需要宿主空闲检查");
		if (this.#timer) clearInterval(this.#timer);
		this.#hooks = options;
		this.#intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs! > 0 ? options.intervalMs! : DEFAULT_INTERVAL;
		const retry = Number.isFinite(options.idleRetryMs) && options.idleRetryMs! > 0 ? options.idleRetryMs! : Math.min(15_000, this.#intervalMs);
		this.#timer = setInterval(() => { void this.autoUpdateOnce(); }, retry);
		this.#timer.unref();
		void this.autoUpdateOnce();
	}
	/** Deterministic offline regression seam; the timer calls this same actual updater. */
	async autoUpdateOnce(): Promise<void> {
		if (this.#closed || this.#autoRunning) return;
		this.#autoRunning = true;
		try {
			for (const id of IDS) {
				if (this.#closed || this.#running.has(id)) continue;
				const pointer = this.#read().plugins[id];
				if ((!pointer.active && !pointer.candidate) || (!pointer.autoUpdate && !pointer.activationRequested)) continue; // A user-staged first install may activate later; never download unrequested missing plugins.
				try {
					await this.#operation(id, async () => {
						let current = this.#read().plugins[id];
						if (current.autoUpdate && (!current.lastCheck || this.#now() - Date.parse(current.lastCheck) >= this.#intervalMs)) { await this.#check(id, {}); current = this.#read().plugins[id]; }
						if ((!current.autoUpdate && !current.activationRequested) || !current.candidate || current.candidateRejected || current.candidate.startsWith(`${current.blockedCommit}-`)) return;
						await this.#activate(id, current.candidate, false, true);
					});
				} catch { /* #operation retained the current/previous version and safe failure state. */ }
			}
		} catch (error) { for (const id of IDS) this.#errors.set(id, this.#safeError(error)); }
		finally { this.#autoRunning = false; }
	}
	close(): void { this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; this.#controller.abort(); }
}
