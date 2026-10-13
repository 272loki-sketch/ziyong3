import assert from "node:assert/strict";
import test from "node:test";
import { buildCardFrontSnapshot } from "../src/cardfront.ts";
import { inspectBoundRegex } from "../src/regex-inspector.ts";
import {
	dispatchGlobalActionOption,
	GLOBAL_ACTION_OPTIONS_RULE,
	hideGlobalActionOptionsBlockForDisplay,
	parseGlobalActionOptions,
} from "../src/regex-options.ts";

const optionsText = "正文前。\n<options>\n1. 观察四周，暂不暴露来意\n2. 向守门人询问来客\n</options>\n正文后。";
const script = (scriptName: string, disabled = false) => ({
	scriptName,
	findRegex: "/<状态>([\\s\\S]*?)<\\/状态>/g",
	replaceString: "<div>$1</div>",
	placement: [2],
	markdownOnly: true,
	disabled,
});

test("global options parser只接受单一精确纯文本区块并保留源码范围", () => {
	const parsed = parseGlobalActionOptions(optionsText);
	assert.equal(parsed.status, "valid");
	if (parsed.status !== "valid") return;
	assert.deepEqual(parsed.options, ["观察四周，暂不暴露来意", "向守门人询问来客"]);
	assert.equal(optionsText.slice(parsed.start, parsed.end), "<options>\n1. 观察四周，暂不暴露来意\n2. 向守门人询问来客\n</options>");
	assert.equal(hideGlobalActionOptionsBlockForDisplay(optionsText, parsed), "正文前。\n\n正文后。");
	assert.equal(parseGlobalActionOptions("只有叙事正文").status, "absent");
	assert.equal(parseGlobalActionOptions("<options class='x'>行动</options>").status, "invalid");
	assert.equal(parseGlobalActionOptions("<options><b>HTML</b></options>").status, "invalid");
	assert.equal(parseGlobalActionOptions("<options>一项</options><options>二项</options>").status, "invalid");
	assert.equal(parseGlobalActionOptions(`<options>${Array.from({ length: GLOBAL_ACTION_OPTIONS_RULE.maxOptions + 1 }, (_, i) => `${i + 1}. 选项`).join("\n")}</options>`).status, "invalid");
	assert.equal(parseGlobalActionOptions(`<options>${"长".repeat(GLOBAL_ACTION_OPTIONS_RULE.maxOptionChars + 1)}</options>`).status, "invalid");
	assert.equal(parseGlobalActionOptions("<options>空白 <options>嵌套</options></options>").status, "invalid");
});

test("全局选项选择只调用现有输入回调，不发送也不改正文/作者稿", () => {
	const narrative = "合成 rpNarrative 原值";
	const authorDraft = "合成 rpAuthorDraft 原值";
	const selected: string[] = [];
	assert.equal(dispatchGlobalActionOption("  询问守门人  ", (text) => selected.push(text)), true);
	assert.deepEqual(selected, ["询问守门人"]);
	assert.equal(dispatchGlobalActionOption("<img src=x>", (text) => selected.push(text)), false);
	assert.equal(dispatchGlobalActionOption("继续", undefined), false);
	assert.equal(narrative, "合成 rpNarrative 原值");
	assert.equal(authorDraft, "合成 rpAuthorDraft 原值");
	assert.equal(GLOBAL_ACTION_OPTIONS_RULE.scope, "global");
});

test("两张合成卡共享global options，但预设与局部规则保持隔离且保留disabled", () => {
	const cards = [
		{ card: "card-a.json", preset: "preset-a.json", skinEnabled: false, cardScripts: [script("A局部启用", false), script("A局部关闭", true)] },
		{ card: "card-b.json", preset: "preset-b.json", skinEnabled: true, cardScripts: [script("B局部启用", false)] },
	];
	const snapshots = cards.map((card) => {
		const presetName = card.preset === "preset-a.json" ? "A预设专属规则" : "B预设专属规则";
		const inspected = inspectBoundRegex([
			{ id: card.preset, kind: "preset", name: card.preset, path: card.preset, scripts: [script(presetName)] },
			{ id: card.card, kind: "card", name: card.card, path: card.card, scripts: card.cardScripts },
		]);
		const front = buildCardFrontSnapshot({ card: card.card, userName: "合成用户", cardSkinOff: card.skinEnabled ? [] : [card.card] }, null, "合成角色", [
			{ source: card.preset, scripts: [script(presetName)] },
		]);
		return { card, inspected, front };
	});

	const emptyGlobal = inspectBoundRegex([{ id: "global-empty", kind: "global", name: "空全局来源", path: ".liyuan/regex-global.json", scripts: [] }]);
	assert.equal(emptyGlobal.sources[0].scope, "global");
	assert.equal(emptyGlobal.sources[0].ruleCount, 0);
	assert.equal(parseGlobalActionOptions(optionsText).status, "valid", "empty native GLOBAL scripts do not disable the builtin options parser");

	for (const snapshot of snapshots) {
		const parsed = parseGlobalActionOptions(optionsText);
		assert.equal(parsed.status, "valid", `${snapshot.card.card} must receive the same global parser independent of skin binding`);
		assert.equal(snapshot.front.enabled, snapshot.card.skinEnabled);
	}
	assert.deepEqual(snapshots[0].inspected.rules.filter((rule) => rule.scope === "preset").map((rule) => rule.name), ["A预设专属规则"]);
	assert.deepEqual(snapshots[1].inspected.rules.filter((rule) => rule.scope === "preset").map((rule) => rule.name), ["B预设专属规则"]);
	assert.equal(snapshots[0].inspected.rules.some((rule) => rule.name === "B预设专属规则"), false);
	assert.deepEqual(snapshots[0].inspected.rules.filter((rule) => rule.scope === "local").map((rule) => rule.disabled), [false, true]);
	assert.equal(snapshots[1].inspected.rules.every((rule) => rule.scope !== "preset" || rule.name !== "A预设专属规则"), true);
});

test("global options accepts a normal nine-choice block instead of silently rejecting the whole layout",()=>{
 const text="<options>\n"+Array.from({length:9},(_,i)=>`${i+1}. 合成行动 ${i+1}`).join("\n")+"\n</options>";
 const parsed=parseGlobalActionOptions(text);assert.equal(parsed.status,"valid");if(parsed.status==="valid")assert.equal(parsed.options.length,9);
});

test('real wire display retains strict options until React replaces them, including thinking timeline',async()=>{
 const {toWireMsg}=await import('../server/wire.ts');
 const msg:any={role:'assistant',content:[{type:'text',text:optionsText}],stopReason:'stop',details:{rpGenerationMode:'direct',rpAuthorDraft:optionsText,rpNarrative:'正文前。\n正文后。',rpTimeline:[{kind:'thinking',text:'合成思考'},{kind:'text',text:optionsText}]}};
 const wire=toWireMsg(msg,{charName:'测试',userName:'用户'})!;
 assert.equal(parseGlobalActionOptions(wire.text).status,'valid');
 assert.equal(parseGlobalActionOptions(wire.timeline!.find(s=>s.kind==='text')!.text!).status,'valid');
 assert.equal(wire.authorDelivery,optionsText);assert.equal(msg.details.rpAuthorDraft,optionsText);
});
