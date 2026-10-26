import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("historical reader remains passive; restored generation is a separate explicit control", () => {
	const source = readFileSync("web/src/components/Messages.tsx", "utf8");
	assert.doesNotMatch(source, /apiPost|localStorage\.setItem|enqueueNovelAi/);
	assert.match(source, /<NovelAiImageControls/);
	assert.match(source, /localStorage\.getItem\(browserCacheKey\)/);
	assert.match(source, /\/api\/historical-images\?prompt=/);
	assert.match(source, /历史图片提示/);
	assert.match(source, /createContext\(false\)/);
	assert.match(readFileSync("web/src/components/SettingsPanel.tsx", "utf8"), /<NovelAiSection/);
	const control = readFileSync("web/src/components/NovelAiImageControls.tsx", "utf8");
	assert.match(control, /if \(readOnly \|\| incomplete/);
	assert.match(control, /onClick=\{\(\) => void generate\(\)\}/);
	assert.doesNotMatch(control.split("const generate =")[0], /method: "POST"/);
	assert.doesNotMatch(control, /localStorage\.setItem/);
});
