import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";

/** Browser requests must target the same authority. Forwarded headers are not trusted. */
export function isSameOriginRequest(req: Pick<IncomingMessage, "headers">): boolean {
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin" && site !== "none") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true; // CLI and authenticated internal runtimes.
	if (typeof origin !== "string" || typeof req.headers.host !== "string") return false;
	try {
		const url = new URL(origin);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== origin) return false;
		const expected = new URL(`${url.protocol}//${req.headers.host}`);
		return expected.host === url.host && expected.origin === origin;
	} catch { return false; }
}

/** Canonicalize before authentication, since plugin routers also normalize dot segments. */
export function requestPathname(raw: string): string {
	if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(raw)) throw new Error("无效的请求路径");
	const pathname = decodeURIComponent(new URL(raw, "http://localhost").pathname);
	if (/[\\\x00-\x1f\x7f]/.test(pathname)) throw new Error("无效的请求路径");
	return pathname;
}

export function isAccessGuardedPath(path: string): boolean {
	if (path.startsWith("/api/")) return !path.startsWith("/api/access/");
	return ["/veridis-rewrite/", "/media/", "/audio/", "/uploads/", "/tavern-compat/", "/scripts/extensions/third-party/JS-Slash-Runner/"].some(prefix => path.startsWith(prefix))
		|| ["/veridis-rewrite-host.html", "/tavern-plugin-host.html"].includes(path);
}

/** No sibling-prefix escape, symlink traversal, directories, or dot-file disclosure. */
export function resolveStaticFile(root: string, relativePath: string): string | null {
	if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\") || /[\x00-\x1f\x7f]/.test(relativePath)) return null;
	const parts = relativePath.split("/");
	if (parts.some(part => !part || part.startsWith("."))) return null;
	try {
		let file = resolve(root);
		for (let i = 0; i < parts.length; i++) {
			file = join(file, parts[i]);
			const stat = lstatSync(file);
			if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) return null;
		}
		return file;
	} catch { return null; }
}

/** Bounded pre-hash login throttle. Client identity is the socket, never a spoofable proxy header. */
export class AccessAttemptLimiter {
	readonly #clients = new Map<string, { count: number; until: number }>();
	#global = { count: 0, until: 0 };
	private readonly now: () => number;
	private readonly windowMs: number;
	private readonly maxClients: number;
	constructor(now = Date.now, windowMs = 60_000, maxClients = 1024) {
		this.now = now; this.windowMs = windowMs; this.maxClients = maxClients;
	}
	allow(client: string): boolean {
		const now = this.now();
		if (this.#global.until <= now) this.#global = { count: 0, until: now + this.windowMs };
		for (const [key, value] of this.#clients) if (value.until <= now) this.#clients.delete(key);
		let entry = this.#clients.get(client);
		if (!entry) {
			if (this.#clients.size >= this.maxClients) return false;
			entry = { count: 0, until: now + this.windowMs };
			this.#clients.set(client, entry);
		}
		if (entry.count >= 5 || this.#global.count >= 20) return false;
		entry.count++; this.#global.count++;
		return true;
	}
}

/** Password-free local servers must not trust arbitrary DNS names (DNS rebinding). */
export function isTrustedUnprotectedHost(req: Pick<IncomingMessage, "headers">, trusted: ReadonlySet<string>): boolean {
	if (typeof req.headers.host !== "string") return false;
	try {
		const url = new URL(`http://${req.headers.host}`);
		if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
		return trusted.has(url.hostname.toLowerCase());
	} catch { return false; }
}
