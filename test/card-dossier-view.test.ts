import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { buildDossierReadingView, projectDossierReadingHtml, needsDossierSnapshot, selectDossierSnapshot, delegatedDossierShell } from "../web/src/cardDossierView.ts";
import { buildSrcDoc } from "../web/src/frameDoc.ts";
import { splitRichContentParts } from "../web/src/richContentParts.ts";
import { prepareDisplayText } from "../src/postprocess.ts";

const source = '\n<Analysis>这只是合成更新分析，不是首楼的状态内容。</Analysis>\n<JSONPatch>[{"op":"delta","path":"/人际交往/道友录/合成人物/好感","value":2}]</JSONPatch>\n';
const snapshot = { 主角状态: { 修为: { 当前境界: "合成境界", 进度百分比: 0 }, 灵石钱包: { 下品灵石: 50 } }, 世界系统: { 当前时间: "合成日期 子时", 修仙秘闻: { 合成条目: "未在本轮指令中提及，也必须显示。" } }, 人际交往: { 道友录: { 合成人物: { 好感: 42 } } } };
const wrapper = (body: string) => `<div class="cxtd-box"><details><summary class="cxtd-head">合成卷宗</summary><div class="cxtd-body">${body}</div></details></div><style>.cxtd-box{color:gold}.cxtd-body{font-size:12px}</style>`;
const decode = (html: string) => html.replace(/&(?:amp|lt|gt|quot|#39);/g, value => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[value]!);
const viewText = (view: string) => decode(view.replace(/^<span[^>]*>/, "").replace(/<\/span>$/, ""));
const binding = { entryId: "saved-entry", entryScope: "saved-scope" };
const context = () => ({ scopeKey: binding.entryScope, sourceEntryId: "latest-other-entry", visibleEntryIds: [binding.entryId, "latest-other-entry"], chat: [{ __liyuanEntryId: binding.entryId, is_user: false, swipe_id: 0 }], state: { messages: { [binding.entryId]: { variables: [{ stat_data: structuredClone(snapshot), schema: { ignored: true } }] } } } });

const delegatedSkin = () => ({ rules: [{ name: "Synthetic original static skin", source: '<UpdateVariable>\\s*([\\s\\S]*?)\\s*</UpdateVariable>', flags: "g", replace: '\n```html\n<!doctype html><html><head></head><body>' + wrapper('$1') + '</body></html>\n```\n' }], charName: "Synthetic card", userName: "Synthetic user" });

test("delegated shell reuses only the original enabled static card skin without changing canonical prose", () => {
	const prose = "Synthetic canonical prose without update tags.", skin = delegatedSkin(), before = structuredClone(skin);
	const shell = delegatedDossierShell(prose, skin)!;
	assert.equal(shell, skin.rules[0].replace.replace('$1', '<JSONPatch>[]</JSONPatch>'));
	assert.equal(needsDossierSnapshot(shell), true);
	assert.equal(prose, "Synthetic canonical prose without update tags.");
	assert.deepEqual(skin, before);
	assert.deepEqual(parse(viewText(buildDossierReadingView('<JSONPatch>[]</JSONPatch>', snapshot)!)), snapshot);
	assert.equal((buildSrcDoc(shell, false, true, 844, undefined, snapshot).match(/data-liyuan-dossier-view="snapshot"/g) ?? []).length, 1);
});

test("delegated shell never fabricates a skin or duplicates authored HTML/update/initvar", () => {
	for (const skin of [undefined, null, { ...delegatedSkin(), rules: [] }]) assert.equal(delegatedDossierShell("Canonical prose", skin), null);
	for (const text of [wrapper(source), delegatedSkin().rules[0].replace, '<UpdateVariable>' + source + '</UpdateVariable>', '<initvar>initial: 1</initvar>']) {
		assert.equal(delegatedDossierShell(text, delegatedSkin()), null);
	}
	for (const patch of [{ source: '(.*)' }, { source: '<UpdateVariable>[' }, { replace: '<div class="other-body">$1</div>' }]) {
		const skin = delegatedSkin(); Object.assign(skin.rules[0], patch);
		assert.equal(delegatedDossierShell("Canonical prose", skin), null);
	}
});

test("delegated shell rejects script and template runtimes, but can select a later safe original rule", () => {
	for (const runtime of ['<script>window.__cardRuntime = true</script>', '<SCRIPT src="/runtime.js"></SCRIPT>', '<% runModel() %>']) {
		const skin = delegatedSkin(), safe = structuredClone(skin.rules[0]); skin.rules[0].replace += runtime;
		assert.equal(delegatedDossierShell("Canonical prose", skin), null);
		skin.rules.push(safe);
		assert.equal(delegatedDossierShell("Canonical prose", skin), safe.replace.replace('$1', '<JSONPatch>[]</JSONPatch>'));
	}
});

test("dossier matches the first floor's complete indented key/value state, not an operation list", () => {
	const view = buildDossierReadingView(source, snapshot)!;
	assert.match(view, /data-liyuan-dossier-view="snapshot"/);
	assert.match(view, /主角状态:\n  修为:\n    当前境界: 合成境界/);
	assert.match(view, /世界系统:\n  当前时间: 合成日期 子时/);
	assert.match(view, /好感: 42/); assert.ok(!view.includes("好感: 2"));
	assert.ok(view.includes("未在本轮指令中提及，也必须显示。"));
	for (const label of ["推演说明", "本轮更新指令", "原始更新指令", "cxtd-operation", "cxtd-patch-list", "<Analysis>", "<JSONPatch>"]) assert.ok(!view.includes(label), label);
	assert.deepEqual(parse(viewText(view)), snapshot);
});

test("only replace the protocol body, preserving original wrapper, CSS, controls and surrounding prose", () => {
	const html = "前文\n" + wrapper(source) + "\n后文", copy = structuredClone(snapshot);
	assert.equal(projectDossierReadingHtml(html, snapshot), html.replace(source, buildDossierReadingView(source, snapshot)!));
	const projected = projectDossierReadingHtml(html, snapshot);
	assert.equal(projectDossierReadingHtml(projected, snapshot), projected);
	assert.deepEqual(snapshot, copy, "no patch application or snapshot mutation");
});

test("first-floor initvar is the reference and stays byte-for-byte unchanged, never using the latest floor's values", () => {
	const html = wrapper('<initvar>\n主角状态:\n  合成初始值: 1\n</initvar>');
	assert.equal(needsDossierSnapshot(html), false); assert.equal(projectDossierReadingHtml(html, snapshot), html);
});

test("original regex -> RichContent -> static srcdoc with a native stored snapshot renders only the first-floor format", () => {
	const raw = '合成前文。\n<UpdateVariable>' + source + '</UpdateVariable>\n合成后文。';
	const skin = { rules: [{ name: "合成完成卷宗", source: '<UpdateVariable>\\s*([\\s\\S]*?)\\s*</UpdateVariable>', flags: "g", replace: '\n```html\n<!doctype html><html><head></head><body>' + wrapper('$1') + '</body></html>\n```\n' }], charName: "合成卡", userName: "合成用户" };
	const parts = splitRichContentParts(prepareDisplayText(raw, skin), skin), html = parts.find(part => part.kind === "html")!;
	assert.equal(html.scripts, false); assert.ok(needsDossierSnapshot(html.html));
	const doc = buildSrcDoc(html.html, false, true, 900, undefined, snapshot);
	assert.equal((doc.match(/data-liyuan-dossier-view="snapshot"/g) ?? []).length, 1);
	assert.ok(!doc.includes("<JSONPatch>")); assert.ok(!doc.includes("<script"));
	assert.ok(doc.indexOf('data-liyuan-card-layout="dossier-reader"') < doc.lastIndexOf('</body>'));
	assert.ok(raw.includes(source));
});

test("no source-bound snapshot means no fabricated state, no patch replay and no first-floor copying", () => {
	for (const data of [undefined, null, {}, [], "invalid"]) {
		assert.equal(buildDossierReadingView(source, data), null);
		assert.equal(projectDossierReadingHtml(wrapper(source), data), wrapper(source));
	}
	assert.match(projectDossierReadingHtml(wrapper(source), null, "loading"), /正在读取本楼已存状态卷宗/);
	assert.match(projectDossierReadingHtml(wrapper(source), null, "unavailable"), /未代用其他楼层数据/);
});

test("snapshot adaptation is static/seamless only, not script frames, agent show_html or arbitrary cards", () => {
	for (const [scripts, seamless] of [[true, true], [false, false], [true, false]]) {
		const doc = buildSrcDoc(wrapper(source), scripts, seamless, 900, undefined, snapshot);
		assert.ok(doc.includes(source)); assert.ok(!doc.includes('data-liyuan-dossier-view="snapshot"'));
	}
	const html = wrapper(source).replaceAll("cxtd-body", "different-body");
	assert.equal(needsDossierSnapshot(html), false); assert.equal(projectDossierReadingHtml(html, snapshot), html);
});

test("ordinary prose, authored HTML, custom commands and incomplete protocol remain original", () => {
	for (const text of ["普通正文", '<p>原已有的<em>美化</em></p>', '<Analysis>只有分析</Analysis>', '<pre>_.set("a", 1)</pre>', '<JSONPatch>[{', source + "另有作者正文"]) {
		const html = wrapper(text); assert.equal(needsDossierSnapshot(html), false); assert.equal(projectDossierReadingHtml(html, snapshot), html);
	}
});

test("HTML-like values and keys are escaped in a static snapshot and round-trip without losing scalar types", () => {
	const data = { '<img src=x onerror="alert(1)">': '<script>bad</script> & </div>', values: ["", "false", "0", false, 0, null, [], {}], 文本: "第一行\n第二行", 特殊键: { "a:b": "a # b" } };
	const view = buildDossierReadingView(source, data)!;
	assert.ok(!view.includes('<img')); assert.ok(!view.includes('<script>'));
	assert.deepEqual(parse(viewText(view)), data);
});

test("read only exact-entry native stat_data; latest/chat/schema variables cannot substitute for that floor", () => {
	assert.deepEqual(selectDossierSnapshot(context(), binding), snapshot);
	const ctx: any = context(); ctx.state.messages[binding.entryId].variables = []; ctx.state.messages.other = { variables: [{ stat_data: snapshot }] }; ctx.state.chatMetadata = { stat_data: snapshot };
	assert.equal(selectDossierSnapshot(ctx, binding), null);
});

test("scope, branch visibility and message identity reject stale cards or sibling branches", () => {
	const cases: any[] = [context(), context(), context(), context()];
	cases[0].scopeKey = "other-scope"; cases[1].visibleEntryIds = ["sibling"]; cases[2].chat = []; cases[3].chat[0].__liyuanEntryId = "sibling";
	for (const ctx of cases) assert.equal(selectDossierSnapshot(ctx, binding), null);
});

test("user inputs and unfinished author delivery cannot inherit a display snapshot", () => {
	for (const patch of [{ is_user: true }, { __liyuanUnfinished: true }]) {
		const ctx: any = context(); Object.assign(ctx.chat[0], patch); assert.equal(selectDossierSnapshot(ctx, binding), null);
	}
});

test("select only the message's current native swipe; never another swipe or an ancestor", () => {
	const ctx: any = context(); ctx.chat[0].swipe_id = 1; ctx.state.messages[binding.entryId].variables = [{ stat_data: { stale: true } }, { stat_data: snapshot }];
	assert.deepEqual(selectDossierSnapshot(ctx, binding), snapshot);
	for (const swipe of [2, -1, 1.5, "0", null]) { ctx.chat[0].swipe_id = swipe; assert.equal(selectDossierSnapshot(ctx, binding), null); }
	ctx.chat[0].swipe_id = 1; ctx.state.messages[binding.entryId].variables = { stat_data: snapshot }; assert.equal(selectDossierSnapshot(ctx, binding), null);
	ctx.chat[0].swipe_id = 0; assert.deepEqual(selectDossierSnapshot(ctx, binding), snapshot);
});
