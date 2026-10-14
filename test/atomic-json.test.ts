import assert from "node:assert/strict";
import { closeSync, copyFileSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeJsonAtomicWithBackup, type AtomicJsonFsOps } from "../src/atomic-json.ts";

function fixture(run: (dir: string, path: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-atomic-json-"));
	try { run(dir, join(dir, "config.json")); }
	finally { rmSync(dir, { recursive: true, force: true }); }
}

function enospc(message: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = "ENOSPC";
	return error;
}

function failWritesFor(purpose: string): Partial<AtomicJsonFsOps> {
	const descriptors = new Map<number, string>();
	const failed = new Set<number>();
	return {
		openSync(path, flags, mode) {
			const fd = openSync(path, flags as never, mode);
			descriptors.set(fd, path);
			return fd;
		},
		writeSync(fd, buffer, offset, length, position) {
			if (descriptors.get(fd)?.includes(`-${purpose}-`) && !failed.has(fd)) {
				failed.add(fd);
				const partialLength = Math.min(3, length);
				if (partialLength > 0) writeSync(fd, buffer, offset, partialLength, position);
				throw enospc(`synthetic partial ${purpose} write full`);
			}
			return writeSync(fd, buffer, offset, length, position);
		},
		closeSync(fd) {
			try { closeSync(fd); }
			finally { descriptors.delete(fd); }
		},
	};
}

function failBackupCopy(): Partial<AtomicJsonFsOps> {
	return {
		copyFileSync(source, destination, flags) {
			if (destination.includes("-backup-")) {
				// Simulate a partial copy followed by ENOSPC; helper must unlink this temp.
				writeFileSync(destination, "partial backup", { flag: "wx" });
				throw enospc("synthetic backup copy full");
			}
			copyFileSync(source, destination, flags);
		},
	};
}

function failTargetRename(path: string): Partial<AtomicJsonFsOps> {
	return {
		renameSync(oldPath, newPath) {
			if (newPath === path) throw enospc("synthetic target commit full");
			renameSync(oldPath, newPath);
		},
	};
}

function names(dir: string): string[] {
	return readdirSync(dir).sort();
}

function assertPosixMode(path: string, expected: number): void {
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o7777, expected, path);
}

test("ENOSPC 写新配置临时文件时原 config 与旧 bak 均保持，临时文件清理", () => fixture((dir, path) => {
	const original = '{ "generationMode": "director" }\n';
	const oldBak = '{"older":"backup"}\n';
	writeFileSync(path, original, { mode: 0o640 });
	writeFileSync(`${path}.bak`, oldBak, { mode: 0o600 });

	assert.throws(() => writeJsonAtomicWithBackup(path, { generationMode: "direct" }, { ops: failWritesFor("new") }), { code: "ENOSPC" });
	assert.equal(readFileSync(path, "utf8"), original);
	assert.equal(readFileSync(`${path}.bak`, "utf8"), oldBak);
	assert.deepEqual(names(dir), ["config.json", "config.json.bak"]);
}));

test("ENOSPC 复制旧 config 到备份临时文件时原 config 与旧 bak 均保持", () => fixture((dir, path) => {
	const original = '{\n  "prior": true\n}\n';
	const oldBak = '{"evenOlder":true}\n';
	writeFileSync(path, original, { mode: 0o640 });
	writeFileSync(`${path}.bak`, oldBak, { mode: 0o600 });

	assert.throws(() => writeJsonAtomicWithBackup(path, { next: true }, { spacing: 2, ops: failBackupCopy() }), { code: "ENOSPC" });
	assert.equal(readFileSync(path, "utf8"), original);
	assert.equal(readFileSync(`${path}.bak`, "utf8"), oldBak);
	assert.deepEqual(names(dir), ["config.json", "config.json.bak"]);
}));

test("主 config 原子提交失败会回滚已暂存的 bak，两个正式文件逐字节不变", () => fixture((dir, path) => {
	const original = '{ "manualSpacing" : [1, 2] }\n';
	const oldBak = '{"previousBackup":"keep exactly"}\n';
	writeFileSync(path, original, { mode: 0o640 });
	writeFileSync(`${path}.bak`, oldBak, { mode: 0o600 });

	assert.throws(() => writeJsonAtomicWithBackup(path, { next: true }, { ops: failTargetRename(path) }), { code: "ENOSPC" });
	assert.equal(readFileSync(path, "utf8"), original);
	assert.equal(readFileSync(`${path}.bak`, "utf8"), oldBak);
	assert.deepEqual(names(dir), ["config.json", "config.json.bak"]);
}));

test("JSON 序列化失败发生在任何文件系统操作之前", () => fixture((dir, path) => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	let touched = false;
	assert.throws(() => writeJsonAtomicWithBackup(path, cyclic, { ops: { existsSync() { touched = true; return false; } } }), /circular|cyclic/i);
	assert.equal(touched, false);
	assert.deepEqual(names(dir), []);
}));

test("成功时 .bak 精确保存旧字节；POSIX 上主文件保留 mode/owner，spacing 可指定", () => fixture((dir, path) => {
	const original = '{ "legacy" : [1, 2] }\r\n';
	writeFileSync(path, original, { mode: 0o640 });
	const before = statSync(path);

	writeJsonAtomicWithBackup(path, { generationMode: "direct", nested: { keep: true } }, { spacing: 2 });

	assert.equal(readFileSync(`${path}.bak`, "utf8"), original);
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ generationMode: "direct", nested: { keep: true } }, null, 2)}\n`);
	const after = statSync(path);
	if (process.platform !== "win32") {
		assert.equal(after.mode & 0o7777, before.mode & 0o7777);
		assert.equal(after.uid, before.uid);
		assert.equal(after.gid, before.gid);
		assert.equal(statSync(`${path}.bak`).mode & 0o7777, before.mode & 0o7777);
	}
	assert.deepEqual(names(dir), ["config.json", "config.json.bak"]);
}));

test("默认JSON缩进为tab", () => fixture((dir, path) => {
	const value = { generationMode: "director", nested: { enabled: true } };
	writeJsonAtomicWithBackup(path, value);
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(value, null, "\t")}\n`);
}));

test("首次创建失败不留下目标或 bak；POSIX 上成功时使用私有 0600", () => fixture((dir, path) => {
	assert.throws(() => writeJsonAtomicWithBackup(path, { first: true }, { ops: failWritesFor("new") }), { code: "ENOSPC" });
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(`${path}.bak`), false);
	assert.deepEqual(names(dir), []);

	assert.throws(() => writeJsonAtomicWithBackup(path, { first: true }, { ops: failTargetRename(path) }), { code: "ENOSPC" });
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(`${path}.bak`), false);
	assert.deepEqual(names(dir), []);

	writeJsonAtomicWithBackup(path, { first: true });
	assertPosixMode(path, 0o600);
	assert.equal(existsSync(`${path}.bak`), false);
}));
