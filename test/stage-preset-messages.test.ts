import assert from "node:assert/strict";
import test from "node:test";
import { assembleStPreset } from "../src/preset-assemble.ts";
import { buildStagePresetMessages } from "../src/stage/assemble.ts";

test("preset roles, markers and depths retain order around unmodified history", () => {
	const prompts = [
		{ identifier: "s", role: "system", content: "SYSTEM" },
		{ identifier: "u", role: "user", content: "USER" },
		{ identifier: "charDescription", role: "system", marker: true },
		{ identifier: "a", role: "assistant", content: "ASSISTANT" },
		{ identifier: "chatHistory", marker: true },
		{ identifier: "worldInfoAfter", role: "user", marker: true },
		{ identifier: "tail", role: "assistant", content: "TAIL" },
		{ identifier: "depth", role: "user", content: "DEPTH", injection_position: 1, injection_depth: 1 },
		{ identifier: "off", role: "user", content: "OFF" },
	];
	const assembled = assembleStPreset({ prompts, prompt_order: [{ character_id: 100001,
		order: prompts.map(p => ({ identifier: p.identifier, enabled: p.identifier !== "off" })) }] },
		{ materials: { charDescription: "CARD\r\nEXACT", worldInfoAfter: "WORLD" } });
	const history = [{ role: "assistant", content: "PAST" }, { role: "user", content: "INPUT" }];
	const messages = buildStagePresetMessages(history, assembled.before, assembled.after, assembled.depth,
		[{ content: "NATIVE", position: 4, depth: 1, role: 0 }]) as any[];
	assert.deepEqual(messages.map(m => m.role), ["system", "user", "system", "assistant", "assistant", "user", "system", "user", "user", "assistant"]);
	assert.deepEqual(messages.map(m => typeof m.content === "string" ? m.content : m.content[0].text),
		["SYSTEM", "USER", "CARD\r\nEXACT", "ASSISTANT", "PAST", "DEPTH", "NATIVE", "INPUT", "WORLD", "TAIL"]);
	assert.equal(messages[4], history[0]);
	assert.equal(messages[7], history[1]);
	assert.equal(messages[3].usage.totalTokens, 0);
});

test("empty preset does not change history; overdeep pieces stay inside history marker", () => {
	const history = [{ role: "user", content: "INPUT" }];
	assert.deepEqual(buildStagePresetMessages(history, [], [], []), history);
	const assembled = assembleStPreset({ prompts: [
		{ identifier: "before", content: "BEFORE" },
		{ identifier: "chatHistory", marker: true },
		{ identifier: "depth", content: "DEEP", injection_position: 1, injection_depth: 999 },
		{ identifier: "after", content: "AFTER" },
	] });
	const messages = buildStagePresetMessages(history, assembled.before, assembled.after, assembled.depth) as any[];
	assert.deepEqual(messages.map(m => typeof m.content === "string" ? m.content : m.content[0].text), ["BEFORE", "DEEP", "INPUT", "AFTER"]);
});
