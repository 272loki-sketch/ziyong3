import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { findHistoricalImage } from "../src/historical-images.ts";
import { handleApiRequest, type RestHost } from "../server/rest.ts";

test("retired image routes are absent; historical lookup preserves files and projects only src", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-historical-images-"));
	const config = { enabled: true, apiKey: "synthetic-private-key", baseUrl: "https://must-not-contact.invalid", model: "fixture", sampler: "fixture", scheduler: "fixture", steps: 12, scale: 5, cfgRescale: 0.2, width: 512, height: 768, positivePrefix: "synthetic prefix", positiveSuffix: "synthetic suffix", negativePrompt: "synthetic negative" };
	const key = createHash("sha256").update(JSON.stringify({ prompt: "tree, cloud", negativePrompt: "", seed: null, model: config.model, sampler: config.sampler, scheduler: config.scheduler, steps: config.steps, scale: config.scale, cfgRescale: config.cfgRescale, width: config.width, height: config.height, positivePrefix: config.positivePrefix, positiveSuffix: config.positiveSuffix, configNegativePrompt: config.negativePrompt })).digest("hex");
	mkdirSync(join(cwd, ".liyuan"));
	mkdirSync(join(cwd, ".liyuan-media"));
	const configPath = join(cwd, ".liyuan", "novelai.json"), cachePath = join(cwd, ".liyuan", "novelai-image-cache.json"), imagePath = join(cwd, ".liyuan-media", "fixture.png");
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
	const writeCache = (src: string) => writeFileSync(cachePath, JSON.stringify({ [key]: { src, bytes: 7, apiKey: "synthetic-leak", private: config } }));
	writeCache("/media/fixture.png");
	writeFileSync(imagePath, "fixture");
	const before = [configPath, cachePath, imagePath].map(path => readFileSync(path));
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (async () => { requests++; throw new Error("Network forbidden"); }) as typeof fetch;
	const host = { cwd } as RestHost;
	async function request(method: string, url: string) {
		const req = Readable.from(['{"prompt":"tree, cloud","apiKey":"must-not-save"}']) as any;
		req.method = method; req.url = url;
		let status = 0, body = "";
		const res = { writeHead(code: number) { status = code; }, end(value = "") { body += value; } };
		const handled = await handleApiRequest(req, res as never, host);
		return { handled, status, body };
	}
	try {
		for (const [method, url] of [["GET", "/api/novelai"], ["PUT", "/api/novelai"], ["POST", "/api/novelai/generate"], ["GET", "/api/novelai/cached?prompt=tree"], ["PUT", "/api/historical-images"], ["POST", "/api/historical-images"]]) {
			const result = await request(method, url);
			assert.equal(result.handled, true);
			assert.equal(result.status, 404, `${method} ${url}`);
		}
		assert.deepEqual(findHistoricalImage(cwd, "  tree,   cloud  "), { src: "/media/fixture.png" });
		const hit = await request("GET", "/api/historical-images?prompt=tree%2C%20cloud");
		assert.equal(hit.status, 200);
		assert.deepEqual(JSON.parse(hit.body), { src: "/media/fixture.png" });
		const miss = await request("GET", "/api/historical-images?prompt=unknown");
		assert.deepEqual(JSON.parse(miss.body), { src: null });
		assert.equal((await request("GET", "/api/historical-images?prompt=")).status, 400);
		assert.equal((await request("GET", `/api/historical-images?prompt=${"x".repeat(100001)}`)).status, 400);
		assert.deepEqual([configPath, cachePath, imagePath].map(path => readFileSync(path)), before);
		assert.deepEqual(readdirSync(join(cwd, ".liyuan")).sort(), ["novelai-image-cache.json", "novelai.json"]);
		mkdirSync(join(cwd, ".liyuan-media", "directory.png"));
		for (const src of ["/media/missing.png", "/media/../novelai.json", "https://must-not-contact.invalid/image.png", "/media/fixture.png?secret", "/media/.", "/media/directory.png"]) {
			writeCache(src);
			assert.equal(findHistoricalImage(cwd, "tree, cloud"), null);
		}
		writeFileSync(cachePath, "not json");
		assert.equal(findHistoricalImage(cwd, "tree, cloud"), null);
		assert.equal(requests, 0);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("historical lookup retains the old default key when config is absent or malformed", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-historical-defaults-"));
	try {
		mkdirSync(join(cwd, ".liyuan"));
		mkdirSync(join(cwd, ".liyuan-media"));
		writeFileSync(join(cwd, ".liyuan-media", "fixture.png"), "fixture");
		const key = createHash("sha256").update(JSON.stringify({ prompt: "tree", negativePrompt: "", seed: null, model: "nai-diffusion-4-5-full", sampler: "k_dpmpp_2m", scheduler: "karras", steps: 28, scale: 10, cfgRescale: 0.18, width: 1024, height: 1024, positivePrefix: "", positiveSuffix: "", configNegativePrompt: "" })).digest("hex");
		writeFileSync(join(cwd, ".liyuan", "novelai-image-cache.json"), JSON.stringify({ [key]: { src: "/media/fixture.png", bytes: 7 } }));
		assert.deepEqual(findHistoricalImage(cwd, "tree"), { src: "/media/fixture.png" });
		writeFileSync(join(cwd, ".liyuan", "novelai.json"), "not json");
		assert.deepEqual(findHistoricalImage(cwd, "tree"), { src: "/media/fixture.png" });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
