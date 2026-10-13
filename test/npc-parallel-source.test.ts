import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NpcParallelSources, NPC_PARALLEL_UPSTREAM, type NpcParallelHooks } from "../server/npc-parallel-source.ts";
import { acquireTavernPluginLock } from "../server/tavern-plugin-lock.ts";

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], {
  encoding: "utf8",
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
}).trim();
function put(repo: string, path: string, bytes: string | Buffer) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
function revision(repo: string, version: string, options: { js?: string; css?: string; assets?: string[]; manifestExtra?: Record<string, unknown>; extra?: Record<string, string> } = {}) {
  put(repo, "manifest.json", `${JSON.stringify({ display_name: "synthetic NPC Parallel", version, js: "index.js", css: "style.css", ...(options.assets ? { assets: options.assets } : {}), ...(options.manifestExtra ?? {}) }, null, 2)}\n`);
  put(repo, "index.js", options.js ?? `globalThis.__syntheticNpcParallel = ${JSON.stringify(version)};\r\n`);
  put(repo, "style.css", options.css ?? `/* original fixture ${version} */\r\n.npc { color: #123456; }\r\n`);
  put(repo, "LICENSE", "Synthetic MIT fixture license\r\n");
  for (const [path, bytes] of Object.entries(options.extra ?? {})) put(repo, path, bytes);
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", `synthetic ${version}`);
  return git(repo, "rev-parse", "HEAD");
}
function makeRepo(base: string) {
  const repo = join(base, "synthetic-upstream");
  mkdirSync(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Synthetic Fixture");
  git(repo, "config", "user.email", "synthetic@example.invalid");
  revision(repo, "1.0.0", { extra: { "README.md": "Must not be installed.\n", "test/fixture.test.js": "Not a runtime asset.\n", "src/dev.js": "Not a runtime asset.\n" } });
  return repo;
}
async function fixture(run: (value: { base: string; cwd: string; repo: string }) => Promise<void> | void) {
  const base = mkdtempSync(join(tmpdir(), "liyuan-npc-parallel-source-test-"));
  const cwd = join(base, "host");
  mkdirSync(cwd);
  const repo = makeRepo(base);
  try { await run({ base, cwd, repo }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}
function hooks(overrides: Partial<NpcParallelHooks> = {}): NpcParallelHooks {
  return { isIdle: () => true, validateCandidate: async () => true, ...overrides };
}
function assertPrivateMode(path: string, mode: number) { assert.equal(lstatSync(path).mode & 0o777, mode, path); }


test("fixed public source, secure defaults, original bytes and manifest-only installation", () => fixture(async ({ cwd, repo }) => {
  assert.equal(NPC_PARALLEL_UPSTREAM.repository, "https://github.com/ug776732-arch/npc-parallel.git");
  const source = new NpcParallelSources(cwd, hooks());
  try {
    assert.deepEqual(source.status(), { installed: false, enabled: false, autoUpdate: false, updateAvailable: false, pendingActivation: false });
    assert.throws(() => source.configure({ enabled: true }), /先安装并验收/);
    const expectedJs = readFileSync(join(repo, "index.js"));
    const expectedCss = readFileSync(join(repo, "style.css"));
    const candidate = await source.install({ fixtureRepo: repo });
    assert.equal(candidate.version, "1.0.0");
    assert.equal(source.status().enabled, false, "installation must not implicitly enable the plugin");
    assert.equal(source.status().commit, git(repo, "rev-parse", "HEAD"));
    assert.equal(source.resolveAsset("index.js", candidate), join(candidate.root, "index.js"));
    assert.deepEqual(readFileSync(source.resolveAsset("index.js", candidate)!), expectedJs);
    assert.deepEqual(readFileSync(source.resolveAsset("style.css", candidate)!), expectedCss);
    assert.equal(source.resolveAsset("README.md", candidate), null);
    assert.equal(source.resolveAsset("src/dev.js", candidate), null);
    assert.equal(source.resolveAsset("test/fixture.test.js", candidate), null);
    assertPrivateMode(source.root, 0o700);
    assertPrivateMode(join(source.root, "versions"), 0o700);
    assertPrivateMode(candidate.root, 0o700);
    assertPrivateMode(join(candidate.root, "index.js"), 0o600);
    assertPrivateMode(join(candidate.root, "style.css"), 0o600);
    assertPrivateMode(join(dirname(candidate.root), "source.json"), 0o600);
    source.configure({ enabled: true, autoUpdate: true });
    assert.equal(source.status().enabled, true);
    assert.equal(source.status().autoUpdate, true);
  } finally { source.close(); }
}));


test("checkUpdate stages only; missing/failed synthetic validation can never activate a download", () => fixture(async ({ cwd, repo }) => {
  const source = new NpcParallelSources(cwd, { isIdle: () => true });
  try {
    const checked = await source.checkUpdate({ fixtureRepo: repo });
    assert.equal(checked.updateAvailable, true);
    assert.equal(source.status().installed, false);
    assert.equal(source.status().pendingActivation, true);
    await assert.rejects(source.install({ fixtureRepo: repo }), /需要主程序提供合成宿主验收/);
    assert.equal(source.status().installed, false);
    assert.equal(source.status().enabled, false);
  } finally { source.close(); }
}));


test("runtime entrypoints may reference only explicitly declared manifest assets", () => fixture(async ({ cwd, repo }) => {
  const missingRepo = join(dirname(repo), "missing-dependency");
  mkdirSync(missingRepo);
  git(missingRepo, "init", "--quiet");
  git(missingRepo, "config", "user.name", "Synthetic Fixture");
  git(missingRepo, "config", "user.email", "synthetic@example.invalid");
  revision(missingRepo, "1.0.0", { css: ".x { background: url('./font.woff2'); }\n" });
  const source = new NpcParallelSources(cwd, hooks());
  try {
    await assert.rejects(source.install({ fixtureRepo: missingRepo }), /未由 manifest 声明/);
    assert.equal(source.status().installed, false);
    const declaredRepo = join(dirname(repo), "declared-asset");
    mkdirSync(declaredRepo);
    git(declaredRepo, "init", "--quiet");
    git(declaredRepo, "config", "user.name", "Synthetic Fixture");
    git(declaredRepo, "config", "user.email", "synthetic@example.invalid");
    revision(declaredRepo, "1.1.0", { assets: ["font.woff2"], css: ".x { background: url('./font.woff2'); }\n", extra: { "font.woff2": "synthetic font bytes" } });
    const candidate = await source.install({ fixtureRepo: declaredRepo });
    assert.deepEqual(readFileSync(source.resolveAsset("font.woff2", candidate)!), Buffer.from("synthetic font bytes"));
  } finally { source.close(); }
}));


test("unknown plain metadata is preserved byte-for-byte while undeclared paths remain unavailable", () => fixture(async ({ cwd, repo }) => {
  const source = new NpcParallelSources(cwd, hooks());
  try {
    await source.install({ fixtureRepo: repo });
    revision(repo, "2.0.0", {
      manifestExtra: {
        description: "New harmless description metadata",
        branding: { color: "#7356bf", label: "fixture-only" },
        undeclared_asset_hint: "extra/runtime.js",
      },
      extra: { "extra/runtime.js": "must not be installed unless declared" },
    });
    const originalManifestBytes = readFileSync(join(repo, "manifest.json"));
    const candidate = await source.update({ fixtureRepo: repo });
    assert.equal(candidate.version, "2.0.0");
    assert.equal((candidate.manifest.description), "New harmless description metadata");
    assert.deepEqual(candidate.manifest.branding, { color: "#7356bf", label: "fixture-only" });
    assert.equal(candidate.manifest.undeclared_asset_hint, "extra/runtime.js");
    assert.deepEqual(readFileSync(source.resolveAsset("manifest.json", candidate)!), originalManifestBytes);
    assert.equal(source.resolveAsset("extra/runtime.js", candidate), null);
    assert.equal(source.resolveAsset("README.md", candidate), null);
  } finally { source.close(); }
}));


test("unknown API metadata is delegated to the synthetic runtime gate, not manifest parsing", () => fixture(async ({ cwd, repo }) => {
  const source = new NpcParallelSources(cwd, hooks({ validateCandidate: async (candidate) => candidate.manifest.new_api !== "unsupported-host-api" }));
  try {
    await source.install({ fixtureRepo: repo });
    revision(repo, "2.0.0", { manifestExtra: { new_api: "unsupported-host-api" } });
    await assert.rejects(source.update({ fixtureRepo: repo }), /验收拒绝候选/);
    assert.equal(source.status().version, "1.0.0");
    assert.equal(source.status().candidateVersion, "2.0.0");
  } finally { source.close(); }
}));


test("dangerous prototype-related JSON keys are rejected recursively", () => fixture(async ({ cwd, repo }) => {
  const source = new NpcParallelSources(cwd, hooks());
  try {
    await source.install({ fixtureRepo: repo });
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const version = `2.${["__proto__", "prototype", "constructor"].indexOf(key)}.0`;
      const raw = `{"display_name":"fixture","version":"${version}","js":"index.js","css":"style.css","branding":{"nested":{"${key}":{"polluted":true}}}}\n`;
      put(repo, "manifest.json", raw);
      put(repo, "index.js", `globalThis.__syntheticNpcParallel = ${JSON.stringify(version)};\n`);
      git(repo, "add", "manifest.json", "index.js");
      git(repo, "commit", "--quiet", "-m", `dangerous key ${key}`);
      await assert.rejects(source.update({ fixtureRepo: repo }), /危险 JSON 键/);
      assert.equal(source.status().version, "1.0.0");
      assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
    }
  } finally { source.close(); }
}));


test("rejected update retains old active bytes and reports candidate separately", () => fixture(async ({ cwd, repo }) => {
  let rejectTwo = true;
  const source = new NpcParallelSources(cwd, hooks({ validateCandidate: async (candidate) => !(rejectTwo && candidate.version === "2.0.0") }));
  try {
    const first = await source.install({ fixtureRepo: repo });
    const original = readFileSync(join(first.root, "index.js"));
    revision(repo, "2.0.0");
    await assert.rejects(source.update({ fixtureRepo: repo }), /验收拒绝候选/);
    assert.equal(source.status().version, "1.0.0");
    assert.equal(source.status().commit, first.commit);
    assert.equal(source.status().candidateVersion, "2.0.0");
    assert.equal(source.status().pendingActivation, true);
    assert.match(source.status().lastError!, /验收拒绝/);
    assert.deepEqual(readFileSync(source.resolveAsset("index.js")!), original);
    rejectTwo = false;
    const second = await source.update({ fixtureRepo: repo });
    assert.equal(second.version, "2.0.0");
    assert.equal(source.status().version, "2.0.0");
    assert.equal(source.status().previousVersion, "1.0.0");
    assert.equal(source.status().pendingActivation, false);
    assert.equal(source.status().enabled, false);
  } finally { source.close(); }
}));


test("tampering during synthetic validation is detected before pointer switch", () => fixture(async ({ cwd, repo }) => {
  let tamper = false;
  const source = new NpcParallelSources(cwd, hooks({ validateCandidate: async (candidate) => {
    if (tamper && candidate.version === "2.0.0") writeFileSync(join(candidate.root, "index.js"), "modified after validation");
    return true;
  } }));
  try {
    const first = await source.install({ fixtureRepo: repo });
    const oldBytes = readFileSync(join(first.root, "index.js"));
    revision(repo, "2.0.0");
    tamper = true;
    await assert.rejects(source.update({ fixtureRepo: repo }), /验收后原文件字节变化/);
    assert.equal(source.status().version, "1.0.0");
    assert.deepEqual(readFileSync(source.resolveAsset("index.js")!), oldBytes);
  } finally { source.close(); }
}));


test("busy host keeps candidate pending, then activates only when idle", () => fixture(async ({ cwd, repo }) => {
  let idle = false;
  let validations = 0;
  const source = new NpcParallelSources(cwd, hooks({ isIdle: () => idle, validateCandidate: async () => { validations++; return true; } }));
  try {
    const staged = await source.install({ fixtureRepo: repo });
    assert.equal(staged.version, "1.0.0");
    assert.equal(source.status().installed, false);
    assert.equal(source.status().pendingActivation, true);
    assert.equal(validations, 0);
    idle = true;
    const candidate = await source.install({ fixtureRepo: repo });
    assert.equal(candidate.version, "1.0.0");
    assert.equal(validations, 1);
    assert.equal(source.status().installed, true);
  } finally { source.close(); }
}));


test("rollback blocks the reverted commit from automatic reactivation", () => fixture(async ({ cwd, repo }) => {
  const source = new NpcParallelSources(cwd, hooks());
  try {
    const first = await source.install({ fixtureRepo: repo });
    source.configure({ enabled: true, autoUpdate: true });
    const badCommit = revision(repo, "2.0.0");
    await source.update({ fixtureRepo: repo });
    const rolledBack = await source.rollback();
    assert.equal(rolledBack.commit, first.commit);
    assert.equal(source.status().version, "1.0.0");
    assert.equal(source.status().previousVersion, "2.0.0");
    await assert.rejects(source.rollback(), /已被标记为坏 commit/);
    await source.autoUpdateOnce({ fixtureRepo: repo });
    assert.equal(source.status().version, "1.0.0");
    assert.equal(source.status().commit, first.commit);
    assert.equal(source.status().candidateVersion, undefined);
    const goodCommit = revision(repo, "3.0.0");
    await source.autoUpdateOnce({ fixtureRepo: repo });
    assert.equal(source.status().version, "3.0.0");
    assert.equal(source.status().commit, goodCommit);
    assert.notEqual(source.status().commit, badCommit);
  } finally { source.close(); }
}));


test("configure during async validation is lock-safe and activation preserves newer flags", () => fixture(async ({ cwd, repo }) => {
  let started!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const source = new NpcParallelSources(cwd, hooks({ validateCandidate: async (candidate) => {
    if (candidate.version === "2.0.0") { started(); await gate; }
    return true;
  } }));
  try {
    await source.install({ fixtureRepo: repo });
    revision(repo, "2.0.0");
    const pending = source.update({ fixtureRepo: repo });
    await began;
    source.configure({ enabled: true, autoUpdate: true });
    release();
    await pending;
    assert.equal(source.status().version, "2.0.0");
    assert.equal(source.status().enabled, true);
    assert.equal(source.status().autoUpdate, true);
  } finally { release(); source.close(); }
}));


test("activation callback rollback preserves configure changes made while callback is pending", () => fixture(async ({ cwd, repo }) => {
  let calls = 0;
  let started!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const source = new NpcParallelSources(cwd, hooks({ onActivated: async () => {
    calls++;
    if (calls === 2) { started(); await gate; throw new Error("synthetic realm load failure"); }
  } }));
  try {
    await source.install({ fixtureRepo: repo });
    revision(repo, "2.0.0");
    const pending = source.update({ fixtureRepo: repo });
    await began;
    source.configure({ enabled: true, autoUpdate: true });
    release();
    await assert.rejects(pending, /已保留旧版/);
    assert.equal(source.status().version, "1.0.0");
    assert.equal(source.status().candidateVersion, "2.0.0");
    assert.equal(source.status().enabled, true);
    assert.equal(source.status().autoUpdate, true);
  } finally { release(); source.close(); }
}));


test("candidate compare-and-swap prevents a late validation from overwriting a newer staged commit", () => fixture(async ({ cwd, repo }) => {
  let started!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sourceA = new NpcParallelSources(cwd, hooks({ validateCandidate: async (candidate) => {
    if (candidate.version === "2.0.0") { started(); await gate; }
    return true;
  } }));
  const sourceB = new NpcParallelSources(cwd, hooks());
  try {
    await sourceA.install({ fixtureRepo: repo });
    revision(repo, "2.0.0");
    const pending = sourceA.update({ fixtureRepo: repo });
    await began;
    revision(repo, "3.0.0");
    await sourceB.checkUpdate({ fixtureRepo: repo });
    release();
    await assert.rejects(pending, /CAS/);
    assert.equal(sourceA.status().version, "1.0.0");
    assert.equal(sourceA.status().candidateVersion, "3.0.0");
  } finally { release(); sourceA.close(); sourceB.close(); }
}));


test("write lock serializes state changes across source-manager instances", () => fixture(({ cwd }) => {
  const first = new NpcParallelSources(cwd, hooks());
  const second = new NpcParallelSources(cwd, hooks());
  const lock = acquireLock(first.root);
  try { assert.throws(() => second.configure({ autoUpdate: true }), /正在写入|锁所有者/); }
  finally { lock.release(); first.close(); second.close(); }
}));


test("symlinked upstream runtime files and symlinked managed paths are refused", () => fixture(async ({ base, cwd, repo }) => {
  const source = new NpcParallelSources(cwd, hooks());
  try {
    const first = await source.install({ fixtureRepo: repo });
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "must never be read through a symlink");
    unlinkSync(join(repo, "index.js"));
    symlinkSync(outside, join(repo, "index.js"));
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "synthetic symlink attack");
    await assert.rejects(source.update({ fixtureRepo: repo }), /不是普通 Git 文件/);
    assert.equal(source.status().version, "1.0.0");
    assert.deepEqual(readFileSync(source.resolveAsset("index.js")!), Buffer.from(`globalThis.__syntheticNpcParallel = "1.0.0";\r\n`));
    assertPrivateMode(source.root, 0o700);
    assert.equal(readFileSync(outside, "utf8"), "must never be read through a symlink");
    void first;
  } finally { source.close(); }
}));


test("installed symlinks, corrupt bytes, and cross-path access fail closed", () => fixture(async ({ base, cwd, repo }) => {
  const source = new NpcParallelSources(cwd, hooks());
  try {
    const candidate = await source.install({ fixtureRepo: repo });
    source.configure({ enabled: true });
    for (const invalid of ["../state.json", "/etc/passwd", "assets/../../state.json", "index.js?x=1", "index.js\\foo", "\0bad"]) {
      assert.equal(source.resolveAsset(invalid), null, invalid);
    }
    assert.equal(source.resolveAsset("README.md"), null);
    assert.equal(source.resolveAsset("index.js", { ...candidate, root: base }), null);
    const index = join(candidate.root, "index.js");
    unlinkSync(index);
    symlinkSync(join(base, "outside.txt"), index);
    writeFileSync(join(base, "outside.txt"), "outside");
    assert.equal(source.resolveAsset("index.js"), null);
    assert.equal(source.active(), null);
    assert.equal(source.status().installed, false);
    assert.equal(source.status().enabled, false);
  } finally { source.close(); }
}));


test("private-root symlinks are refused without following their target", () => fixture(({ base, cwd }) => {
  const outside = join(base, "outside");
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(cwd, ".liyuan-npc-parallel"));
  assert.throws(() => new NpcParallelSources(cwd, hooks()), /私有目录/);
  assert.deepEqual(readdirSync(outside), []);
}));


test("installer CLI stages fixture bytes only and never activates/enables them", () => fixture(({ cwd, repo }) => {
  const script = fileURLToPath(new URL("../scripts/install-npc-parallel.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script, "--cwd", cwd, "--fixture-repo", repo], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.staged, true);
  assert.equal(report.activated, false);
  assert.equal(report.enabled, false);
  assert.equal(report.version, "1.0.0");
  assert.match(report.note, /不代表运行兼容/);
  assert.equal(lstatSync(join(cwd, ".liyuan-npc-parallel")).mode & 0o777, 0o700);
}));

test("proxy parameter accepts HTTP(S) only and refuses embedded credentials", () => fixture(async ({ cwd, repo }) => {
  const source = new NpcParallelSources(cwd, hooks());
  try {
    await assert.rejects(source.checkUpdate({ fixtureRepo: repo, proxy: "socks5://proxy.example.invalid:1080" }), /HTTP\(S\)/);
    await assert.rejects(source.checkUpdate({ fixtureRepo: repo, proxy: "http://user:pass@proxy.example.invalid:7890" }), /无凭据/);
  } finally { source.close(); }
}));

test("symlinked state file is refused without reading its target", () => fixture(({ cwd, base }) => {
  const root = join(cwd, ".liyuan-npc-parallel");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, "versions"), { mode: 0o700 });
  const outside = join(base, "state-outside.json");
  writeFileSync(outside, JSON.stringify({ schema: 1, enabled: true, autoUpdate: true }));
  symlinkSync(outside, join(root, "state.json"));
  assert.throws(() => new NpcParallelSources(cwd, hooks()), /状态文件不是安全的普通文件/);
  assert.equal(readFileSync(outside, "utf8"), JSON.stringify({ schema: 1, enabled: true, autoUpdate: true }));
}));

function acquireLock(root: string) {
  return acquireTavernPluginLock(root);
}

test("known Tavern host imports are adapter capabilities, unknown traversal remains rejected", () => fixture(async ({ cwd, repo }) => {
 writeFileSync(join(repo,"index.js"),"import {eventSource} from '../../../../script.js';\nimport {getContext} from '../../../extensions.js';\nexport const testValue = 1;\n");
 git(repo,"add",".");git(repo,"commit","-m","native host imports");
 const source=new NpcParallelSources(cwd,hooks());
 try {const candidate=await source.install({fixtureRepo:repo});assert.equal(readFileSync(join(candidate.root,"index.js"),"utf8"),readFileSync(join(repo,"index.js"),"utf8"));
  writeFileSync(join(repo,"index.js"),"import '../../../../private-admin.js';\n");git(repo,"add",".");git(repo,"commit","-m","unknown outside module");await assert.rejects(source.update({fixtureRepo:repo}),/越出/);
 }finally{source.close();}
}));
test('staged activation requires new host acceptance without re-fetching or bypassing integrity',()=>fixture(async({cwd,repo})=>{
 const stage=new NpcParallelSources(cwd,{isIdle:()=>false});await stage.checkUpdate({fixtureRepo:repo});stage.close();
 let checked=0;const live=new NpcParallelSources(cwd,hooks({validateCandidate:async()=>{checked++;return true;}}));
 try{await live.activateStaged();assert.equal(live.status().installed,true);assert.equal(checked,1);await assert.rejects(live.activateStaged(),/没有已暂存/);}finally{live.close();}
}));
test('rejected commit stays blocked after a later good update and a subsequent HEAD rewind',()=>fixture(async({cwd,repo})=>{
 const source=new NpcParallelSources(cwd,hooks());try{await source.install({fixtureRepo:repo});const bad=revision(repo,'2.0.0');await source.update({fixtureRepo:repo});await source.rollback();revision(repo,'3.0.0');await source.update({fixtureRepo:repo});source.configure({autoUpdate:true});
  const branch=git(repo,'symbolic-ref','HEAD');git(repo,'update-ref',branch,bad);await source.autoUpdateOnce({fixtureRepo:repo});assert.equal(source.status().version,'3.0.0');
 }finally{source.close();}
}));
