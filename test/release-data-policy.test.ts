import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { approvedDocumentation, pathCategory } from "../scripts/public-repository-policy.mjs";
import test from "node:test";

// Never execute pack-release.ps1: it can build and reads a real working tree.
// Extract its actual embedded Python programs and run them only on /tmp fixtures.
const source = readFileSync(new URL("../scripts/pack-release.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function literal(variable: string): string {
	const match = source.match(new RegExp(`\\$${variable} = @'\\n([\\s\\S]*?)\\n'@`));
	assert.ok(match, `missing shared ${variable}`);
	return match[1];
}
const policyJson = literal("ReleaseDataPolicyJson");
const predicate = literal("ReleasePathPolicyPython");
const policy = JSON.parse(policyJson) as {
	excludedDirectoryNames: string[];
	excludedDirectoryPrefixes: string[];
	excludedRelativeDirectories: string[];
	productDirectoryExceptions: string[];
};
function functionSource(name: string): string {
	const start = source.indexOf(`function ${name} {`);
	assert.ok(start >= 0, `missing ${name}`);
	const end = source.indexOf("\nfunction ", start + 1);
	return source.slice(start, end < 0 ? undefined : end);
}
function pythonProgram(name: string, values: Record<string, string>): string {
	const match = functionSource(name).match(/\$py = @"\n([\s\S]*?)\n"@/);
	assert.ok(match, `missing embedded Python in ${name}`);
	return match[1].replace(/\$(ReleaseDataPolicyJson|ReleasePathPolicyPython|SourceDir|ZipPath)\b/g, (_all, variable: string) => {
		const value = { ReleaseDataPolicyJson: policyJson, ReleasePathPolicyPython: predicate, ...values }[variable];
		assert.notEqual(value, undefined, `missing fixture value ${variable}`);
		return value;
	});
}
function python(code: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", code], {
		encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
	});
	assert.ifError(result.error); // Python stdlib is also required by the real packaging script.
	return result;
}
function fixture(run: (root: string, stage: string, zip: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "liyuan-release-policy-"));
	try { run(root, join(root, "stage"), join(root, "fixture.zip")); }
	finally { rmSync(root, { recursive: true, force: true }); }
}
function put(stage: string, file: string, content: string): void {
	const path = join(stage, file);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}
const productFiles = {
	".liyuan/extensions/roleplay.ts": "// product RP wiring",
	"server/mcp/vision-server.mjs": "// product builtin vision server",
	"skills/世界推演/SKILL.md": "builtin rules",
	"package.json": '{"name":"release-fixture"}',
};
const privatePaths = [
	".liyuan-veridis-rewrite/versions/original/src/aiRewrite/runtime.js",
	".liyuan-veridis-rewrite/state.json",
	".liyuan-npc-parallel/state.json",
	".liyuan-npc-parallel/versions/original/index.js",
	".liyuan-npc-parallel/.liyuan-tavern-plugins/state/private-candidates.json",
	".liyuan-stage-skills/世界推演/SKILL.md",
	".liyuan-memory/scopes/fixture/memory.sqlite",
	".liyuan-tavern-plugins/versions/helper/original/dist/index.js",
	".liyuan-tavern-plugins/state/private-vars.json",
	".liyuan-assistant/session.jsonl",
	".liyuan-future-user-data/private.txt",
	".rp-future-user-data/private.txt",
	".backup/old-config.json",
	".liyuan/settings.json",
	".liyuan/outline/research/doc.txt",
	".liyuan-research/network.json",
	"assets/personas/private.png",
	"assets/presets/private.json",
	"assets/gen/private.png",
	"data/config/private.json",
	"test/private-fixture.txt",
];

test("release: all three layers consume one directory policy and preserve the RP product exception", () => {
	assert.ok(policy.excludedDirectoryNames.includes(".liyuan-stage-skills"));
	for (const dir of [".liyuan-memory", ".liyuan-assistant", ".backup"]) assert.ok(policy.excludedDirectoryNames.includes(dir));
	assert.deepEqual(policy.productDirectoryExceptions, [".liyuan/extensions"]);
	assert.deepEqual(policy.excludedDirectoryPrefixes, [".liyuan-", ".rp-"]);
	const stage = functionSource("Stage-Clean");
	assert.match(stage, /\$xd = @\(\$ReleaseDataPolicy\.excludedDirectoryNames\)/);
	assert.match(stage, /\$ReleaseDataPolicy\.excludedRelativeDirectories/);
	assert.match(stage, /\$ReleaseDataPolicy\.excludedDirectoryPrefixes/);
	assert.match(stage, /Copy-Item \(Join-Path \$extSrc "\*\.ts"\) \$extDst -Force/);
	assert.match(stage, /roleplay\.ts/);
	for (const fn of ["Write-Utf8Zip", "Test-ReleaseZip"]) {
		const code = functionSource(fn);
		assert.match(code, /\$ReleaseDataPolicyJson/);
		assert.match(code, /\$ReleasePathPolicyPython/);
		assert.match(code, /release_path_is_excluded\(/);
	}
	assert.doesNotMatch(source, /\b(skip_dirs|forbidden_dirs)\s*=/);
});

test("release: actual embedded ZIP writer excludes user data from an isolated fixture, including future runtime names", () => fixture((_root, stage, zip) => {
	for (const [path, content] of Object.entries(productFiles)) put(stage, path, content);
	for (const path of privatePaths) put(stage, path, "PRIVATE-FIXTURE-ONLY");
	const writer = pythonProgram("Write-Utf8Zip", { SourceDir: stage, ZipPath: zip });
	const written = python(writer + "\nprint(json.dumps(zipfile.ZipFile(zip_path).namelist()))\n");
	assert.equal(written.status, 0, written.stderr);
	const names = JSON.parse(written.stdout.trim().split("\n").at(-1)!) as string[];
	assert.deepEqual([...names].sort(), Object.keys(productFiles).map(path => `Liyuan/${path}`).sort());
	const checked = python(pythonProgram("Test-ReleaseZip", { ZipPath: zip }));
	assert.equal(checked.status, 0, checked.stdout + checked.stderr);
}));

test("release: actual embedded ZIP checker rejects injected user directories even if staging/archive pruning regress", () => fixture((_root, stage, zip) => {
	for (const [path, content] of Object.entries(productFiles)) put(stage, path, content);
	assert.equal(python(pythonProgram("Write-Utf8Zip", { SourceDir: stage, ZipPath: zip })).status, 0);
	const injection = `import zipfile\nwith zipfile.ZipFile(${JSON.stringify(zip)}, 'a') as z:\n` + privatePaths.map(path => `    z.writestr(${JSON.stringify(`Liyuan/${path}`)}, 'PRIVATE-FIXTURE-ONLY')`).join("\n");
	assert.equal(python(injection).status, 0);
	const checked = python(pythonProgram("Test-ReleaseZip", { ZipPath: zip }));
	assert.equal(checked.status, 1, checked.stdout + checked.stderr);
	for (const path of privatePaths) assert.ok(checked.stdout.includes(`Liyuan/${path}`), `missing leak rejection: ${path}`);
}));

test("release: checker fails closed when the required RP/vision product wiring is missing", () => fixture((_root, _stage, zip) => {
	assert.equal(python(`import zipfile\nwith zipfile.ZipFile(${JSON.stringify(zip)}, 'w') as z:\n    z.writestr('Liyuan/package.json', '{}')`).status, 0);
	const checked = python(pythonProgram("Test-ReleaseZip", { ZipPath: zip }));
	assert.equal(checked.status, 1);
	assert.match(checked.stdout, /MISSING \.liyuan\/extensions\/roleplay\.ts/);
	assert.match(checked.stdout, /MISSING server\/mcp\/vision-server\.mjs/);
}));

test("release: manifest public maintenance tools retain their import and hook dependency closure after trimming and ZIP", () => fixture((_root, stage, zip) => {
	const staging = functionSource("Stage-Clean");
	const array = (name: string): string[] => {
		const match = staging.match(new RegExp(`\\$${name} = @\\(\\n([\\s\\S]*?)\\n  \\)`));
		assert.ok(match, `missing ${name}`);
		return [...match[1].matchAll(/^\s*"([^"]+)"/gm)].map(value => value[1].replace(/\\/g, "/"));
	};
	const retained = array("maintenancePaths");
	const drops = array("dropGlobs");
	const excludedFiles = array("xf");
	assert.match(staging, /\$maintenancePaths[\s\S]*?ForEach-Object \{ Join-Path \$dest \$_ \}/);
	assert.match(staging, /Get-Item \$p[^\n]*\| Where-Object \{\n\s*\$_\.FullName -notin \$maintenancePaths\n\s*\} \| Remove-Item/);
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const pending: string[] = ["git:public", "privacy:check", "privacy:staged", "privacy:commit", "docs:check"].map(name => {
		const match = manifest.scripts[name]?.match(/^node (scripts\/[^ ]+\.mjs)(?: |$)/);
		assert.ok(match, `missing public maintenance entrypoint ${name}`);
		return match[1];
	});
	// The exporter copies these tools into candidate hooks, rather than importing the guard.
	const exporter = readFileSync(new URL("../scripts/prepare-public-git.mjs", import.meta.url), "utf8");
	const hookTools = exporter.match(/for \(const name of \[([^\]]+)\]\)/);
	assert.ok(hookTools, "missing exporter hook tool dependencies");
	for (const match of hookTools[1].matchAll(/'([^']+\.mjs)'/g)) pending.push(`scripts/${match[1]}`);
	pending.push("scripts/check-public-data.mjs", "scripts/check-publication-range.mjs");
	const files: Record<string, string> = { ...productFiles, "package.json": JSON.stringify(manifest) };
	const visited = new Set<string>();
	while (pending.length) {
		const path = pending.pop()!;
		if (visited.has(path)) continue;
		visited.add(path);
		assert.equal(pathCategory(path, true), null, `unapproved maintenance dependency ${path}`);
		assert.ok(retained.includes(path), `unprotected maintenance dependency ${path}`);
		const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
		files[path] = text;
		for (const match of text.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
			pending.push(posix.normalize(posix.join(posix.dirname(path), match[1])));
		}
	}
	assert.deepEqual([...visited].sort(), [...retained].sort(), "retention must be limited to the reviewed dependency closure");
	const survives = python(`import fnmatch, json\nfiles = ${JSON.stringify([...Object.keys(files), "scripts/check-private-fixture.mjs"])}\ndrops = ${JSON.stringify(drops)}\nexcluded = ${JSON.stringify(excludedFiles)}\nretained = ${JSON.stringify(retained)}\nprint(json.dumps([p for p in files if not any(fnmatch.fnmatchcase(p.rsplit('/', 1)[-1], g) for g in excluded) and (p in retained or not any(fnmatch.fnmatchcase(p, g) for g in drops))]))`);
	assert.equal(survives.status, 0, survives.stderr);
	const staged = JSON.parse(survives.stdout) as string[];
	assert.ok(!staged.includes("scripts/check-private-fixture.mjs"), "unapproved check tools must still be trimmed");
	for (const path of staged) put(stage, path, files[path]);
	const written = python(pythonProgram("Write-Utf8Zip", { SourceDir: stage, ZipPath: zip }) + "\nprint(json.dumps(zipfile.ZipFile(zip_path).namelist()))\n");
	assert.equal(written.status, 0, written.stderr);
	const names = JSON.parse(written.stdout.trim().split("\n").at(-1)!) as string[];
	for (const path of visited) assert.ok(names.includes(`Liyuan/${path}`), `missing archived dependency ${path}`);
	const checked = python(pythonProgram("Test-ReleaseZip", { ZipPath: zip }));
	assert.equal(checked.status, 0, checked.stdout + checked.stderr);
	// Exercise real static imports without exporting a repository or running an audit.
	const help = spawnSync(process.execPath, [join(stage, "scripts/prepare-public-git.mjs"), "--help"], {
		cwd: dirname(stage), encoding: "utf8", timeout: 5_000,
	});
	assert.ifError(help.error);
	assert.equal(help.status, 0, help.stdout + help.stderr);
	assert.match(help.stdout, /Usage: node scripts\/prepare-public-git\.mjs/);
}));


test("release: approved public guide closure is not trimmed as historical development notes", () => {
 const staging = functionSource("Stage-Clean");
 const match = staging.match(/\$dropGlobs = @\(\n([\s\S]*?)\n  \)/);
 assert.ok(match);
 const drops = [...match[1].matchAll(/^\s*"([^"]+)"/gm)].map(value => value[1].replace(/\\/g, "/"));
 const guides = ["README.md", "TESTING.md", "AGENTS.md", "CLAUDE.md", "deploy/README.md", "deploy/VPS-OPERATIONS.md", "licenses/README.md", ...[...approvedDocumentation].map(name => `docs/${name}`)];
 const checked = python(`import fnmatch, json\nguides = ${JSON.stringify(guides)}\ndrops = ${JSON.stringify(drops)}\nprint(json.dumps([p for p in guides if any(fnmatch.fnmatchcase(p, g) for g in drops)]))`);
 assert.equal(checked.status, 0, checked.stderr);
 assert.deepEqual(JSON.parse(checked.stdout), [], "public README and navigation links must survive release trimming");
 assert.ok(drops.includes("test"));
 assert.ok(drops.includes("docs/superpowers"));
});
