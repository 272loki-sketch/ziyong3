/** Original-byte NPC Parallel source manager. Upstream assets are never patched or rebuilt. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeJsonAtomicWithBackup } from "../src/atomic-json.ts";
import { acquireTavernPluginLock } from "./tavern-plugin-lock.ts";

export const NPC_PARALLEL_UPSTREAM = Object.freeze({
  name: "众生侧写",
  repository: "https://github.com/ug776732-arch/npc-parallel.git",
});

const ROOT_NAME = ".liyuan-npc-parallel";
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION_KEY = /^([0-9a-f]{40})-([0-9a-f]{64})$/;
const MAX_FILES = 2048;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const RUNTIME_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".css", ".html", ".htm", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".ico", ".woff", ".woff2", ".ttf", ".otf", ".wasm",
]);

export interface NpcParallelFile {
  path: string;
  bytes: number;
  sha256: string;
  gitBlob: string;
}
export interface NpcParallelCandidate {
  /** Directory containing only manifest-declared runtime assets and LICENSE. */
  root: string;
  version: string;
  commit: string;
  sha256: string;
  manifest: Record<string, unknown>;
}
export interface NpcParallelStatus {
  installed: boolean;
  enabled: boolean;
  autoUpdate: boolean;
  version?: string;
  previousVersion?: string;
  commit?: string;
  sha256?: string;
  candidateVersion?: string;
  updateAvailable?: boolean;
  pendingActivation?: boolean;
  lastError?: string;
}
export interface NpcParallelHooks {
  isIdle: () => boolean | Promise<boolean>;
  /** Must exercise the candidate through a synthetic host/session; absence fails closed for activation. */
  validateCandidate?: (candidate: NpcParallelCandidate) => Promise<boolean>;
  onActivated?: () => Promise<void>;
}
export interface NpcParallelOptions {
  proxy?: string;
  commit?: string;
  /** Explicit offline test seam; production source is always the fixed public repository above. */
  fixtureRepo?: string;
}
export interface NpcParallelCheckResult {
  updateAvailable: boolean;
  candidateVersion?: string;
  version?: string;
  commit?: string;
  sha256?: string;
}

interface SourceRecord {
  schema: 1;
  repository: string;
  commit: string;
  version: string;
  sha256: string;
  files: NpcParallelFile[];
}
interface Pointer {
  schema: 1;
  enabled: boolean;
  autoUpdate: boolean;
  active?: string;
  previous?: string;
  candidate?: string;
  blockedCommit?: string;
  blockedCommits?: string[];
  lastCheck?: string;
  lastError?: string;
}
interface TreeEntry { mode: string; type: string; oid: string; path: string }

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function existsLstat(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw error; }
}
const gitBlob = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
const aggregate = (files: NpcParallelFile[]) => digest(JSON.stringify(files));
function safeRelative(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 1024 && !isAbsolute(path) &&
    !path.includes("\\") && !/[\x00-\x1f\x7f?#]/.test(path) &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
function assertPlainDirectory(path: string, label: string): void {
  if (existsLstat(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label}不是安全的普通目录`);
    chmodSync(path, 0o700);
  } else mkdirSync(path, { mode: 0o700 });
}
function assertPlainFile(path: string, label: string, maxBytes = MAX_FILE_BYTES): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error(`${label}不是安全的普通文件`);
}
function safeFilePath(root: string, relativePath: string): string {
  if (!safeRelative(relativePath)) throw new Error("NPC Parallel 资源路径无效");
  let current = root;
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("NPC Parallel 资产根目录已改变");
  chmodSync(root, 0o700);
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error("NPC Parallel 资源包含非普通文件或符号链接");
    }
    chmodSync(current, index === parts.length - 1 ? 0o600 : 0o700);
  }
  return current;
}
function ensureProxy(proxy?: string): string | undefined {
  if (proxy === undefined || proxy === "") return undefined;
  let parsed: URL;
  try { parsed = new URL(proxy); } catch { throw new Error("Git 代理地址无效"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("Git 代理必须是无凭据的 HTTP(S) 地址");
  return parsed.toString();
}
function git(args: string[], options: { cwd?: string; proxy?: string; fixture?: boolean; signal?: AbortSignal } = {}): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/bin/false";
  const prefix = [
    "-c", "credential.helper=",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null",
    "-c", "protocol.ext.allow=never",
    "-c", "http.followRedirects=false",
    "-c", `http.proxy=${options.proxy ?? ""}`,
    "-c", "http.version=HTTP/1.1",
  ];
  if (options.fixture) prefix.push("-c", "protocol.file.allow=always");
  return new Promise((resolvePromise, reject) => execFile("git", [...prefix, ...args], {
    cwd: options.cwd,
    encoding: "buffer",
    maxBuffer: MAX_TOTAL_BYTES + 8 * 1024 * 1024,
    timeout: 120_000,
    signal: options.signal,
    env,
  }, (error, stdout) => error
    ? reject(new Error(`固定上游 Git 操作失败（${String((error as NodeJS.ErrnoException).code ?? "unknown")}）`))
    : resolvePromise(stdout)));
}
function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const row of bytes.toString("utf8").split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error("上游 Git tree 格式无效");
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    if (!mode || !type || !oid || !safeRelative(path)) throw new Error("上游 Git tree 含不安全路径");
    entries.push({ mode, type, oid, path });
    if (entries.length > MAX_FILES * 4) throw new Error("上游仓库 tree 项过多");
  }
  return entries;
}
function assertSafeManifestKeys(root: unknown): void {
  const dangerous = new Set(["__proto__", "prototype", "constructor"]);
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (++visited > 100_000 || current.depth > 64) throw new Error("上游 manifest JSON 结构过深或过大");
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (dangerous.has(key)) throw new Error(`上游 manifest 含危险 JSON 键，安全拒绝：${key}`);
      pending.push({ value, depth: current.depth + 1 });
    }
  }
}
function plainManifest(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("上游 manifest 超出大小限制");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("上游 manifest 不是有效 UTF-8");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("上游 manifest JSON 无效"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("上游 manifest 必须是 JSON 对象");
  }
  assertSafeManifestKeys(value);
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.version !== "string" || manifest.version.length < 1 || manifest.version.length > 128 || /[\x00-\x1f\x7f]/.test(manifest.version)) {
    throw new Error("上游 manifest 缺少有效版本号");
  }
  for (const key of ["display_name", "author", "homePage"]) {
    if (manifest[key] !== undefined && (typeof manifest[key] !== "string" || manifest[key].length > 512)) throw new Error(`上游 manifest.${key} 类型无效`);
  }
  if (manifest.loading_order !== undefined && (typeof manifest.loading_order !== "number" || !Number.isFinite(manifest.loading_order))) throw new Error("上游 manifest.loading_order 类型无效");
  if (manifest.auto_update !== undefined && typeof manifest.auto_update !== "boolean") throw new Error("上游 manifest.auto_update 类型无效");
  for (const key of ["requires", "optional"]) {
    if (manifest[key] !== undefined && (!Array.isArray(manifest[key]) || manifest[key].some((entry) => typeof entry !== "string" || entry.length > 256))) throw new Error(`上游 manifest.${key} 类型无效`);
  }
  return manifest;
}
function manifestAssets(manifest: Record<string, unknown>): string[] {
  const result = new Set<string>(["manifest.json"]);
  const js = manifest.js;
  if (typeof js !== "string" || !safeRelative(js) || ![".js", ".mjs", ".cjs"].includes(extname(js).toLowerCase())) throw new Error("上游 manifest.js 缺失、类型无效或路径不安全");
  result.add(js);
  if (manifest.css !== undefined && manifest.css !== null && manifest.css !== "") {
    if (typeof manifest.css !== "string" || !safeRelative(manifest.css) || extname(manifest.css).toLowerCase() !== ".css") throw new Error("上游 manifest.css 类型无效或路径不安全");
    result.add(manifest.css);
  }
  // Only this explicit manifest field is treated as additional runtime assets. Other
  // repository files (README, tests, source, maps, build output) are never copied.
  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets) || manifest.assets.length > MAX_FILES) throw new Error("manifest.assets 必须是有界路径数组");
    for (const asset of manifest.assets) {
      if (typeof asset !== "string" || !safeRelative(asset)) throw new Error("manifest.assets 含不安全路径");
      result.add(asset);
    }
  }
  if (manifest.runtime_assets !== undefined) {
    if (!Array.isArray(manifest.runtime_assets) || manifest.runtime_assets.length > MAX_FILES) throw new Error("manifest.runtime_assets 必须是有界路径数组");
    for (const asset of manifest.runtime_assets) {
      if (typeof asset !== "string" || !safeRelative(asset)) throw new Error("manifest.runtime_assets 含不安全路径");
      result.add(asset);
    }
  }
  if (result.size > MAX_FILES) throw new Error("manifest 声明的运行资源过多");
  for (const path of result) {
    if (path === "manifest.json") continue;
    if (!RUNTIME_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw new Error(`manifest 声明了不支持的运行资源类型：${path}`);
    }
  }
  return [...result].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function resolveRelativeAsset(from: string, request: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(request.split(/[?#]/, 1)[0]); } catch { throw new Error("上游运行资源 URL 编码无效"); }
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const combined = `${base}/${decoded}`.split("/");
  const normalized: string[] = [];
  for (const part of combined) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!normalized.length) throw new Error("上游资源引用越出插件目录"); normalized.pop(); }
    else normalized.push(part);
  }
  const result = normalized.join("/");
  if (!safeRelative(result)) throw new Error("上游资源引用路径不安全");
  return result;
}
function localReferences(path: string, bytes: Buffer): string[] {
  const extension = extname(path).toLowerCase();
  const text = bytes.toString("utf8");
  if (extension === ".css") {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const refs: string[] = [];
    for (const match of clean.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      const value = match[2].trim();
      if (!value || /^(?:data:|blob:|https?:|\/\/|#)/i.test(value)) continue;
      refs.push(resolveRelativeAsset(path, value));
    }
    return refs;
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const refs: string[] = [];
    const patterns = [
      /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?(['"])(\.\.?\/[^'"\r\n]+)\1/g,
      /\bimport\s*\(\s*(['"])(\.\.?\/[^'"\r\n]+)\1\s*\)/g,
      /\bnew\s+URL\(\s*(['"])(\.\.?\/[^'"\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/g,
      /\b(?:fetch|open)\s*\(\s*(['"])(\.\.?\/[^'"\r\n]+)\1/g,
    ];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
      // Known Tavern host-module imports resolve outside the original plugin asset directory.
      // They are supplied by the independently tested adapter, never copied from an arbitrary repository path.
      if (!path.includes("/") && ["../../../../script.js", "../../../extensions.js"].includes(match[2])) continue;
      refs.push(resolveRelativeAsset(path, match[2]));
    }
    return refs;
  }
  if (extension === ".html" || extension === ".htm") {
    const refs: string[] = [];
    for (const match of text.matchAll(/\b(?:src|href)\s*=\s*(['"])(\.\.?\/[^'"\r\n]+)\1/gi)) refs.push(resolveRelativeAsset(path, match[2]));
    return refs;
  }
  return [];
}
function assertLocalReferences(files: Map<string, Buffer>): void {
  const declared = new Set(files.keys());
  for (const [path, bytes] of files) {
    for (const dependency of localReferences(path, bytes)) {
      if (!declared.has(dependency)) throw new Error(`上游运行文件引用了未由 manifest 声明的资源：${dependency}`);
    }
  }
}
function defaultPointer(): Pointer { return { schema: 1, enabled: false, autoUpdate: false }; }
function tightenPrivateTree(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error("NPC Parallel 暂存树含符号链接");
  if (info.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) tightenPrivateTree(join(path, name));
  } else if (info.isFile()) chmodSync(path, 0o600);
  else throw new Error("NPC Parallel 暂存树含非普通文件");
}
function assertExactAssetTree(root: string, expected: Set<string>): void {
  const found = new Set<string>();
  const walk = (directory: string, prefix: string) => {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("NPC Parallel 资产树含非普通目录或符号链接");
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!safeRelative(path)) throw new Error("NPC Parallel 资产树含不安全路径");
      const full = join(directory, name), child = lstatSync(full);
      if (child.isSymbolicLink()) throw new Error("NPC Parallel 资产树拒绝符号链接");
      if (child.isDirectory()) walk(full, path);
      else if (child.isFile()) { chmodSync(full, 0o600); found.add(path); }
      else throw new Error("NPC Parallel 资产树含非普通文件");
    }
  };
  walk(root, "");
  if (found.size !== expected.size || [...expected].some((path) => !found.has(path))) throw new Error("NPC Parallel 资产目录存在未声明或缺失的文件");
}
function validatePointer(value: unknown): Pointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("NPC Parallel 状态文件格式无效");
  const pointer = value as Pointer;
  if (pointer.schema !== 1 || typeof pointer.enabled !== "boolean" || typeof pointer.autoUpdate !== "boolean") throw new Error("NPC Parallel 状态文件格式无效");
  for (const key of [pointer.active, pointer.previous, pointer.candidate]) if (key !== undefined && !VERSION_KEY.test(key)) throw new Error("NPC Parallel 状态版本指针无效");
  if (pointer.blockedCommit !== undefined && !COMMIT.test(pointer.blockedCommit)) throw new Error("NPC Parallel 回退保护标识无效");
  if(pointer.blockedCommits!==undefined&&(!Array.isArray(pointer.blockedCommits)||pointer.blockedCommits.length>2048||pointer.blockedCommits.some(id=>typeof id!=="string"||!COMMIT.test(id))))throw new Error("NPC Parallel 回退历史无效");
  if (pointer.lastCheck !== undefined && (typeof pointer.lastCheck !== "string" || !Number.isFinite(Date.parse(pointer.lastCheck)))) throw new Error("NPC Parallel 检查时间无效");
  if (pointer.lastError !== undefined && (typeof pointer.lastError !== "string" || pointer.lastError.length > 1000)) throw new Error("NPC Parallel 错误状态无效");
  return pointer;
}

export class NpcParallelSources {
  readonly root: string;
  readonly statePath: string;
  readonly #hooks?: NpcParallelHooks;
  readonly #versionsRoot: string;
  #closed = false;
  #running = false;
  #controller = new AbortController();

  constructor(cwd: string, hooks?: NpcParallelHooks) {
    this.root = join(resolve(cwd), ROOT_NAME);
    this.statePath = join(this.root, "state.json");
    this.#versionsRoot = join(this.root, "versions");
    this.#hooks = hooks;
    assertPlainDirectory(this.root, "NPC Parallel 私有目录");
    assertPlainDirectory(this.#versionsRoot, "NPC Parallel 版本目录");
    if (existsLstat(this.statePath)) {
      assertPlainFile(this.statePath, "NPC Parallel 状态文件", 1024 * 1024);
      chmodSync(this.statePath, 0o600);
      validatePointer(JSON.parse(readFileSync(this.statePath, "utf8")));
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error("NPC Parallel 来源管理已关闭"); }
  #read(): Pointer {
    if (!existsLstat(this.statePath)) return defaultPointer();
    assertPlainFile(this.statePath, "NPC Parallel 状态文件", 1024 * 1024);
    chmodSync(this.statePath, 0o600);
    return validatePointer(JSON.parse(readFileSync(this.statePath, "utf8")));
  }
  #write(pointer: Pointer): void {
    assertPlainDirectory(this.root, "NPC Parallel 私有目录");
    if (existsLstat(this.statePath)) { assertPlainFile(this.statePath, "NPC Parallel 状态文件", 1024 * 1024); chmodSync(this.statePath, 0o600); }
    const backup = `${this.statePath}.bak`;
    if (existsLstat(backup)) { assertPlainFile(backup, "NPC Parallel 状态备份", 1024 * 1024); chmodSync(backup, 0o600); }
    writeJsonAtomicWithBackup(this.statePath, pointer);
    chmodSync(this.statePath, 0o600);
    if (existsLstat(backup)) chmodSync(backup, 0o600);
  }
  #withLock<T>(work: () => T): T {
    const lock = acquireTavernPluginLock(this.root);
    try { lock.assertOwned(); return work(); } finally { lock.release(); }
  }
  async #operation<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#running) throw new Error("NPC Parallel 来源正在执行另一项操作");
    this.#running = true;
    try { return await work(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "NPC Parallel 操作失败";
      try { this.#withLock(() => { const pointer = this.#read(); pointer.lastError = message.slice(0, 1000); this.#write(pointer); }); } catch { /* preserve the primary error; status remains fail-closed */ }
      throw error;
    } finally { this.#running = false; }
  }
  #versions(): string {
    assertPlainDirectory(this.root, "NPC Parallel 私有目录");
    assertPlainDirectory(this.#versionsRoot, "NPC Parallel 版本目录");
    return this.#versionsRoot;
  }
  #versionDirectory(key: string): string {
    if (!VERSION_KEY.test(key)) throw new Error("NPC Parallel 版本键无效");
    return join(this.#versions(), key);
  }
  #loadRecord(key: string): { directory: string; assetsRoot: string; record: SourceRecord; manifest: Record<string, unknown> } {
    const directory = this.#versionDirectory(key);
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("NPC Parallel 版本目录不是普通目录");
    chmodSync(directory, 0o700);
    const metadata = join(directory, "source.json");
    assertPlainFile(metadata, "NPC Parallel 来源记录", 8 * 1024 * 1024);
    chmodSync(metadata, 0o600);
    const record = JSON.parse(readFileSync(metadata, "utf8")) as SourceRecord;
    if (record?.schema !== 1 || record.repository !== NPC_PARALLEL_UPSTREAM.repository || !COMMIT.test(record.commit) ||
      typeof record.version !== "string" || !HASH.test(record.sha256) || !Array.isArray(record.files) || record.files.length < 3 || record.files.length > MAX_FILES ||
      key !== `${record.commit}-${record.sha256}`) throw new Error("NPC Parallel 来源记录格式或版本键无效");
    const assetsRoot = join(directory, "assets");
    const assetsInfo = lstatSync(assetsRoot);
    if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) throw new Error("NPC Parallel 资产目录不是普通目录");
    chmodSync(assetsRoot, 0o700);
    let total = 0;
    const listed = new Set<string>();
    for (const file of record.files) {
      if (!file || !safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES ||
        !HASH.test(file.sha256) || !/^[0-9a-f]{40}$/.test(file.gitBlob) || listed.has(file.path)) throw new Error("NPC Parallel 文件清单无效");
      listed.add(file.path);
      total += file.bytes;
      if (total > MAX_TOTAL_BYTES) throw new Error("NPC Parallel 安装文件总量超限");
      const target = safeFilePath(assetsRoot, file.path);
      const bytes = readFileSync(target);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256 || gitBlob(bytes) !== file.gitBlob) throw new Error(`NPC Parallel 原文件字节完整性失败：${file.path}`);
    }
    assertExactAssetTree(assetsRoot, listed);
    const files = [...record.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (aggregate(files) !== record.sha256) throw new Error("NPC Parallel 全文件哈希复核失败");
    const manifestBytes = readFileSync(safeFilePath(assetsRoot, "manifest.json"));
    const manifest = plainManifest(manifestBytes);
    if (manifest.version !== record.version) throw new Error("NPC Parallel manifest 版本与来源记录不一致");
    const expected = new Set(manifestAssets(manifest));
    if (lstatSync(join(assetsRoot, "LICENSE"), { bigint: false }).isFile()) expected.add("LICENSE");
    if (expected.size !== listed.size || [...expected].some((path) => !listed.has(path))) throw new Error("NPC Parallel 安装文件超出 manifest 声明或缺少必需资源");
    return { directory, assetsRoot, record, manifest };
  }
  #candidate(key: string): NpcParallelCandidate {
    const loaded = this.#loadRecord(key);
    return { root: loaded.assetsRoot, version: loaded.record.version, commit: loaded.record.commit, sha256: loaded.record.sha256, manifest: loaded.manifest };
  }
  #verify(key: string): boolean { try { this.#loadRecord(key); return true; } catch { return false; } }
  #keyForCommit(commit: string): string | null {
    if (!COMMIT.test(commit)) return null;
    const entries = readdirSync(this.#versions());
    const found = entries.find((entry) => VERSION_KEY.test(entry) && entry.startsWith(`${commit}-`));
    return found ?? null;
  }
  #parseProxy(options: NpcParallelOptions): string | undefined {
    const proxy = options.proxy ?? process.env.LIYUAN_NPC_PARALLEL_GIT_PROXY ?? process.env.LIYUAN_TAVERN_GIT_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    return ensureProxy(proxy);
  }
  async #resolveCommit(options: NpcParallelOptions, proxy?: string): Promise<{ commit: string; repository: string; fixture: boolean }> {
    if (options.fixtureRepo !== undefined) {
      const fixturePath = resolve(options.fixtureRepo);
      const stat = lstatSync(fixturePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixtureRepo 必须是普通本地 Git 仓库目录");
      const commit = options.commit ?? (await git(["-C", fixturePath, "rev-parse", "--verify", "HEAD"], { fixture: true, signal: this.#controller.signal })).toString("utf8").trim();
      if (!COMMIT.test(commit)) throw new Error("fixtureRepo commit 必须为完整的 40 位标识");
      return { commit, repository: fixturePath, fixture: true };
    }
    if (options.commit !== undefined && !COMMIT.test(options.commit)) throw new Error("NPC Parallel commit 必须为完整的 40 位标识");
    let commit = options.commit;
    if (!commit) {
      const refs = (await git(["ls-remote", "--exit-code", NPC_PARALLEL_UPSTREAM.repository, "HEAD"], { proxy, signal: this.#controller.signal })).toString("utf8").trim();
      const line = refs.split("\n").find((row) => row.endsWith("\tHEAD"));
      commit = line?.split("\t")[0];
      if (!commit || !COMMIT.test(commit)) throw new Error("固定公开上游未返回有效 commit");
    }
    return { commit, repository: NPC_PARALLEL_UPSTREAM.repository, fixture: false };
  }
  async #stage(options: NpcParallelOptions): Promise<string> {
    const proxy = this.#parseProxy(options);
    const resolved = await this.#resolveCommit(options, proxy);
    const existing = this.#keyForCommit(resolved.commit);
    if (existing) {
      if (!this.#verify(existing)) throw new Error("同 commit 的 NPC Parallel 缓存损坏，拒绝覆盖");
      this.#withLock(() => {
        const pointer = this.#read();
        pointer.candidate = existing === pointer.active ? undefined : existing;
        pointer.lastCheck = new Date().toISOString();
        delete pointer.lastError;
        this.#write(pointer);
      });
      return existing;
    }

    const stage = join(this.root, `.staging-${process.pid}-${randomBytes(12).toString("hex")}`);
    assertPlainDirectory(stage, "NPC Parallel 候选暂存目录");
    try {
      const database = join(stage, "git");
      assertPlainDirectory(database, "NPC Parallel 临时 Git 目录");
      await git(["init", "--quiet", database], { fixture: resolved.fixture, signal: this.#controller.signal });
      tightenPrivateTree(join(database, ".git"));
      if (resolved.fixture) {
        await git(["-C", database, "fetch", "--no-tags", "--depth=1", "--", resolved.repository, resolved.commit], { proxy, fixture: true, signal: this.#controller.signal });
      } else {
        // Ask the fixed GitHub origin for commit/tree objects first; promisor fetches
        // only the manifest-declared blobs later, avoiding a full repository mirror.
        await git(["-C", database, "remote", "add", "origin", NPC_PARALLEL_UPSTREAM.repository], { signal: this.#controller.signal });
        await git(["-C", database, "config", "remote.origin.promisor", "true"], { signal: this.#controller.signal });
        await git(["-C", database, "config", "remote.origin.partialclonefilter", "blob:none"], { signal: this.#controller.signal });
        await git(["-C", database, "config", "extensions.partialClone", "origin"], { signal: this.#controller.signal });
        await git(["-C", database, "fetch", "--filter=blob:none", "--no-tags", "--depth=1", "origin", resolved.commit], { proxy, signal: this.#controller.signal });
      }
      tightenPrivateTree(join(database, ".git"));
      const tree = parseTree(await git(["-C", database, "ls-tree", "-r", "-z", "--full-tree", resolved.commit], { proxy, fixture: resolved.fixture, signal: this.#controller.signal }));
      const byPath = new Map(tree.map((entry) => [entry.path, entry]));
      const manifestEntry = byPath.get("manifest.json");
      if (!manifestEntry || manifestEntry.type !== "blob" || !/^100(?:644|755)$/.test(manifestEntry.mode) || !/^[0-9a-f]{40}$/.test(manifestEntry.oid)) {
        throw new Error("固定 commit 缺少普通 manifest.json 文件");
      }
      const manifestBytes = await git(["-C", database, "cat-file", "blob", manifestEntry.oid], { proxy, fixture: resolved.fixture, signal: this.#controller.signal });
      if (gitBlob(manifestBytes) !== manifestEntry.oid) throw new Error("上游 manifest Git blob 校验失败");
      const manifest = plainManifest(manifestBytes);
      const selected = new Set(manifestAssets(manifest));
      const license = byPath.get("LICENSE");
      if (!license || license.type !== "blob" || !/^100(?:644|755)$/.test(license.mode)) throw new Error("固定 commit 缺少普通 LICENSE 文件");
      selected.add("LICENSE");
      if (selected.size > MAX_FILES) throw new Error("manifest 声明的运行文件过多");

      const packageRoot = join(stage, "package");
      const assetsRoot = join(packageRoot, "assets");
      assertPlainDirectory(packageRoot, "NPC Parallel 候选包目录");
      assertPlainDirectory(assetsRoot, "NPC Parallel 候选资产目录");
      const fileRecords: NpcParallelFile[] = [];
      const content = new Map<string, Buffer>();
      let total = 0;
      for (const path of [...selected].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
        const entry = byPath.get(path);
        if (!entry) throw new Error(`manifest 声明的运行资源在固定 commit 中缺失：${path}`);
        if (entry.type !== "blob" || !/^100(?:644|755)$/.test(entry.mode) || !/^[0-9a-f]{40}$/.test(entry.oid)) {
          throw new Error(`manifest 声明的运行资源不是普通 Git 文件：${path}`);
        }
        const bytes = path === "manifest.json" ? manifestBytes : await git(["-C", database, "cat-file", "blob", entry.oid], { proxy, fixture: resolved.fixture, signal: this.#controller.signal });
        if (bytes.length > MAX_FILE_BYTES || (total += bytes.length) > MAX_TOTAL_BYTES) throw new Error("NPC Parallel manifest 声明资源超出安全预算");
        if (gitBlob(bytes) !== entry.oid) throw new Error(`原始 Git blob 哈希不匹配：${path}`);
        let directory = assetsRoot;
        for (const part of path.split("/").slice(0, -1)) { directory = join(directory, part); assertPlainDirectory(directory, "NPC Parallel 资源子目录"); }
        writeFileSync(join(assetsRoot, ...path.split("/")), bytes, { flag: "wx", mode: 0o600 });
        chmodSync(join(assetsRoot, ...path.split("/")), 0o600);
        content.set(path, bytes);
        fileRecords.push({ path, bytes: bytes.length, sha256: digest(bytes), gitBlob: entry.oid });
      }
      assertLocalReferences(content);
      const sortedFiles = fileRecords.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const sha256 = aggregate(sortedFiles);
      const record: SourceRecord = { schema: 1, repository: NPC_PARALLEL_UPSTREAM.repository, commit: resolved.commit, version: manifest.version as string, sha256, files: sortedFiles };
      writeFileSync(join(packageRoot, "source.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      chmodSync(join(packageRoot, "source.json"), 0o600);
      const key = `${resolved.commit}-${sha256}`;
      const target = this.#versionDirectory(key);
      this.#withLock(() => {
        if (existsLstat(target)) {
          if (!this.#verify(key)) throw new Error("同标识 NPC Parallel 缓存损坏，拒绝覆盖");
        } else renameSync(packageRoot, target);
        if (!this.#verify(key)) throw new Error("NPC Parallel 候选原字节全量复核失败");
        const pointer = this.#read();
        pointer.candidate = key === pointer.active ? undefined : key;
        pointer.lastCheck = new Date().toISOString();
        delete pointer.lastError;
        this.#write(pointer);
      });
      return key;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  #blocked(pointer:Pointer,commit:string):boolean{return pointer.blockedCommit===commit||!!pointer.blockedCommits?.includes(commit);}
  async #acceptAndActivate(key: string, mode: "install" | "update" | "rollback" | "automatic"): Promise<NpcParallelCandidate> {
    this.#assertOpen();
    if (!this.#hooks?.validateCandidate) throw new Error("缺少 NPC Parallel 合成宿主验收回调；候选仅暂存，拒绝激活");
    if (!this.#verify(key)) throw new Error("NPC Parallel 候选原文件完整性失败，拒绝激活");
    const before = this.#read();
    const candidate = this.#candidate(key);
    if (!await this.#hooks.isIdle()) {
      if (mode === "rollback") throw new Error("梨园仍忙碌，NPC Parallel 暂不回退");
      return candidate;
    }
    const accepted = await this.#hooks.validateCandidate(candidate);
    if (accepted !== true) throw new Error("NPC Parallel 合成宿主验收拒绝候选，旧版保持激活");
    this.#assertOpen();
    const afterValidation = this.#read();
    if (afterValidation.active !== before.active || (mode === "rollback" ? afterValidation.previous !== key : key !== before.active && afterValidation.candidate !== key)) {
      throw new Error("NPC Parallel 来源状态已变化，候选 CAS 失败");
    }
    if (mode === "automatic" && (!afterValidation.autoUpdate || this.#blocked(afterValidation,candidate.commit))) {
      throw new Error("NPC Parallel 自动更新已关闭或该 commit 已被回退，拒绝切换");
    }
    if (!await this.#hooks.isIdle()) {
      if (mode === "rollback") throw new Error("梨园仍忙碌，NPC Parallel 暂不回退");
      return candidate;
    }
    this.#assertOpen();
    const current = this.#read();
    if (current.active !== before.active || (mode === "rollback" ? current.previous !== key : key !== before.active && current.candidate !== key)) throw new Error("NPC Parallel 激活前 CAS 失败");
    if (mode === "automatic" && (!current.autoUpdate || this.#blocked(current,candidate.commit))) throw new Error("NPC Parallel 自动更新状态已改变，拒绝切换");
    if (!this.#verify(key)) throw new Error("NPC Parallel 宿主验收后原文件字节变化，拒绝切换");

    let old: Pointer | undefined;
    let switched = false;
    this.#withLock(() => {
      const latest = this.#read();
      if (latest.active !== current.active || (mode === "rollback" ? latest.previous !== key : key !== current.active && latest.candidate !== key)) throw new Error("NPC Parallel 原子切换 CAS 冲突");
      if (mode === "automatic" && (!latest.autoUpdate || this.#blocked(latest,candidate.commit))) throw new Error("NPC Parallel 自动更新配置已改变，拒绝切换");
      if (!this.#verify(key)) throw new Error("NPC Parallel 原文件在原子切换前发生变化");
      if (latest.active === key && mode !== "rollback") return;
      old = { ...latest };
      const next: Pointer = { ...latest, active: key };
      if (mode === "rollback") {
        const oldCandidate = latest.active;
        next.previous = oldCandidate;
        next.blockedCommit = oldCandidate ? this.#candidate(oldCandidate).commit : candidate.commit;
        next.blockedCommits=[...new Set([...(latest.blockedCommits??[]),next.blockedCommit])];
        delete next.candidate;
      } else {
        if (latest.active && latest.active !== key) next.previous = latest.active;
        delete next.candidate;
        if(latest.blockedCommit)next.blockedCommits=[...new Set([...(latest.blockedCommits??[]),latest.blockedCommit])];
        // Historical rejected commits remain blocked after later accepted releases.
      }
      delete next.lastError;
      this.#write(next);
      switched = true;
    });
    if (!switched) return candidate;
    try { await this.#hooks.onActivated?.(); }
    catch (error) {
      this.#withLock(() => {
        const now = this.#read();
        if (now.active === key && old) this.#write({
          ...old,
          enabled: now.enabled,
          autoUpdate: now.autoUpdate,
          candidate: now.candidate ?? old.candidate ?? (mode === "rollback" ? undefined : key),
          lastCheck: now.lastCheck ?? old.lastCheck,
          lastError: "NPC Parallel 激活回调失败；已恢复切换前版本",
        });
      });
      throw new Error("NPC Parallel 宿主加载新版本失败，已保留旧版", { cause: error });
    }
    return candidate;
  }

  status(): NpcParallelStatus {
    let pointer: Pointer;
    try { pointer = this.#read(); } catch (error) {
      return { installed: false, enabled: false, autoUpdate: false, lastError: error instanceof Error ? error.message : "NPC Parallel 状态不可用" };
    }
    let active: NpcParallelCandidate | null = null;
    let previous: NpcParallelCandidate | null = null;
    let candidate: NpcParallelCandidate | null = null;
    let error = pointer.lastError;
    if (pointer.active) {
      try { active = this.#candidate(pointer.active); } catch (cause) { error = cause instanceof Error ? cause.message : "NPC Parallel 激活版本完整性失败"; }
    }
    if (pointer.previous) {
      try { previous = this.#candidate(pointer.previous); } catch (cause) { error = cause instanceof Error ? cause.message : "NPC Parallel 上一版完整性失败"; }
    }
    if (pointer.candidate) {
      try { candidate = this.#candidate(pointer.candidate); } catch (cause) { error = cause instanceof Error ? cause.message : "NPC Parallel 候选版本完整性失败"; }
    }
    return {
      installed: active !== null,
      enabled: pointer.enabled && active !== null,
      autoUpdate: pointer.autoUpdate,
      ...(active ? { version: active.version, commit: active.commit, sha256: active.sha256 } : {}),
      ...(previous ? { previousVersion: previous.version } : {}),
      ...(candidate && pointer.candidate !== pointer.active ? { candidateVersion: candidate.version, updateAvailable: true, pendingActivation: true } : { updateAvailable: false, pendingActivation: false }),
      ...(error ? { lastError: error } : {}),
    };
  }
  active(): NpcParallelCandidate | null {
    const pointer = this.#read();
    if (!pointer.active) return null;
    try { return this.#candidate(pointer.active); } catch { return null; }
  }
  resolveAsset(relativePath: string, candidate?: NpcParallelCandidate): string | null {
    if (!safeRelative(relativePath)) return null;
    try {
      const selected = candidate ?? this.active();
      if (!selected) return null;
      const root = resolve(selected.root);
      const versionsRoot = resolve(this.#versionsRoot) + sep;
      const packageRoot = relative(versionsRoot, root);
      if (packageRoot.startsWith(`..${sep}`) || packageRoot === ".." || isAbsolute(packageRoot) || !packageRoot.endsWith(`${sep}assets`)) return null;
      const key = packageRoot.split(sep)[0];
      const persisted = this.#candidate(key);
      if (persisted.root !== root || persisted.commit !== selected.commit || persisted.version !== selected.version || persisted.sha256 !== selected.sha256) return null;
      const loaded = this.#loadRecord(key);
      if (!loaded.record.files.some((file) => file.path === relativePath)) return null;
      return safeFilePath(loaded.assetsRoot, relativePath);
    } catch { return null; }
  }
  configure(options: { enabled?: boolean; autoUpdate?: boolean }): void {
    this.#assertOpen();
    if (!options || typeof options !== "object" || Object.keys(options).some((key) => key !== "enabled" && key !== "autoUpdate") ||
      Object.values(options).some((value) => typeof value !== "boolean")) throw new Error("NPC Parallel 配置只接受布尔 enabled/autoUpdate");
    this.#withLock(() => {
      const pointer = this.#read();
      if (options.enabled === true && (!pointer.active || !this.#verify(pointer.active))) throw new Error("必须先安装并验收 NPC Parallel，才能启用");
      if (options.enabled !== undefined) pointer.enabled = options.enabled;
      if (options.autoUpdate !== undefined) pointer.autoUpdate = options.autoUpdate;
      delete pointer.lastError;
      this.#write(pointer);
    });
  }
  async checkUpdate(options: NpcParallelOptions = {}): Promise<NpcParallelCheckResult> {
    return this.#operation(async () => {
      const key = await this.#stage(options);
      const candidate = this.#candidate(key);
      const pointer = this.#read();
      return { updateAvailable: Boolean(key !== pointer.active), candidateVersion: candidate.version, version: candidate.version, commit: candidate.commit, sha256: candidate.sha256 };
    });
  }
  /** Activate an already byte-verified staged pointer; still requires fresh synthetic validation and idle/CAS checks. */
  async activateStaged(): Promise<NpcParallelCandidate> {
    return this.#operation(async () => {
      const pointer=this.#read(),key=pointer.candidate;
      if(!key)throw new Error("没有已暂存的候选；先检查更新或下载原文件");
      const candidate=this.#candidate(key);
      if(this.#blocked(pointer,candidate.commit))throw new Error("该 commit 已被回退，拒绝重新激活");
      return await this.#acceptAndActivate(key,"update");
    });
  }
  async install(options: NpcParallelOptions = {}): Promise<NpcParallelCandidate> {
    return this.#operation(async () => {
      const key = await this.#stage(options);
      if (!this.#hooks?.validateCandidate) throw new Error("候选已安全暂存；需要主程序提供合成宿主验收后才能安装激活");
      return await this.#acceptAndActivate(key, "install");
    });
  }
  async update(options: NpcParallelOptions = {}): Promise<NpcParallelCandidate> {
    return this.#operation(async () => {
      const key = await this.#stage(options);
      const candidate = this.#candidate(key);
      if (this.#blocked(this.#read(),candidate.commit)) throw new Error("该 commit 已由用户回退，自动或普通更新不会重新激活它");
      if (!this.#hooks?.validateCandidate) throw new Error("候选已安全暂存；需要主程序提供合成宿主验收后才能更新激活");
      return await this.#acceptAndActivate(key, "update");
    });
  }
  async rollback(): Promise<NpcParallelCandidate> {
    return this.#operation(async () => {
      const pointer = this.#read();
      if (!pointer.active || !pointer.previous) throw new Error("没有可回退的 NPC Parallel 上一版");
      const target = this.#candidate(pointer.previous);
      if (this.#blocked(pointer,target.commit)) throw new Error("目标版本已被标记为坏 commit，拒绝再次切回");
      if (!this.#hooks?.validateCandidate) throw new Error("回退前需要主程序对上一版执行合成宿主验收");
      return await this.#acceptAndActivate(pointer.previous, "rollback");
    });
  }
  async autoUpdateOnce(options: Omit<NpcParallelOptions, "commit"> = {}): Promise<void> {
    this.#assertOpen();
    if (this.#running) return;
    const before = this.#read();
    if (!before.autoUpdate) return;
    this.#running = true;
    try {
      const proxy = this.#parseProxy(options);
      const latest = await this.#resolveCommit(options, proxy);
      const state = this.#read();
      if (this.#blocked(state,latest.commit) || state.active && this.#candidate(state.active).commit === latest.commit) return;
      const key = await this.#stage({ ...options, proxy, commit: latest.commit });
      const candidate = this.#candidate(key);
      if (this.#blocked(this.#read(),candidate.commit)) return;
      if (!this.#hooks?.validateCandidate) throw new Error("自动更新候选已暂存，但缺少合成宿主验收回调");
      await this.#acceptAndActivate(key, "automatic");
    } catch (error) {
      const message = error instanceof Error ? error.message : "NPC Parallel 自动更新失败";
      try { this.#withLock(() => { const pointer = this.#read(); pointer.lastError = message.slice(0, 1000); this.#write(pointer); }); } catch { /* never claim an update succeeded */ }
    } finally { this.#running = false; }
  }
  close(): void { this.#closed = true; this.#controller.abort(); }
}
