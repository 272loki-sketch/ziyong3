import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fchmodSync,
	fchownSync,
	fsyncSync,
	fstatSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** Narrow synchronous filesystem seam for deterministic persistence-failure tests. */
export interface AtomicJsonFsOps {
	existsSync(path: string): boolean;
	openSync(path: string, flags: string, mode?: number): number;
	writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
	fstatSync(fd: number): { uid: number; gid: number };
	fchownSync(fd: number, uid: number, gid: number): void;
	fchmodSync(fd: number, mode: number): void;
	copyFileSync(source: string, destination: string, flags?: number): void;
	statSync(path: string): { mode: number; uid: number; gid: number };
	renameSync(oldPath: string, newPath: string): void;
	unlinkSync(path: string): void;
}

export interface AtomicJsonWriteOptions {
	spacing?: string | number;
	ops?: Partial<AtomicJsonFsOps>;
}

const defaultOps: AtomicJsonFsOps = {
	existsSync,
	openSync,
	writeSync,
	fsyncSync,
	closeSync,
	fstatSync,
	fchownSync,
	fchmodSync,
	copyFileSync,
	statSync,
	renameSync,
	unlinkSync,
};

const MODE_MASK = 0o7777;
const FIRST_FILE_MODE = 0o600;

function tempName(path: string, purpose: string): string {
	return join(dirname(path), `.liyuan-json-${purpose}-${process.pid}-${randomUUID()}.tmp`);
}

function writeAll(ops: AtomicJsonFsOps, fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		const written = ops.writeSync(fd, data, offset, data.length - offset, offset);
		if (!Number.isInteger(written) || written <= 0) throw new Error("同步写入未能推进");
		offset += written;
	}
}

function writeSyncedTemp(
	path: string,
	purpose: string,
	data: Buffer,
	mode: number,
	owner: { uid: number; gid: number } | undefined,
	ops: AtomicJsonFsOps,
): string {
	let temp = "";
	let fd: number | undefined;
	let primaryError: unknown;
	try {
		// randomUUID makes collisions vanishingly unlikely; wx remains the authority.
		for (let attempt = 0; attempt < 8; attempt++) {
			const candidate = tempName(path, purpose);
			try {
				fd = ops.openSync(candidate, "wx", mode);
				temp = candidate;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt === 7) throw error;
			}
		}
		if (fd === undefined) throw new Error("无法创建唯一临时文件");

		// The temp is created by the same service process as the destination. If its
		// current identity differs, restore the existing file's uid/gid before chmod.
		const created = ops.fstatSync(fd);
		if (owner && (created.uid !== owner.uid || created.gid !== owner.gid)) {
			ops.fchownSync(fd, owner.uid, owner.gid);
		}
		writeAll(ops, fd, data);
		// Apply after writing: writes/chown may clear set-id permission bits.
		ops.fchmodSync(fd, mode & MODE_MASK);
		ops.fsyncSync(fd);
	} catch (error) {
		primaryError = error;
	}
	if (fd !== undefined) {
		try {
			ops.closeSync(fd);
		} catch (error) {
			primaryError ??= error;
		}
	}
	if (primaryError !== undefined) {
		if (temp) {
			try { ops.unlinkSync(temp); } catch { /* preserve the original write error */ }
		}
		throw primaryError;
	}
	return temp;
}

function copySyncedTemp(
	path: string,
	purpose: string,
	source: string,
	mode: number,
	owner: { uid: number; gid: number },
	ops: AtomicJsonFsOps,
): string {
	let temp: string | undefined;
	let primaryError: unknown;
	for (let attempt = 0; attempt < 8; attempt++) {
		const candidate = tempName(path, purpose);
		temp = candidate;
		try {
			ops.copyFileSync(source, candidate, constants.COPYFILE_EXCL);
			primaryError = undefined;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
				temp = undefined; // This collision belongs to another writer; never unlink it.
				if (attempt < 7) continue;
			}
			primaryError = error;
			break;
		}
	}
	if (!temp || primaryError !== undefined) {
		removeTemp(ops, temp);
		throw primaryError ?? new Error("无法创建唯一备份临时文件");
	}

	let fd: number | undefined;
	try {
		fd = ops.openSync(temp, "r+");
		const created = ops.fstatSync(fd);
		if (created.uid !== owner.uid || created.gid !== owner.gid) ops.fchownSync(fd, owner.uid, owner.gid);
		ops.fchmodSync(fd, mode & MODE_MASK);
		ops.fsyncSync(fd);
	} catch (error) {
		primaryError = error;
	}
	if (fd !== undefined) {
		try { ops.closeSync(fd); } catch (error) { primaryError ??= error; }
	}
	if (primaryError !== undefined) {
		removeTemp(ops, temp);
		throw primaryError;
	}
	return temp;
}

function removeTemp(ops: AtomicJsonFsOps, path: string | undefined): void {
	if (!path) return;
	try { ops.unlinkSync(path); } catch { /* best-effort cleanup must not mask the write error */ }
}

/**
 * Serialize before filesystem access, stage complete fsynced files beside the
 * destination, and publish them only with same-directory atomic renames.
 */
export function writeJsonAtomicWithBackup(path: string, data: unknown, options: AtomicJsonWriteOptions = {}): void {
	const serialized = JSON.stringify(data, null, options.spacing ?? "\t");
	if (typeof serialized !== "string") throw new TypeError("JSON 根值无法序列化");
	const jsonBytes = Buffer.from(`${serialized}\n`, "utf8");
	const ops: AtomicJsonFsOps = { ...defaultOps, ...options.ops };

	const hadOriginal = ops.existsSync(path);
	const originalStat = hadOriginal ? ops.statSync(path) : undefined;
	const targetMode = originalStat ? originalStat.mode & MODE_MASK : FIRST_FILE_MODE;
	const targetOwner = originalStat ? { uid: originalStat.uid, gid: originalStat.gid } : undefined;
	const backupPath = `${path}.bak`;

	let newConfigTemp: string | undefined;
	let newBackupTemp: string | undefined;
	let oldBackupSnapshotTemp: string | undefined;
	let backupPublished = false;

	try {
		newConfigTemp = writeSyncedTemp(path, "new", jsonBytes, targetMode, targetOwner, ops);
		if (hadOriginal) {
			// Copy bytes, not parsed JSON: even hand-formatted legacy files are backed up exactly.
			newBackupTemp = copySyncedTemp(path, "backup", path, targetMode, targetOwner!, ops);

			// Keep a complete rollback snapshot so a failed final config rename cannot
			// leave a newly-published .bak in place instead of the prior .bak.
			if (ops.existsSync(backupPath)) {
				const oldBackupStat = ops.statSync(backupPath);
				oldBackupSnapshotTemp = copySyncedTemp(
					path,
					"bak-rollback",
					backupPath,
					oldBackupStat.mode & MODE_MASK,
					{ uid: oldBackupStat.uid, gid: oldBackupStat.gid },
					ops,
				);
			}

			ops.renameSync(newBackupTemp, backupPath);
			newBackupTemp = undefined;
			backupPublished = true;
		}

		try {
			ops.renameSync(newConfigTemp, path);
			newConfigTemp = undefined;
		} catch (error) {
			if (backupPublished) {
				let rollbackError: unknown;
				try {
					if (oldBackupSnapshotTemp) {
						ops.renameSync(oldBackupSnapshotTemp, backupPath);
						oldBackupSnapshotTemp = undefined;
					} else {
						ops.unlinkSync(backupPath);
					}
					backupPublished = false;
				} catch (restoreError) {
					rollbackError = restoreError;
				}
				if (rollbackError !== undefined && error && typeof error === "object") {
					// Keep the original write error (notably ENOSPC/EDQUOT) as the one
					// surfaced to the caller while retaining rollback diagnostics where possible.
					try { Object.defineProperty(error, "rollbackError", { value: rollbackError, configurable: true }); } catch { /* never mask the original */ }
					if (oldBackupSnapshotTemp) {
						try { Object.defineProperty(error, "recoveryPath", { value: oldBackupSnapshotTemp, configurable: true }); } catch { /* keep the recovery file regardless */ }
						oldBackupSnapshotTemp = undefined; // retain the only complete old-.bak copy
					}
				}
			}
			throw error;
		}
	} finally {
		removeTemp(ops, newConfigTemp);
		removeTemp(ops, newBackupTemp);
		removeTemp(ops, oldBackupSnapshotTemp);
	}
}
