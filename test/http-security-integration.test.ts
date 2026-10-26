import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { ACCESS_COOKIE, setPassword } from "../src/access.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function portNumber(): Promise<number> { const listener = createServer(); await new Promise<void>(ok => listener.listen(0, "127.0.0.1", ok)); const port = (listener.address() as { port: number }).port; await new Promise<void>(ok => listener.close(() => ok())); return port; }
function rawRequest(port: number, path: string, headers: Record<string, string> = {}): Promise<{ code: number; text: string }> { return new Promise((ok, fail) => { const req = httpRequest({ host: "127.0.0.1", port, path, headers }, res => { let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => ok({ code: res.statusCode!, text })); }); req.on("error", fail); req.end(); }); }

test("real HTTP/WS boundary: authenticated aliases, cross-site denial, CSP/private files, WS auth and pre-hash throttling (no model calls)", { timeout: 50_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-http-security-integration-"));
	let child: ReturnType<typeof spawn> | undefined;
	const sockets: WebSocket[] = [];
	try {
		mkdirSync(join(cwd, ".liyuan")); mkdirSync(join(cwd, "web/dist"), { recursive: true });
		writeFileSync(join(cwd, "web/dist/index.html"), "<html>synthetic UI only</html>");
		for (const name of ["src", "skills", "node_modules"]) symlinkSync(join(root, name), join(cwd, name), process.platform === "win32" ? "junction" : "dir");
		symlinkSync(join(root, ".liyuan/extensions"), join(cwd, ".liyuan/extensions"), process.platform === "win32" ? "junction" : "dir");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "synthetic-http-boundary", version: "1.8.16", type: "module" }));
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "合成安全卡", first_mes: "合成开场" } }));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "Fixture", greeting: false, novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false }, literaryWorldEnabled: false, literaryEcologyEnabled: false }));
		writeFileSync(join(cwd, "liyuan.agent.json"), JSON.stringify({ version: 1, defaultProvider: "fixture", defaultModel: "writer", providers: { fixture: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "synthetic-not-real", models: [{ id: "writer" }] } } }));
		mkdirSync(join(cwd, ".liyuan-uploads")); mkdirSync(join(cwd, ".liyuan-media"));
		writeFileSync(join(cwd, ".liyuan-uploads/fixture.html"), "<script>synthetic</script>");
		writeFileSync(join(cwd, ".liyuan-media/fixture.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>synthetic</script></svg>");
		writeFileSync(join(cwd, "outside.txt"), "SYNTHETIC_PRIVATE_SENTINEL");
		if (process.platform !== "win32") symlinkSync(join(cwd, "outside.txt"), join(cwd, ".liyuan-uploads/linked.txt"));
		const auth = setPassword(cwd, "synthetic-password"), cookie = `${ACCESS_COOKIE}=${auth.token}`;
		const port = await portNumber(), base = `http://127.0.0.1:${port}`;
		child = spawn(process.execPath, [join(root, "server/main.ts"), "--new"], { cwd, env: { ...process.env, HOME: join(cwd, "home"), LIYUAN_CODING_AGENT_DIR: join(cwd, "agent"), HOST: "127.0.0.1", PORT: String(port), LIYUAN_PLAY_SLOT_CHILD: "1" }, stdio: "ignore" });
		const end = Date.now() + 20_000;
		while (Date.now() < end) { try { if ((await fetch(base + "/healthz")).ok) break; } catch {} await new Promise(ok => setTimeout(ok, 100)); }
		const health = await (await fetch(base + "/healthz")).json() as any;
		assert.equal(health.ok, true); assert.equal(health.sessionId, undefined); assert.equal(health.char, undefined);
		for (const path of ["/api/config", "/veridis-rewrite-host.html", "/veridis-rewrite/original/settings.html", "/public/../api/tavern-plugins/status", "/public/%2e%2e/api/tavern-plugins/status", "/%61pi/config"]) assert.equal((await rawRequest(port, path)).code, 401, path);
		for (const path of ["/api/config", "/api/access/status"]) assert.equal((await fetch(base + path, { headers: { cookie, origin: "http://evil.invalid" } })).status, 403);
		assert.equal((await fetch(base + "/api/access/set", { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ newPassword: "attacker" }) })).status, 403);
		const config = await fetch(base + "/api/config", { headers: { cookie, origin: base } }); assert.equal(config.status, 200); assert.match(config.headers.get("cache-control")!, /no-store/); assert.equal(config.headers.get("x-content-type-options"), "nosniff");
		for (const path of ["/uploads/fixture.html", "/media/fixture.svg"]) { const response = await fetch(base + path, { headers: { cookie } }); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /private.*no-store/); assert.match(response.headers.get("content-security-policy")!, /sandbox/); }
		if (process.platform !== "win32") assert.equal((await fetch(base + "/uploads/linked.txt", { headers: { cookie } })).status, 404);
		assert.equal((await rawRequest(port, "/uploads/%2e%2e/outside.txt", { cookie })).text.includes("SYNTHETIC_PRIVATE_SENTINEL"), false);
		const websocket = async (headers: Record<string, string>, expected: "hello" | "closed") => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers }); sockets.push(ws); ws.on("error", () => {});
			await new Promise<void>((ok, fail) => { const timer = setTimeout(() => fail(Error("synthetic socket timeout")), 3000); ws.once(expected === "hello" ? "message" : "close", () => { clearTimeout(timer); ok(); }); }); return ws;
		};
		await websocket({ cookie, origin: "http://evil.invalid" }, "closed"); await websocket({}, "closed"); const good = await websocket({ cookie, origin: base }, "hello"); good.close();
		for (let i = 0; i < 5; i++) assert.equal((await fetch(base + "/api/access/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "synthetic-wrong" }) })).status, 401);
		const limited = await fetch(base + "/api/access/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "synthetic-wrong" }) }); assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60");
	} finally {
		for (const socket of sockets) socket.terminate();
		if (child && child.exitCode === null) { const exited = new Promise<void>(ok => child!.once("exit", () => ok())); child.kill(); await exited; }
		rmSync(cwd, { recursive: true, force: true });
	}
});
