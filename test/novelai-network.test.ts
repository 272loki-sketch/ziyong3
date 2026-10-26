import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { test } from "node:test";
import { fetchNovelAi } from "../src/novelai-network.ts";

const init = (signal = AbortSignal.timeout(3000)): RequestInit => ({ method: "POST", signal, headers: { authorization: "Bearer synthetic-only-loopback-key", "content-type": "application/json" }, body: JSON.stringify({ input: "synthetic tree" }) });
function server() {
	let requests = 0;
	const api = createServer(async (req, res) => {
		requests++;
		assert.equal(req.headers["proxy-authorization"], undefined);
		assert.equal(req.headers.authorization, "Bearer synthetic-only-loopback-key");
		if (req.url === "/redirect") { res.writeHead(302, { location: "/must-not-follow" }); res.end(); return; }
		if (req.url === "/hang") return;
		const chunks: Buffer[] = []; for await (const part of req) chunks.push(part);
		assert.equal(JSON.parse(Buffer.concat(chunks).toString()).input, "synthetic tree");
		res.writeHead(200, { "content-type": "image/png" }); res.end("synthetic png response");
	});
	return { api, get requests() { return requests; } };
}
function listen(api: ReturnType<typeof createServer>): Promise<string> { return new Promise(resolve => api.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(api.address() as {port:number}).port}`))); }
function close(api: ReturnType<typeof createServer>): Promise<void> { api.closeAllConnections(); return new Promise(done => api.close(() => done())); }

test("NovelAI direct transport does not follow redirects and propagates cancellation", async () => {
	const f = server(), base = await listen(f.api);
	try {
		const response = await fetchNovelAi(`${base}/image`, init(), {});
		assert.equal(await response.text(), "synthetic png response");
		await assert.rejects(fetchNovelAi(`${base}/redirect`, init(), {}));
		assert.equal(f.requests, 2);
		const controller = new AbortController();
		const pending = fetchNovelAi(`${base}/hang`, init(controller.signal), {});
		const check = assert.rejects(pending); controller.abort(); await check;
	} finally { await close(f.api); }
});

test("NovelAI CONNECT transport honors target ports, isolates proxy credentials and rejects redirects", async () => {
	const f = server(), base = await listen(f.api), target = new URL(base), sockets = new Set<net.Socket>();
	let connects = 0;
	const proxy = createServer();
	proxy.on("connect", (req, client, head) => {
		connects++; sockets.add(client); client.on("close", () => sockets.delete(client));
		assert.equal(req.url, `127.0.0.1:${target.port}`);
		assert.equal(req.headers.authorization, undefined);
		assert.equal(req.headers["proxy-authorization"], `Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`);
		const remote = net.connect({ host: "127.0.0.1", port: Number(target.port) }); sockets.add(remote); remote.on("close", () => sockets.delete(remote));
		remote.on("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); });
		client.on("error", () => remote.destroy()); remote.on("error", () => client.destroy()); client.on("close", () => remote.destroy());
	});
	const proxyUrl = new URL(await listen(proxy)); proxyUrl.username = "synthetic-user"; proxyUrl.password = "synthetic-password";
	const env = { LIYUAN_NOVELAI_PROXY: proxyUrl.href };
	try {
		assert.equal(await (await fetchNovelAi(`${base}/image`, init(), env)).text(), "synthetic png response");
		await assert.rejects(fetchNovelAi(`${base}/redirect`, init(), env), /重定向/);
		assert.equal(f.requests, 2); assert.equal(connects, 2);
		const controller = new AbortController(), pending = fetchNovelAi(`${base}/hang`, init(controller.signal), env);
		const check = assert.rejects(pending); setTimeout(() => controller.abort(), 20); await check;
	} finally { for (const socket of sockets) socket.destroy(); await close(proxy); await close(f.api); }
});
