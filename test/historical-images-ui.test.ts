import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("historical image UI has no generation, configuration or cache writes", () => {
	const source = readFileSync("web/src/components/Messages.tsx", "utf8");
	assert.doesNotMatch(source, /NovelAi|novelai|apiPost|localStorage\.setItem|enqueueNovelAi/);
	assert.match(source, /localStorage\.getItem\(browserCacheKey\)/);
	assert.match(source, /\/api\/historical-images\?prompt=/);
	assert.match(source, /历史图片提示/);
	assert.match(source, /createContext\(false\)/);
	assert.doesNotMatch(readFileSync("web/src/components/SettingsPanel.tsx", "utf8"), /novelai|NovelAi|NovelAI/);
});
