/**
 * 访问密码（Web 登录）：scrypt 加盐哈希 + 持久化会话 token（纯函数，零 pi 依赖）。
 *
 * - 存储 `.liyuan/access.json`（.gitignore 已覆盖 .liyuan/*，不随仓库分发）；
 * - 未设置密码 = 完全开放（首次使用零门槛）；设置后 REST / WS / 媒体托管统一凭 Cookie 过闸；
 * - 设置/修改密码会清空全部旧 token（所有已登录设备下线），并为当前设备签发新 token。
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeJsonAtomicWithBackup } from "./atomic-json.ts";
import { join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE = "liyuan_access";
const MAX_TOKENS = 20;
const MAX_ACCESS_BYTES = 64 * 1024;
const MAX_PASSWORD_LENGTH = 1024;
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const TOKEN = /^[a-f0-9]{64}$/;

export interface AccessToken {
	id: string;
	createdAt: number;
}

export interface AccessData {
	salt: string;
	hash: string;
	tokens: AccessToken[];
}

function accessPath(cwd: string): string {
	return join(cwd, ".liyuan", "access.json");
}

function assertPrivateDirectory(cwd: string): void {
	const directory = join(cwd, ".liyuan");
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("访问密码目录类型无效，拒绝开放服务");
}

export function loadAccess(cwd: string): AccessData | null {
	let stat;
	try {
		assertPrivateDirectory(cwd);
		stat = lstatSync(accessPath(cwd));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("访问密码文件无法读取，拒绝开放服务", { cause: error });
	}
	try {
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ACCESS_BYTES) throw new Error("invalid file");
		const bytes = readFileSync(accessPath(cwd));
		if (bytes.length > MAX_ACCESS_BYTES) throw new Error("invalid size");
		const raw = JSON.parse(bytes.toString("utf8")) as AccessData;
		if (!raw || typeof raw.salt !== "string" || typeof raw.hash !== "string" || !/^[a-f0-9]{32}$/.test(raw.salt) || !/^[a-f0-9]{128}$/.test(raw.hash)
			|| !Array.isArray(raw.tokens) || raw.tokens.length > MAX_TOKENS
			|| raw.tokens.some(token => !token || typeof token.id !== "string" || !TOKEN.test(token.id) || !Number.isSafeInteger(token.createdAt) || token.createdAt < 0)) throw new Error("invalid credentials");
		return { salt: raw.salt, hash: raw.hash, tokens: raw.tokens };
	} catch (error) {
		throw new Error("访问密码文件损坏或类型无效，拒绝开放服务；请由本机管理员检查", { cause: error });
	}
}

function save(cwd: string, data: AccessData): void {
	mkdirSync(join(cwd, ".liyuan"), { recursive: true, mode: 0o700 });
	assertPrivateDirectory(cwd);
	if (process.platform !== "win32") chmodSync(join(cwd, ".liyuan"), 0o700);
	try {
		const stat = lstatSync(accessPath(cwd));
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("访问密码文件类型无效，未覆盖原文件");
		if (process.platform !== "win32") chmodSync(accessPath(cwd), 0o600);
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	writeJsonAtomicWithBackup(accessPath(cwd), data);
}

function hashPassword(password: string, salt: string): string {
	return scryptSync(password, salt, 64).toString("hex");
}

/** 设置/修改密码：清空旧 token（所有设备下线），返回为当前设备签发的新 token */
export function setPassword(cwd: string, password: string): { data: AccessData; token: string } {
	if (!password || password.length > MAX_PASSWORD_LENGTH) throw new Error("密码长度无效");
	const salt = randomBytes(16).toString("hex");
	const token = randomBytes(32).toString("hex");
	const data: AccessData = { salt, hash: hashPassword(password, salt), tokens: [{ id: token, createdAt: Date.now() }] };
	save(cwd, data);
	return { data, token };
}

/** 关闭密码：删除存储文件，恢复完全开放 */
export function clearPassword(cwd: string): void {
	try { assertPrivateDirectory(cwd); unlinkSync(accessPath(cwd)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function verifyPassword(data: AccessData, password: string): boolean {
	if (password.length > MAX_PASSWORD_LENGTH) return false;
	const a = Buffer.from(hashPassword(password, data.salt), "hex");
	const b = Buffer.from(data.hash, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

/** 登录成功后签发新 token 并落盘（FIFO，上限 MAX_TOKENS） */
export function issueToken(cwd: string, data: AccessData): string {
	const token = randomBytes(32).toString("hex");
	const next = { ...data, tokens: [...data.tokens, { id: token, createdAt: Date.now() }].slice(-MAX_TOKENS) };
	save(cwd, next);
	data.tokens = next.tokens;
	return token;
}

export function verifyToken(data: AccessData, token: string | undefined, now = Date.now()): boolean {
	if (!token || !TOKEN.test(token)) return false;
	const t = Buffer.from(token);
	let ok = false;
	for (const item of data.tokens) {
		if (!Number.isFinite(item.createdAt) || item.createdAt > now + 60_000 || now - item.createdAt >= TOKEN_TTL_MS) continue;
		const id = Buffer.from(item.id);
		if (id.length === t.length && timingSafeEqual(id, t)) ok = true;
	}
	return ok;
}

/** 注销：吊销单个 token */
export function revokeToken(cwd: string, data: AccessData, token: string | undefined): void {
	if (!token) return;
	const before = data.tokens.length;
	const next = { ...data, tokens: data.tokens.filter(t => t.id !== token) };
	if (next.tokens.length !== before) { save(cwd, next); data.tokens = next.tokens; }
}

/** 解析 Cookie 请求头 */
export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = Object.create(null) as Record<string, string>;
	if (!header) return out;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i > 0) {
			try {
				out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
			} catch {
				/* 非法编码的杂项 cookie 忽略 */
			}
		}
	}
	return out;
}

/** Keep HTTP/LAN compatibility, but HTTPS browser logins must use a Secure cookie. */
export function accessCookie(token: string | null, secure = false): string {
	if (token !== null && !TOKEN.test(token)) throw new Error("无效的访问令牌");
	return `${ACCESS_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${token ? "31536000" : "0"}`;
}
