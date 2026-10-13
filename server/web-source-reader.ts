/**
 * Candidate-source excerpt reader for web_research.
 * Public HTTPS/443 only; DNS pinned for direct requests and IP-pinned CONNECT
 * for configured HTTPS proxies. No redirects/cookies/scripts.
 * Failure degrades to search snippets. Excerpts are NOT verified canon facts.
 */
import https from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { readableHtmlText } from "../src/tools/research-html.ts";
import { selectResearchExcerpt } from "../src/tools/research-text.ts";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { containsPrivateSearchMaterial, hostUsesWebResearchProxy, resolveWebResearchProxy, tunnel } from "./web-research.ts";

export function isPublicIPv4(ip: string): boolean {
	if (isIP(ip) !== 4) return false;
	const x = ip.split(".").map(Number);
	if (x.length !== 4 || x.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a,b,c] = x;
	return !(a === 0 || a === 10 || a === 127 || a >= 224
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
        || ip === "168.63.129.16"
		|| (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
		|| (a === 203 && b === 0 && c === 113));
}
export function publicSourceUrl(input: string): URL | null {
	try {
		const url = new URL(input), host = url.hostname.toLowerCase();
		if (input.length > 2048 || containsPrivateSearchMaterial(input) || url.protocol !== "https:" || (url.port && url.port !== "443")
			|| url.username || url.password || isIP(host)
			|| host === "localhost" || host.endsWith(".localhost")
			|| !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)
			|| host.length > 253) return null;
		return url;
	} catch { return null; }
}
/** Decode the page's declared text encoding; UTF-8-only decoding corrupts older Chinese/Japanese canon sources. */
export function decodeReadableBody(bytes: Uint8Array, contentType: string): string {
	const declared = contentType.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i)?.[1];
	const meta = /text\/html/i.test(contentType) ? Buffer.from(bytes.subarray(0, 4096)).toString("latin1")
		.match(/<meta\b[^>]*charset\s*=\s*["']?\s*([a-z0-9._-]+)/i)?.[1] : undefined;
	const charset = declared ?? meta ?? "utf-8";
	try { return new TextDecoder(charset).decode(bytes); }
	catch { return new TextDecoder("utf-8").decode(bytes); }
}

/** Fail closed before streaming a document with the wrong type or excessive size. */
export function readablePageHeaders(status: number | undefined, headers: {
	"content-type"?: string | string[];
	"content-encoding"?: string | string[];
	"content-length"?: string | string[];
}): boolean {
	const type = String(headers["content-type"] ?? "").toLowerCase();
	const encoding = String(headers["content-encoding"] ?? "").toLowerCase();
	const length = Number(headers["content-length"] ?? "0");
	return status === 200
		&& /^(text\/html|text\/plain)(?:;|$)/.test(type)
		&& ["", "identity", "gzip", "deflate", "br"].includes(encoding)
		&& (Number.isFinite(length) && length >= 0 && length <= 160_000);
}

/** Linear scan: malformed markup must not monopolize the backend event loop. */
export function stripReadableHtml(input: string): string { return readableHtmlText(input, 160_000); }

export function extractReadableExcerpt(html: string, focus = "", isHtml = true, maxChars = 4_000): string {
	const cleaned = (isHtml ? stripReadableHtml(html)
        .replace(/&(?:nbsp|#160);/gi, " ")
        .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Math.min(Number.parseInt(value, 16), 0x10ffff)))
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
		 : html.slice(0, 160_000)).replace(/\s+/g, " ").trim();
	return maxChars === 160_000 ? cleaned : selectResearchExcerpt(cleaned, focus);
}

/** Injectable transport for synthetic tests; never controlled by tool arguments. */
export interface SourceReaderTransport {
	lookup: typeof lookup;
	request: typeof https.request;
	proxy: () => URL | null;
    useProxy?: (hostname: string, proxy: URL) => boolean;
	tunnel: typeof tunnel;
}
const transport: SourceReaderTransport = { lookup, request: https.request, proxy: resolveWebResearchProxy, tunnel };
/** Trusted server configuration; tools never supply an environment or transport. */
export function sourceReaderTransport(env: NodeJS.ProcessEnv): SourceReaderTransport {
    return { ...transport, proxy: () => resolveWebResearchProxy(env), useProxy: (hostname, proxy) => hostUsesWebResearchProxy(hostname, proxy, env) };
}


/** No redirect/auth/cookie forwarding. Validate all resolved addresses and pin one. */
export async function readPublicWebDocument(input: string, parentSignal?: AbortSignal, io: SourceReaderTransport = transport): Promise<string | null> {
	const url = publicSourceUrl(input);
	if (!url || parentSignal?.aborted) return null;
	const deadline = AbortSignal.timeout(6500);
	const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
	let socket: Awaited<ReturnType<typeof tunnel>> | undefined;
	try {
		const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
		let abort!: () => void;
		const stopped = new Promise<never>((_, reject) => { abort = () => reject(new Error("DNS cancelled")); dnsSignal.addEventListener("abort", abort, { once: true }); });
		const addresses = await Promise.race([io.lookup(url.hostname, { all: true, family: 4 }), stopped])
			.finally(() => dnsSignal.removeEventListener("abort", abort));
		if (signal.aborted || !addresses.length || addresses.some(x => !isPublicIPv4(x.address))) return null;
		const ip = addresses[0].address;
		const networkSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
		const proxy = io.proxy();
		if (proxy && (io.useProxy?.(url.hostname, proxy) ?? hostUsesWebResearchProxy(url.hostname, proxy))) socket = await io.tunnel(url, proxy, networkSignal, ip);
		if (networkSignal.aborted) return null;
		return await new Promise<string | null>(resolve => {
			let settled = false;
			const done = (value: string | null) => {
				if (settled) return; settled = true;
				networkSignal.removeEventListener("abort", abortRequest);
				resolve(networkSignal.aborted ? null : value);
			};
			const abortRequest = () => { req.destroy(); done(null); };
			const req = io.request(url, {
				method: "GET", signal: networkSignal, timeout: 3500, rejectUnauthorized: true, family: 4,
				headers: { "user-agent": "LiyuanResearch/1.0", accept: "text/html,text/plain", "accept-encoding": "identity" },
				// Direct requests use a per-request agent, preventing reuse of another DNS decision.
				...(socket ? { createConnection: () => socket! } : { agent: false, lookup: ((_host, _options, cb) => cb(null, ip, 4)) satisfies LookupFunction }),
			}, response => {
				const type = String(response.headers["content-type"] ?? "");
				if (networkSignal.aborted || !readablePageHeaders(response.statusCode, response.headers)) { response.destroy(); done(null); return; }
				const chunks: Buffer[] = []; let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 160_000) { req.destroy(); response.destroy(); done(null); }
					else chunks.push(chunk);
				});
				response.once("end", () => {
					try {
                        const encoded = Buffer.concat(chunks), encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
                        const options = { maxOutputLength: 160_000 };
                        const bytes = encoding === "gzip" ? gunzipSync(encoded, options) : encoding === "deflate" ? inflateSync(encoded, options) : encoding === "br" ? brotliDecompressSync(encoded, options) : encoded;
                        if (bytes.length > 160_000) { done(null); return; }
                        done(extractReadableExcerpt(decodeReadableBody(bytes, type), "", /^text\/html/i.test(type), 160_000) || null);
                    }
					catch { done(null); }
				});
				response.once("error", () => done(null)); response.once("aborted", () => done(null));
				response.once("close", () => { if (!response.complete) done(null); });
			});
			req.once("error", () => done(null)); req.once("timeout", abortRequest);
			networkSignal.addEventListener("abort", abortRequest, { once: true });
			if (networkSignal.aborted) abortRequest(); else req.end();
		});
	} catch { return null; }
	finally { socket?.destroy(); }
}

export async function readPublicWebSource(input: string, parentSignal?: AbortSignal, focus = "", io: SourceReaderTransport = transport): Promise<string | null> {
    const text = await readPublicWebDocument(input, parentSignal, io);
    return text && !parentSignal?.aborted ? selectResearchExcerpt(text, focus) : null;
}
