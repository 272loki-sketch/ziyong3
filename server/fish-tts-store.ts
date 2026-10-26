import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicWithBackup } from "../src/atomic-json.ts";
import { defaultFishTtsConfig, validateFishTtsConfig, type FishTtsConfig } from "../src/fish-tts.ts";
import { acquireTavernPluginLock } from "./tavern-plugin-lock.ts";

interface Saved { version: 1; revision: number; apiKey: string; config: FishTtsConfig }
const MAX_CONFIG = 256 * 1024;
export const FISH_AUDIO_MAX_BYTES = 24 * 1024 * 1024;
const MAX_CACHE = 256 * 1024 * 1024;
export const fishDigest = (text: string) => createHash("sha256").update(text).digest("hex");
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
/** No read creates data. Private directory components and files cannot be symlinks. */
export class FishTtsStore {
	readonly root: string;
	constructor(cwd: string) { this.root = join(cwd, ".liyuan-fish-tts"); }
	private directory(path: string, create = false): boolean {
		if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
		try {
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("配音私有目录不允许符号链接");
			if (process.platform !== "win32" && (stat.mode & 0o077)) chmodSync(path, 0o700);
			return true;
		} catch (error) { if (missing(error)) return false; throw error; }
	}
	private readFile(path: string, limit: number): Buffer | null {
		let fd: number;
		try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
		catch (error) { if (missing(error)) return null; throw error; }
		try {
			const info = fstatSync(fd);
			if (!info.isFile() || info.size > limit || info.nlink !== 1) throw new Error("配音私有文件类型或大小无效");
			// Windows reports 0666 for every writable file; POSIX modes are not an ACL there.
			if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("配音私有文件权限应为 0600；未读取不安全的文件");
			return readFileSync(fd);
		} finally { closeSync(fd); }
	}
	read(): Saved {
		const initial: Saved = { version: 1, revision: 0, apiKey: "", config: defaultFishTtsConfig() };
		if (!this.directory(this.root)) return initial;
		const bytes = this.readFile(join(this.root, "config.json"), MAX_CONFIG);
		if (!bytes) return initial;
		const value = JSON.parse(bytes.toString("utf8")) as Saved;
		if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.apiKey !== "string") throw new Error("配音设置文件无效，未重置已有配置");
		value.config = validateFishTtsConfig(value.config);
		return value;
	}
	save(revision: number, input: unknown, apiKey: unknown, guard: () => void): Saved {
		this.directory(this.root, true);
		const lock = acquireTavernPluginLock(this.root);
		try {
			guard(); lock.assertOwned();
			const old = this.read();
			if (!Number.isSafeInteger(revision) || revision !== old.revision) throw Object.assign(new Error("配音设置已更新，请刷新后重试"), { status: 409 });
			if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 1024 || /[\x00-\x20\x7f]/.test(apiKey))) throw new Error("Fish API Key 格式无效");
			const saved: Saved = { ...old, revision: old.revision + 1, apiKey: apiKey === undefined ? old.apiKey : apiKey as string, config: validateFishTtsConfig(input, old.config) };
			if (Buffer.byteLength(JSON.stringify(saved)) > MAX_CONFIG) throw new Error("配音设置超过存储上限");
			this.readFile(join(this.root, "config.json.bak"), MAX_CONFIG);
			guard(); lock.assertOwned(); writeJsonAtomicWithBackup(join(this.root, "config.json"), saved);
			return saved;
		} finally { lock.release(); }
	}
	cache(key: string): Buffer | null {
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("音频标识无效");
		if (!this.directory(this.root) || !this.directory(join(this.root, "audio"))) return null;
		return this.readFile(join(this.root, "audio", `${key}.mp3`), FISH_AUDIO_MAX_BYTES);
	}
	assertCacheCapacity(): void {
		if (!this.directory(this.root) || !this.directory(join(this.root, "audio"))) return;
		const used = readdirSync(join(this.root, "audio")).reduce((sum, name) => sum + lstatSync(join(this.root, "audio", name)).size, 0);
		// Reserve the maximum accepted response before making a potentially paid call.
		if (used + FISH_AUDIO_MAX_BYTES > MAX_CACHE) throw Object.assign(new Error("配音缓存空间不足以接收单次音频；未调用 Fish，请先维护缓存，已有音频与设置未删除"), { status: 507 });
	}
	putAudio(key: string, bytes: Buffer, guard: () => void): void {
		if (!/^[a-f0-9]{64}$/.test(key) || !bytes.length || bytes.length > FISH_AUDIO_MAX_BYTES) throw new Error("音频大小无效");
		this.directory(this.root, true); this.directory(join(this.root, "audio"), true);
		const lock = acquireTavernPluginLock(this.root);
		try {
			guard(); lock.assertOwned();
			if (this.cache(key)) return;
			const used = readdirSync(join(this.root, "audio")).reduce((sum, name) => sum + lstatSync(join(this.root, "audio", name)).size, 0);
			if (used + bytes.length > MAX_CACHE) throw new Error("配音缓存已达 256 MiB；未删除已有音频，请先维护缓存");
			const temporary = join(this.root, "audio", `.pending-${randomUUID()}.tmp`);
			let fd: number | undefined;
			try {
				fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
				guard(); lock.assertOwned(); renameSync(temporary, join(this.root, "audio", `${key}.mp3`));
			} finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
		} finally { lock.release(); }
	}
}
/** Only documented public settings cross the HTTP boundary; future private fields stay on disk. */
export function publicFishConfig(config: FishTtsConfig): FishTtsConfig {
	return { networkMode: config.networkMode, enabled: config.enabled, model: config.model, speed: config.speed, readNarration: config.readNarration, narratorVoiceId: config.narratorVoiceId,
		voices: config.voices.map(voice => ({ id: voice.id, name: voice.name, aliases: voice.aliases, referenceId: voice.referenceId, enabled: voice.enabled })) };
}
