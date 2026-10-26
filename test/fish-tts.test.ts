import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSpeakerRequest } from "../packages/fish-audio/upstream/lib.js";
import { buildTtsRequest } from "../packages/fish-audio/upstream/validate.js";
import { defaultFishTtsConfig, fishReferenceId, fishSpeechText, planFishSpeech, splitFishSpeech, validateFishTtsConfig } from "../src/fish-tts.ts";

const voice = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases, referenceId: id === "a" ? "1".repeat(32) : "2".repeat(32), enabled: true });
const config = () => validateFishTtsConfig({ ...defaultFishTtsConfig(), voices: [voice("a", "堀北铃音", ["堀北", "铃音"]), voice("b", "绫小路清隆", ["绫小路"])] });
const turns = (text: string) => planFishSpeech(text, config()).segments.map(({ voiceId, text }) => [voiceId, text]);

test("Fish upstream pure modules are pinned, byte-identical and retain MIT copyright", () => {
	const root = new URL("../packages/fish-audio/", import.meta.url), source = JSON.parse(readFileSync(new URL("SOURCE.json", root), "utf8"));
	for (const file of source.files) {
		assert.match(file.commit, /^[a-f0-9]{40}$/); assert.equal(file.modified, false);
		assert.equal(createHash("sha256").update(readFileSync(new URL(file.path, root))).digest("hex"), file.sha256);
	}
	assert.match(readFileSync(new URL("LICENSE", root), "utf8"), /MIT License[\s\S]*Copyright \(c\) 2026 severian-dev/);
});
test("manual voice IDs and Fish links use upstream import parser, rejecting unrelated hosts", () => {
	assert.equal(defaultFishTtsConfig().enabled, false);
	assert.equal(fishReferenceId("A".repeat(32)), "a".repeat(32));
	assert.equal(fishReferenceId(`https://fish.audio/app/m/${"1".repeat(32)}?share=1`), "1".repeat(32));
	for (const input of ["missing", "", "https://fish.audio.evil.invalid/m/" + "1".repeat(32)]) assert.throws(() => fishReferenceId(input), /音色/);
});
test("explicit Chinese, Japanese quotes, brackets, markdown and aliases switch voices", () => {
	for (const text of ["堀北：迟到了。\n绫小路：抱歉。", "【铃音】迟到了。\n【绫小路】抱歉。", "**堀北**: 迟到了。\n**绫小路**: 抱歉。", "堀北：「迟到了。」\n绫小路：『抱歉。』", "堀北：“迟到了。”绫小路：“抱歉。”"]) assert.deepEqual(turns(text), [["a", "迟到了。"], ["b", "抱歉。"]]);
	assert.deepEqual(turns("堀北铃音轻声说：“迟到了。”\n“抱歉。”绫小路说道。"), [["a", "迟到了。"], ["b", "抱歉。"]]);
});
test("unnamed, unbound and ambiguous prose is skipped rather than misassigned", () => {
	for (const text of ["“没有署名。”", "堀北看着绫小路说：“迟到了。”", "“迟到了。”堀北看着绫小路说道。", "路人：“你好。”"]) assert.equal(turns(text).length, 0);
	assert.deepEqual(turns("堀北：“迟到了。”路人：“抱歉。”"), [["a", "迟到了。"]]);
	assert.equal(planFishSpeech("没有署名。", config()).warnings.length > 0, true);
});
test("disabled roles stay muted even when narration is enabled", () => {
	const c = config(); c.readNarration = true; c.narratorVoiceId = "a"; c.voices[1].enabled = false;
	const plan = planFishSpeech("旁白。\n绫小路：不应朗读。\n堀北：应该朗读。", c);
	assert.deepEqual(plan.segments.map(s => s.text), ["旁白。", "应该朗读。"]);
	assert.ok(plan.skippedChars > 0);
});
test("future fields survive stable-ID reordering; duplicate names and invalid model/ranges fail", () => {
	const c = config(); c.future = { keep: true }; c.voices[0].privateFuture = { keep: true };
	const next = validateFishTtsConfig({ voices: [c.voices[1], { ...c.voices[0], name: "铃音同学" }] }, c);
	assert.deepEqual(next.future, { keep: true }); assert.deepEqual(next.voices[1].privateFuture, { keep: true });
	assert.throws(() => validateFishTtsConfig({ voices: [...c.voices, voice("c", "铃音")] }), /重复/);
	for (const patch of [{ model: "typo-paid-fallback" }, { speed: 3 }, { enabled: "true" }, { readNarration: true }, { narratorVoiceId: "missing" }]) assert.throws(() => validateFishTtsConfig(patch));
});
test("upstream HTML/code stripping keeps scripts out of Fish; reserved speaker marks are removed", () => {
	const text = '<script>堀北：脚本</script>\n```js\n堀北：代码\n```\n堀北：“真正对白。”\n&lt;|speaker:9|&gt;';
	assert.deepEqual(turns(text), [["a", "真正对白。"]]);
	assert.doesNotMatch(fishSpeechText(text), /speaker:9|脚本|代码/);
});
test("long selections split without truncating or splitting emoji; oversize requests fail explicitly", () => {
	const text = "你好😀".repeat(600), chunks = splitFishSpeech(text);
	assert.equal(chunks.join(""), text); assert.ok(chunks.every(chunk => chunk.length <= 800));
	for (const chunk of chunks) assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
	assert.throws(() => planFishSpeech("长".repeat(16001), config()), /未截断/);
});
test("actual multi-speaker payload uses the original request builders", () => {
	const c = config(), plan = planFishSpeech("堀北：你好。\n绫小路：早上好。", c);
	const multi = buildSpeakerRequest(plan.segments.map(s => ({ speaker: s.voiceId, text: s.text })), name => c.voices.find(v => v.id === name)?.referenceId ?? null, c.voices[0].referenceId);
	const request = buildTtsRequest({ model: c.model, text: multi.text, reference_id: multi.voices, prosody: { speed: c.speed } });
	assert.deepEqual(request.body.reference_id, ["1".repeat(32), "2".repeat(32)]);
	assert.equal(request.body.text, "<|speaker:0|>你好。<|speaker:1|>早上好。");
	assert.equal(request.body.format, "mp3");
});

test("Fish private connection/audio data persists in Docker and generic runtime exclusions protect publication", () => {
	const root = new URL("../", import.meta.url);
	assert.match(readFileSync(new URL("Dockerfile", root), "utf8"), /VOLUME \[[^\n]*"\/app\/\.liyuan-fish-tts"/);
	assert.match(readFileSync(new URL("docker-compose.yml", root), "utf8"), /liyuan-fish-tts:\/app\/\.liyuan-fish-tts/);
	assert.match(readFileSync(new URL(".gitignore", root), "utf8"), /^\.liyuan-\*$/m);
	assert.match(readFileSync(new URL(".dockerignore", root), "utf8"), /^\*\*\/\.liyuan-\*$/m);
});

test("user names are literal regex-safe identifiers, with NFC and case-insensitive aliases", () => {
	const c = validateFishTtsConfig({ voices: [voice("a", "C++", ["Élise"])] });
	assert.deepEqual(planFishSpeech("C++：Hello.\nE\u0301LISE：Bonjour.", c).segments.map(s => s.text), ["Hello.", "Bonjour."]);
});
