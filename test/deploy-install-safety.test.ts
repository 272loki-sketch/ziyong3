import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../deploy/install.sh", import.meta.url));
const repo = "https://example.invalid/synthetic.git";
const secretRepo = "https://synthetic-user:synthetic-secret@example.invalid/other.git";

function install(options: {
	existing?: boolean;
	status?: string;
	origin?: string;
	fail?: string;
	ref?: string;
	detached?: boolean;
	repoEnv?: string;
	args?: string[];
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "liyuan-install-test-"));
	try {
		const bin = join(root, "bin");
		const dir = join(root, "install");
		const log = join(root, "commands.jsonl");
		mkdirSync(bin);
		mkdirSync(join(root, "home"));
		const sentinel = join(dir, "keep.txt");
		if (options.existing !== false) {
			mkdirSync(join(dir, "web", "dist"), { recursive: true });
			mkdirSync(join(dir, ".git"));
			writeFileSync(join(dir, "web", "dist", "index.html"), "synthetic");
			writeFileSync(sentinel, "synthetic local bytes");
		}
		const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
let args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'node') { console.log('v22.19.0'); process.exit(0); }
if (name === 'id') { console.log('1000'); process.exit(0); }
if (name === 'hostname') { console.log('127.0.0.1'); process.exit(0); }
if (name === 'npm') process.exit(0);
if (name !== 'git') process.exit(91);
if (args[0] === '-C') args = args.slice(2);
const command = args[0];
if (process.env.MOCK_FAIL === command || (process.env.MOCK_FAIL === 'local-checkout' && command === 'checkout' && !args[1].startsWith('origin/'))) {
  console.error(process.env.MOCK_ORIGIN);
  process.exit(1);
}
if (command === 'clone') {
  const dir = args.at(-1);
  fs.mkdirSync(path.join(dir, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'dist', 'index.html'), 'synthetic');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'synthetic local bytes');
}
else if (command === 'status') process.stdout.write(process.env.MOCK_STATUS);
else if (command === 'remote') console.log(process.env.MOCK_ORIGIN);
else if (command === 'symbolic-ref') {
  if (process.env.MOCK_DETACHED === '1') process.exit(1);
  console.log('refs/heads/' + process.env.MOCK_REF);
} else if (!['fetch', 'checkout', 'merge', 'clone'].includes(command)) process.exit(92);
`;
		for (const command of ["git", "npm", "curl", "node", "id", "hostname", "systemctl", "fuser", "nohup"]) {
			const path = join(bin, command);
			writeFileSync(path, mock);
			chmodSync(path, 0o700);
		}
		const result = spawnSync("/bin/bash", [installer, "--dir", dir, "--no-start", ...(options.args ?? [])], {
			cwd: root,
			env: {
				PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: root,
				LIYUAN_REF: options.ref ?? "main",
				...(options.repoEnv === undefined ? {} : { LIYUAN_REPO: options.repoEnv }),
				MOCK_LOG: log, MOCK_STATUS: options.status ?? "", MOCK_ORIGIN: options.origin ?? repo,
				MOCK_FAIL: options.fail ?? "", MOCK_REF: options.ref ?? "main",
				MOCK_DETACHED: options.detached ? "1" : "0",
			},
			encoding: "utf8", timeout: 10_000,
		});
		assert.equal(result.error, undefined);
		if (options.existing !== false || options.fail !== "clone") {
			assert.equal(readFileSync(sentinel, "utf8"), "synthetic local bytes");
		}
		const commands: string[][] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(commands.every(([name]) => !["curl", "systemctl", "fuser", "nohup"].includes(name)));
		const git = commands.filter(([name]) => name === "git").map((args) => args[1] === "-C" ? args.slice(3) : args.slice(1));
		assert.ok(git.every((args) => !args.includes("-f") && !args.includes("--force")));
		assert.ok(git.every(([command]) => !["reset", "clean", "stash", "pull"].includes(command)));
		return { code: result.status, output: result.stdout + result.stderr, commands, git };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

for (const status of [" M tracked.txt\n", "M  staged.txt\n", "?? untracked.txt\n"]) {
	test(`installer refuses dirty status ${status.trim()} before fetch or npm`, () => {
		const result = install({ status });
		assert.equal(result.code, 1);
		assert.deepEqual(result.git.map(([command]) => command), ["status"]);
		assert.ok(!result.commands.some(([name]) => name === "npm"));
	});
}

test("installer verifies explicit CLI and environment origins without exposing credentials", () => {
	for (const options of [{ args: ["--repo", secretRepo] }, { repoEnv: secretRepo }]) {
		const result = install({ ...options, origin: repo });
		assert.equal(result.code, 1);
		assert.deepEqual(result.git.map(([command]) => command), ["status", "remote"]);
		assert.ok(!result.output.includes(secretRepo));
		assert.ok(!result.output.includes("synthetic-secret"));
	}
	const matching = install({ origin: secretRepo, repoEnv: repo, args: ["--repo", secretRepo] });
	assert.equal(matching.code, 0);
	assert.ok(!matching.output.includes("synthetic-secret"));
});

test("installer refuses an empty origin before fetch", () => {
	const result = install({ origin: "" });
	assert.equal(result.code, 1);
	assert.deepEqual(result.git.map(([command]) => command), ["status", "remote"]);
	assert.ok(!result.commands.some(([name]) => name === "npm"));
});

for (const fail of ["status", "remote", "fetch", "checkout", "merge"]) {
	test(`installer stops on ${fail} failure without npm or credential leakage`, () => {
		const result = install({ fail, origin: secretRepo });
		assert.equal(result.code, 1);
		assert.ok(!result.commands.some(([name]) => name === "npm"));
		assert.ok(!result.output.includes("synthetic-secret"));
		if (fail === "fetch") assert.ok(!result.git.some(([command]) => command === "checkout"));
	});
}

test("clean inherited branch preserves its origin and fast-forwards the requested remote branch", () => {
	const result = install({ ref: "feature/synthetic" });
	assert.equal(result.code, 0);
	assert.deepEqual(result.git, [
		["status", "--porcelain", "--untracked-files=all"], ["remote", "get-url", "origin"],
		["fetch", "--tags", "origin"], ["checkout", "feature/synthetic"],
		["symbolic-ref", "--quiet", "HEAD"], ["merge", "--ff-only", "origin/feature/synthetic"],
	]);
	assert.ok(result.commands.some(([name]) => name === "npm"));
});

test("existing tags and remote-only refs install without a pull or merge", () => {
	for (const options of [{ ref: "v0.0.0-synthetic" }, { ref: "new-branch", fail: "local-checkout" }]) {
		const result = install({ ...options, detached: true });
		assert.equal(result.code, 0);
		assert.ok(!result.git.some(([command]) => command === "pull" || command === "merge"));
		if (options.fail) assert.ok(result.git.some((args) => args[0] === "checkout" && args[1] === "origin/new-branch"));
	}
});

test("fresh branch and tag clone retain requested refs and redact repository URLs", () => {
	for (const ref of ["main", "v0.0.0-synthetic"]) {
		const result = install({ existing: false, ref, args: ["--repo", secretRepo] });
		assert.equal(result.code, 0);
		assert.deepEqual(result.git[0].slice(0, 6), ["clone", "--depth", "1", "--branch", ref, secretRepo]);
		assert.deepEqual(result.git[1], ["checkout", ref]);
		assert.ok(!result.output.includes("synthetic-secret"));
	}
	const result = install({ existing: false, fail: "clone", origin: secretRepo, args: ["--repo", secretRepo] });
	assert.equal(result.code, 1);
	assert.ok(!result.output.includes("synthetic-secret"));
	assert.ok(!result.commands.some(([name]) => name === "npm"));
});
