/** Explicit NovelAI-only proxy selection. No global proxy changes, redirects or paid retries. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";

export function novelAiEndpoint(base: string): URL {
	let url: URL;
	try { url = new URL(base); } catch { throw new Error("NovelAI 接口地址无效"); }
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash)
		throw new Error("NovelAI 接口须为 HTTPS（仅本机允许 HTTP），且不能包含凭据、查询或片段");
	url.pathname = /\/ai\/generate-image\/?$/i.test(url.pathname) ? url.pathname.replace(/\/$/, "") : `${url.pathname.replace(/\/+$/, "")}/ai/generate-image`;
	return url;
}
export function novelAiProxy(env: NodeJS.ProcessEnv = process.env): URL | null {
	const raw = env.LIYUAN_NOVELAI_PROXY?.trim();
	if (!raw || raw.toLowerCase() === "direct") return null;
	let proxy: URL;
	try { proxy = new URL(raw.includes("://") ? raw : `http://${raw}`); } catch { throw new Error("NovelAI 专用代理地址无效"); }
	if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error("NovelAI 专用代理只支持 HTTP(S) CONNECT");
	return proxy;
}
function tunnel(target: URL, proxy: URL, signal: AbortSignal): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const authority = `${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}`;
		const headers: Record<string, string> = { host: authority };
		if (proxy.username || proxy.password) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
		const connection = new URL(proxy.href); connection.username = ""; connection.password = "";
		const request = (proxy.protocol === "https:" ? https : http).request(connection, { method: "CONNECT", path: authority, headers, signal, agent: false, maxHeaderSize: 16_384 });
		request.once("error", reject);
		request.once("connect", (response, socket, head) => {
			if (response.statusCode !== 200 || head.length || signal.aborted) { socket.destroy(); reject(new Error("NovelAI 代理连接被拒绝或已取消")); return; }
			resolve(socket);
		});
		request.once("response", response => { response.destroy(); reject(new Error("NovelAI 代理未建立 CONNECT 隧道")); });
		request.end();
	});
}
export async function fetchNovelAi(url: string, init: RequestInit, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
	const target = new URL(url), proxy = novelAiProxy(env);
	if (!proxy) return fetch(url, { ...init, redirect: "error" });
	const signal = init.signal ?? AbortSignal.timeout(120_000);
	signal.throwIfAborted();
	const raw = await tunnel(target, proxy, signal);
	if (signal.aborted) { raw.destroy(); signal.throwIfAborted(); }
	const hostname = target.hostname.replace(/^\[|\]$/g, "");
	const socket = target.protocol === "https:" ? tls.connect({ socket: raw, host: hostname, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true }) : raw;
	const agent = target.protocol === "https:" ? new https.Agent() : new http.Agent();
	agent.createConnection = () => socket;
	return new Promise((resolve, reject) => {
		const cleanup = () => { signal.removeEventListener("abort", abort); agent.destroy(); raw.destroy(); };
		const abort = () => { socket.destroy(); raw.destroy(); };
		signal.addEventListener("abort", abort, { once: true });
		socket.once("error", error => { cleanup(); reject(error); });
		const request = (target.protocol === "https:" ? https : http).request(target, { method: "POST", headers: init.headers as Record<string, string>, signal, agent }, response => {
			response.once("close", cleanup);
			const headers = new Headers();
			for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
			const status = response.statusCode ?? 502;
			if (status >= 300 && status < 400) { response.destroy(); reject(new Error("NovelAI 不允许重定向")); return; }
			resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
		});
		request.once("error", error => { cleanup(); reject(error); });
		request.end(typeof init.body === "string" ? init.body : undefined);
	});
}
