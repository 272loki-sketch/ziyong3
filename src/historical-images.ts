import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./paths.ts";

/** Read the retired cache without exposing or rewriting its private configuration. */
export function findHistoricalImage(cwd: string, rawPrompt: string): { src: string } | null {
	try {
		const defaults = { model: "nai-diffusion-4-5-full", sampler: "k_dpmpp_2m", scheduler: "karras", steps: 28, scale: 10, cfgRescale: 0.18, width: 1024, height: 1024, positivePrefix: "", positiveSuffix: "", negativePrompt: "" };
		let config = {};
		try { config = JSON.parse(readFileSync(join(cwd, ".liyuan", "novelai.json"), "utf8")); } catch { /* The old reader used defaults when configuration was absent. */ }
		const c = { ...defaults, ...config };
		// Keep the original key field order and normalization for persisted images.
		const key = createHash("sha256").update(JSON.stringify({
			prompt: rawPrompt.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
			negativePrompt: "", seed: null,
			model: c.model, sampler: c.sampler, scheduler: c.scheduler, steps: c.steps,
			scale: c.scale, cfgRescale: c.cfgRescale, width: c.width, height: c.height,
			positivePrefix: c.positivePrefix, positiveSuffix: c.positiveSuffix, configNegativePrompt: c.negativePrompt,
		})).digest("hex");
		const cache = JSON.parse(readFileSync(join(cwd, ".liyuan", "novelai-image-cache.json"), "utf8"));
		const src = cache?.[key]?.src;
		if (typeof src !== "string") return null;
		const match = /^\/media\/([A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpe?g|webp))$/i.exec(src);
		return match && statSync(join(dir(cwd, "media"), match[1])).isFile() ? { src } : null;
	} catch {
		return null;
	}
}
