/** Private, process-owned lock. Dead owners can be recovered; live/unknown owners cannot. */
import { randomBytes } from "node:crypto";
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Stats } from "node:fs";

interface Owner { version: 1; pid: number; startTime: string | null; bootId: string | null; nonce: string; createdAt: number }
export interface TavernPluginLock { assertOwned(): void; release(): void }
export const TAVERN_LEGACY_LOCK_GRACE_MS = 30_000;
const busy = () => Object.assign(new Error("插件状态正在写入或锁所有者无法安全确认，请稍后重试"), { statusCode: 409 });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function stat(path: string): Stats | null { try { return lstatSync(path); } catch (error) { if (missing(error)) return null; throw error; } }
function startTime(pid: number): string | null {
 try { const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), value = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/)[19]; return /^\d+$/.test(value) ? value : null; }
 catch { return null; }
}
function bootId(): string | null { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return null; } }
function owner(): Owner { return { version: 1, pid: process.pid, startTime: startTime(process.pid), bootId: bootId(), nonce: randomBytes(24).toString("hex"), createdAt: Date.now() }; }
function readOwner(path: string): Owner | null {
 const info = stat(path); if (!info) return null;
 if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw busy();
 // O_NOFOLLOW also rejects a symlink swapped in after lstat.
 const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
 let value: Owner; try { value = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
 if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^[a-f0-9]{48}$/.test(value.nonce) || !Number.isFinite(value.createdAt) ||
     !(value.startTime === null || typeof value.startTime === "string" && /^\d+$/.test(value.startTime)) || !(value.bootId === null || typeof value.bootId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.bootId))) throw busy();
 return value;
}
function alive(value: Owner): boolean {
 // EPERM/unknown means alive. A recycled PID is distinguished by Linux starttime and boot identity.
 const boot = bootId(); if (boot && value.bootId && boot !== value.bootId) return false;
 try { process.kill(value.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
 const start = startTime(value.pid); return !(start && value.startTime && start !== value.startTime);
}
function identical(a: Owner | null, b: Owner | null) { return a === null ? b === null : b !== null && a.nonce === b.nonce && a.pid === b.pid && a.startTime === b.startTime && a.bootId === b.bootId; }
function recover(path: string, depth: number): boolean {
 const before = stat(path); if (!before) return true;
 if (!before.isDirectory() || before.isSymbolicLink()) throw busy();
 let prior: Owner | null; try { prior = readOwner(join(path, "owner.json")); } catch { throw busy(); }
 if (prior ? alive(prior) : Date.now() - before.mtimeMs < TAVERN_LEGACY_LOCK_GRACE_MS) throw busy();
 // Reclaimers are serialized inside the old inode. A crashed reclaimer's gate is
 // recovered by the same process-identity protocol, not an unguarded unlink.
 let gate: TavernPluginLock;
 try { gate = acquirePath(join(path, ".recovery-lock"), depth + 1); }
 catch (error) { if (missing(error)) return true; throw error; }
 let moved: string | null = null;
 try {
  gate.assertOwned();
  const current = stat(path); if (!current || !same(before, current)) throw busy();
  const next = readOwner(join(path, "owner.json")); if (!identical(prior, next) || next && alive(next)) throw busy();
  if (readdirSync(path).some(name => name !== "owner.json" && name !== ".recovery-lock")) throw busy();
  // Renaming with our live recovery gate held prevents a second reclaimer from
  // moving a newly acquired lock during a check/unlink window.
  const destination = path + ".stale-" + randomBytes(16).toString("hex");
  renameSync(path, destination); moved = destination;
  return true;
 } finally {
  if (moved) {
   // The renamed inode contains only the dead owner and our private gate.
   const old = stat(moved); if (old && same(before, old)) rmSync(moved, { recursive: true });
  } else { gate.release(); }
 }
}
function acquirePath(path: string, depth = 0): TavernPluginLock {
 if (depth > 8) throw busy(); // pathological repeated crashes require manual inspection
 const value = owner();
 for (let attempt = 0; ; attempt++) {
  try { mkdirSync(path, { mode: 0o700 }); break; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (attempt >= 2 || !recover(path, depth)) throw busy(); }
 }
 const info = lstatSync(path), record = join(path, "owner.json");
 try { writeFileSync(record, JSON.stringify(value), { flag: "wx", mode: 0o600 }); }
 catch (error) { try { if (same(info, lstatSync(path))) rmdirSync(path); } catch { /* do not delete anything not ours */ } throw error; }
 let released = false;
 const assertOwned = () => { const current = stat(path); if (released || !current || !same(info, current) || !identical(value, readOwner(record))) throw busy(); };
 return { assertOwned, release() {
  if (released) return;
  try { assertOwned(); unlinkSync(record); try { rmdirSync(path); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; } }
  finally { released = true; }
 } };
}

export function acquireTavernPluginLock(root: string): TavernPluginLock { return acquirePath(join(root, ".write-lock")); }
